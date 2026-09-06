// session-db.js — huhifadhi WhatsApp session (creds + keys) kwenye Turso
// (libSQL, database ile ile inayotumika na pairing/db.js) badala ya faili
// kwenye disk/Railway volume.
//
// KWA NINI: useMultiFileAuthState() inaandika creds.json + funguo nyingi
// kama faili kwenye folda ya ndani ya container (mfano `./session`). Bila
// Railway volume iliyounganishwa kwenye folda hiyo, kila deploy/restart
// inafuta faili hizo na session inapotea. Faili hili linahifadhi kila kitu
// Turso badala yake, hivyo session inaishi bila kujali container/redeploy —
// mradi tu TURSO_DATABASE_URL/TURSO_AUTH_TOKEN ile ile inatumika (tazama
// lib/db.js — kwa default zinatoka pairing/pairingConfig.js).
//
// Kila "key" (prekey/session-chain/sender-key) ni ROW yake tofauti kwenye
// `wa_session_keys` (si blob moja kubwa), na `keysCache` ya kila session
// huanza TUPU na hujaa TU kwa funguo ambazo Baileys kweli ameziomba —
// hivyo boot ni haraka na maombi kwa Turso yanalingana na matumizi halisi,
// si ukubwa wa jumla wa historia ya session.
//
// "API" (majina ya functions zinazotumika nje: initializeDatabase,
// useTursoAuthState, deleteSession, deleteAllSessions,
// seedCredsFromLegacyImport, migrateDiskSessionIfPresent) ndiyo kiungo
// pekee ambacho index.js kinahitaji.

const { getClient, runBatch } = require('./lib/db');
const pino = require('pino');
const { createLogger } = require('./lib/logger');
const fs = require('fs');
const path = require('path');

const logger = pino({ level: 'silent' }); // passed to Baileys' makeCacheableSignalKeyStore — must stay pino, not our wrapper
const log = createLogger('session-db'); // structured logging for this module's own messages

const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

const CREDS_REFRESH_INTERVAL = 10 * 60 * 60 * 1000; // masaa 10

// Chini = data salama zaidi lakini maandishi mengi zaidi kwa Turso; juu =
// maandishi machache zaidi lakini hatari kidogo ya kupoteza mabadiliko ya
// sekunde chache pindi process ikifa ghafla. Flush inaandika TU funguo
// zilizobadilika, si blob nzima.
const FLUSH_INTERVAL_MS = parseInt(process.env.SESSION_FLUSH_MS || '5000', 10);

// Idadi kubwa zaidi ya funguo zinazoandikwa kwa statement moja ya batch
// (epuka statement moja kubwa mno ikiwa matukio mengi yametokea kwa wakati
// mmoja).
const MAX_KEYS_PER_BATCH = 200;

const KEYS_STATS_LOG_INTERVAL = 30 * 60 * 1000; // dakika 30
const KEYS_STATS_WARN_THRESHOLD = 8000; // idadi ya "keys" zinazosababisha onyo

// ── PRUNING (salama): funguo za aina "session"/"sender-key" ambazo Baileys
// mwenyewe ameshaziondoa kwenye kumbukumbu (set → null) tayari zinafutwa mara
// moja kwenye DB (angalia keyStore.set() chini). Hii hapa ni SAFETY NET ya
// ziada tu: prekeys za muda (aina zenye "pre-key" jina lake) ambazo hazija-
// guswa kwa muda mrefu SANA (default siku 30) zinafutwa taratibu.
const PRUNE_ENABLED = process.env.SESSION_PRUNE_ENABLED !== 'false';
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // saa 6
const PRUNE_PREKEY_MAX_AGE_MS = parseInt(process.env.SESSION_PRUNE_PREKEY_DAYS || '30', 10) * 24 * 60 * 60 * 1000;

// ── MESSAGE STORE (kwa ajili ya getMessage() — retry system + poll votes) ──
const MESSAGE_STORE_MAX_AGE_MS = parseInt(process.env.MESSAGE_STORE_HOURS || '72', 10) * 60 * 60 * 1000;
const MESSAGE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // saa 6

const exitHandlers = new Map();
let globalExitHandlerRegistered = false;
let schemaReady = false;

