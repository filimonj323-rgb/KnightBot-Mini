/**
 * pocketOptionTrader.js — Node.js client inayoongea na pocket_bridge/app.py
 * (Python, Flask) kwa HTTP, ili bot kuu ya Node isihitaji kuandika upya
 * WebSocket/socket.io protocol isiyo rasmi ya Pocket Option.
 *
 * Kabla ya kutumia: endesha `python3 pocket_bridge/app.py` (kando na bot
 * kuu), weka POCKET_BRIDGE_URL kwenye .env ya Node ikielekeza huko (mfano
 * http://127.0.0.1:5055), na POCKET_BRIDGE_SECRET ilinganishwe na ile ya
 * pocket_bridge/.env.
 */

// Bridge iko ndani ya container MOJA ile ile (Njia A — child process
// inayoanzishwa na index.js), kwa hiyo URL ni localhost ya kudumu — si
// env var tena. Port lazima ilingane na pocket_bridge/app.py (5055).
const pocketStore = require('./pocketStore');

const BRIDGE_URL = 'http://127.0.0.1:5055';
// Secret inayounganisha Node↔Python — hii pekee inabaki env (Railway)
// kwa sababu ni sensitive na lazima ilingane na POCKET_BRIDGE_SECRET
// ya pocket_bridge/.env upande wa Python.
const BRIDGE_SECRET = process.env.POCKET_BRIDGE_SECRET || 'badilisha_hii_iwe_secret_ndefu';

async function bridgeFetch(path, opts = {}) {
  const url = `${BRIDGE_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Secret': BRIDGE_SECRET,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Pocket Option bridge error (${res.status})`);
  }
  return data;
}

// Bridge "iko juu" = process ya Python inajibu HTTP. Haihitaji connection ya
// Pocket Option iwe tayari (inaunganishwa lazily/eagerly ndani ya bridge) —
// vinginevyo amri zote zingekataliwa kabla ya connection ya kwanza kuanzishwa.
async function isBridgeUp() {
  try {
    const data = await bridgeFetch('/health');
    return data.ok === true;
  } catch (err) {
    return false;
  }
}

