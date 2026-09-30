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

async function isBridgeUp() {
  try {
    const data = await bridgeFetch('/health');
    return !!data.connected;
  } catch (err) {
    return false;
  }
}

async function getBalance() {
  const data = await bridgeFetch('/balance');
  return data.balance;
}

/**
 * @param {string} pair - mfano "EURUSD" au "EURUSD_otc"
 * @param {number} timeframeSeconds - mfano 60 (1min), 300 (5min)
 * @param {number} count - idadi ya candles za kurudi nyuma
 * @returns {Promise<{time:number, open:number, high:number, low:number, close:number}[]>}
 */
async function getCandles(pair, timeframeSeconds = 60, count = 100) {
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
  getBalance,
  getCandles,
  placeOrder,
  getOrderResult,
  getSignal,
  BRIDGE_URL,
};
