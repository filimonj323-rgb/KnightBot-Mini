/**
 * pairing/envSync.js
 *
 * Inahifadhi (backup) env vars za Railway ndani ya Turso, na kuzirudisha
 * kiotomatiki pale zinapokosekana (mfano ukihamia account mpya ya Railway).
 *
 * UGUNDUZI WA KIOTOMATIKI: env var YOYOTE mpya unayoweka Railway
 * (jina la HERUFI KUBWA, mfano ABLINER_API_KEY) inahifadhiwa yenyewe — HAKUNA
 * haja ya kuhariri code. Zinazorukwa ni za mfumo tu (PATH, PORT, RAILWAY_*,
 * NODE_*, *_PATH n.k.) na siri-msingi (TURSO_*, TOKENVAULT_KEY,
 * ADMIN_SESSION_SECRET) ambazo haziwezi kuhifadhiwa Turso kwa sababu
 * zinahitajika KUFIKIA/KUFUNGUA Turso yenyewe. Hizo zinapatikana kwenye export.
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

// Zinazorukwa (haziingii Turso wala export ya kawaida):
//  - mfumo/build: PATH, PORT, RAILWAY_*, NODE_*, NIXPACKS_*, PUPPETEER_*, n.k.
//  - zinazoelekeza path za container: *_PATH, *_DIR, *_HOME, *_ROOT
//  - siri-msingi: TURSO_* (zinahitajika kufikia Turso kwanza), TOKENVAULT_KEY,
//    ADMIN_SESSION_SECRET (ndiyo key ya kusimba nakala — isingeweza kujirudisha yenyewe)
const NEVER_EXACT = new Set([
  'PATH', 'HOME', 'PWD', 'OLDPWD', 'SHLVL', 'HOSTNAME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'TERM', 'TMP', 'TEMP', 'TMPDIR', 'PORT', 'CI', 'DEBIAN_FRONTEND',
  'LD_LIBRARY_PATH', 'ENV_SYNC_DELETE', 'TOKENVAULT_KEY', 'ADMIN_SESSION_SECRET',
]);
const NEVER_PREFIXES = [
  'RAILWAY_', 'RAILPACK_', 'NIXPACKS_', 'NIX_', 'NODE_', 'NPM_', 'YARN_', 'PNPM_', 'BUN_', 'MISE_',
  'PUPPETEER_', 'PLAYWRIGHT_', 'LC_', 'XDG_', 'KUBERNETES_', 'TURSO_',
];
const NEVER_SUFFIXES = ['_PATH', '_DIR', '_HOME', '_ROOT'];
const MAX_VALUE_LEN = 20000;
const SYNC_TIMEOUT_MS = 10000;

function isSyncable(name) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return false; // herufi kubwa tu (inaruka npm_*, _, n.k.)
  if (NEVER_EXACT.has(name)) return false;
  if (NEVER_PREFIXES.some((p) => name.startsWith(p))) return false;
  if (NEVER_SUFFIXES.some((x) => name.endsWith(x))) return false;
  return true;
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
    if (value === undefined || value === '' || String(value).length > MAX_VALUE_LEN) continue;

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
    if (!isSyncable(name)) continue;
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

// ── Export kwa mikono (Admin → "Pakua env vars") ─────────────────────────
// Inajumuisha env zote za envSync PAMOJA na zile zisizohifadhiwa Turso kwa
// makusudi (TOKENVAULT_KEY, ADMIN_SESSION_SECRET, TURSO_*), ili uweze kuzibandika kwenye Railway
// (Variables → Raw Editor) ya account mpya. Faili hili lina SIRI — usiliweke
// GitHub (hata private) wala usilishiriki.
const EXPORT_EXTRA = ['TOKENVAULT_KEY', 'ADMIN_SESSION_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'];

function quoteEnvValue(v) {
  const s = String(v);
  if (/^[A-Za-z0-9_@%+=:,.\/-]*$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n') + '"';
}

function exportEnvText(env = process.env) {
  const names = Object.keys(env)
    .filter((n) => env[n] !== undefined && env[n] !== '' && (isSyncable(n) || EXPORT_EXTRA.includes(n)))
    .sort();
  const lines = [
    '# Railway env vars — imetengenezwa ' + new Date().toISOString(),
    '# SIRI: usiweke GitHub wala usishiriki. Bandika kwenye Railway → Variables → Raw Editor.',
    '',
    ...names.map((n) => `${n}=${quoteEnvValue(env[n])}`),
    '',
  ];
  return { text: lines.join('\n'), names, missing: ['TOKENVAULT_KEY', 'ADMIN_SESSION_SECRET'].filter((n) => !env[n]) };
}

module.exports = { syncEnv, runSync, isSyncable, encrypt, decrypt, exportEnvText };
