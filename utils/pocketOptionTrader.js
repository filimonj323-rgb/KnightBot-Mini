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
  return { orderId: data.order_id, raw: data.raw };
}

async function getOrderResult(orderId) {
  const data = await bridgeFetch(`/order/${encodeURIComponent(orderId)}/result`);
  return data.result;
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
  getSignal,
  BRIDGE_URL,
};