// ── @itsliaaa/baileys ni ESM-only — KnightBot-Mini inaipakia kwa
// dynamic import() ndani ya index.js (loadBaileysBridge) na kuiweka
// global.__baileys. Faili hili halitumii `import`/`require` ya moja kwa
// moja kwa baileys — linasoma helpers zinazohitajika (initAuthCreds,
// makeCacheableSignalKeyStore) kutoka global.__baileys wakati
// useTursoAuthState() inapoitwa. Kwa hiyo: MUHIMU kuita
// loadBaileysBridge() KABLA ya useTursoAuthState() — mpangilio uleule
// uliokuwa ukitumika kwa useMultiFileAuthState() awali.
function getBaileys() {
  const b = global.__baileys;
  if (!b || !b.initAuthCreds || !b.makeCacheableSignalKeyStore) {
    throw new Error(
      '[session-db] global.__baileys haijapakiwa bado. Ita loadBaileysBridge() (au sawa nayo) KABLA ya useTursoAuthState().'
    );
  }
  return b;
}

// ── PER-SESSION RUNTIME STATE CACHE ─────────────────────────────────────
// Huhifadhi {creds, keysCache, keyWriter, credsWriter} kwa maisha yote ya
// process kwa kila sessionId. Boot ya KWANZA ya session hiyo ndiyo pekee
// inayosoma Turso kikamilifu; kila reconnect baada ya hapo inatumia tena
// OBJECTS ZILE ZILE badala ya kuzijenga upya — hivyo RAM na maombi kwa
// Turso haviongezeki kwa kila reconnect, na timers (stats/pruner/refresh)
// zinasajiliwa mara MOJA tu kwa sessionId.
const sessionRuntimeCache = new Map(); // sessionId -> { creds, keysCache, keyWriter, credsWriter }

// Sentinel inayowekwa kwenye keysCache kuashiria "tumeshauliza DB kwa hii
// key, na haipo" — ni tofauti na "haijawahi kuulizwa" (undefined/!has()).
const NEGATIVE = Symbol('negative-key-lookup');

/** Frees a session's cached in-memory state + background timers. Call when a session is deleted (logout/removed) so a re-pair starts clean and nothing keeps ticking for a session that no longer exists. */
function clearSessionRuntimeState(sessionId) {
  sessionRuntimeCache.delete(sessionId);
  unregisterGlobalExitHandler(sessionId);
  for (const timerMapName of ['keysStatsTimers', 'prekeyPruneTimers', 'credRefreshTimers', 'messagePruneTimers']) {
    const map = global[timerMapName];
    if (!map) continue;
    for (const key of [...map.keys()]) {
      if (key === sessionId || key.endsWith(`_${sessionId}`)) {
        clearInterval(map.get(key));
        map.delete(key);
      }
    }
  }
}

function reviveBuffers(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(reviveBuffers);
  if (typeof obj === 'object') {
    if (obj.type === 'Buffer') {
      if (typeof obj.base64 === 'string') return Buffer.from(obj.base64, 'base64');
      if (Array.isArray(obj.data)) return Buffer.from(obj.data);
    }
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = reviveBuffers(value);
    }
    return result;
  }
  return obj;
}

function replacer(key, value) {
  if (Buffer.isBuffer(value)) {
    return { type: 'Buffer', base64: value.toString('base64') };
  }
  return value;
}

async function retryOperation(operation, operationName = 'DB Operation') {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt - 1);
        log.warn(`[session-db] ${operationName} attempt ${attempt}/${MAX_RETRIES} failed, retrying in ${delay}ms:`, err.message);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  log.error(`[session-db] ${operationName} failed after ${MAX_RETRIES} attempts:`, lastError.message);
  throw lastError;
}

async function initializeDatabase() {
  if (schemaReady) return true;
  try {
    const client = getClient();
    await client.batch(
      [
        `CREATE TABLE IF NOT EXISTS wa_sessions (
                session_id TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )`,
        `CREATE TABLE IF NOT EXISTS wa_session_keys (
                session_id TEXT NOT NULL,
                key_id TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, key_id)
            )`,
        `CREATE INDEX IF NOT EXISTS idx_wa_session_keys_updated ON wa_session_keys (session_id, updated_at)`,
        `CREATE TABLE IF NOT EXISTS wa_messages (
                session_id TEXT NOT NULL,
                msg_id TEXT NOT NULL,
                remote_jid TEXT NOT NULL,
                message TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (session_id, remote_jid, msg_id)
            )`,
        `CREATE INDEX IF NOT EXISTS idx_wa_messages_updated ON wa_messages (session_id, updated_at)`,
      ],
      'write'
    );
    schemaReady = true;
    log.info('[session-db] Majedwali "wa_sessions" + "wa_session_keys" + "wa_messages" tayari (Turso).');
    return true;
  } catch (err) {
    log.error('[session-db] Table error:', err.message);
    return false;
  }
}

