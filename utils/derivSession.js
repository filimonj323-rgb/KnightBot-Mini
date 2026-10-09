/**
 * derivSession.js — Muunganisho wa Deriv wa KILA mteja (token yake mwenyewe, akaunti yake mwenyewe).
 *
 * Tofauti na utils/derivTrader.js (singleton ya owner, env vars), hapa kila mteja ana `DerivSession` yake:
 *   REST POST /trading/v1/options/accounts/{id}/otp  →  URL ya WebSocket yenye OTP  →  amri za Deriv.
 * Token inapatikana TU kupitia derivAccounts.getTokenForManage() (imesimbwa DB, inafunguliwa wakati wa kuunganisha,
 * haihifadhiwi kwenye property ya session — inatumika mara moja kupata OTP).
 *
 * Hii ni safu ya MUUNGANISHO + amri ghafi za Deriv. SERA (vikomo, idhini, kill switch) iko kwenye
 * utils/derivCustomerTrader.js — usiite placeMultiplier() moja kwa moja kutoka nje ya hiyo.
 *
 * Sifa: kuunganisha unapohitajika (lazy), heartbeat (ping/pong) kuua "zombie", kuunganisha upya otomatiki, timeout ya kila ombi,
 * kufunga ukikaa bila kutumika (IDLE_MS), na kikomo cha jumla cha miunganisho (MAX_SESSIONS).
 * Siri: OTP URL, token na headers HAZIANDIKWI kwenye log kamwe.
 */

const axios = require('axios');
const WebSocket = require('ws');
const accounts = require('./derivAccounts');

const API_BASE = process.env.DERIV_API_BASE || 'https://api.derivws.com';
const REST_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = Number(process.env.DERIV_REQUEST_TIMEOUT_MS || 15000);
const HEARTBEAT_MS = Number(process.env.DERIV_SESSION_HEARTBEAT_MS || 60 * 1000);
const PONG_TIMEOUT_MS = Number(process.env.DERIV_SESSION_PONG_MS || 20 * 1000);
const IDLE_MS = Number(process.env.DERIV_SESSION_IDLE_MS || 5 * 60 * 1000);
let MAX_SESSIONS = Number(process.env.DERIV_MAX_SESSIONS || 20);

const ALLOWED_MULTIPLIERS = [100, 200, 300, 500, 800];

class SessionError extends Error {
  constructor(userMessage, code) {
    super(userMessage);
    this.userMessage = userMessage;
    this.code = code || 'SESSION';
  }
}

