/**
 * derivTrader.js — Muunganiko na utekelezaji wa trade kupitia Deriv API
 * MPYA (2026): https://developers.deriv.com — REST (OTP) + WebSocket.
 *
 * ⚠️ BADILIKO KUBWA: Deriv wameacha kabisa mfumo wa zamani (legacy
 * ws.derivws.com/binaryws.com/red.binaryws.com na app_id namba kama 1089).
 * App ID za zamani HAZIFANYI KAZI kwenye mfumo mpya ("Invalid App ID" /
 * "401 Unauthorized"). Hii ndiyo sababu ya 520 zote tulizoziona awali.
 *
 * MAHITAJI MAPYA (env vars):
 *   DERIV_APP_ID     — App ID mpya kutoka developers.deriv.com (mfano
 *                       "app12345" — tumia kama ilivyo, na herufi "app")
 *   DERIV_API_TOKEN  — Personal Access Token (PAT) yenye scopes "trade" na
 *                       "account_manage", kutoka developers.deriv.com dashboard
 *   DERIV_ACCOUNT_ID — Account ID/loginid yako ya Deriv (mfano "VRTC1234567"
 *                       kwa demo) — inaonekana juu-kulia kwenye akaunti yako
 *
 * Mtiririko: (1) REST POST /accounts/{id}/otp → inarudisha WebSocket URL
 * yenye "otp" (tayari imethibitishwa/authenticated, hakuna "authorize"
 * inayohitajika tena) → (2) unganisha WebSocket kwenye URL hiyo → (3) tuma
 * amri za trading. Symbol field sasa ni "underlying_symbol" (si "symbol"
 * kama zamani).
 *
 * Aina ya contract: "Multipliers" (MULTUP/MULTDOWN) — ina Stop Loss/Take
 * Profit ASILI kwenye contract yenyewe (Deriv inafunga kiotomatiki).
 *
 * ⚠️⚠️ FOREX/MULTIPLIERS INA HATARI KUBWA (leverage). Hii SI ushauri wa
 * kifedha. Stop Loss na Take Profit ni LAZIMA kwenye kila trade.
 */

const axios = require('axios');
const WebSocket = require('ws');

const APP_ID = process.env.DERIV_APP_ID || null;
const API_TOKEN = process.env.DERIV_API_TOKEN || null;
const ACCOUNT_ID = process.env.DERIV_ACCOUNT_ID || null;
const API_BASE = 'https://api.derivws.com';

const MAX_STAKE_USD = Number(process.env.DERIV_MAX_STAKE_USD || 50);
const MIN_STAKE_USD = Number(process.env.DERIV_MIN_STAKE_USD || 1);
const MAX_MULTIPLIER = Number(process.env.DERIV_MAX_MULTIPLIER || 100);
const DEFAULT_MULTIPLIER = Number(process.env.DERIV_DEFAULT_MULTIPLIER || 20);

// Deriv Multipliers (MULTUP/MULTDOWN) hukubali TU thamani hizi maalum.
// Ukituma namba nyingine yoyote, Deriv API inakataa na kurudisha:
// "Multiplier is not in acceptable range. Accepts 100,200,300,500,800."
const ALLOWED_MULTIPLIERS = [100, 200, 300, 500, 800];

const REQUEST_TIMEOUT_MS = 15000;
const REST_TIMEOUT_MS = 15000;

let ws = null;
let wsReady = false;
let connectPromise = null;
let reqCounter = 1;
const pending = new Map(); // req_id -> { resolve, reject }

