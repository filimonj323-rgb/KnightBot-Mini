/**
 * derivAccounts.js — Akaunti ya Deriv ya KILA mteja wa pairing bot (DEMO tu kwa sasa).
 *
 * Hatua (a): hifadhi salama ya token + PIN + swichi + vikomo + maamuzi ya admin.
 * HAIFUNGUI trades — inatoa `canTrade()` / `getTokenForTrading()` ambazo hatua zinazofuata
 * (derivSession, commands, auto-trade) zitazitumia kama lango LA PEKEE.
 *
 * Mfumo wa ruhusa (zote lazima ziwe kweli ili trade ifunguliwe — fail-closed):
 *   token imehifadhiwa + status 'active' + akaunti ni DEMO (au admin ametoa realAllowed)
 *   + admin amemuidhinisha (adminApproved) + mteja amewasha (userEnabled)
 *   + kill switch ya wote haijawashwa.
 * Auto-trade: pamoja na hapo, autoApproved (admin) + autoEnabled (mteja).
 *
 * Mteja anaweza KUZIMA (userEnabled/autoEnabled) au kuondoa token wakati wowote bila PIN.
 * KUWASHA, kuweka token na kubadilisha PIN kunahitaji PIN.
 *
 * Mtindo: makosa ya mtumiaji yanatupwa kama DerivAccountError (userMessage), makosa ya
 * DB/usimbaji yanapita juu bila kuvujisha siri. Token HAIANDIKWI kwenye log.
 */

const db = require('../pairing/db');
const vault = require('./derivCrypto');
const pins = require('./derivPin');
const { validateToken, DerivValidationError } = require('./derivValidate');

class DerivAccountError extends Error {
  constructor(userMessage, code, extra) {
    super(userMessage);
    this.userMessage = userMessage;
    this.code = code || 'ERROR';
    Object.assign(this, extra || {});
  }
}

// Vikomo vigumu (dari ya juu kabisa ambayo admin anaweza kuweka kwa mteja). Env zinaweza kuvipunguza/kuvipandisha.
const CEILING = {
  maxStake: Number(process.env.DERIV_CUSTOMER_MAX_STAKE_CEIL || 20),
  maxTradesDay: Number(process.env.DERIV_CUSTOMER_MAX_TRADES_DAY_CEIL || 20),
  maxDailyLoss: Number(process.env.DERIV_CUSTOMER_MAX_DAILY_LOSS_CEIL || 50),
  maxOpen: Number(process.env.DERIV_CUSTOMER_MAX_OPEN_CEIL || 5),
};

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const KILL_KEY = 'derivKillAll';

// ── Rate limit ndogo (in-memory) kwa routes za dashboard ──────────────────────────────
const rl = new Map();
function rateLimit(key, max = 12, windowMs = 60 * 1000) {
  const now = Date.now();
  const arr = (rl.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    rl.set(key, arr);
    throw new DerivAccountError('Maombi mengi mno. Subiri dakika moja kisha jaribu tena.', 'RATE_LIMIT');
  }
  arr.push(now);
  rl.set(key, arr);
  if (rl.size > 5000) for (const [k, v] of rl) if (!v.some((t) => now - t < windowMs)) rl.delete(k);
}

