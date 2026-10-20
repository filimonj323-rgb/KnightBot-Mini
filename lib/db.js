// lib/db.js — Turso (libSQL) client kwa ajili ya session-db.js.
//
// Inatumia DATABASE ILE ILE tayari iliyowekwa kwa pairing/pairingConfig.js
// (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) — haihitaji akaunti/database
// nyingine. Ukitaka session za bot kuu ziwe kwenye database TOFAUTI na ile
// ya pairing (users/payments), weka TURSO_DATABASE_URL na TURSO_AUTH_TOKEN
// kama environment variables kwenye Railway — hizo zitachukua kipaumbele
// juu ya pairingConfig.js.

const { createClient } = require('@libsql/client');

let cfg = {};
try {
  // Njia kutoka lib/db.js kwenda pairing/pairingConfig.js
  cfg = require('../pairing/pairingConfig');
} catch (e) {
  // Sawa kama haipo — env vars pekee ndizo zitatumika hapo chini.
}

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || cfg.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || cfg.TURSO_AUTH_TOKEN;

let client = null;

function getClient() {
  if (!client) {
    if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
      throw new Error(
        '[db] TURSO_DATABASE_URL / TURSO_AUTH_TOKEN haijapatikana (wala env var wala pairing/pairingConfig.js).'
      );
    }
    client = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  }
  return client;
}

// ── DATABASE ZA SESSIONS (SHARDS) ───────────────────────────────────────────
// wa_sessions / wa_session_keys / wa_messages (zinazoandika sana) zinaweza kugawanywa
// kwenye database 1 hadi 8 (shards). Kila session_id inapangiwa shard MOJA kwa hash ya jina lake,
// kwa hiyo writes zinasambaa sawasawa.
//
// Railway Variables (hesabu kuanzia 1, bila kuruka):
//   SESSION_TURSO_DATABASE_URL_1 / SESSION_TURSO_AUTH_TOKEN_1
//   SESSION_TURSO_DATABASE_URL_2 / SESSION_TURSO_AUTH_TOKEN_2
//   SESSION_TURSO_DATABASE_URL_3 / SESSION_TURSO_AUTH_TOKEN_3  ...
// (Majina ya zamani bila namba, SESSION_TURSO_DATABASE_URL/TOKEN, yanahesabiwa kama shard 1.)
//
// MUHIMU 1: quota ya Turso ni ya AKAUNTI nzima — kila shard iwe kwenye akaunti TOFAUTI ya Turso.
// MUHIMU 2: USIBADILISHE idadi ya shards baada ya kuanza kuzitumia (hash itabadilika na sessions
//           zitapotea kwenye shard zilizotarajiwa). Amua idadi sasa na uibakize.
// Zikikosekana kabisa, sessions zinaendelea kutumia database kuu (tabia ya zamani).
const MAX_SESSION_SHARDS = 8;
const crypto = require('crypto');

function readShardConfig() {
  const out = [];
  for (let i = 1; i <= MAX_SESSION_SHARDS; i++) {
    const url = process.env[`SESSION_TURSO_DATABASE_URL_${i}`] || (i === 1 ? process.env.SESSION_TURSO_DATABASE_URL : '') || '';
    const token = process.env[`SESSION_TURSO_AUTH_TOKEN_${i}`] || (i === 1 ? process.env.SESSION_TURSO_AUTH_TOKEN : '') || '';
    if (!url || !token) break; // acha kwenye pengo la kwanza
    if (url === TURSO_DATABASE_URL) continue; // usitumie database kuu kama shard
    out.push({ url, token, client: null });
  }
  return out;
}
const shards = readShardConfig();

function sessionDbIsSeparate() {
  return shards.length > 0;
}

function sessionShardCount() {
  return shards.length;
}

function shardIndexFor(sessionId) {
  if (shards.length <= 1) return 0;
  return crypto.createHash('md5').update(String(sessionId)).digest().readUInt32BE(0) % shards.length;
}

function shardClient(sh) {
  if (!sh.client) sh.client = createClient({ url: sh.url, authToken: sh.token });
  return sh.client;
}

/** Client ya shard inayomiliki session hii (au database kuu ikiwa hakuna shards). */
function getSessionClient(sessionId) {
  if (!shards.length) return getClient();
  return shardClient(shards[shardIndexFor(sessionId)]);
}

/** Clients zote zinazobeba data ya sessions (kwa schema/list/delete-all). */
function getAllSessionClients() {
  if (!shards.length) return [getClient()];
  return shards.map(shardClient);
}

async function runSessionBatch(sessionId, statements) {
  return getSessionClient(sessionId).batch(statements, 'write');
}

/** Inaendesha statements kadhaa kwa pamoja, atomic (zote zafaulu au zote zarudi nyuma). */
async function runBatch(statements) {
  return getClient().batch(statements, 'write');
}

module.exports = { getClient, runBatch, getSessionClient, getAllSessionClients, runSessionBatch, sessionDbIsSeparate, sessionShardCount, shardIndexFor };
