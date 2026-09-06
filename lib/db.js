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

/** Inaendesha statements kadhaa kwa pamoja, atomic (zote zafaulu au zote zarudi nyuma). */
async function runBatch(statements) {
  return getClient().batch(statements, 'write');
}

module.exports = { getClient, runBatch };