function parseLimitOrderAmountConstraint(message) {
  const msg = String(message || '');
  let m = msg.match(/(?:equal to or higher than|higher than|greater than|at least)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m && Number(m[1]) > 0) return { type: 'min', value: Number(m[1]) };
  m = msg.match(/(?:equal to or lower than|lower than|less than|at most|maximum of)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  if (m && Number(m[1]) > 0) return { type: 'max', value: Number(m[1]) };
  return null;
}

class DerivSession {
  constructor(phone) {
    this.phone = String(phone);
    this.ws = null;
    this.ready = false;
    this.connectPromise = null;
    this.reqCounter = 1;
    this.pending = new Map();
    this.heartbeatTimer = null;
    this.pongTimer = null;
    this.lastUsed = Date.now();
    this.closedByUs = false;
  }

  // ── muunganisho ───────────────────────────────────────────────────────────────────
  async _fetchOtpUrl() {
    const appId = process.env.DERIV_APP_ID;
    if (!appId) throw new SessionError('Huduma ya Deriv haijawekwa vizuri upande wa server.', 'NO_APP_ID');
    const { token, accountId } = await accounts.getTokenForManage(this.phone); // inatupa DerivAccountError ikikataliwa
    let res;
    try {
      res = await axios.post(
        `${API_BASE}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
        {},
        {
          headers: { Authorization: `Bearer ${token}`, 'Deriv-App-ID': appId },
          timeout: REST_TIMEOUT_MS,
          validateStatus: () => true,
          maxRedirects: 0,
        }
      );
    } catch {
      throw new SessionError('Imeshindwa kufikia Deriv sasa hivi. Jaribu tena baadaye.', 'NETWORK');
    }
    if (res.status === 401 || res.status === 403) {
      await accounts.markInvalid(this.phone, 'Deriv imekataa token (huenda imekwisha muda au imefutwa). Iunganishe upya.').catch(() => {});
      throw new SessionError('Deriv imekataa token yako. Itengeneze upya na uiunganishe tena.', 'TOKEN_REJECTED');
    }
    const url = res.data?.data?.url;
    if (res.status < 200 || res.status >= 300 || !url) {
      throw new SessionError('Deriv haikutoa muunganisho (hitilafu ya Deriv). Jaribu tena baadaye.', 'UPSTREAM');
    }
    return url;
  }

  _connectWs(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;
      this.closedByUs = false;

      ws.on('open', () => {
        this.ready = true;
        settled = true;
        this._startHeartbeat(ws);
        resolve();
      });
      ws.on('pong', () => {
        if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
      });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const p = this.pending.get(msg.req_id);
        if (!p) return;
        this.pending.delete(msg.req_id);
        if (msg.error) {
          const err = new Error(msg.error.message || 'Deriv API error');
          err.code = msg.error.code;
          p.reject(err);
        } else {
          p.resolve(msg);
        }
      });
      ws.on('close', () => {
        if (this.ws === ws) { this.ready = false; this.ws = null; this.connectPromise = null; }
        this._stopHeartbeat();
        this._rejectAll(new SessionError('Muunganisho wa Deriv umekatika.', 'DISCONNECTED'));
      });
      ws.on('error', () => {
        // Usiandike err.message — kwa 'unexpected-response' inaweza kubeba URL (OTP).
        if (!settled) { settled = true; reject(new SessionError('Imeshindwa kuunganisha na Deriv.', 'NETWORK')); }
      });
    });
  }

  async connect() {
    if (this.ready) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      try {
        const url = await this._fetchOtpUrl();
        await this._connectWs(url);
      } catch (err) {
        this.connectPromise = null;
        throw err;
      }
    })();
    return this.connectPromise;
  }

  _startHeartbeat(ws) {
    this._stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || !this.ready || this.pongTimer) return;
      try { ws.ping(); } catch { return; }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.ws !== ws) return;
        try { ws.terminate(); } catch { /* ignore */ } // 'close' itafuata na kusafisha
      }, PONG_TIMEOUT_MS);
      if (this.pongTimer.unref) this.pongTimer.unref();
    }, HEARTBEAT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  _rejectAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  close() {
    this.closedByUs = true;
    this._stopHeartbeat();
    this._rejectAll(new SessionError('Muunganisho umefungwa.', 'CLOSED'));
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    this.connectPromise = null;
    if (ws) { try { ws.terminate(); } catch { /* ignore */ } }
  }

  async send(payload) {
    await this.connect();
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || !this.ready) return reject(new SessionError('Muunganisho wa Deriv umekatika.', 'DISCONNECTED'));
      const req_id = this.reqCounter++;
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new SessionError('Muda wa ombi la Deriv umeisha.', 'TIMEOUT'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(req_id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        ws.send(JSON.stringify({ ...payload, req_id }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(req_id);
        reject(new SessionError('Imeshindwa kutuma ombi kwa Deriv.', 'SEND'));
      }
    });
  }

  // ── amri za Deriv (ghafi; sera iko kwenye derivCustomerTrader) ───────────────────────
  async getBalance() {
    return (await this.send({ balance: 1 })).balance; // { balance, currency }
  }

  async getPortfolio() {
    const res = await this.send({ portfolio: 1 });
    return res.portfolio?.contracts || [];
  }

  async getContract(contractId) {
    return (await this.send({ proposal_open_contract: 1, contract_id: Number(contractId) })).proposal_open_contract;
  }

  async getOpenPositionsLive() {
    const list = await this.getPortfolio();
    return Promise.all(
      list.map(async (p) => {
        try {
          const d = await this.getContract(p.contract_id);
          return { ...p, bid_price: d?.bid_price ?? p.bid_price, profit: d?.profit ?? p.profit, current_spot: d?.current_spot, limit_order: d?.limit_order ?? p.limit_order };
        } catch {
          return p;
        }
      })
    );
  }

  async getClosedFromHistory(contractId) {
    const res = await this.send({ profit_table: 1, description: 1, limit: 50, sort: 'DESC' });
    const rows = res.profit_table?.transactions || [];
    return rows.find((t) => String(t.contract_id) === String(contractId)) || null;
  }

  /** proposal kisha buy. Vigezo VIMEKWISHA kuthibitishwa na derivCustomerTrader. Inarudisha { ...buy, stop_loss, take_profit }. */
  async placeMultiplier({ underlyingSymbol, direction, stake, stopLoss, takeProfit, multiplier }) {
    const contractType = direction === 'BUY' ? 'MULTUP' : 'MULTDOWN';
    const build = (sl, tp) => ({
      proposal: 1, amount: stake, basis: 'stake', contract_type: contractType, currency: 'USD', multiplier,
      underlying_symbol: underlyingSymbol, limit_order: { stop_loss: sl, take_profit: tp },
    });
    let sl = stopLoss, tp = takeProfit, res;
    try {
      res = await this.send(build(sl, tp));
    } catch (err) {
      // Deriv inaweza kukataa SL/TP kwa kiwango cha chini/juu — rekebisha MARA MOJA kwa uwiano uleule (kama derivTrader).
      const c = parseLimitOrderAmountConstraint(err.message);
      if (!c) throw err;
      const ratio = sl > 0 ? tp / sl : 2;
      sl = c.type === 'min' ? Number((c.value + 0.01).toFixed(2)) : Number(Math.max(c.value - 0.01, 0.01).toFixed(2));
      tp = Number((sl * ratio).toFixed(2));
      res = await this.send(build(sl, tp));
    }
    const proposal = res.proposal;
    if (!proposal?.id) throw new SessionError('Deriv haikutoa proposal.', 'NO_PROPOSAL');
    let buyRes;
    try {
      buyRes = await this.send({ buy: proposal.id, price: proposal.ask_price ?? stake });
    } catch (err) {
      err.stage = 'buy'; // timeout/kukatika hapa = matokeo HAYAJULIKANI (trade inaweza kuwa imefunguliwa)
      throw err;
    }
    return { ...buyRes.buy, stop_loss: sl, take_profit: tp };
  }

  async closeContract(contractId) {
    return (await this.send({ sell: Number(contractId), price: 0 })).sell;
  }

  /** Inafunga na kuhesabu faida/hasara HALISI (sold_for - buy_price), ikishindikana profit_table. */
  async closeContractWithPnL(contractId) {
    let buyPrice;
    try { buyPrice = Number((await this.getContract(contractId))?.buy_price); } catch { /* endelea */ }
    const sell = await this.closeContract(contractId);
    const soldFor = Number(sell?.sold_for);
    let profit = Number.isFinite(soldFor) && Number.isFinite(buyPrice) ? soldFor - buyPrice : NaN;
    if (!Number.isFinite(profit)) {
      try {
        const closed = await this.getClosedFromHistory(contractId);
        if (closed) {
          const cp = Number(closed.profit);
          profit = Number.isFinite(cp) ? cp : Number(closed.sell_price) - Number(closed.buy_price);
        }
      } catch { /* profit inabaki NaN */ }
    }
    return { ...sell, buy_price: buyPrice, sold_for: soldFor, profit: Number.isFinite(profit) ? profit : null };
  }
}

// ── Registry ───────────────────────────────────────────────────────────────────────
const sessions = new Map(); // phone -> DerivSession

function getSession(phone) {
  const key = String(phone);
  let s = sessions.get(key);
  if (s) return s;
  if (sessions.size >= MAX_SESSIONS) {
    // Jaribu kuondoa session iliyokaa bila kutumika kwa muda mrefu zaidi.
    let oldest = null;
    for (const x of sessions.values()) if (!oldest || x.lastUsed < oldest.lastUsed) oldest = x;
    if (oldest && Date.now() - oldest.lastUsed > 30 * 1000) { oldest.close(); sessions.delete(oldest.phone); }
    else throw new SessionError('Seva ina wateja wengi wanaotumia Deriv sasa hivi. Jaribu tena baada ya dakika chache.', 'BUSY');
  }
  s = new DerivSession(key);
  sessions.set(key, s);
  return s;
}

function closeSession(phone) {
  const s = sessions.get(String(phone));
  if (s) { s.close(); sessions.delete(String(phone)); }
}

function closeAllSessions() {
  for (const s of sessions.values()) s.close();
  sessions.clear();
}

// Token ikibadilika/ikiondolewa/ikikataliwa → funga muunganisho wa mteja huyo mara moja.
accounts.events.on('session-close', closeSession);

// Funga zilizokaa bila kutumika.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [phone, s] of sessions) if (now - s.lastUsed > IDLE_MS) { s.close(); sessions.delete(phone); }
}, 60 * 1000);
if (sweeper.unref) sweeper.unref();

module.exports = {
  DerivSession,
  SessionError,
  ALLOWED_MULTIPLIERS,
  getSession,
  closeSession,
  closeAllSessions,
  _sessionCount: () => sessions.size,
  _setMaxSessions: (n) => { MAX_SESSIONS = n; }, // kwa majaribio tu
  _parseConstraint: parseLimitOrderAmountConstraint,
};
