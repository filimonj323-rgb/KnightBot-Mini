/**
 * JSON-based Database for Group Settings — sasa ikiwa na "backing store" ya
 * kudumu (Turso/libSQL, database ile ile inayotumika na session-db.js kwa
 * ajili ya session), ili database/*.json (antilink, antitag, warnings,
 * moderators, n.k.) HAIPOTEI bot inaporedeploy kwenye hosting yenye disk
 * inayofutika (Railway/Render/Heroku bila volume).
 *
 * MUUNDO: kila function ya nje (getGroupSettings, updateGroupSettings, n.k.)
 * INABAKI SYNCHRONOUS kama awali — hakuna faili lingine lililoita database.js
 * linalohitajika kubadilishwa. Turso inatumika "chinichini" tu:
 *   1) initializeDatabase() (async) inaitwa MARA MOJA wakati bot inapoanza
 *      (index.js) — inasoma blob za mwisho kutoka Turso na kuandika juu ya
 *      faili za JSON za ndani KABLA ya command yoyote kuanza kusoma.
 *   2) Kila writeDB() bado inaandika faili la ndani MARA MOJA (kama awali,
 *      hivyo hakuna ucheleweshaji), KISHA inatuma nakala kwenda Turso
 *      "fire-and-forget" (bila kusubiri) ili isilambe commands.
 * Ikiwa TURSO_DATABASE_URL/TURSO_AUTH_TOKEN havijawekwa, kila kitu
 * kinaendelea kufanya kazi kama awali (faili za JSON za ndani pekee) —
 * hakuna crash, ni "best effort" tu.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { AsyncLocalStorage } = require('async_hooks');
const { getClient } = require('./lib/db');
const { createLogger } = require('./lib/logger');

const log = createLogger('database');

const DB_PATH = path.join(__dirname, 'database');
const GROUPS_DB = path.join(DB_PATH, 'groups.json');
const USERS_DB = path.join(DB_PATH, 'users.json');
const WARNINGS_DB = path.join(DB_PATH, 'warnings.json');
const MODS_DB = path.join(DB_PATH, 'mods.json');

// Ramani kutoka path la faili la ndani → "store_key" kwenye Turso.
const STORE_KEYS = {
  [GROUPS_DB]: 'groups',
  [USERS_DB]: 'users',
  [WARNINGS_DB]: 'warnings',
  [MODS_DB]: 'mods',
};

// Initialize database directory
if (!fs.existsSync(DB_PATH)) {
  fs.mkdirSync(DB_PATH, { recursive: true });
}

// Initialize database files
const initDB = (filePath, defaultData = {}) => {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultData, null, 2));
  }
};

initDB(GROUPS_DB, {});
initDB(USERS_DB, {});
initDB(WARNINGS_DB, {});
initDB(MODS_DB, { moderators: [] });

// ── TURSO BACKING STORE ─────────────────────────────────────────────────
let tursoSchemaReady = false;
let tursoAvailable = true; // inageuka false ikiwa env vars hazipo, ili tusijaribu tena kila wakati

async function ensureTursoSchema() {
  if (tursoSchemaReady || !tursoAvailable) return tursoSchemaReady;
  try {
    const client = getClient();
    await client.execute(`CREATE TABLE IF NOT EXISTS kb_data_store (
      store_key TEXT PRIMARY KEY,
      json_data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    tursoSchemaReady = true;
  } catch (err) {
    tursoAvailable = false;
    log.warn(`[database] Turso haipatikani (${err.message}) — kutumia faili za ndani pekee, bila kudumu baada ya redeploy.`);
  }
  return tursoSchemaReady;
}

/**
 * Inaitwa MARA MOJA wakati bot inapoanza (index.js). Inavuta blob ya mwisho
 * ya kila store kutoka Turso na kuandika juu ya faili ya ndani husika —
 * hii ndiyo inayorudisha mipangilio ya group baada ya redeploy kufuta disk.
 */
async function initializeDatabase() {
  const ready = await ensureTursoSchema();
  if (!ready) return false;
  try {
    const client = getClient();
    for (const [filePath, storeKey] of Object.entries(STORE_KEYS)) {
      const res = await client.execute({
        sql: `SELECT json_data FROM kb_data_store WHERE store_key = ?`,
        args: [storeKey],
      });
      if (res.rows.length > 0) {
        const remoteData = JSON.parse(res.rows[0].json_data);
        fs.writeFileSync(filePath, JSON.stringify(remoteData, null, 2));
      }
    }
    log.info('[database] Mipangilio ya group/user/warnings/mods imerejeshwa kutoka Turso.');
    return true;
  } catch (err) {
    log.warn(`[database] Imeshindwa kuvuta data kutoka Turso, kuendelea na faili za ndani: ${err.message}`);
    return false;
  }
}

/** Fire-and-forget: haisubiriwi (await) popote inapoitwa, ili isicheleweshe commands. */
function persistToTursoAsync(filePath, data) {
  const storeKey = STORE_KEYS[filePath];
  if (!storeKey || !tursoAvailable) return;
  (async () => {
    const ready = await ensureTursoSchema();
    if (!ready) return;
    try {
      const client = getClient();
      await client.execute({
        sql: `INSERT INTO kb_data_store (store_key, json_data, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(store_key) DO UPDATE SET json_data = excluded.json_data, updated_at = excluded.updated_at`,
        args: [storeKey, JSON.stringify(data), Date.now()],
      });
    } catch (err) {
      log.warn(`[database] Imeshindwa kuhifadhi "${storeKey}" kwenye Turso: ${err.message}`);
    }
  })();
}