async function loadCreds(sessionId) {
  return retryOperation(async () => {
    const client = getClient();
    const res = await client.execute({ sql: `SELECT state FROM wa_sessions WHERE session_id = ?`, args: [sessionId] });
    if (res.rows.length === 0) return null;
    return JSON.parse(res.rows[0].state);
  }, `loadCreds(${sessionId})`);
}

/**
 * Inaorodhesha session_id zote zilizopo kwenye Turso zenye prefix fulani
 * (mfano "pairing_" kwa ajili ya wateja wa pairing/instanceManager.js).
 * Inatumika kwenye auto-reconnect ya boot ili kupata namba ambazo tayari
 * zimehamishwa Turso hata kama folda yao ya disk haipo tena (imeshahamishwa
 * jina awali, au Railway volume mpya haina chochote).
 */
async function listSessionIds(prefix) {
  return retryOperation(async () => {
    const client = getClient();
    const res = await client.execute({
      sql: `SELECT session_id FROM wa_sessions WHERE session_id LIKE ?`,
      args: [`${prefix}%`],
    });
    return res.rows.map((r) => r.session_id);
  }, `listSessionIds(${prefix})`);
}

async function saveCredsRow(sessionId, credsData) {
  return retryOperation(async () => {
    const client = getClient();
    const serialized = JSON.stringify({ creds: credsData }, replacer);
    await client.execute({
      sql: `INSERT INTO wa_sessions (session_id, state, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE
             SET state = excluded.state, updated_at = excluded.updated_at`,
      args: [sessionId, serialized, Date.now()],
    });
  }, `saveCredsRow(${sessionId})`);
}

