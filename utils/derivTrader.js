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

function checkEnv() {
  const missing = [];
  if (!APP_ID) missing.push('DERIV_APP_ID');
  if (!API_TOKEN) missing.push('DERIV_API_TOKEN');
  if (missing.length) {
    throw new Error(`Env zifuatazo hazipo: ${missing.join(', ')}`);
  }
}

let cachedAccountId = ACCOUNT_ID || null;

// Badala ya kutegemea loginid ya kawaida (VRTC.../CR...) ambayo SI sahihi
// kwenye mfumo huu mpya ("Options trading account"), tunauliza Deriv
// yenyewe ni account ID gani ya kutumia — hii ndiyo sababu ya ile "404"
// tuliyoiona (DERIV_ACCOUNT_ID iliyokisiwa haikutambulika).
async function resolveAccountId() {
  if (cachedAccountId) return cachedAccountId;

  const { data } = await axios.get(`${API_BASE}/trading/v1/options/accounts`, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Deriv-App-ID': APP_ID,
    },
    timeout: REST_TIMEOUT_MS,
  });

  const accounts = data?.data || data?.accounts || [];
  if (!Array.isArray(accounts) || !accounts.length) {
    throw new Error('Hakuna Options trading account iliyopatikana kwenye Deriv (angalia DERIV_APP_ID/DERIV_API_TOKEN)');
  }

  const acc = accounts.find((a) => a.is_virtual || a.demo || a.account_type === 'demo') || accounts[0];
  cachedAccountId = acc.account_id || acc.id;
  if (!cachedAccountId) {
    throw new Error('Account ID haikupatikana kwenye response ya Deriv (muundo umebadilika?)');
  }
  return cachedAccountId;
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
      resolve();
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
      wsReady = false;
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
  const amt = Math.min(Number(stake), MAX_STAKE_USD);
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

  // Hatua A: proposal (bei ya sasa ya kufungua contract hii)
  const proposalRes = await send({
    proposal: 1,
    amount: amt,
    basis: 'stake',
    contract_type: contractType,
    currency: 'USD',
    multiplier: mult,
    underlying_symbol: underlyingSymbol,
    limit_order: {
      stop_loss: sl,
      take_profit: tp,
    },
  });

  const proposal = proposalRes.proposal;
  if (!proposal?.id) throw new Error('Proposal haikupatikana kutoka Deriv');

  // Hatua B: buy kwa kutumia proposal id
  const buyRes = await send({
    buy: proposal.id,
    price: proposal.ask_price ?? amt,
  });

  return buyRes.buy; // { contract_id, buy_price, longcode, ... }
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
        };
      } catch (err) {
        return p; // ukiona hitilafu kwa contract moja, bado onyesha nyingine
      }
    })
  );
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

async function getContractDetails(contractId) {
  const res = await send({ proposal_open_contract: 1, contract_id: contractId });
  return res.proposal_open_contract;
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
  getContractDetails,
  closeContract,
  closeAll,
  getBalance,
  MAX_STAKE_USD,
  MAX_MULTIPLIER,
};