// Hali kamili ya bridge (connected, ssid_set, last_error) kwa diagnostics.
async function getBridgeStatus() {
  try {
    return await bridgeFetch('/health');
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getBalance() {
  const data = await bridgeFetch('/balance');
  return data.balance;
}

// Orodha ya assets zote zinazotambulika (cache saa 1).
let assetsCache = { at: 0, list: null };
async function getAssets() {
  if (assetsCache.list && Date.now() - assetsCache.at < 60 * 60 * 1000) return assetsCache.list;
  const data = await bridgeFetch('/assets');
  assetsCache = { at: Date.now(), list: data.assets };
  return data.assets;
}

/**
 * Linganisha jina la jozi na orodha halisi ya assets ya Pocket Option
 * (majina ni case-sensitive: "USDJPY", "EURUSD_otc"). Mtumiaji akiandika
 * "usdjpy" au "EURUSD_OTC" tunalirekebisha badala ya kupata "Invalid asset".
 * Kama jina halipo kabisa, tunatupa error yenye mapendekezo.
 */
async function resolveAsset(pair) {
  const raw = String(pair || '').trim();
  if (!raw) throw new Error('pair inahitajika');
  const norm = (x) => String(x).replace(/[^a-z0-9]/gi, '').toLowerCase();
  let list;
  try {
    list = await getAssets();
  } catch (err) {
    // Orodha haipatikani — angalau sahihisha muundo wa kawaida.
    const isOtc = /otc$/i.test(raw);
    const base = norm(raw).replace(/otc$/, '').toUpperCase();
    return isOtc ? `${base}_otc` : base;
  }
  const exact = list.find((a) => a === raw);
  if (exact) return exact;
  const wanted = norm(raw);
  const ci = list.find((a) => norm(a) === wanted);
  if (ci) return ci;
  const stem = wanted.replace(/otc$/, '');
  const suggestions = list.filter((a) => norm(a).includes(stem)).slice(0, 6);
  throw new Error(
    `Jozi "${raw}" haipo kwenye orodha ya Pocket Option.` +
      (suggestions.length ? ` Labda: ${suggestions.join(', ')}` : '')
  );
}

/**
 * @param {string} pair - mfano "EURUSD" au "EURUSD_otc"
 * @param {number} timeframeSeconds - mfano 60 (1min), 300 (5min)
 * @param {number} count - idadi ya candles za kurudi nyuma
 * @returns {Promise<{time:number, open:number, high:number, low:number, close:number}[]>}
 */
async function getCandles(pair, timeframeSeconds = 60, count = 100) {
  pair = await resolveAsset(pair);
  const query = new URLSearchParams({ pair, timeframe: timeframeSeconds, count });
  const data = await bridgeFetch(`/candles?${query.toString()}`);
  return data.candles;
}

/**
 * Fungua order ya Binary/Turbo Option.
 * @param {{pair:string, direction:'BUY'|'SELL', amount:number, expirySeconds:number}} opts
 */
async function placeOrder({ pair, direction, amount, expirySeconds }) {
  if (!pair) throw new Error('pair inahitajika');
  pair = await resolveAsset(pair);
  if (!(amount > 0)) throw new Error('amount lazima iwe zaidi ya 0');
  if (!(expirySeconds > 0)) throw new Error('expirySeconds lazima iwe zaidi ya 0');

  const data = await bridgeFetch('/order', {
    method: 'POST',
    body: JSON.stringify({
      pair,
      direction: direction === 'SELL' ? 'SELL' : 'BUY',
      amount,
      expiry_seconds: expirySeconds,
    }),
  });

  // Hifadhi trade kwenye database (Turso) ili restart isiipoteze, kisha
  // anzisha ufuatiliaji wa matokeo yake itakapofika expiry.
  const direct = direction === 'SELL' ? 'SELL' : 'BUY';
  await pocketStore.recordOpenTrade({ orderId: data.order_id, pair, direction: direct, stake: amount, expirySeconds });
  scheduleSettle(String(data.order_id), Date.now() + expirySeconds * 1000);

  return { orderId: data.order_id, raw: data.raw };
}

// Matokeo ni "ya mwisho" pale bridge inapoweza kubaini win/loss (boolean).
const isFinalResult = (r) => r && typeof r.win === 'boolean';

async function getOrderResult(orderId) {
  // Trade iliyokwisha kufungwa na kuhifadhiwa (hata kabla ya restart) —
  // rudisha matokeo yaliyohifadhiwa badala ya kuuliza bridge tena.
  const stored = await pocketStore.getClosedResult(orderId);
  if (stored) return stored;

  const data = await bridgeFetch(`/order/${encodeURIComponent(orderId)}/result`);
  if (isFinalResult(data.result)) {
    await pocketStore.recordClosedTrade(orderId, {
      win: data.result.win,
      profit: data.result.profit ?? data.result.pnl,
      result: data.result,
    });
  }
  return data.result;
}

// ── Ufuatiliaji wa matokeo (unaendelea hata baada ya restart) ───────────
const SETTLE_RETRY_MS = 30 * 1000;
const SETTLE_GIVE_UP_MS = 15 * 60 * 1000; // baada ya expiry + dakika 15 bila jibu -> "unknown"
const settling = new Set();

function scheduleSettle(orderId, expiresAt) {
  if (settling.has(orderId)) return;
  settling.add(orderId);
  const run = async () => {
    try {
      const result = await getOrderResult(orderId); // inahifadhi yenyewe kama ni ya mwisho
      if (isFinalResult(result)) return settling.delete(orderId);
    } catch (err) {
      // bridge chini / order haijulikani kwa bridge mpya — jaribu tena hapa chini
    }
    if (Date.now() - expiresAt > SETTLE_GIVE_UP_MS) {
      await pocketStore.recordClosedTrade(orderId, { status: 'unknown' });
      return settling.delete(orderId);
    }
    setTimeout(run, SETTLE_RETRY_MS);
  };
  setTimeout(run, Math.max(0, expiresAt - Date.now()) + 5000);
}

let tradesRestored = false;
/**
 * Inaitwa kwenye startup (index.js): inarejesha trades zilizokuwa wazi
 * kabla ya restart na kuendelea kufuatilia matokeo yao. Inaitwa mara moja tu
 * hata 'open' ya WhatsApp ikirudiwa baada ya reconnect.
 */
async function restoreOpenTrades() {
  if (tradesRestored) return 0;
  tradesRestored = true;
  const open = await pocketStore.getOpenTrades();
  for (const t of open) scheduleSettle(String(t.orderId), Number(t.expiresAt));
  if (open.length) console.log(`[pocket] Trades ${open.length} zilizokuwa wazi zimerejeshwa kutoka database.`);
  return open.length;
}

/**
 * Signal ya BUY/SELL/NEUTRAL + strength, ikitumia candles ZA POCKET OPTION
 * MWENYEWE (siyo Twelve Data) — inafaa kwa OTC pairs na timeframe fupi
 * (dakika 1-5) zinazolingana na expiry halisi ya Binary/Turbo Options.
 */
async function getSignal(pair, timeframeSeconds = 60) {
  const { computeSignalFromCandles } = require('./indicators');
  const candles = await getCandles(pair, timeframeSeconds, 100);
  if (!candles || candles.length < 30) {
    throw new Error('Candles hazitoshi kuhesabu signal (chini ya 30).');
  }
  return computeSignalFromCandles(candles);
}

module.exports = {
  isBridgeUp,
  getBridgeStatus,
  getBalance,
  getCandles,
  getAssets,
  placeOrder,
  getOrderResult,
  restoreOpenTrades,
  getSignal,
  BRIDGE_URL,
};
