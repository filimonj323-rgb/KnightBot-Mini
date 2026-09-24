/**
 * derivTrader.js — Muunganiko na utekelezaji wa trade kupitia Deriv API
 * (WebSocket, https://api.deriv.com).
 *
 * DERIV_API_TOKEN (LAZIMA): Deriv → Settings → API Token → tengeneza token
 * yenye ruhusa za "Trade" na "Read".
 * DERIV_APP_ID (hiari): sajili app yako mwenyewe kwenye api.deriv.com kwa
 * matumizi ya kudumu; 1089 ni app_id ya majaribio ya Deriv (default).
 *
 * Aina ya contract inayotumika: "Multipliers" (MULTUP/MULTDOWN) — hii
 * ndiyo bidhaa ya Deriv inayofanana zaidi na forex CFD ya kawaida (leverage
 * kupitia "multiplier"), na INA Stop Loss/Take Profit ASILI kwenye contract
 * yenyewe (si kitu tunachosimamia sisi wenyewe kwa kufuatilia bei kila
 * wakati) — Deriv yenyewe inafunga contract moja kwa moja ikifika SL/TP.
 *
 * ⚠️⚠️ FOREX/MULTIPLIERS INA HATARI KUBWA (leverage). Hii SI ushauri wa
 * kifedha. Stop Loss na Take Profit ni LAZIMA kwenye kila trade — code hii
 * inakataa kufungua trade bila hizo.
 */

const WebSocket = require('ws');

const APP_ID = process.env.DERIV_APP_ID || '1089';
const API_TOKEN = process.env.DERIV_API_TOKEN || null;
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

// Ulinzi wa usalama (safety rails) — hata kwenye demo, tunazoea tabia njema
// tangu mwanzo ili zibaki pale live ikija baadaye.
const MAX_STAKE_USD = Number(process.env.DERIV_MAX_STAKE_USD || 50);
const MAX_MULTIPLIER = Number(process.env.DERIV_MAX_MULTIPLIER || 100);
const DEFAULT_MULTIPLIER = Number(process.env.DERIV_DEFAULT_MULTIPLIER || 20);

const REQUEST_TIMEOUT_MS = 15000;
const CONNECT_RETRIES = 3;
const CONNECT_RETRY_DELAY_MS = 2000;

let ws = null;
let authorized = false;
let connectPromise = null;
let reqCounter = 1;
const pending = new Map(); // req_id -> { resolve, reject }

function rejectAllPending(err) {
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Jaribio moja la kuunganisha (bila retry) — imetenganishwa ili connect()
// iweze kuijaribu tena kama itashindwa (mfano 520 ya Cloudflare, ambayo
// mara nyingi ni ya muda mfupi/kupita).
function connectOnce() {
  return new Promise((resolve, reject) => {
    // Headers hizi zinasaidia kuepuka ulinzi wa Cloudflare unaoweza
    // kuzuia maombi yasiyo na "User-Agent"/"Origin" ya kawaida ya browser,
    // ambao mara nyingine husababisha 520 kwa maombi ya moja kwa moja
    // kutoka seva (mfano Railway) badala ya browser.
    ws = new WebSocket(WS_URL, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Origin: 'https://app.deriv.com',
      },
      handshakeTimeout: 15000,
    });

    let settled = false;

    ws.on('open', async () => {
      try {
        const authRes = await sendRaw({ authorize: API_TOKEN });
        authorized = true;
        settled = true;
        resolve(authRes);
      } catch (err) {
        settled = true;
        reject(err);
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

    ws.on('close', () => {
      authorized = false;
      connectPromise = null;
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

  if (!API_TOKEN) {
    return Promise.reject(new Error('DERIV_API_TOKEN haipo kwenye env'));
  }

  connectPromise = (async () => {
    let lastErr;
    for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
      try {
        return await connectOnce();
      } catch (err) {
        lastErr = err;
        console.warn(`derivTrader: jaribio ${attempt}/${CONNECT_RETRIES} la kuunganisha limeshindwa —`, err.message);
        if (attempt < CONNECT_RETRIES) await sleep(CONNECT_RETRY_DELAY_MS * attempt);
      }
    }
    connectPromise = null;
    throw new Error(
      `Imeshindwa kuunganisha na Deriv baada ya majaribio ${CONNECT_RETRIES} (${lastErr?.message || 'sababu haijulikani'}). ` +
      `Kama tatizo ni "520", mara nyingi ni la muda mfupi upande wa Deriv/Cloudflare — subiri dakika chache kisha jaribu tena.`
    );
  })();

  return connectPromise;
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

async function ensureConnected() {
  if (!authorized) await connect();
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
// Utekelezaji wa trade
// ─────────────────────────────────────────────
async function placeMultiplier({ pair, direction, stake, stopLoss, takeProfit, multiplier }) {
  const amt = Math.min(Number(stake), MAX_STAKE_USD);
  if (!(amt > 0)) throw new Error('Stake si sahihi (lazima iwe namba > 0)');

  const sl = Number(stopLoss);
  const tp = Number(takeProfit);
  if (!(sl > 0) || !(tp > 0)) {
    throw new Error('Stop Loss na Take Profit ni LAZIMA (namba > 0)');
  }

  const mult = Math.min(Number(multiplier) || DEFAULT_MULTIPLIER, MAX_MULTIPLIER);
  const contractType = direction === 'BUY' ? 'MULTUP' : 'MULTDOWN';
  const symbol = toDerivSymbol(pair);

  const res = await send({
    buy: 1,
    price: amt,
    parameters: {
      amount: amt,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      symbol,
      multiplier: mult,
      limit_order: {
        stop_loss: sl,
        take_profit: tp,
      },
    },
  });

  return res.buy; // { contract_id, buy_price, longcode, ... }
}

async function getOpenPositions() {
  const res = await send({ portfolio: 1 });
  return res.portfolio?.contracts || [];
}

async function closeContract(contractId) {
  const res = await send({ sell: contractId, price: 0 }); // price:0 = kubali bei ya soko
  return res.sell;
}

async function closeAll() {
  const positions = await getOpenPositions();
  const results = [];
  for (const p of positions) {
    try {
      const r = await closeContract(p.contract_id);
      results.push({ contract_id: p.contract_id, ok: true, r });
    } catch (err) {
      results.push({ contract_id: p.contract_id, ok: false, error: err.message });
    }
  }
  return results;
}

async function getBalance() {
  const res = await send({ balance: 1 });
  return res.balance; // { balance, currency, ... }
}

module.exports = {
  placeMultiplier,
  getOpenPositions,
  closeContract,
  closeAll,
  getBalance,
  MAX_STAKE_USD,
  MAX_MULTIPLIER,
};
