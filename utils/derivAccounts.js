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

const { EventEmitter } = require('events');
const db = require('../pairing/db');
const vault = require('./derivCrypto');
const pins = require('./derivPin');
const { validateToken, DerivValidationError } = require('./derivValidate');

// 'session-close' (phone): muunganisho wa mteja (derivSession) lazima ufungwe — token imebadilika/imeondolewa/imekataliwa.
const events = new EventEmitter();

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

// Stake ya auto-trade ya msingi (kabla ya mteja kuomba nyingine na admin kuidhinisha). Inapunguzwa hadi maxStake ya mteja.
const AUTO_STAKE_DEFAULT = Number(process.env.DERIV_AUTO_STAKE_USD || 2);
const MIN_STAKE = Number(process.env.DERIV_MIN_STAKE_USD || 1);
const STAKE_RESET = 'autoStake = NULL, autoStakeReq = NULL, autoStakeReqAt = NULL';
const r2 = (n) => Math.round(Number(n) * 100) / 100;
/** Stake halisi ambayo auto-trade itatumia: iliyoidhinishwa (au default) ikipunguzwa hadi maxStake ya sasa. */
function effectiveAutoStake(row) {
  const base = row && Number(row.autoStake) > 0 ? Number(row.autoStake) : AUTO_STAKE_DEFAULT;
  const cap = row && Number(row.maxStake) > 0 ? Number(row.maxStake) : base;
  return r2(Math.min(base, cap));
}

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
    autoStake: effectiveAutoStake(row),
    autoStakeApproved: Number(row.autoStake) > 0 ? Number(row.autoStake) : null,
    autoStakeRequest: Number(row.autoStakeReq) > 0 ? { stake: Number(row.autoStakeReq), at: row.autoStakeReqAt ? Number(row.autoStakeReqAt) : null } : null,
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