// ── Kill switch ya wateja WOTE (fx_auto_settings, ufunguo 'derivKillAll') ────────────
let killCache = { at: 0, v: true }; // v:true mwanzoni = fail-closed hadi DB isomwe
async function getKillAll(force = false) {
  if (!force && Date.now() - killCache.at < 3000) return killCache.v;
  try {
    const r = await db.query('SELECT settingValue FROM fx_auto_settings WHERE settingKey = ?', [KILL_KEY]);
    killCache = { at: Date.now(), v: r.rows.length ? String(r.rows[0].settingValue) === '1' : false };
  } catch (err) {
    console.error('[derivAccounts] Imeshindwa kusoma kill switch (nafunga kwa usalama):', err.message);
    killCache = { at: Date.now() - 2000, v: true }; // jaribu tena baada ya ~1s
  }
  return killCache.v;
}
async function setKillAll(on) {
  await db.query(
    `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
    [KILL_KEY, on ? '1' : '0', Date.now()]
  );
  killCache = { at: Date.now(), v: !!on };
  return !!on;
}

// ── Mwonekano wa umma wa safu (KAMWE hauna encToken/pinHash) ───────────────────────────
function maskId(id) {
  const s = String(id || '');
  return s.length > 4 ? `${s.slice(0, 4)}•••${s.slice(-2)}` : s;
}
function toPublic(row) {
  if (!row) return null;
  const now = Date.now();
  return {
    phoneNumber: row.phoneNumber,
    hasPin: !!row.pinHash,
    mustChangePin: !!row.mustChangePin,
    pinLockedUntil: row.pinLockedUntil && row.pinLockedUntil > now ? Number(row.pinLockedUntil) : null,
    connected: !!row.encToken,
    accountIdMasked: row.accountId ? maskId(row.accountId) : null,
    isDemo: !!row.isDemo,
    currency: row.currency || null,
    tokenHint: row.tokenHint || null,
    status: row.status || 'none',
    adminApproved: !!row.adminApproved,
    autoApproved: !!row.autoApproved,
    realAllowed: !!row.realAllowed,
    userEnabled: !!row.userEnabled,
    autoEnabled: !!row.autoEnabled,
    limits: {
      maxStake: Number(row.maxStake),
      maxTradesDay: Number(row.maxTradesDay),
      maxDailyLoss: Number(row.maxDailyLoss),
      maxOpen: Number(row.maxOpen),
    },
    lastError: row.lastError || null,
    connectedAt: row.connectedAt ? Number(row.connectedAt) : null,
    updatedAt: row.updatedAt ? Number(row.updatedAt) : null,
  };
}

async function getRow(phone) {
  const r = await db.query('SELECT * FROM deriv_accounts WHERE phoneNumber = ?', [String(phone)]);
  return r.rows[0] || null;
}
async function ensureRow(phone) {
  await db.query('INSERT OR IGNORE INTO deriv_accounts (phoneNumber, updatedAt) VALUES (?, ?)', [String(phone), Date.now()]);
  return getRow(phone);
}
async function touch(phone, sets, args = []) {
  await db.query(`UPDATE deriv_accounts SET ${sets}, updatedAt = ? WHERE phoneNumber = ?`, [...args, Date.now(), String(phone)]);
}

async function getPublic(phone) {
  const row = await getRow(phone);
  const pub = toPublic(row) || toPublic({ phoneNumber: String(phone), isDemo: 1, status: 'none', maxStake: 5, maxTradesDay: 5, maxDailyLoss: 10, maxOpen: 2 });
  pub.killAll = await getKillAll();
  pub.vaultReady = vault.isConfigured();
  return pub;
}

// ── PIN: uthibitisho na lockout ──────────────────────────────────────────────────────
async function checkPin(phone, pin) {
  const row = await getRow(phone);
  if (!row || !row.pinHash) throw new DerivAccountError('Hujaweka PIN bado. Weka PIN kwanza.', 'NO_PIN');
  const now = Date.now();
  if (row.pinLockedUntil && row.pinLockedUntil > now) {
    const mins = Math.ceil((row.pinLockedUntil - now) / 60000);
    throw new DerivAccountError(`PIN imefungwa kwa muda kwa sababu ya majaribio mengi. Jaribu tena baada ya dakika ${mins}, au mwombe msimamizi akurejeshee.`, 'PIN_LOCKED');
  }
  const ok = await pins.verifyPinHash(pin, row.pinHash);
  if (ok) {
    if (row.pinFails || row.pinLockedUntil) await touch(phone, 'pinFails = 0, pinLockedUntil = NULL');
    return row;
  }
  const fails = Number(row.pinFails || 0) + 1;
  if (fails >= PIN_MAX_FAILS) {
    await touch(phone, 'pinFails = 0, pinLockedUntil = ?', [now + PIN_LOCK_MS]);
    throw new DerivAccountError(`PIN si sahihi mara ${PIN_MAX_FAILS}. Imefungwa dakika ${PIN_LOCK_MS / 60000}.`, 'PIN_LOCKED');
  }
  await touch(phone, 'pinFails = ?', [fails]);
  throw new DerivAccountError(`PIN si sahihi. Umebakiwa na majaribio ${PIN_MAX_FAILS - fails}.`, 'PIN_WRONG');
}

/** Kuweka PIN ya kwanza (oldPin haihitajiki) au kubadilisha (oldPin inahitajika; pia baada ya admin reset). */
async function setPin(phone, newPin, oldPin) {
  const bad = pins.formatError(newPin);
  if (bad) throw new DerivAccountError(bad, 'PIN_FORMAT');
  if (!vault.isConfigured()) throw new DerivAccountError('Huduma ya Deriv bado haijawashwa na msimamizi (ufunguo wa usalama haupo).', 'VAULT_OFF');
  const row = await ensureRow(phone);
  if (row.pinHash) {
    await checkPin(phone, oldPin);
    if (String(oldPin) === String(newPin)) throw new DerivAccountError('PIN mpya lazima ipishane na ya zamani.', 'PIN_SAME');
  }
  await touch(phone, 'pinHash = ?, mustChangePin = 0, pinFails = 0, pinLockedUntil = NULL', [await pins.hashPin(newPin)]);
  return getPublic(phone);
}

function needReady(row) {
  if (!row || !row.pinHash) throw new DerivAccountError('Weka PIN kwanza.', 'NO_PIN');
  if (row.mustChangePin) throw new DerivAccountError('Msimamizi amekurejeshea PIN ya muda. Ibadilishe kwanza kuwa PIN yako mwenyewe.', 'MUST_CHANGE_PIN');
}

// ── Kuunganisha / kuondoa token ──────────────────────────────────────────────────────
async function connect(phone, token, pin) {
  if (!vault.isConfigured()) throw new DerivAccountError('Huduma ya Deriv bado haijawashwa na msimamizi (ufunguo wa usalama haupo).', 'VAULT_OFF');
  const row0 = await getRow(phone);
  needReady(row0);
  await checkPin(phone, pin);

  let info;
  try {
    info = await validateToken(token, { allowReal: !!row0.realAllowed });
  } catch (err) {
    if (err instanceof DerivValidationError) {
      await touch(phone, 'lastError = ?', [err.userMessage]).catch(() => {});
      throw new DerivAccountError(err.userMessage, err.code);
    }
    throw err;
  }

  const enc = vault.encrypt(String(token).trim(), String(phone)); // inatupa kama ufunguo hakuna — kabla ya kuandika chochote
  const sameAccount = row0.accountId && row0.accountId === info.accountId;
  // Akaunti mpya/tofauti = uidhinishaji upya wa admin + swichi zote zianze zimezimwa.
  await touch(
    phone,
    `encToken = ?, tokenHint = ?, accountId = ?, isDemo = ?, currency = ?, status = 'active', lastError = NULL, connectedAt = ?,
     userEnabled = 0, autoEnabled = 0` + (sameAccount ? '' : ', adminApproved = 0, autoApproved = 0'),
    [enc, vault.hint(token), info.accountId, info.isDemo ? 1 : 0, info.currency, Date.now()]
  );
  return { account: await getPublic(phone), balance: info.balance };
}

/** Bila PIN — mteja anaweza kuondoa token yake wakati wowote. */
async function disconnect(phone) {
  await ensureRow(phone);
  await touch(
    phone,
    `encToken = NULL, tokenHint = NULL, accountId = NULL, currency = NULL, status = 'none', lastError = NULL, connectedAt = NULL,
     userEnabled = 0, autoEnabled = 0, adminApproved = 0, autoApproved = 0`
  );
  return getPublic(phone);
}

/** Kuzima: bila PIN. Kuwasha: PIN + masharti. */
async function setSwitches(phone, { userEnabled, autoEnabled, pin } = {}) {
  const row = await getRow(phone);
  const turningOn = userEnabled === true || autoEnabled === true;
  // Kuzima kunafanikiwa DAIMA (hata bila akaunti — ni kusimamisha tu); kuwasha kunahitaji akaunti.
  if (turningOn && (!row || !row.encToken)) throw new DerivAccountError('Unganisha akaunti ya Deriv kwanza.', 'NOT_CONNECTED');
  if (!row) return getPublic(phone);
  if (turningOn) {
    needReady(row);
    await checkPin(phone, pin);
    if (row.status !== 'active') throw new DerivAccountError('Akaunti yako ya Deriv haifanyi kazi (token ina tatizo). Iunganishe upya.', 'NOT_ACTIVE');
    if (await getKillAll()) throw new DerivAccountError('Trading imesimamishwa kwa muda na msimamizi.', 'KILLED');
    if (!row.adminApproved) throw new DerivAccountError('Msimamizi bado hajakuruhusu kutrade. Mwombe akuidhinishe.', 'NOT_APPROVED');
    if (autoEnabled === true && !row.autoApproved) throw new DerivAccountError('Msimamizi bado hajakuruhusu auto-trade kwako.', 'AUTO_NOT_APPROVED');
    if (autoEnabled === true && !row.userEnabled && userEnabled !== true) {
      throw new DerivAccountError('Washa trading kwanza kabla ya auto-trade.', 'ENABLE_TRADING_FIRST');
    }
  }

  const sets = [];
  const args = [];
  if (typeof userEnabled === 'boolean') {
    sets.push('userEnabled = ?');
    args.push(userEnabled ? 1 : 0);
    if (!userEnabled) sets.push('autoEnabled = 0'); // trading ikizimwa, auto inazimwa pia
  }
  if (typeof autoEnabled === 'boolean') {
    sets.push('autoEnabled = ?');
    args.push(autoEnabled ? 1 : 0);
  }
  if (sets.length) await touch(phone, sets.join(', '), args);
  return getPublic(phone);
}

// ── Lango la trading (litatumika na hatua zinazofuata) ───────────────────────────────
/**
 * @returns {Promise<{ok:boolean, reason?:string}>} — inarudisha ok:false kwa kosa lolote (DB, usimbaji, n.k.).
 */
async function canTrade(phone, { auto = false } = {}) {
  try {
    if (!phone) return { ok: false, reason: 'no_phone' };
    if (await getKillAll()) return { ok: false, reason: 'kill_all' };
    const row = await getRow(phone);
    if (!row || !row.encToken) return { ok: false, reason: 'not_connected' };
    if (row.status !== 'active') return { ok: false, reason: 'inactive' };
    if (!row.isDemo && !row.realAllowed) return { ok: false, reason: 'real_not_allowed' };
    if (!row.adminApproved) return { ok: false, reason: 'not_approved' };
    if (!row.userEnabled) return { ok: false, reason: 'user_disabled' };
    if (auto && (!row.autoApproved || !row.autoEnabled)) return { ok: false, reason: 'auto_off' };
    return { ok: true, accountId: row.accountId, isDemo: !!row.isDemo, limits: toPublic(row).limits };
  } catch (err) {
    console.error('[derivAccounts] canTrade imeshindwa (nazuia):', err.message);
    return { ok: false, reason: 'error' };
  }
}

/** Inarudisha token iliyofunguliwa TU baada ya canTrade() kupita. Usiiandike kwenye log. */
async function getTokenForTrading(phone, opts) {
  const gate = await canTrade(phone, opts);
  if (!gate.ok) throw new DerivAccountError('Trading haijaruhusiwa kwa akaunti hii.', 'DENIED', { reason: gate.reason });
  const row = await getRow(phone);
  const token = vault.decrypt(row.encToken, String(phone));
  return { token, accountId: row.accountId, isDemo: !!row.isDemo, limits: gate.limits };
}

/** Hatua zinazofuata zikiona Deriv imekataa token (401), ziite hii ili swichi zote zizimwe. */
async function markInvalid(phone, message) {
  await ensureRow(phone);
  await touch(phone, `status = 'invalid', userEnabled = 0, autoEnabled = 0, lastError = ?`, [String(message || 'Token imekataliwa na Deriv').slice(0, 200)]);
}

// ── Admin ────────────────────────────────────────────────────────────────────────────
async function adminList() {
  const r = await db.query('SELECT * FROM deriv_accounts ORDER BY updatedAt DESC', []);
  return { killAll: await getKillAll(true), vaultReady: vault.isConfigured(), accounts: r.rows.map(toPublic) };
}

function num(v, name, ceil) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new DerivAccountError(`${name} lazima iwe namba > 0.`, 'BAD_LIMIT');
  if (n > ceil) throw new DerivAccountError(`${name} haiwezi kuzidi ${ceil} (kikomo kigumu).`, 'BAD_LIMIT');
  return n;
}

/**
 * action: approve | revoke | approve_auto | revoke_auto | allow_real | deny_real |
 *         set_limits | reset_pin | remove | kill_all | resume_all
 * reset_pin inarudisha { tempPin } — admin ndiye pekee anayeiona (na DM ikiombwa); mteja analazimika kuibadilisha.
 */
async function adminAction(phone, action, payload = {}) {
  if (action === 'kill_all') return { killAll: await setKillAll(true) };
  if (action === 'resume_all') return { killAll: await setKillAll(false) };

  if (!phone) throw new DerivAccountError('Namba ya mteja inahitajika.', 'NO_PHONE');
  const row = await getRow(phone);
  if (!row) throw new DerivAccountError('Mteja huyu hajaanza kuweka akaunti ya Deriv.', 'NOT_FOUND');

  switch (action) {
    case 'approve':
      if (!row.encToken) throw new DerivAccountError('Mteja hajaunganisha akaunti ya Deriv bado.', 'NOT_CONNECTED');
      if (!row.isDemo && !row.realAllowed) throw new DerivAccountError('Akaunti hii ni ya REAL — ruhusu REAL kwanza (kwa makusudi).', 'REAL_NOT_ALLOWED');
      await touch(phone, 'adminApproved = 1');
      break;
    case 'revoke': // inazima kila kitu cha mteja huyu
      await touch(phone, 'adminApproved = 0, autoApproved = 0, userEnabled = 0, autoEnabled = 0');
      break;
    case 'approve_auto':
      if (!row.adminApproved) throw new DerivAccountError('Mwidhinishe kutrade kwanza.', 'NOT_APPROVED');
      await touch(phone, 'autoApproved = 1');
      break;
    case 'revoke_auto':
      await touch(phone, 'autoApproved = 0, autoEnabled = 0');
      break;
    case 'allow_real':
      await touch(phone, 'realAllowed = 1');
      break;
    case 'deny_real':
      await touch(phone, row.isDemo ? 'realAllowed = 0' : 'realAllowed = 0, adminApproved = 0, autoApproved = 0, userEnabled = 0, autoEnabled = 0');
      break;
    case 'set_limits': {
      const l = payload.limits || {};
      const maxStake = num(l.maxStake ?? row.maxStake, 'Stake ya juu', CEILING.maxStake);
      const maxTradesDay = Math.floor(num(l.maxTradesDay ?? row.maxTradesDay, 'Trades kwa siku', CEILING.maxTradesDay));
      const maxDailyLoss = num(l.maxDailyLoss ?? row.maxDailyLoss, 'Hasara ya siku', CEILING.maxDailyLoss);
      const maxOpen = Math.floor(num(l.maxOpen ?? row.maxOpen, 'Trades wazi', CEILING.maxOpen));
      await touch(phone, 'maxStake = ?, maxTradesDay = ?, maxDailyLoss = ?, maxOpen = ?', [maxStake, maxTradesDay, maxDailyLoss, maxOpen]);
      break;
    }
    case 'reset_pin': {
      if (!vault.isConfigured()) throw new DerivAccountError('TOKENVAULT_KEY haipo — siwezi kutengeneza PIN.', 'VAULT_OFF');
      const tempPin = pins.generateTempPin();
      await touch(phone, 'pinHash = ?, mustChangePin = 1, pinFails = 0, pinLockedUntil = NULL', [await pins.hashPin(tempPin)]);
      // Swichi zinazimwa — mteja lazima ajithibitishe tena kwa PIN yake mpya.
      await touch(phone, 'userEnabled = 0, autoEnabled = 0');
      return { account: await getPublic(phone), tempPin };
    }
    case 'remove':
      await db.query('DELETE FROM deriv_accounts WHERE phoneNumber = ?', [String(phone)]);
      return { account: null };
    default:
      throw new DerivAccountError('Action isiyojulikana.', 'BAD_ACTION');
  }
  return { account: await getPublic(phone) };
}

module.exports = {
  DerivAccountError,
  CEILING,
  rateLimit,
  getPublic,
  setPin,
  connect,
  disconnect,
  setSwitches,
  canTrade,
  getTokenForTrading,
  markInvalid,
  getKillAll,
  setKillAll,
  adminList,
  adminAction,
};