async function countKeys(sessionId) {
  return retryOperation(async () => {
    const client = getClient();
    const res = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM wa_session_keys WHERE session_id = ?`,
      args: [sessionId],
    });
    return Number(res.rows[0]?.n || 0);
  }, `countKeys(${sessionId})`);
}

async function getKeysByIds(sessionId, keyIds) {
  if (keyIds.length === 0) return {};
  return retryOperation(async () => {
    const client = getClient();
    const placeholders = keyIds.map(() => '?').join(', ');
    const res = await client.execute({
      sql: `SELECT key_id, value FROM wa_session_keys WHERE session_id = ? AND key_id IN (${placeholders})`,
      args: [sessionId, ...keyIds],
    });
    const found = {};
    for (const row of res.rows) {
      found[row.key_id] = reviveBuffers(JSON.parse(row.value));
    }
    return found;
  }, `getKeysByIds(${sessionId})`);
}

async function migrateLegacyKeysIfNeeded(sessionId, legacyKeys) {
  const entries = Object.entries(legacyKeys || {});
  if (entries.length === 0) return;
  log.info(`[session-db] Inahamisha keys ${entries.length} za zamani kwenda muundo mpya wa per-key...`);
  await upsertKeys(sessionId, Object.fromEntries(entries));
  log.info(`[session-db] Uhamisho wa keys umekamilika.`);
}

async function upsertKeys(sessionId, keyMap) {
  const entries = Object.entries(keyMap);
  if (entries.length === 0) return;

  for (let i = 0; i < entries.length; i += MAX_KEYS_PER_BATCH) {
    const chunk = entries.slice(i, i + MAX_KEYS_PER_BATCH);
    const now = Date.now();
    const rowsSql = [];
    const args = [];
    for (const [keyId, value] of chunk) {
      rowsSql.push('(?, ?, ?, ?)');
      args.push(sessionId, keyId, JSON.stringify(value, replacer), now);
    }
    await retryOperation(async () => {
      const client = getClient();
      await client.execute({
        sql: `INSERT INTO wa_session_keys (session_id, key_id, value, updated_at)
                 VALUES ${rowsSql.join(', ')}
                 ON CONFLICT(session_id, key_id) DO UPDATE
                 SET value = excluded.value, updated_at = excluded.updated_at`,
        args,
      });
    }, `upsertKeys(${sessionId}, batch ${i / MAX_KEYS_PER_BATCH})`);
  }
}

async function deleteKeys(sessionId, keyIds) {
  if (keyIds.length === 0) return;
  for (let i = 0; i < keyIds.length; i += MAX_KEYS_PER_BATCH) {
    const chunk = keyIds.slice(i, i + MAX_KEYS_PER_BATCH);
    await retryOperation(async () => {
      const client = getClient();
      const placeholders = chunk.map(() => '?').join(', ');
      await client.execute({
        sql: `DELETE FROM wa_session_keys WHERE session_id = ? AND key_id IN (${placeholders})`,
        args: [sessionId, ...chunk],
      });
    }, `deleteKeys(${sessionId}, batch ${i / MAX_KEYS_PER_BATCH})`);
  }
}

// ── UHAMISHO: ./session (au pairing/sessions/<phone>) KWENYE VOLUME → TURSO ──
// Baileys' useMultiFileAuthState() huandika creds.json + funguo nyingine kama
// `${category}-${id}.json` (mfano "pre-key-3.json", "session-2557...-1@s...
// .json"). Category zenyewe zina "-" ndani yake, kwa hiyo tunalinganisha na
// orodha ya majina yanayojulikana (ndefu kwanza) badala ya kugawanya kwa "-".
const KNOWN_KEY_CATEGORIES = [
  'app-state-sync-version',
  'app-state-sync-key',
  'sender-key-memory',
  'sender-key',
  'pre-key',
  'session',
];

function parseLegacyKeyFileName(fileName) {
  if (!fileName.endsWith('.json')) return null;
  const base = fileName.slice(0, -'.json'.length);
  for (const category of KNOWN_KEY_CATEGORIES) {
    if (base.startsWith(`${category}-`)) {
      return { type: category, id: base.slice(category.length + 1) };
    }
  }
  return null; // faili isiyotambulika (mfano app-state-sync-version bila id, faili potofu, n.k) — ruka salama
}

/**
 * Kama Turso HAINA session hii bado, lakini kuna folda ya zamani kwenye disk
 * (Railway volume, iliyoandikwa na useMultiFileAuthState kabla ya kuhamia
 * Turso) yenye creds.json — inahamisha creds + funguo zake ZOTE kwenda Turso
 * mara moja, kisha inabadilisha jina la folda ile (haiifuti) ili isijaribiwe
 * tena. Matokeo yake: hakuna haja ya ku-scan QR/pairing code upya baada ya
 * kubadili msimbo kutumia Turso — session ya zamani "inahamia" tu.
 *
 * Salama kuita kila boot (idempotent):
 *  - Kama Turso tayari ina creds za sessionId hii → no-op (haiandiki juu).
 *  - Kama folda ya disk haipo au haina creds.json → no-op.
 *  - Kama uhamisho umeshafanyika awali, folda tayari imebadilishwa jina
 *    (`<folder>.migrated-<timestamp>`) hivyo haitaonekana tena kwenye path
 *    ya awali.
 *
 * @param {string} sessionId - jina la session kwenye Turso (config.sessionName || 'default')
 * @param {string} diskFolder - path kamili ya folda ya zamani (mfano `${__dirname}/session`)
 * @returns {Promise<boolean>} true ikiwa uhamisho umefanyika sasa hivi
 */
async function migrateDiskSessionIfPresent(sessionId, diskFolder) {
  try {
    const credsPath = path.join(diskFolder, 'creds.json');
    if (!fs.existsSync(diskFolder) || !fs.existsSync(credsPath)) {
      return false; // hakuna session ya zamani ya kuhamisha
    }

    await initializeDatabase();

    const existing = await loadCreds(sessionId);
    if (existing) {
      log.info(
        `[session-db] Turso tayari ina session "${sessionId}" — sikuhamishi kutoka disk (${diskFolder}). ` +
        `Unaweza kuifuta folda hiyo mwenyewe ukishathibitisha bot inafanya kazi vizuri.`
      );
      return false;
    }

    log.info(`[session-db] Nimeona session ya zamani kwenye Railway volume (${diskFolder}) — ninaihamisha kwenda Turso...`);

    // 1) Creds (sehemu MUHIMU zaidi — bila hii, huwezi kuepuka kulink upya)
    const rawCreds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    await saveCredsRow(sessionId, reviveBuffers(rawCreds));

    // 2) Funguo nyingine zote (pre-key/session/sender-key/app-state-sync-*)
    const keyMap = {};
    let unrecognized = 0;
    for (const file of fs.readdirSync(diskFolder)) {
      if (file === 'creds.json') continue;
      const parsed = parseLegacyKeyFileName(file);
      if (!parsed) {
        if (file.endsWith('.json')) unrecognized++;
        continue;
      }
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(diskFolder, file), 'utf-8'));
        keyMap[`${parsed.type}--${parsed.id}`] = reviveBuffers(raw);
      } catch (e) {
        log.warn(`[session-db] Faili "${file}" haikusomeka wakati wa uhamisho, imerukwa: ${e.message}`);
      }
    }
    const keyCount = Object.keys(keyMap).length;
    if (keyCount > 0) {
      await upsertKeys(sessionId, keyMap);
    }

    // 3) Badilisha jina la folda ya zamani (si kuifuta) — salama, na inazuia
    //    uhamisho huu kujaribiwa tena boot ijayo.
    let archivedPath = null;
    try {
      archivedPath = `${diskFolder}.migrated-${Date.now()}`;
      fs.renameSync(diskFolder, archivedPath);
    } catch (e) {
      log.warn(`[session-db] Uhamisho umefanikiwa lakini kubadilisha jina la folda ya zamani kumeshindikana (si tatizo kubwa): ${e.message}`);
    }

    log.info(
      `[session-db] ✅ Session "${sessionId}" imehamishwa kutoka Railway volume kwenda Turso ` +
      `(creds + funguo ${keyCount}${unrecognized ? `, faili ${unrecognized} hazikutambulika zikarukwa` : ''}). ` +
      `Hakuna haja ya kulink upya.` +
      (archivedPath ? ` Folda ya zamani imehifadhiwa kama "${path.basename(archivedPath)}".` : '')
    );

    return true;
  } catch (err) {
    log.error(`[session-db] migrateDiskSessionIfPresent(${sessionId}, ${diskFolder}) error: ${err.message}`);
    return false; // kushindwa hapa hakuzuii bot kuendelea na normal QR/pairing flow
  }
}

async function deleteSession(sessionId) {
  return retryOperation(async () => {
    await runBatch([
      { sql: `DELETE FROM wa_sessions WHERE session_id = ?`, args: [sessionId] },
      { sql: `DELETE FROM wa_session_keys WHERE session_id = ?`, args: [sessionId] },
      { sql: `DELETE FROM wa_messages WHERE session_id = ?`, args: [sessionId] },
    ]);
    clearSessionRuntimeState(sessionId);
    log.info(`[session-db] Session ${sessionId} deleted (creds + keys + messages)`);
  }, `deleteSession(${sessionId})`);
}

async function deleteAllSessions() {
  return retryOperation(async () => {
    await runBatch([`DELETE FROM wa_sessions`, `DELETE FROM wa_session_keys`, `DELETE FROM wa_messages`]);
    for (const sessionId of [...sessionRuntimeCache.keys()]) clearSessionRuntimeState(sessionId);
    exitHandlers.clear();
    log.info(`[session-db] Sessions zote zimefutwa (creds + keys + messages).`);
  }, 'deleteAllSessions');
}

async function saveMessageForRetry(sessionId, key, message) {
  if (!key?.id || !key?.remoteJid || !message) return;
  return retryOperation(async () => {
    const client = getClient();
    const serialized = JSON.stringify(message, replacer);
    await client.execute({
      sql: `INSERT INTO wa_messages (session_id, msg_id, remote_jid, message, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id, remote_jid, msg_id) DO UPDATE
             SET message = excluded.message, updated_at = excluded.updated_at`,
      args: [sessionId, key.id, key.remoteJid, serialized, Date.now()],
    });
  }, `saveMessageForRetry(${sessionId}, ${key.id})`);
}

async function getStoredMessage(sessionId, key) {
  if (!key?.id || !key?.remoteJid) return undefined;
  return retryOperation(async () => {
    const client = getClient();
    const res = await client.execute({
      sql: `SELECT message FROM wa_messages WHERE session_id = ? AND remote_jid = ? AND msg_id = ?`,
      args: [sessionId, key.remoteJid, key.id],
    });
    if (res.rows.length === 0) return undefined;
    return reviveBuffers(JSON.parse(res.rows[0].message));
  }, `getStoredMessage(${sessionId}, ${key.id})`);
}

function startMessagePruner(sessionId) {
  const timerKey = `msgprune_${sessionId}`;
  if (!global.messagePruneTimers) global.messagePruneTimers = new Map();
  if (global.messagePruneTimers.has(timerKey)) return;

  const timer = setInterval(async () => {
    try {
      const client = getClient();
      const cutoff = Date.now() - MESSAGE_STORE_MAX_AGE_MS;
      const res = await client.execute({
        sql: `DELETE FROM wa_messages WHERE session_id = ? AND updated_at < ?`,
        args: [sessionId, cutoff],
      });
      if (res.rowsAffected > 0) {
        log.info(`[session-db] Message store pruning: ${res.rowsAffected} ujumbe wa zamani (>${MESSAGE_STORE_MAX_AGE_MS / 3600000}h) umefutwa.`);
      }
    } catch (err) {
      log.warn(`[session-db] Message store pruning error: ${err.message}`);
    }
  }, MESSAGE_PRUNE_INTERVAL_MS);

  global.messagePruneTimers.set(timerKey, timer);
}

// ── Global exit handling ─────────────────────────────────────────────────
// Sajili listener MOJA tu (si moja kwa kila session) kwa SIGINT/SIGTERM/
// beforeExit, inayopitia every session's flush function kutoka Map moja
// iliyoshirikiwa — muhimu ukiwa unaendesha session nyingi (mfano
// pairing/instanceManager.js) kwenye process moja.
async function flushAllSessionsOnExit() {
  log.info(`[session-db] Emergency save before exit (${exitHandlers.size} session(s))...`);
  const flushes = [...exitHandlers.values()].map((flushImmediate) =>
    flushImmediate().catch((err) => log.error('[session-db] Emergency save failed for one session:', err.message))
  );
  await Promise.allSettled(flushes);
  log.info('[session-db] Final save complete.');
}

function ensureGlobalExitHandlerRegistered() {
  if (globalExitHandlerRegistered) return;
  globalExitHandlerRegistered = true;
  process.once('SIGINT', flushAllSessionsOnExit);
  process.once('SIGTERM', flushAllSessionsOnExit);
  process.once('beforeExit', flushAllSessionsOnExit);
}

function registerGlobalExitHandler(sessionId, flushImmediate) {
  exitHandlers.set(sessionId, flushImmediate);
  ensureGlobalExitHandlerRegistered();
}

function unregisterGlobalExitHandler(sessionId) {
  exitHandlers.delete(sessionId);
}

function createThrottledKeyWriter(sessionId) {
  let pendingUpserts = new Map();
  let pendingDeletes = new Set();
  let timer = null;
  let lastFlushAt = 0;
  let flushing = false;
  let flushWaiters = [];

  async function doFlush() {
    if (flushing) return new Promise((resolve) => flushWaiters.push(resolve));
    if (pendingUpserts.size === 0 && pendingDeletes.size === 0) return;

    flushing = true;
    lastFlushAt = Date.now();

    const upserts = pendingUpserts;
    const deletes = pendingDeletes;
    pendingUpserts = new Map();
    pendingDeletes = new Set();

    try {
      if (upserts.size > 0) {
        await upsertKeys(sessionId, Object.fromEntries(upserts));
      }
      if (deletes.size > 0) {
        await deleteKeys(sessionId, [...deletes]);
      }
    } catch (err) {
      log.error(`[session-db] Key flush error (${sessionId}):`, err.message);
      for (const [k, v] of upserts) pendingUpserts.set(k, v);
      for (const k of deletes) pendingDeletes.add(k);
    } finally {
      flushing = false;
      const waiters = flushWaiters;
      flushWaiters = [];
      waiters.forEach((resolve) => resolve());
      if (pendingUpserts.size > 0 || pendingDeletes.size > 0) scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (timer) return;
    const elapsed = Date.now() - lastFlushAt;
    const wait = Math.max(0, FLUSH_INTERVAL_MS - elapsed);
    timer = setTimeout(() => {
      timer = null;
      doFlush();
    }, wait);
  }

  function markKeySet(keyId, value) {
    pendingDeletes.delete(keyId);
    pendingUpserts.set(keyId, value);
    scheduleFlush();
  }

  function markKeyDelete(keyId) {
    pendingUpserts.delete(keyId);
    pendingDeletes.add(keyId);
    scheduleFlush();
  }

  async function flushImmediate() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await doFlush();
  }

  return { markKeySet, markKeyDelete, flushImmediate };
}

function createThrottledCredsWriter(sessionId, getSnapshot) {
  let timer = null;
  let dirty = false;
  let lastFlushAt = 0;
  let flushing = false;
  let flushWaiters = [];

  async function doFlush() {
    if (flushing) return new Promise((resolve) => flushWaiters.push(resolve));
    if (!dirty) return;
    flushing = true;
    dirty = false;
    lastFlushAt = Date.now();
    try {
      await saveCredsRow(sessionId, getSnapshot());
    } catch (err) {
      log.error(`[session-db] Creds flush error (${sessionId}):`, err.message);
      dirty = true;
    } finally {
      flushing = false;
      const waiters = flushWaiters;
      flushWaiters = [];
      waiters.forEach((resolve) => resolve());
      if (dirty) scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (timer) return;
    const elapsed = Date.now() - lastFlushAt;
    const wait = Math.max(0, FLUSH_INTERVAL_MS - elapsed);
    timer = setTimeout(() => {
      timer = null;
      doFlush();
    }, wait);
  }

  function markDirty() {
    dirty = true;
    scheduleFlush();
  }

  async function flushImmediate() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = true;
    await doFlush();
  }

  return { markDirty, flushImmediate };
}

function startKeysStatsLogger(sessionId, keysCache) {
  const timerKey = `keystats_${sessionId}`;
  if (!global.keysStatsTimers) global.keysStatsTimers = new Map();
  if (global.keysStatsTimers.has(timerKey)) return;

  const timer = setInterval(async () => {
    try {
      const total = await countKeys(sessionId);
      const cached = keysCache.size;
      if (total >= KEYS_STATS_WARN_THRESHOLD) {
        log.warn(`[session-db] session(${sessionId}): jumla ya keys DB=${total}, zilizopakiwa RAM (lazy cache)=${cached} — fuatilia ukuaji.`);
      } else {
        log.info(`[session-db] session(${sessionId}): DB=${total} keys, RAM cache=${cached} keys`);
      }
    } catch (err) {
      log.warn(`[session-db] keysStatsLogger error: ${err.message}`);
    }
  }, KEYS_STATS_LOG_INTERVAL);

  global.keysStatsTimers.set(timerKey, timer);
}

function startPrekeyPruner(sessionId, keysCache) {
  if (!PRUNE_ENABLED) return;
  const timerKey = `prune_${sessionId}`;
  if (!global.prekeyPruneTimers) global.prekeyPruneTimers = new Map();
  if (global.prekeyPruneTimers.has(timerKey)) return;

  const timer = setInterval(async () => {
    try {
      const client = getClient();
      const cutoff = Date.now() - PRUNE_PREKEY_MAX_AGE_MS;
      // Turso/libSQL RETURNING inaweza kutokuwepo kwa toleo fulani, hivyo
      // hatutegemei kupata key_id zilizofutwa hapa — RAM cache ya funguo
      // hizo (kama zipo) itasafishwa yenyewe kwa asili kwenye reconnect
      // ijayo ya session hiyo, si tatizo la usalama wala usahihi.
      const res = await client.execute({
        sql: `DELETE FROM wa_session_keys WHERE session_id = ? AND key_id LIKE 'pre-key--%' AND updated_at < ?`,
        args: [sessionId, cutoff],
      });
      if (res.rowsAffected > 0) {
        log.info(`[session-db] Prekey pruning: ${res.rowsAffected} prekeys za zamani (>${PRUNE_PREKEY_MAX_AGE_MS / 86400000}d) zimefutwa.`);
      }
    } catch (err) {
      log.warn(`[session-db] Prekey pruning error: ${err.message}`);
    }
  }, PRUNE_INTERVAL_MS);

  global.prekeyPruneTimers.set(timerKey, timer);
}

/**
 * Inatumika badala ya `fs.writeFileSync(sessionFile, decompressedData)` wa
 * zamani kwa ajili ya "KnightBot!..." session strings — badala ya kuandika
 * creds.json kwenye disk, inaandika moja kwa moja Turso KABLA
 * useTursoAuthState() haijaitwa kwa sessionId hiyo. `decompressedJson`
 * ni Buffer/string ya JSON (matokeo ya zlib.gunzipSync kama ilivyokuwa awali).
 */
async function seedCredsFromLegacyImport(sessionId, decompressedJson) {
  const parsed = JSON.parse(decompressedJson.toString('utf8'));
  // Faili za zamani za creds.json zinaweza kuwa na muundo { creds: {...} }
  // au creds ghafi bila wrapper, kutegemea chanzo cha export — zote mbili
  // zinashughulikiwa hapa.
  const credsObj = parsed && parsed.creds ? parsed.creds : parsed;
  await saveCredsRow(sessionId, reviveBuffers(credsObj));
}

async function useTursoAuthState(sessionId) {
  let entry = sessionRuntimeCache.get(sessionId);

  if (!entry) {
    const { initAuthCreds } = getBaileys();
    const fullState = await loadCreds(sessionId);
    const creds = reviveBuffers(fullState?.creds) || initAuthCreds();

    const keysCache = new Map();

    // Legacy migration bado inahitaji ukaguzi wa mara moja tu: je session
    // hii ina funguo tayari kwenye jedwali jipya? Hii ni COUNT nyepesi, si
    // upakuaji wa data yenyewe.
    const existingKeyCount = await countKeys(sessionId);
    if (fullState?.keys && Object.keys(fullState.keys).length > 0 && existingKeyCount === 0) {
      const legacyKeys = reviveBuffers(fullState.keys);
      await migrateLegacyKeysIfNeeded(sessionId, legacyKeys);
      for (const [key, value] of Object.entries(legacyKeys)) {
        keysCache.set(key, value);
      }
    }

    const keyWriter = createThrottledKeyWriter(sessionId);
    const credsWriter = createThrottledCredsWriter(sessionId, () => entry.creds);

    entry = { creds, keysCache, keyWriter, credsWriter };
    sessionRuntimeCache.set(sessionId, entry);

    startKeysStatsLogger(sessionId, entry.keysCache);
    startPrekeyPruner(sessionId, entry.keysCache);
    startMessagePruner(sessionId);
  }

  const { creds, keysCache, keyWriter, credsWriter } = entry;

  const keyStore = {
    get: async (type, ids) => {
      const result = {};
      const missing = [];

      for (const id of ids) {
        const key = `${type}--${id}`;
        if (keysCache.has(key)) {
          const cached = keysCache.get(key);
          if (cached !== NEGATIVE) result[id] = cached;
        } else {
          missing.push({ id, key });
        }
      }

      if (missing.length > 0) {
        const fetched = await getKeysByIds(sessionId, missing.map((m) => m.key));
        for (const { id, key } of missing) {
          if (Object.prototype.hasOwnProperty.call(fetched, key)) {
            keysCache.set(key, fetched[key]);
            result[id] = fetched[key];
          } else {
            keysCache.set(key, NEGATIVE);
          }
        }
      }

      return result;
    },
    set: async (data) => {
      for (const [type, entries] of Object.entries(data)) {
        if (!entries) continue;
        for (const [id, value] of Object.entries(entries)) {
          const key = `${type}--${id}`;
          if (value == null) {
            keysCache.set(key, NEGATIVE);
            keyWriter.markKeyDelete(key);
          } else {
            keysCache.set(key, value);
            keyWriter.markKeySet(key, value);
          }
        }
      }
    },
  };

  const { makeCacheableSignalKeyStore } = getBaileys();
  const keys = makeCacheableSignalKeyStore(keyStore, logger);

  const saveCreds = async (update) => {
    const wasRegistered = !!creds.registered;

    if (update && typeof update === 'object') {
      Object.assign(creds, update);
    }
    credsWriter.markDirty();

    if (!wasRegistered && creds.registered) {
      try {
        await credsWriter.flushImmediate();
        log.info(`[session-db] Pairing imekamilika — imehifadhiwa papo hapo (${sessionId}).`);
      } catch (err) {
        log.error('[session-db] Immediate pairing-save error:', err.message);
      }
    }
  };

  const refreshTimerKey = `refresh_${sessionId}`;
  if (!global.credRefreshTimers) {
    global.credRefreshTimers = new Map();
  }
  if (!global.credRefreshTimers.has(refreshTimerKey)) {
    const timer = setInterval(async () => {
      try {
        log.info('[session-db] Refreshing credentials (scheduled refresh)...');
        await credsWriter.flushImmediate();
        log.info('[session-db] Credentials refreshed');
      } catch (err) {
        log.error('[session-db] Credential refresh error:', err.message);
      }
    }, CREDS_REFRESH_INTERVAL);
    global.credRefreshTimers.set(refreshTimerKey, timer);
  }

  registerGlobalExitHandler(sessionId, async () => {
    await Promise.allSettled([credsWriter.flushImmediate(), keyWriter.flushImmediate()]);
  });

  const dispose = async () => {
    await Promise.allSettled([credsWriter.flushImmediate(), keyWriter.flushImmediate()]);
  };

  return { state: { creds, keys }, saveCreds, dispose };
}

module.exports = {
  initializeDatabase,
  useTursoAuthState,
  deleteSession,
  deleteAllSessions,
  saveMessageForRetry,
  getStoredMessage,
  seedCredsFromLegacyImport,
  migrateDiskSessionIfPresent,
  loadCreds,
  listSessionIds,
};