/** Kuthibitisha PIN kwa hatua nyeti (mfano kufungua trade kutoka dashboard). Inatupa DerivAccountError ikikataliwa; inahesabu majaribio mabaya. */
async function requirePin(phone, pin) {
  const row = await getRow(phone);
  needReady(row);
  await checkPin(phone, pin);
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
     userEnabled = 0, autoEnabled = 0` + (sameAccount ? '' : `, adminApproved = 0, autoApproved = 0, ${STAKE_RESET}`),
    [enc, vault.hint(token), info.accountId, info.isDemo ? 1 : 0, info.currency, Date.now()]
  );
  events.emit('session-close', String(phone)); // token mpya → muunganisho wa zamani ufungwe
  return { account: await getPublic(phone), balance: info.balance };
}

/** Bila PIN — mteja anaweza kuondoa token yake wakati wowote. */
async function disconnect(phone) {
  await ensureRow(phone);
  await touch(
    phone,
    `encToken = NULL, tokenHint = NULL, accountId = NULL, currency = NULL, status = 'none', lastError = NULL, connectedAt = NULL,
     userEnabled = 0, autoEnabled = 0, adminApproved = 0, autoApproved = 0, ${STAKE_RESET}`
  );
  events.emit('session-close', String(phone));
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
    const pub = toPublic(row);
    return { ok: true, accountId: row.accountId, isDemo: !!row.isDemo, limits: pub.limits, autoStake: pub.autoStake };
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

/**
 * Token kwa ajili ya KUSIMAMIA (kuona positions/balance na KUFUNGA trades) — gate ndogo kuliko canTrade():
 * inahitaji tu token iliyohifadhiwa, status 'active', na akaunti DEMO (au realAllowed). HAIHITAJI idhini ya admin,
 * swichi ya mteja wala kill switch — kufunga trade ni kupunguza hatari, lazima ifanye kazi hata trading ikiwa imesimamishwa
 * (panic wakati wa kill switch). Kufungua trade bado kunahitaji canTrade().
 */
async function getTokenForManage(phone) {
  let row;
  try {
    row = await getRow(phone);
  } catch (err) {
    console.error('[derivAccounts] getTokenForManage: DB imeshindwa:', err.message);
    throw new DerivAccountError('Hitilafu ya ndani. Jaribu tena.', 'DENIED', { reason: 'error' });
  }
  if (!row || !row.encToken) throw new DerivAccountError('Hujaunganisha akaunti ya Deriv.', 'DENIED', { reason: 'not_connected' });
  if (row.status !== 'active') throw new DerivAccountError('Akaunti yako ya Deriv ina tatizo (token). Iunganishe upya.', 'DENIED', { reason: 'inactive' });
  if (!row.isDemo && !row.realAllowed) throw new DerivAccountError('Akaunti ya REAL haijaruhusiwa.', 'DENIED', { reason: 'real_not_allowed' });
  return { token: vault.decrypt(row.encToken, String(phone)), accountId: row.accountId, isDemo: !!row.isDemo };
}

/** Hatua zinazofuata zikiona Deriv imekataa token (401), ziite hii ili swichi zote zizimwe. */
async function markInvalid(phone, message) {
  await ensureRow(phone);
  await touch(phone, `status = 'invalid', userEnabled = 0, autoEnabled = 0, lastError = ?`, [String(message || 'Token imekataliwa na Deriv').slice(0, 200)]);
  events.emit('session-close', String(phone));
}

/**
 * Mteja anaomba stake ya auto-trade. Kupunguza (au kubaki sawa) = hatari ndogo → inatekelezwa mara moja.
 * Kuongeza = ombi linasubiri idhini ya admin (approve_stake / reject_stake); stake ya sasa inaendelea hadi aidhinishe.
 * Hakuna PIN (ombi halibadilishi chochote hadi admin aidhinishe); route ina rate limit.
 */
async function requestAutoStake(phone, stake) {
  const row = await getRow(phone);
  if (!row || !row.encToken) throw new DerivAccountError('Unganisha akaunti ya Deriv kwanza.', 'NOT_CONNECTED');
  const v = r2(stake);
  if (!Number.isFinite(v) || v <= 0) throw new DerivAccountError('Stake lazima iwe namba > 0.', 'BAD_STAKE');
  if (v < MIN_STAKE) throw new DerivAccountError(`Stake ni ndogo mno (chini ya $${MIN_STAKE}).`, 'BAD_STAKE');
  if (v > CEILING.maxStake) throw new DerivAccountError(`Stake haiwezi kuzidi $${CEILING.maxStake}.`, 'BAD_STAKE');
  const current = effectiveAutoStake(row);
  if (v <= current) {
    await touch(phone, 'autoStake = ?, autoStakeReq = NULL, autoStakeReqAt = NULL', [v]);
    return { applied: true, stake: v, account: await getPublic(phone) };
  }
  await touch(phone, 'autoStakeReq = ?, autoStakeReqAt = ?', [v, Date.now()]);
  return { pending: true, stake: v, account: await getPublic(phone) };
}

/** Mteja anaondoa ombi lake linalosubiri. */
async function cancelAutoStakeRequest(phone) {
  await ensureRow(phone);
  await touch(phone, 'autoStakeReq = NULL, autoStakeReqAt = NULL');
  return getPublic(phone);
}

/**
 * Wateja (namba tu) ambao auto-trade yao iko tayari: token hai + admin amewaidhinisha kutrade na auto + wamewasha swichi zote mbili.
 * Hii ni orodha ya awali tu — kila trade bado inapita canTrade(phone, {auto:true}) (kill switch, DEMO, n.k.).
 */
async function listAutoReady() {
  const r = await db.query(
    `SELECT phoneNumber FROM deriv_accounts
     WHERE encToken IS NOT NULL AND status = 'active' AND adminApproved = 1 AND userEnabled = 1 AND autoApproved = 1 AND autoEnabled = 1`,
    []
  );
  return r.rows.map((x) => String(x.phoneNumber));
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
      await touch(phone, `adminApproved = 0, autoApproved = 0, userEnabled = 0, autoEnabled = 0, ${STAKE_RESET}`);
      break;
    case 'approve_auto':
      if (!row.adminApproved) throw new DerivAccountError('Mwidhinishe kutrade kwanza.', 'NOT_APPROVED');
      await touch(phone, 'autoApproved = 1');
      break;
    case 'revoke_auto':
      await touch(phone, `autoApproved = 0, autoEnabled = 0, ${STAKE_RESET}`);
      break;
    case 'approve_stake': { // idhinisha ombi la stake ya auto-trade la mteja
      const req = Number(row.autoStakeReq);
      if (!(req > 0)) throw new DerivAccountError('Mteja hana ombi la stake linalosubiri.', 'NO_REQUEST');
      if (req > Number(row.maxStake)) throw new DerivAccountError(`Stake iliyoombwa ($${req}) inazidi "Stake ya juu" ya mteja ($${row.maxStake}). Ongeza kikomo kwanza (Vikomo vya Mteja), kisha idhinisha.`, 'ABOVE_LIMIT');
      await touch(phone, 'autoStake = ?, autoStakeReq = NULL, autoStakeReqAt = NULL', [req]);
      return { account: await getPublic(phone), stakeResult: { approved: true, stake: req } };
    }
    case 'reject_stake': {
      const req = Number(row.autoStakeReq);
      if (!(req > 0)) throw new DerivAccountError('Mteja hana ombi la stake linalosubiri.', 'NO_REQUEST');
      await touch(phone, 'autoStakeReq = NULL, autoStakeReqAt = NULL');
      return { account: await getPublic(phone), stakeResult: { approved: false, stake: req } };
    }
    case 'set_stake': { // admin anaweka moja kwa moja; thamani tupu = rudi kwenye default
      const raw = payload.stake;
      if (raw === null || raw === undefined || raw === '') { await touch(phone, STAKE_RESET); break; }
      const v = r2(num(raw, 'Stake ya auto-trade', CEILING.maxStake));
      if (v < MIN_STAKE) throw new DerivAccountError(`Stake ni ndogo mno (chini ya $${MIN_STAKE}).`, 'BAD_STAKE');
      if (v > Number(row.maxStake)) throw new DerivAccountError(`Stake ($${v}) inazidi "Stake ya juu" ya mteja ($${row.maxStake}). Ongeza kikomo kwanza.`, 'ABOVE_LIMIT');
      await touch(phone, 'autoStake = ?, autoStakeReq = NULL, autoStakeReqAt = NULL', [v]);
      return { account: await getPublic(phone), stakeResult: { approved: true, stake: v, byAdmin: true } };
    }
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
      events.emit('session-close', String(phone));
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
  requirePin,
  connect,
  disconnect,
  setSwitches,
  canTrade,
  listAutoReady,
  requestAutoStake,
  cancelAutoStakeRequest,
  effectiveAutoStake,
  AUTO_STAKE_DEFAULT,
  getTokenForTrading,
  getTokenForManage,
  markInvalid,
  events,
  getKillAll,
  setKillAll,
  adminList,
  adminAction,
};