// ── Heartbeat/ping — kugundua "zombie connection" ───────────────────────
// Tatizo lililoonekana: baada ya muda mrefu bila restart, WebSocket
// inaweza kubaki "wsReady=true" hata kama muunganiko wa kweli (TCP) tayari
// umekufa kimya kimya (Railway/network inakata bila kutuma 'close' frame
// sahihi — jambo la kawaida kwa WS zinazokaa wazi kwa muda mrefu). Bila
// heartbeat, ensureConnected() inaona "wsReady=true" na HAIJARIBU
// kuunganisha upya — kila ombi (proposal, buy, positions...) linasubiri
// sekunde 15 (REQUEST_TIMEOUT_MS) kisha ku-timeout, MARA KWA MARA, bila
// mwisho — auto-trader "inalala" hadi bot irestart kwa kulazimishwa
// (connection mpya kabisa). Heartbeat hii inatuma ping kila dakika 1, na
// kama pong haijarudi ndani ya sekunde 20, tunaua (terminate) socket
// iliyokufa ili ensureConnected() iunganishe upya OTOMATIKI bila kuhitaji
// restart ya bot nzima.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const PONG_TIMEOUT_MS = 20 * 1000;
let heartbeatTimer = null;
let pongTimeoutTimer = null; // timer ya sekunde 20 kwa kila ping iliyotumwa
let lastPongAt = 0;

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (pongTimeoutTimer) {
    clearTimeout(pongTimeoutTimer);
    pongTimeoutTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongAt = Date.now();
  const sock = ws;
  heartbeatTimer = setInterval(() => {
    if (!ws || ws !== sock || !wsReady) return;
    if (pongTimeoutTimer) return; // ping iliyotangulia bado inasubiri pong
    try {
      sock.ping();
    } catch (err) {
      console.error('[derivTrader] Imeshindwa kutuma ping:', err.message);
      return;
    }
    // Pong ikirudi, handler ya 'pong' inafuta timer hii. Isiporudi ndani
    // ya PONG_TIMEOUT_MS, ndipo tunaua socket (zombie halisi).
    pongTimeoutTimer = setTimeout(() => {
      pongTimeoutTimer = null;
      if (ws !== sock || !wsReady) return;
      console.error('[derivTrader] 💀 Hakuna pong kwa zaidi ya sekunde 20 — muunganiko "zombie", naukatisha ili uunganishwe upya moja kwa moja.');
      try {
        sock.terminate(); // inalazimisha 'close' event mara moja
      } catch (err) {
        console.error('[derivTrader] Imeshindwa ku-terminate socket iliyokufa:', err.message);
      }
    }, PONG_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function checkEnv() {
  const missing = [];
  if (!APP_ID) missing.push('DERIV_APP_ID');
  if (!API_TOKEN) missing.push('DERIV_API_TOKEN');
  if (missing.length) {
    throw new Error(`Env zifuatazo hazipo: ${missing.join(', ')}`);
  }
}

// ── Akaunti hai: DEMO au REAL ───────────────────────────────────────────
// Uchaguzi (mode) unahifadhiwa kwenye DB (fx_auto_settings) ili ubaki baada ya redeploy.
// Kipaumbele: mode iliyohifadhiwa > DERIV_ACCOUNT_ID (env) > DEMO ya kwanza (tabia ya zamani).
// REAL ina kikomo chake cha stake (realMaxStake) kinachotekelezwa kwenye placeMultiplier().
const { classify } = require('./derivValidate');

const MODE_KEY = 'deriv_account_mode';
const REAL_STAKE_KEY = 'deriv_real_max_stake';
let cachedAccountId = null;
let accountMode = null; // 'demo' | 'real' | null (bado haijaamuliwa)
let modeLoaded = false;
let savedModeChosen = false; // true = mtu amechagua mode waziwazi (DB)
let realMaxStake = Number(process.env.DERIV_REAL_MAX_STAKE_USD || 5);
let switching = false; // trades mpya zinazuiwa wakati wa kubadili akaunti
const switchListeners = [];
/** Moduli (mfano autoTrader) zinajisajili kupokea taarifa akaunti ikibadilika: fn(newMode, prevMode). */
function onAccountSwitched(fn) { if (typeof fn === 'function') switchListeners.push(fn); }

const modeFromId = (id) => (/^VRT/i.test(String(id || '')) ? 'demo' : 'real');
const fxDb = () => require('../pairing/db'); // lazy — epuka circular require

async function readSetting(key) {
  const db = fxDb();
  await db.initSchema();
  const r = await db.query('SELECT settingValue FROM fx_auto_settings WHERE settingKey = ?', [key]);
  return (r.rows || [])[0]?.settingValue ?? null;
}
async function writeSetting(key, value) {
  const db = fxDb();
  await db.initSchema();
  await db.query(
    `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
    [key, String(value), Date.now()]
  );
}

async function loadModeFromDb() {
  if (modeLoaded) return;
  try {
    const m = await readSetting(MODE_KEY);
    if (m === 'demo' || m === 'real') { accountMode = m; savedModeChosen = true; }
    const cap = Number(await readSetting(REAL_STAKE_KEY));
    if (Number.isFinite(cap) && cap > 0) realMaxStake = cap;
    modeLoaded = true; // ikishindwa DB, tutajaribu tena wakati mwingine
  } catch (err) {
    console.error('[derivTrader] Imeshindwa kusoma mode ya akaunti kutoka DB (inatumia default):', err.message);
  }
}

async function fetchOptionsAccounts() {
  const { data } = await axios.get(`${API_BASE}/trading/v1/options/accounts`, {
    headers: { Authorization: `Bearer ${API_TOKEN}`, 'Deriv-App-ID': APP_ID },
    timeout: REST_TIMEOUT_MS,
  });
  const accounts = data?.data || data?.accounts || [];
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error('Hakuna Options trading account iliyopatikana kwenye Deriv (angalia DERIV_APP_ID/DERIV_API_TOKEN)');
  }
  return accounts.map((a) => {
    const c = classify(a);
    const legacyDemo = !!(a.is_virtual || a.demo || a.account_type === 'demo');
    return { id: c.id || a.account_id || a.id, demo: c.demo, legacyDemo, raw: a };
  });
}

// DEMO: classify() === true (au bendera ya zamani). REAL: classify() === false PEKEE (fail-closed:
// kama haijulikani, HAIFAI kuwa REAL).
function pickAccount(list, mode) {
  if (mode === 'real') return list.find((x) => x.demo === false) || null;
  return list.find((x) => x.demo === true) || list.find((x) => x.legacyDemo) || null;
}

async function resolveAccountId() {
  if (cachedAccountId) return cachedAccountId;
  await loadModeFromDb();

  if (!savedModeChosen && ACCOUNT_ID) { // tabia ya zamani: env inatawala ikiwa hakuna uchaguzi wa dashboard
    cachedAccountId = ACCOUNT_ID;
    accountMode = modeFromId(ACCOUNT_ID);
    return cachedAccountId;
  }

  const list = await fetchOptionsAccounts();
  let acc = pickAccount(list, accountMode || 'demo');
  if (!acc && !savedModeChosen) acc = list[0]; // tabia ya zamani tu (hakuna uchaguzi wa wazi)
  if (!acc) {
    throw new Error(accountMode === 'real'
      ? 'Akaunti ya REAL haikupatikana kwenye Deriv (token yako haina REAL account?)'
      : 'Akaunti ya DEMO haikupatikana kwenye Deriv');
  }
  cachedAccountId = acc.id;
  if (!cachedAccountId) throw new Error('Account ID haikupatikana kwenye response ya Deriv (muundo umebadilika?)');
  accountMode = acc.demo === true || acc.legacyDemo ? 'demo' : (acc.demo === false ? 'real' : modeFromId(cachedAccountId));
  return cachedAccountId;
}

function getAccountMode() {
  return accountMode; // 'demo' | 'real' | null
}

/** Hali ya akaunti kwa dashboard. withAvailability=true inauliza Deriv akaunti zipi zipo. */
async function getAccountState({ withAvailability = false } = {}) {
  await resolveAccountId();
  const st = { mode: accountMode, accountId: cachedAccountId, realMaxStake, maxStakeUsd: MAX_STAKE_USD };
  if (withAvailability) {
    try {
      const list = await fetchOptionsAccounts();
      st.demoAvailable = !!pickAccount(list, 'demo');
      st.realAvailable = !!pickAccount(list, 'real');
    } catch (err) {
      st.availabilityError = err.message;
    }
  }
  return st;
}

async function setRealMaxStake(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < MIN_STAKE_USD || v > MAX_STAKE_USD) {
    throw new Error(`Kikomo cha stake ya REAL lazima kiwe kati ya $${MIN_STAKE_USD} na $${MAX_STAKE_USD}.`);
  }
  realMaxStake = v;
  await writeSetting(REAL_STAKE_KEY, v);
  return realMaxStake;
}

/**
 * Badilisha akaunti (demo <-> real). SALAMA:
 *  - inakataa ikiwa kuna trades ZILIZO WAZI kwenye akaunti ya sasa (hazibadilishwi wala hazipotei;
 *    zifunge au subiri zifungwe kwanza), au ikishindwa kuthibitisha hilo (fail-closed);
 *  - REAL inahitaji akaunti ya REAL iliyothibitishwa wazi kuwa REAL (si "haijulikani");
 *  - trades mpya zinazuiwa wakati wa kubadili (flag ya `switching`).
 */
async function switchAccount(mode) {
  if (mode !== 'demo' && mode !== 'real') throw Object.assign(new Error('Mode lazima iwe demo au real.'), { code: 'BAD_MODE' });
  if (switching) throw Object.assign(new Error('Kubadili akaunti kunaendelea tayari — subiri.'), { code: 'BUSY' });
  switching = true;
  try {
    checkEnv();
    await loadModeFromDb();
    const list = await fetchOptionsAccounts();
    const target = pickAccount(list, mode);
    if (!target || !target.id) {
      throw Object.assign(new Error(mode === 'real'
        ? 'Hakuna akaunti ya REAL iliyothibitishwa kwenye token hii ya Deriv.'
        : 'Hakuna akaunti ya DEMO kwenye token hii ya Deriv.'), { code: 'NO_ACCOUNT' });
    }

    let leftOpenDemo = 0;
    const prevMode = accountMode;
    if (cachedAccountId && target.id !== cachedAccountId) {
      let open;
      try {
        open = await getOpenPositions();
      } catch (err) {
        throw Object.assign(new Error('Siwezi kuthibitisha kama kuna trades wazi (' + err.message + '). Jaribu tena.'), { code: 'CANNOT_VERIFY' });
      }
      // REAL zilizo wazi: HAZIRUHUSIWI kuachwa bila usimamizi wa bot (trailing/kufunga) — lazima zifungwe kwanza.
      // DEMO zilizo wazi: zinaruhusiwa — zinaendelea Deriv kwa SL/TP zake; bot inazikumbuka (DB) na kuzisimamia
      // tena ukirudi DEMO.
      if (open.length && accountMode === 'real') {
        throw Object.assign(new Error(`Kuna trades ${open.length} za REAL zilizo wazi. Zifunge kwanza (au subiri zifike SL/TP) kisha ubadilishe — bot haiwezi kuziacha bila usimamizi.`), { code: 'OPEN_POSITIONS', open: open.length });
      }
      leftOpenDemo = open.length;
    }

    await writeSetting(MODE_KEY, mode);
    savedModeChosen = true;
    const changed = target.id !== cachedAccountId;
    cachedAccountId = target.id;
    accountMode = mode;

    if (changed) {
      // Kata muunganiko wa zamani; ensureConnected() itaomba OTP mpya ya akaunti mpya.
      const old = ws;
      ws = null;
      wsReady = false;
      connectPromise = null;
      stopHeartbeat();
      rejectAllPending(new Error('Akaunti imebadilishwa'));
      try { if (old) old.terminate(); } catch (_) { /* tayari imekufa */ }
      console.log(`[derivTrader] 🔄 Akaunti imebadilishwa kuwa ${mode.toUpperCase()} (${cachedAccountId})`);
      // Waambie wasikilizaji (autoTrader) WAKATI `switching` bado true — ili isifungue trade kabla
      // ya kupakia upya trades za akaunti mpya.
      for (const fn of switchListeners) {
        try { await fn(mode, prevMode); }
        catch (err) { console.error('[derivTrader] listener ya kubadili akaunti imeshindwa:', err.message); }
      }
    }
    return { mode: accountMode, accountId: cachedAccountId, realMaxStake, changed, leftOpenDemo };
  } finally {
    switching = false;
  }
}

function rejectAllPending(err) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

// Hatua ya 1 (REST): pata WebSocket URL yenye OTP tayari imethibitishwa.
async function fetchOtpWsUrl() {
  const accountId = await resolveAccountId();
  const { data } = await axios.post(
    `${API_BASE}/trading/v1/options/accounts/${accountId}/otp`,
    {},
    {
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        'Deriv-App-ID': APP_ID,
      },
      timeout: REST_TIMEOUT_MS,
    }
  );
  const url = data?.data?.url;
  if (!url) throw new Error('Deriv haikurudisha WebSocket URL (otp)');
  return url;
}

// Hatua ya 2: unganisha kwenye URL hiyo (tayari imethibitishwa — hakuna
// "authorize" inayohitajika).
function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      wsReady = true;
      settled = true;
      startHeartbeat();
      resolve();
    });

    ws.on('pong', () => {
      lastPongAt = Date.now();
      if (pongTimeoutTimer) {
        clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = null;
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const pend = pending.get(msg.req_id);
      if (!pend) return;
      pending.delete(msg.req_id);
      if (msg.error) {
        const err = new Error(msg.error.message || 'Deriv API error');
        err.code = msg.error.code;
        pend.reject(err);
      } else {
        pend.resolve(msg);
      }
    });

    const mySock = ws;
    ws.on('close', () => {
      if (ws !== mySock) return; // socket ya zamani (akaunti ilibadilishwa) — usiharibu muunganiko mpya
      wsReady = false;
      connectPromise = null;
      stopHeartbeat();
      rejectAllPending(new Error('Muunganiko wa Deriv umekatika'));
    });

    ws.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

async function connect() {
  if (connectPromise) return connectPromise;
  checkEnv();

  connectPromise = (async () => {
    try {
      const wsUrl = await fetchOtpWsUrl();
      await connectWs(wsUrl);
    } catch (err) {
      connectPromise = null;
      throw err;
    }
  })();

  return connectPromise;
}

async function ensureConnected() {
  if (!wsReady) await connect();
}

function sendRaw(payload) {
  return new Promise((resolve, reject) => {
    const req_id = reqCounter++;
    const timer = setTimeout(() => {
      pending.delete(req_id);
      reject(new Error('Muda wa ombi la Deriv umeisha'));
    }, REQUEST_TIMEOUT_MS);

    pending.set(req_id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });

    ws.send(JSON.stringify({ ...payload, req_id }));
  });
}

async function send(payload) {
  await ensureConnected();
  return sendRaw(payload);
}

function toDerivSymbol(pair) {
  // "EURUSD" -> "frxEURUSD" (muundo wa Deriv kwa jozi za forex)
  return `frx${pair.toUpperCase()}`;
}

// ─────────────────────────────────────────────
// Utekelezaji wa trade — proposal kwanza, kisha buy (mfumo mpya hauruhusu
// tena "buy:1, parameters:{...}" moja kwa moja bila proposal).
// ─────────────────────────────────────────────
async function placeMultiplier({ pair, direction, stake, stopLoss, takeProfit, multiplier }) {
  if (switching) throw new Error('Akaunti inabadilishwa sasa hivi — jaribu tena baada ya sekunde chache.');
  await resolveAccountId(); // inajaza accountMode (demo/real)
  let amt = Math.min(Number(stake), MAX_STAKE_USD);
  if (accountMode === 'real' && amt > realMaxStake) {
    console.warn(`[derivTrader] ⚠️ REAL: stake $${amt} imepunguzwa hadi kikomo cha REAL $${realMaxStake}`);
    amt = realMaxStake;
  }
  if (!(amt > 0)) throw new Error('Stake si sahihi (lazima iwe namba > 0)');

  if (amt < MIN_STAKE_USD) {
    throw new Error(`Stake ni ndogo mno (chini ya $${MIN_STAKE_USD}). Weka stake ya angalau $${MIN_STAKE_USD}.`);
  }

  const sl = Number(stopLoss);
  const tp = Number(takeProfit);
  if (!(sl > 0) || !(tp > 0)) {
    throw new Error('Stop Loss na Take Profit ni LAZIMA (namba > 0)');
  }

  const rawMult = Number(multiplier) || DEFAULT_MULTIPLIER;
  if (!ALLOWED_MULTIPLIERS.includes(rawMult)) {
    throw new Error(
      `Multiplier "${rawMult}" si sahihi. Deriv inakubali TU: ${ALLOWED_MULTIPLIERS.join(', ')}.`
    );
  }
  const mult = Math.min(rawMult, MAX_MULTIPLIER);
  const contractType = direction === 'BUY' ? 'MULTUP' : 'MULTDOWN';
  const underlyingSymbol = toDerivSymbol(pair);

  const buildProposalPayload = (slAmt, tpAmt) => ({
    proposal: 1,
    amount: amt,
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    multiplier: mult,
    underlying_symbol: underlyingSymbol,
    limit_order: {
      stop_loss: slAmt,
      take_profit: tpAmt,
    },
  });

  let slUsed = sl;
  let tpUsed = tp;

  // Hatua A: proposal (bei ya sasa ya kufungua contract hii)
  let proposalRes;
  try {
    proposalRes = await send(buildProposalPayload(slUsed, tpUsed));
  } catch (err) {
    // Deriv inakataa SL/TP ikiwa ni NDOGO mno (chini ya kiwango cha chini
    // kinachohitajika wakati huo) AU KUBWA mno (mfano SL > stake — kwa
    // Multipliers, hasara ya juu zaidi inayowezekana haiwezi kuzidi stake,
    // hivyo Deriv ina "max" kidogo chini ya stake kwa ajili ya commission).
    // Ujumbe wake una muundo kama: "...equal to or higher than 0.45" (chini
    // mno) au "...equal to or lower than 0.97" (juu mno). Kiwango hicho
    // hutofautiana kwa jozi/stake, hivyo hakiwezi kuwekwa fasta mapema —
    // tunakisoma moja kwa moja kutoka kwenye ujumbe wa hitilafu na
    // kujaribu tena MARA MOJA na SL/TP iliyorekebishwa (uwiano wa
    // risk:reward wa awali unabaki uleule).
    const constraint = parseLimitOrderAmountConstraint(err.message);
    if (!constraint) throw err;

    const ratio = slUsed > 0 ? tpUsed / slUsed : 2;
    slUsed = constraint.type === 'min'
      ? Number((constraint.value + 0.01).toFixed(2))
      : Number(Math.max(constraint.value - 0.01, 0.01).toFixed(2));
    tpUsed = Number((slUsed * ratio).toFixed(2));
    console.warn(
      `[derivTrader] SL/TP haikubaliki kwa ${pair} (kiwango cha ${constraint.type === 'min' ? 'chini' : 'juu'}: $${constraint.value}) — ` +
        `imerekebishwa: SL $${slUsed}, TP $${tpUsed} (uwiano uleule) na kujaribu tena.`
    );
    proposalRes = await send(buildProposalPayload(slUsed, tpUsed));
  }

  const proposal = proposalRes.proposal;
  if (!proposal?.id) throw new Error('Proposal haikupatikana kutoka Deriv');

  // Hatua B: buy kwa kutumia proposal id
  const buyRes = await send({
    buy: proposal.id,
    price: proposal.ask_price ?? amt,
  });

  // Rudisha SL/TP HALISI zilizotumika (zinaweza kuwa zimerekebishwa hapo
  // juu) ili mwito wa nje (mfano autoTrader.js) aonyeshe namba sahihi
  // kwenye notification, si zile alizoomba awali.
  // commission: gharama ya kufungua kutoka Deriv (kama ipo) — News Trading inaitumia kuonyesha gharama ya kuingia.
  const commission = Number(proposal.commission);
  return { ...buyRes.buy, stop_loss: slUsed, take_profit: tpUsed, ...(Number.isFinite(commission) ? { commission } : {}) };
}

// Inachambua ujumbe wa hitilafu wa Deriv kutafuta kikomo (kiwango cha
// chini AU cha juu) kinachohitajika kwa SL/TP, mfano:
//   "...equal to or higher than 0.45"  -> { type: 'min', value: 0.45 }
//   "...equal to or lower than 0.97"   -> { type: 'max', value: 0.97 }
// Inarudisha null isipokuwa ilipopata namba halali.
function parseLimitOrderAmountConstraint(message) {
  const msg = String(message || '');

  let m = msg.match(/(?:equal to or higher than|higher than|greater than|at least)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return { type: 'min', value: n };
  }

  m = msg.match(/(?:equal to or lower than|lower than|less than|at most|maximum of)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return { type: 'max', value: n };
  }

  return null;
}

async function getOpenPositions() {
  const res = await send({ portfolio: 1 });
  return res.portfolio?.contracts || [];
}

// Kama getOpenPositions() lakini kwa kila contract inaongeza bid_price/profit
// halisi ya SASA (portfolio pekee haitoi hizi — zinahitaji ombi la ziada la
// proposal_open_contract kwa kila contract_id). Hii ndiyo inatoa namba za
// "live" (kupanda/kushuka) kwenye admin dashboard (fxtrading.html).
async function getOpenPositionsLive() {
  const positions = await getOpenPositions();
  return Promise.all(
    positions.map(async (p) => {
      try {
        const details = await getContractDetails(p.contract_id);
        return {
          ...p,
          bid_price: details?.bid_price ?? p.bid_price,
          profit: details?.profit ?? p.profit,
          current_spot: details?.current_spot,
          limit_order: details?.limit_order ?? p.limit_order,
        };
      } catch (err) {
        return p; // ukiona hitilafu kwa contract moja, bado onyesha nyingine
      }
    })
  );
}

// Deriv inahitaji contract_id kama NAMBA (integer). Dashboard hutuma kama
// maandishi ("123456") kupitia JSON/onclick, na hapo "sell" hukataliwa kwa
// "Input validation failed" — ndiyo sababu ya kushindwa kufunga kwa mkono.
function toContractId(contractId) {
  const n = Number(String(contractId).trim());
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`contract_id si sahihi: "${contractId}"`);
  return n;
}

async function closeContract(contractId) {
  const id = toContractId(contractId);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await send({ sell: id, price: 0 }); // price:0 = kubali bei ya soko
      return res.sell; // { contract_id, sold_for, transaction_id, ... } — HAINA "profit"!
    } catch (err) {
      lastErr = err;
      // Jaribu mara ya pili TU kwa matatizo ya muunganisho/muda, si kwa kukataliwa na Deriv.
      if (!/muda|timeout|connect|socket|closed|ws/i.test(String(err.message))) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

// Inabadilisha Stop Loss/Take Profit ya contract iliyo WAZI TAYARI, bila
// kuifunga — kwa Multipliers, Deriv inaruhusu hili kupitia "contract_update"
// (tofauti na "buy" ambapo limit_order inawekwa mara moja tu). stopLoss/
// takeProfit ni $ amounts (order_amount), sawa kabisa na jinsi
// zinavyowekwa kwenye placeMultiplier() hapo juu. Pitisha null/tupu kwa
// moja ili kuiacha kama ilivyo (hakuna haja ya kutuma zote mbili kila mara).
// stopLoss kwa Multipliers ni "order_amount" — namba CHANYA ni hasara ya
// juu zaidi kutoka bei ya ununuzi (dai la kawaida); namba HASI, kwa
// upande mwingine, "inafunga" faida ya chini kabisa iliyohakikishwa (mfano
// -2 = hata bei ikigeuka kabisa, contract itafunga kwa angalau $2 faida).
// Deriv yenyewe inakubali hasi kwa ajili hii hasa — ndiyo msingi wa
// trailing/profit-lock (angalia utils/autoTrader.js -> checkTrailingStops()).
// Sifuri halisi (0) haikubaliki (Deriv inahitaji tofauti ya kweli kutoka
// bei ya ununuzi), kwa hiyo tunazuia hiyo tu, si namba hasi kwa ujumla.
async function updateContractLimits(contractId, { stopLoss, takeProfit } = {}) {
  const limitOrder = {};
  if (stopLoss !== undefined && stopLoss !== null && stopLoss !== '') {
    const sl = Number(stopLoss);
    if (!Number.isFinite(sl) || sl === 0) {
      throw new Error('Stop Loss lazima iwe namba halisi isiyo sifuri (chanya = hasara ya juu; hasi = faida ya chini iliyofungwa)');
    }
    limitOrder.stop_loss = sl;
  }
  if (takeProfit !== undefined && takeProfit !== null && takeProfit !== '') {
    const tp = Number(takeProfit);
    if (!(tp > 0)) throw new Error('Take Profit lazima iwe namba > 0');
    limitOrder.take_profit = tp;
  }
  if (!Object.keys(limitOrder).length) {
    throw new Error('Weka angalau Stop Loss au Take Profit mpya');
  }

  try {
    const res = await send({ contract_update: 1, contract_id: toContractId(contractId), limit_order: limitOrder });
    return res.contract_update;
  } catch (err) {
    // Sawa na placeMultiplier(): Deriv inaweza kukataa thamani mpya kwa
    // kiwango cha chini/juu kinachohitajika wakati huo (hutofautiana kwa
    // jozi/bei ya sasa) — soma ujumbe wake tuutoe ufafanuzi wazi zaidi
    // badala ya kurusha error ghafi ya Deriv.
    const constraint = parseLimitOrderAmountConstraint(err.message);
    if (constraint) {
      throw new Error(
        `Thamani haikubaliki — Deriv inahitaji ${constraint.type === 'min' ? 'angalau' : 'kiwango cha chini ya'} $${constraint.value}. (${err.message})`
      );
    }
    throw err;
  }
}

// closeContract() peke yake HAIRUDISHI profit — jibu la Deriv la "sell" lina
// tu sold_for (fedha ulizopata), si faida/hasara halisi. Ndiyo maana
// dashboard ilikuwa ikionyesha "$0.00" kila wakati (result.profit haikuwepo
// kamwe). Function hii inahesabu faida/hasara HALISI: inapata buy_price
// KABLA ya kuuza (contract ikiwa bado wazi), kisha profit = sold_for -
// buy_price; ikishindikana, inaangukia profit_table (historia).
async function closeContractWithPnL(contractId) {
  let buyPrice;
  try {
    const before = await getContractDetails(contractId);
    buyPrice = Number(before?.buy_price);
  } catch (err) {
    console.error(`[derivTrader] Imeshindwa kupata buy_price kabla ya kuuza ${contractId}:`, err.message);
  }

  const sellResult = await closeContract(contractId);
  const soldFor = Number(sellResult?.sold_for);

  let profit = Number.isFinite(soldFor) && Number.isFinite(buyPrice) ? soldFor - buyPrice : NaN;

  if (!Number.isFinite(profit)) {
    try {
      const closed = await getClosedContractFromHistory(contractId);
      if (closed) {
        const cp = Number(closed.profit);
        profit = Number.isFinite(cp) ? cp : Number(closed.sell_price) - Number(closed.buy_price);
      }
    } catch (err) {
      console.error(`[derivTrader] profit_table imeshindwa (${contractId}):`, err.message);
    }
  }

  return { ...sellResult, buy_price: buyPrice, sold_for: soldFor, profit };
}

async function closeAll() {
  const positions = await getOpenPositions();
  const results = [];
  for (const p of positions) {
    try {
      const r = await closeContractWithPnL(p.contract_id);
      results.push({ contract_id: p.contract_id, ok: true, profit: r.profit, r });
    } catch (err) {
      results.push({ contract_id: p.contract_id, ok: false, error: err.message });
    }
  }
  return results;
}

async function getContractDetails(contractId) {
  const res = await send({ proposal_open_contract: 1, contract_id: toContractId(contractId) });
  return res.proposal_open_contract;
}

// getContractDetails (proposal_open_contract) mara nyingi HAITOI tena
// sell_price/profit sahihi baada ya contract kufungwa kikamilifu na
// kutoweka kwenye portfolio (hasa ikiwa imefungwa muda mrefu uliopita au
// baada ya WebSocket kuunganishwa upya). Kwa contract iliyofungwa, chanzo
// cha kuaminika zaidi ni "profit_table" — historia ya transactions
// zilizokamilika — hivyo tunatafuta contract_id husika humo.
async function getClosedContractFromHistory(contractId) {
  const res = await send({
    profit_table: 1,
    description: 1,
    limit: 25,
    sort: 'DESC',
  });
  const rows = res.profit_table?.transactions || [];
  return rows.find((t) => String(t.contract_id) === String(contractId)) || null;
}

// Transactions zilizofungwa (chanzo cha ukweli cha Deriv) — hutumika kujaza
// faida/hasara ya trades zilizofungwa kwa mkono, na SL/TP, au wakati bot ilikuwa imezimwa.
async function getProfitTable(limit = 100) {
  const res = await send({ profit_table: 1, description: 1, limit: Math.max(1, Math.min(500, Number(limit) || 100)), sort: 'DESC' });
  return res.profit_table?.transactions || [];
}

// ─────────────────────────────────────────────
// Candles za kihistoria (OHLC) kutoka Deriv — mbadala wa Twelve Data kwa
// signal ili bei ya signal iwe ileile ya trade. Umbo la matokeo ni LILELILE
// la Twelve Data (/time_series, ASC): { datetime, open, high, low, close }
// (datetime ni UTC: "YYYY-MM-DD HH:MM:SS", au "YYYY-MM-DD" kwa daily),
// ili indicators.js/backtest/forexSignal visibadilike.
// Candle ya mwisho ni ya muda unaoendelea (haijafungwa) — kama Twelve Data.
// ─────────────────────────────────────────────
const GRANULARITY_BY_INTERVAL = {
  '1min': 60, '2min': 120, '3min': 180, '5min': 300, '10min': 600, '15min': 900,
  '30min': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '8h': 28800, '1day': 86400,
};
const MAX_CANDLES_PER_REQUEST = 5000;

function epochToDatetime(epochSec, granularity) {
  const iso = new Date(Number(epochSec) * 1000).toISOString(); // 2026-10-04T08:00:00.000Z
  return granularity >= 86400 ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
}

async function getCandles(pair, interval, count) {
  const granularity = GRANULARITY_BY_INTERVAL[String(interval).toLowerCase()];
  if (!granularity) {
    throw new Error(`Interval "${interval}" haitambuliki kwa Deriv candles (zinazokubalika: ${Object.keys(GRANULARITY_BY_INTERVAL).join(', ')})`);
  }
  // "EUR/USD" au "EURUSD" -> "frxEURUSD"
  const symbol = toDerivSymbol(String(pair).replace(/[^A-Za-z]/g, ''));
  const n = Math.max(1, Math.min(Number(count) || 100, MAX_CANDLES_PER_REQUEST));
  // Deriv `count` hufanya kazi kama dirisha la muda: weekend haina candles, kwa
  // hiyo tunaomba mara 2 (bila gharama) kisha tunakata n za mwisho — idadi kamili
  // inapatikana hata baada ya weekend/likizo.
  const reqCount = Math.min(n * 2, MAX_CANDLES_PER_REQUEST);

  const res = await send({
    ticks_history: symbol,
    adjust_start_time: 1, // soko likiwa limefungwa (weekend) bado rudisha candles za mwisho zilizopo
    count: reqCount,
    end: 'latest',
    granularity,
    style: 'candles',
  });

  const raw = res && res.candles;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Deriv haikurudisha candles kwa ${symbol} (${interval}). ` +
        `Jibu lilikuwa na: ${res ? Object.keys(res).join(', ') : '(tupu)'}`
    );
  }

  return raw.slice(-n).map((c) => ({
    datetime: epochToDatetime(c.epoch ?? c.open_time ?? c.time, granularity),
    open: String(c.open),
    high: String(c.high),
    low: String(c.low),
    close: String(c.close),
  }));
}

async function getBalance() {
  const res = await send({ balance: 1 });
  return res.balance; // { balance, currency, ... }
}

module.exports = {
  placeMultiplier,
  ALLOWED_MULTIPLIERS,
  MIN_STAKE_USD,
  getOpenPositions,
  getOpenPositionsLive,
  updateContractLimits,
  getContractDetails,
  getClosedContractFromHistory,
  getProfitTable,
  closeContract,
  closeContractWithPnL,
  closeAll,
  getBalance,
  getAccountMode,
  getAccountState,
  switchAccount,
  onAccountSwitched,
  setRealMaxStake,
  MAX_STAKE_USD,
  MAX_MULTIPLIER,
  toDerivSymbol,
  getCandles,
};
