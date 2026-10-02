/**
 * pairing/envSync.js
 *
 * Inahifadhi (backup) env vars za Railway ndani ya Turso, na kuzirudisha
 * kiotomatiki pale zinapokosekana (mfano ukihamia account mpya ya Railway).
 *
 * Inafanya kazi KILA bot inapoanza (kupitia start.js, kabla ya index.js):
 *   1) Env var ipo kwenye Railway  -> inahifadhiwa Turso (inasasishwa ikibadilika).
 *   2) Env var HAIPO kwenye Railway lakini ipo Turso -> inarudishwa kwenye process.env.
 * Railway INASHINDA daima ikiwa env var ipo pande zote mbili.
 *
 * Thamani zinafichwa (AES-256-GCM) kabla ya kuingia Turso, kwa kutumia key
 * inayotokana na ADMIN_SESSION_SECRET ya pairingConfig.js — kwa hiyo mtu
 * anayeona database peke yake haoni funguo. TAHADHARI: ukibadilisha
 * ADMIN_SESSION_SECRET, nakala zilizohifadhiwa hazitasomeka tena (zitaandikwa
 * upya kutoka Railway kwenye boot inayofuata kama zipo huko).
 *
 * KUFUTA env var kabisa: ondoa kwenye Railway, kisha weka kwa boot MOJA tu
 *   ENV_SYNC_DELETE=JINA1,JINA2
 * Itafutwa Turso. Baada ya boot hiyo, ondoa ENV_SYNC_DELETE.
 *
 * Haivurugi startup kamwe: Turso ikikwama, bot inaendelea na env ilizonazo.
 * Majina tu ndiyo yanaandikwa kwenye logs, kamwe thamani.
 */

const crypto = require('crypto');
const cfg = require('./pairingConfig');

// Env vars za "mipangilio/siri" tu — si za mfumo (PORT, NODE_ENV, TMP, n.k.)
// wala TURSO_* (hizo zinahitajika ili kufikia Turso kwanza).
const EXACT_KEYS = new Set([
  'GROQ_API_KEY', 'GROQ_MODEL', 'TAVILY_API_KEY', 'RAPIDAPI_KEY',
  'REMINDER_SECRET', 'BACKUP_SECRET', 'BACKUP_RECIPIENT',
  'PAIR_NUMBER', 'BOT_NAME', 'ALLOWED_ORIGIN', 'FAMILY_SITE_URL',
  'UPDATE_ZIP_URL', 'CUSTOM_PAIRING_CODE',
]);
const PREFIXES = [
  'AUTO_TRADE_', 'DERIV_', 'POCKET_', 'TWELVE_DATA_', 'MANSA_',
  'NEWS_', 'FOREX_', 'PREDICTIONS_', 'MESSAGE_STORE_', 'SESSION_',
];
const SYNC_TIMEOUT_MS = 10000;

function isSyncable(name) {
  return EXACT_KEYS.has(name) || PREFIXES.some((p) => name.startsWith(p));
}

function deriveKey() {
  return crypto.scryptSync(String(cfg.ADMIN_SESSION_SECRET || 'knightbot'), 'knightbot-env-sync-v1', 32);
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(blob) {
  const [ver, ivHex, tagHex, encHex] = String(blob).split(':');
  if (ver !== 'v1') throw new Error('muundo usiojulikana');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
}

/**
 * @param {object} opts
 * @param {Function} [opts.query]  async (sql, args) => ({ rows, rowsAffected }) — default: pairing/db.js
 * @param {object}   [opts.env]    default: process.env
 */
async function runSync({ query, env = process.env } = {}) {
  if (!query) query = require('./db').query;

  await query(
    `CREATE TABLE IF NOT EXISTS app_secrets (
       name      TEXT PRIMARY KEY,
       value     TEXT NOT NULL,
       updatedAt INTEGER NOT NULL
     )`
  );

  const stored = new Map();
  const res = await query('SELECT name, value FROM app_secrets');
  for (const row of res.rows) stored.set(row.name, row.value);

  const saved = [];
  const restored = [];
  const deleted = [];

  // 0) Ufutaji ulioombwa wazi (ENV_SYNC_DELETE) — usirudishe tena.
  const toDelete = new Set(
    String(env.ENV_SYNC_DELETE || '').split(',').map((s) => s.trim()).filter(Boolean)
  );
  for (const name of toDelete) {
    if (stored.has(name)) {
      await query('DELETE FROM app_secrets WHERE name = ?', [name]);
      stored.delete(name);
      deleted.push(name);
    }
  }

  // 1) Railway -> Turso (andika tu kama imebadilika, kulinda kikomo cha writes za Turso).
  for (const name of Object.keys(env)) {
    if (!isSyncable(name) || toDelete.has(name)) continue;
    const value = env[name];
    if (value === undefined || value === '') continue;

    let unchanged = false;
    if (stored.has(name)) {
      try { unchanged = decrypt(stored.get(name)) === value; } catch (e) { unchanged = false; }
    }
    if (unchanged) continue;

    await query(
      'INSERT INTO app_secrets (name, value, updatedAt) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt',
      [name, encrypt(value), Date.now()]
    );
    saved.push(name);
  }

  // 2) Turso -> process.env (kwa zile zisizopo kwenye Railway)
  for (const [name, blob] of stored.entries()) {
    if (env[name] !== undefined && env[name] !== '') continue;
    try {
      env[name] = decrypt(blob);
      restored.push(name);
    } catch (e) {
      console.warn(`[envSync] ${name}: imeshindwa kufungua (ADMIN_SESSION_SECRET imebadilika?) — imerukwa.`);
    }
  }

  return { saved, restored, deleted };
}

/** Haitupi error kamwe — startup lazima iendelee hata Turso ikikwama. */
async function syncEnv(opts = {}) {
  let timer;
  try {
    const result = await Promise.race([
      runSync(opts),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), SYNC_TIMEOUT_MS); }),
    ]);
    console.log(
      `[envSync] imehifadhiwa Turso: ${result.saved.join(', ') || '-'} | imerudishwa kutoka Turso: ${result.restored.join(', ') || '-'}` +
      (result.deleted.length ? ` | imefutwa: ${result.deleted.join(', ')}` : '')
    );
    return result;
  } catch (e) {
    console.error('[envSync] imeshindwa (bot inaendelea na env zilizopo):', e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { syncEnv, runSync, isSyncable, encrypt, decrypt };