// Read database
const readDB = (filePath) => {
  try {
    const data = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading database: ${error.message}`);
    return {};
  }
};

// Write database
const writeDB = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    persistToTursoAsync(filePath, data);
    return true;
  } catch (error) {
    console.error(`Error writing database: ${error.message}`);
    return false;
  }
};

// Owner scoping — lets multiple bot instances (the main bot + every
// pairing/instanceManager.js customer) share this same JSON store without
// one customer's group toggle (antipromo/antilink/n.k) leaking onto another
// customer's bot that also happens to be a member of the same physical
// WhatsApp group. A groupId is globally unique, but it is NOT unique to one
// owner — two different linked numbers can both be in the same group.
//
// runWithOwnerScope(ownerId, fn) marks every getGroupSettings/
// updateGroupSettings call made (directly or via any command it triggers)
// during fn's execution as belonging to `ownerId`. Using AsyncLocalStorage
// (not a plain module variable) keeps this correct even when several
// customers' messages are being handled concurrently.
//
// Passing ownerId=null (or never calling runWithOwnerScope at all — e.g. the
// main bot in index.js) keeps the ORIGINAL unscoped groupId key, so existing
// data for the main bot is untouched. Only pairing/instanceManager.js passes
// a real ownerId (the customer's phone number), which is what actually fixes
// the cross-customer leak.
const ownerScopeStorage = new AsyncLocalStorage();

const runWithOwnerScope = (ownerId, fn) => ownerScopeStorage.run(ownerId || null, fn);

const scopedGroupKey = (groupId) => {
  const owner = ownerScopeStorage.getStore();
  return owner ? `${owner}::${groupId}` : groupId;
};

// Group Settings
const getGroupSettings = (groupId) => {
  const key = scopedGroupKey(groupId);
  const groups = readDB(GROUPS_DB);
  if (!groups[key]) {
    groups[key] = { ...config.defaultGroupSettings };
    writeDB(GROUPS_DB, groups);
  }
  return groups[key];
};

const updateGroupSettings = (groupId, settings) => {
  const key = scopedGroupKey(groupId);
  const groups = readDB(GROUPS_DB);
  groups[key] = { ...groups[key], ...settings };
  return writeDB(GROUPS_DB, groups);
};

// User Data
const getUser = (userId) => {
  const users = readDB(USERS_DB);
  if (!users[userId]) {
    users[userId] = {
      registered: Date.now(),
      premium: false,
      banned: false
    };
    writeDB(USERS_DB, users);
  }
  return users[userId];
};

const updateUser = (userId, data) => {
  const users = readDB(USERS_DB);
  users[userId] = { ...users[userId], ...data };
  return writeDB(USERS_DB, users);
};

// Warnings System
const getWarnings = (groupId, userId) => {
  const warnings = readDB(WARNINGS_DB);
  const key = `${groupId}_${userId}`;
  return warnings[key] || { count: 0, warnings: [] };
};

const addWarning = (groupId, userId, reason) => {
  const warnings = readDB(WARNINGS_DB);
  const key = `${groupId}_${userId}`;
  
  if (!warnings[key]) {
    warnings[key] = { count: 0, warnings: [] };
  }
  
  warnings[key].count++;
  warnings[key].warnings.push({
    reason,
    date: Date.now()
  });
  
  writeDB(WARNINGS_DB, warnings);
  return warnings[key];
};

const removeWarning = (groupId, userId) => {
  const warnings = readDB(WARNINGS_DB);
  const key = `${groupId}_${userId}`;
  
  if (warnings[key] && warnings[key].count > 0) {
    warnings[key].count--;
    warnings[key].warnings.pop();
    writeDB(WARNINGS_DB, warnings);
    return true;
  }
  return false;
};

const clearWarnings = (groupId, userId) => {
  const warnings = readDB(WARNINGS_DB);
  const key = `${groupId}_${userId}`;
  delete warnings[key];
  return writeDB(WARNINGS_DB, warnings);
};

// Moderators System
const getModerators = () => {
  const mods = readDB(MODS_DB);
  return mods.moderators || [];
};

const addModerator = (userId) => {
  const mods = readDB(MODS_DB);
  if (!mods.moderators) mods.moderators = [];
  if (!mods.moderators.includes(userId)) {
    mods.moderators.push(userId);
    return writeDB(MODS_DB, mods);
  }
  return false;
};

const removeModerator = (userId) => {
  const mods = readDB(MODS_DB);
  if (mods.moderators) {
    mods.moderators = mods.moderators.filter(id => id !== userId);
    return writeDB(MODS_DB, mods);
  }
  return false;
};

const isModerator = (userId) => {
  const mods = getModerators();
  return mods.includes(userId);
};

module.exports = {
  initializeDatabase,
  getGroupSettings,
  updateGroupSettings,
  runWithOwnerScope,
  getUser,
  updateUser,
  getWarnings,
  addWarning,
  removeWarning,
  clearWarnings,
  getModerators,
  addModerator,
  removeModerator,
  isModerator
};
