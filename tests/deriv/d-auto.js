// Majaribio ya hatua (d): auto-trade ya wateja (utils/derivCustomerAuto.js) juu ya derivSession/derivTrades/derivCustomerTrader.
// forexSignal na autoTrader (owner) = mocks zinazodhibitiwa na jaribio; Deriv = injini bandia; DB = node:sqlite.
// DB = node:sqlite (DDL halisi + migration ya ownerPhone); Deriv = injini bandia ya ndani (REST + WebSocket);
// ws/axios = shim (npm inazuia — HAZIJARIBIWA moduli halisi).
const path = require('path'), fs = require('fs'), http = require('http'), Module = require('module'), { EventEmitter } = require('events');
const { DatabaseSync } = require('node:sqlite');
const assert = require('assert');
const ROOT = process.argv[2];
const R = (p) => path.join(ROOT, p);
const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logs = [];
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => logs.push(a.map(String).join(' '));

// ---------------- env ----------------
process.env.TOKENVAULT_KEY = 'e'.repeat(64);
process.env.DERIV_APP_ID = 'app12345';
process.env.DERIV_API_BASE = 'http://deriv.fake';
process.env.DERIV_REQUEST_TIMEOUT_MS = '400';
process.env.DERIV_SESSION_HEARTBEAT_MS = '60';
process.env.DERIV_SESSION_PONG_MS = '40';
process.env.DERIV_MAX_SESSIONS = '50';
process.env.DERIV_AUTO_PAIR_STAGGER_MS = '0';
process.env.DERIV_AUTO_STAKE_USD = '2';
process.env.DERIV_AUTO_MAX_CONSECUTIVE_LOSSES = '3';

// ---------------- DB ----------------
const ddl = fs.readFileSync(R('pairing/db.js'), 'utf8');
const getDDL = (n) => new RegExp('`(CREATE TABLE IF NOT EXISTS ' + n + ' \\([\\s\\S]*?\\))`').exec(ddl)[1];
const sqlite = new DatabaseSync(':memory:');
for (const t of ['deriv_accounts', 'fx_auto_settings', 'fx_auto_trades']) sqlite.exec(getDDL(t));
sqlite.exec('ALTER TABLE fx_auto_trades ADD COLUMN ownerPhone TEXT'); // migration halisi ya db.js
let failDb = false;
const dbMock = { async query(sql, a = []) { if (failDb) throw new Error('DB chini'); const st = sqlite.prepare(sql); if (/^\s*select/i.test(sql)) return { rows: st.all(...a).map((r) => ({ ...r })) }; return { rows: [], rowsAffected: st.run(...a).changes }; } };
const dbPath = R('pairing/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

// ---------------- Deriv bandia ----------------
const TOKENS = {}; // token -> { accountId, demo, balance }
const ACCT = {};   // accountId -> state
const F = {
  buys: 0, sells: 0, proposals: [], requests: [], otpCalls: 0, sockets: new Set(),
  minSl: 0.45, mutePong: false, dropBuyReply: false, failProposal: null, nextPnl: 0.5, otp401: new Set(), contractSeq: 1000,
};
function addAccount(token, accountId, demo = true) {
  TOKENS[token] = { accountId, demo };
  ACCT[accountId] = { balance: 10000, contracts: new Map(), history: [], proposals: new Map() };
}
function engine(accountId, req) {
  const A = ACCT[accountId];
  const ok = (extra) => ({ req_id: req.req_id, ...extra });
  const err = (message, code = 'Err') => ({ req_id: req.req_id, error: { message, code } });
  F.requests.push({ accountId, ...req });
  if (req.balance) return ok({ balance: { balance: A.balance, currency: 'USD' } });
  if (req.portfolio) return ok({ portfolio: { contracts: [...A.contracts.values()].map((c) => ({ contract_id: c.id, symbol: c.symbol, buy_price: c.buy, shortcode: `${c.type}_${c.symbol}`, contract_type: c.type })) } });
  if (req.proposal_open_contract) { const c = A.contracts.get(Number(req.contract_id)); if (!c) return err('Contract not found'); return ok({ proposal_open_contract: { buy_price: c.buy, bid_price: c.buy + 0.1, profit: 0.1, current_spot: 1.1, limit_order: c.limit } }); }
  if (req.proposal) {
    F.proposals.push(req);
    if (F.failProposal) return err(F.failProposal);
    if (req.limit_order.stop_loss < F.minSl) return err(`Stop loss must be equal to or higher than ${F.minSl}`);
    const id = 'prop' + Math.random().toString(16).slice(2);
    A.proposals.set(id, req);
    return ok({ proposal: { id, ask_price: req.amount } });
  }
  if (req.buy) {
    if (F.dropBuyReply) { F.dropBuyReply = false; F.buys++; const p = A.proposals.get(req.buy); const id = ++F.contractSeq; A.contracts.set(id, { id, symbol: p.underlying_symbol, type: p.contract_type, buy: p.amount, limit: p.limit_order }); return null; }
    const p = A.proposals.get(req.buy); if (!p) return err('Invalid proposal');
    F.buys++;
    const id = ++F.contractSeq;
    A.contracts.set(id, { id, symbol: p.underlying_symbol, type: p.contract_type, buy: p.amount, limit: p.limit_order });
    return ok({ buy: { contract_id: id, buy_price: p.amount, longcode: 'Multiplier test' } });
  }
  if (req.sell) {
    const c = A.contracts.get(Number(req.sell)); if (!c) return err('Contract not found');
    F.sells++;
    const sold = c.buy + F.nextPnl; A.contracts.delete(c.id); A.history.unshift({ contract_id: c.id, buy_price: c.buy, sell_price: sold, profit: F.nextPnl });
    return ok({ sell: { contract_id: c.id, sold_for: sold } });
  }
  if (req.profit_table) return ok({ profit_table: { transactions: A.history } });
  return err('Unknown request');
}
class FakeWS extends EventEmitter {
  constructor(url) {
    super();
    this.url = url; this.closed = false;
    const m = /otp=([^&]+)/.exec(url); this.accountId = m && decodeURIComponent(m[1]);
    F.sockets.add(this);
    setTimeout(() => { if (!this.closed) this.emit('open'); }, 5);
  }
  send(data) {
    const req = JSON.parse(data);
    setTimeout(() => {
      if (this.closed) return;
      const r = engine(this.accountId, req);
      if (r) this.emit('message', JSON.stringify(r));
    }, 3);
  }
  ping() { if (!F.mutePong) setTimeout(() => !this.closed && this.emit('pong'), 2); }
  terminate() { if (this.closed) return; this.closed = true; F.sockets.delete(this); setImmediate(() => this.emit('close')); }
}
const axiosShim = {
  async get(url, { headers = {} } = {}) {
    const t = (headers.Authorization || '').replace('Bearer ', '');
    if (!/\/trading\/v1\/options\/accounts$/.test(url)) return { status: 404, data: {} };
    const acc = TOKENS[t]; if (!acc) return { status: 401, data: {} };
    return { status: 200, data: { data: [{ account_id: acc.accountId, is_virtual: acc.demo, currency: 'USD', balance: 10000 }] } };
  },
  async post(url, body, { headers = {} } = {}) {
    const m = /\/accounts\/([^/]+)\/otp$/.exec(url);
    if (!m) return { status: 404, data: {} };
    F.otpCalls++;
    const t = (headers.Authorization || '').replace('Bearer ', '');
    const acc = TOKENS[t];
    if (!acc || F.otp401.has(t) || acc.accountId !== decodeURIComponent(m[1])) return { status: 401, data: {} };
    return { status: 200, data: { data: { url: `wss://deriv.fake/ws?otp=${encodeURIComponent(acc.accountId)}&secret=OTPSECRET${F.otpCalls}` } } };
  },
};

// ---------------- stubs za moduli nzito + shims ----------------
const sent = [];
const PHONES = { A: '255711000001', B: '255711000002', C: '255711000003', D: '255711000004', E: '255711000005', G: '255711000006', H: '255711000007' };
const instanceStub = {
  async assertActiveForToken(tok) { const m = /^tok-([A-Z])/.exec(tok); if (m && PHONES[m[1]]) return PHONES[m[1]]; throw new Error('Dashboard link si sahihi. Tumia link uliyopewa baada ya kuunganisha.'); },
  async sendToSelfChat(phone, text) { sent.push({ phone, text }); return true; },
};
const mk = () => { const f = function () {}; return new Proxy(f, { get: (t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : mk()), apply: () => mk(), construct: () => mk() }); };
const KEEP = new Set(['pairing/db.js', 'utils/derivAccounts.js', 'utils/derivCrypto.js', 'utils/derivPin.js', 'utils/derivValidate.js', 'utils/derivSession.js', 'utils/derivTrades.js', 'utils/derivCustomerTrader.js', 'utils/derivCustomerAuto.js']);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return axiosShim;
  if (request === 'ws') return FakeWS;
  let resolved; try { resolved = Module._resolveFilename(request, parent, isMain); } catch { return mk(); }
  if (resolved.startsWith(ROOT)) {
    const rel = path.relative(ROOT, resolved);
    if (rel === 'pairing/instanceManager.js') return instanceStub;
    if (rel === 'utils/forexSignal.js') return forexMock;
    if (rel === 'utils/autoTrader.js') return autoMock;
    if (!KEEP.has(rel)) return mk();
  }
  return origLoad.apply(this, arguments);
};


// ---------------- mocks za signal + autoTrader ya owner ----------------
const SIG = {};    // code -> { direction, strength, newsRisk }
const REGIME = {}; // code -> false = regime filter inazuia
const PAIRS_MOCK = [{ code: 'EURUSD', symbol: 'EUR/USD' }, { code: 'GBPUSD', symbol: 'GBP/USD' }, { code: 'EURGBP', symbol: 'EUR/GBP' }, { code: 'USDJPY', symbol: 'USD/JPY' }];
const forexMock = {
  DATA_SOURCE: 'deriv', DEFAULT_INTERVAL: '1h',
  async fetchForexSnapshot(symbol) { const code = symbol.replace('/', ''); if (SIG[code] && SIG[code].throws) throw new Error('signal chini'); return { code, price: 1.1, atr: 0.0011 }; },
  computeSignal(snap) { return { direction: 'NEUTRAL', strength: 0, newsRisk: false, ...(SIG[snap.code] || {}) }; },
};
const autoMock = {
  PAIRS: PAIRS_MOCK, STRENGTH_THRESHOLD: 67,
  async checkRegimeFilter(code) { return { ok: REGIME[code] !== false }; },
  computeAtrBasedRisk({ atr, price, stake, multiplier }) {
    if (!(atr > 0) || !(price > 0)) return null;
    let sl = Math.min(stake * multiplier * (atr / price), stake), tp = sl * 2;
    if (sl < 1 && stake >= 1) { sl = 1; tp = 2; }
    return { sl: Number(sl.toFixed(2)), tp: Number(tp.toFixed(2)) };
  },
};

const results = [];
async function t(name, fn) { try { await fn(); results.push(1); out('  ✓', name); } catch (e) { results.push(0); out('  ✗', name, '\n     ', (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); } }
async function rej(fn, code) { try { await fn(); } catch (e) { if (code) assert.strictEqual(e.code, code, `ilitarajiwa ${code}, ikapata ${e.code}: ${e.userMessage || e.message}`); return e; } assert.fail('ilitarajiwa kutupa ' + (code || '')); }

(async () => {
  const A = require(R('utils/derivAccounts.js'));
  const S = require(R('utils/derivSession.js'));
  const T = require(R('utils/derivCustomerTrader.js'));
  const D = require(R('utils/derivTrades.js'));
  const AUTO = require(R('utils/derivCustomerAuto.js'));

  const ph = (n) => '2557120000' + String(n).padStart(2, '0');
  const acctOf = {}; // phone -> accountId
  async function mk(n, { auto = true, limits = { maxStake: 5, maxTradesDay: 20, maxDailyLoss: 50, maxOpen: 5 } } = {}) {
    const phone = ph(n), tok = `tokD${n}-demo-00000000${n}`, acc = `VRTD00000${n}`, pin = '4829';
    addAccount(tok, acc); acctOf[phone] = acc; acctOf['tok' + phone] = tok;
    await A.setPin(phone, pin); await A.connect(phone, tok, pin); await A.adminAction(phone, 'approve');
    await A.setSwitches(phone, { userEnabled: true, pin });
    if (limits) await A.adminAction(phone, 'set_limits', { limits });
    if (auto) { await A.adminAction(phone, 'approve_auto'); await A.setSwitches(phone, { autoEnabled: true, pin }); }
    return phone;
  }
  const buys = (phone) => F.requests.filter((r) => r.accountId === acctOf[phone] && r.buy).length;
  const rowsOf = (phone) => sqlite.prepare('SELECT * FROM fx_auto_trades WHERE ownerPhone=? ORDER BY openedAt').all(phone);
  const clearSig = () => { for (const k of Object.keys(SIG)) delete SIG[k]; for (const k of Object.keys(REGIME)) delete REGIME[k]; };
  const resetFake = () => { F.buys = 0; F.sells = 0; F.proposals = []; F.requests = []; F.failProposal = null; F.minSl = 0.45; F.nextPnl = 0.5; F.dropBuyReply = false; F.mutePong = false; };
  const strong = () => { clearSig(); SIG.EURUSD = { direction: 'BUY', strength: 80 }; SIG.GBPUSD = { direction: 'BUY', strength: 75 }; SIG.EURGBP = { direction: 'SELL', strength: 70 }; SIG.USDJPY = { direction: 'NEUTRAL', strength: 0 }; };

  AUTO.start({ notify: async (phone, text) => { sent.push({ phone, text }); return true; } });

  out('\n[1] Nani anaingia kwenye mzunguko (udhibiti wa admin + mteja)');
  const P1 = await mk(1), P2 = await mk(2), PNoAuto = await mk(3, { auto: false });
  await t('listAutoReady: wenye auto tu (idhini ya admin + swichi ya mteja)', async () => {
    const l = await A.listAutoReady();
    assert(l.includes(P1) && l.includes(P2)); assert(!l.includes(PNoAuto));
  });
  await t('mteja bila auto: trade ya auto inakataliwa auto_off BILA kuguswa Deriv; ya mkono inaendelea kufanya kazi', async () => {
    resetFake();
    let e = await rej(() => T.openTrade(PNoAuto, { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2 }, { auto: true, signalStrength: 80 }), 'DENIED');
    assert.strictEqual(e.reason, 'auto_off'); assert.strictEqual(F.requests.filter((r) => r.accountId === acctOf[PNoAuto]).length, 0);
    const r = await T.openTrade(PNoAuto, { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2 });
    assert(r.contractId); assert.strictEqual(rowsOf(PNoAuto)[0].signalStrength, null, 'trade ya mkono haiwekwi alama ya auto');
  });

  out('\n[2] Mzunguko: kila mteja kwenye akaunti yake mwenyewe');
  await t('wateja 2 wenye auto wanapata trades kwenye akaunti zao; asiye na auto hapati', async () => {
    resetFake(); sent.length = 0; strong();
    const noAutoBefore = rowsOf(PNoAuto).length;
    const c = await AUTO.runCycle();
    assert.strictEqual(c.customers, 2);
    for (const p of [P1, P2]) {
      const rows = rowsOf(p);
      assert.strictEqual(rows.length, 2, 'trades 2 kwa kila mteja'); assert.strictEqual(buys(p), 2);
      assert(rows.every((x) => x.signalStrength != null && x.ownerPhone === p));
      assert.deepStrictEqual(rows.map((x) => `${x.code}:${x.direction}`).sort(), ['EURGBP:SELL', 'EURUSD:BUY']);
    }
    assert.strictEqual(rowsOf(PNoAuto).length, noAutoBefore, 'asiye na auto hajaguswa');
    assert.strictEqual(buys(PNoAuto), 0);
    // mtu mmoja haoni/hagusi akaunti ya mwingine
    const acc1 = ACCT[acctOf[P1]], acc2 = ACCT[acctOf[P2]];
    assert.strictEqual(acc1.contracts.size, 2); assert.strictEqual(acc2.contracts.size, 2);
    const ids1 = [...acc1.contracts.keys()], ids2 = [...acc2.contracts.keys()];
    assert(ids1.every((i) => !ids2.includes(i)));
  });
  await t('correlation guard: GBPUSD BUY (USD upande uleule na EURUSD BUY) imeruka; EURGBP SELL imepita', async () => {
    assert(!rowsOf(P1).some((x) => x.code === 'GBPUSD'));
  });
  await t('payload: stake=2, multiplier 100, SL<=stake, TP>0, SL na TP zimewekwa', async () => {
    const p = F.proposals.find((x) => x.underlying_symbol === 'frxEURUSD');
    assert.strictEqual(p.amount, 2); assert.strictEqual(p.multiplier, 100);
    assert(p.limit_order.stop_loss > 0 && p.limit_order.stop_loss <= 2 && p.limit_order.take_profit > 0);
  });
  await t('arifa ya kufungua inaenda kwa mteja husika tu', async () => {
    const mine = sent.filter((s) => s.phone === P1 && /Auto-Trade/.test(s.text));
    assert.strictEqual(mine.length, 2); assert(!sent.some((s) => s.phone === PNoAuto));
    assert(sent.every((s) => !/OTPSECRET|tokD/.test(s.text)));
  });
  await t('mzunguko wa pili: hakuna marudio (jozi zina trade wazi)', async () => {
    resetFake(); const before = rowsOf(P1).length;
    await AUTO.runCycle();
    assert.strictEqual(buys(P1), 0); assert.strictEqual(rowsOf(P1).length, before);
  });

  out('\n[3] Admin anabaki na udhibiti');
  const P4 = await mk(4), P5 = await mk(5);
  await t('revoke_auto: mteja anatoka kwenye mzunguko; wengine hawaathiriki', async () => {
    resetFake(); strong(); await A.adminAction(P5, 'revoke_auto');
    await AUTO.runCycle();
    assert.strictEqual(buys(P5), 0); assert.strictEqual(buys(P4), 2);
  });
  await t('kill_all: hakuna trade mpya kwa mtu yeyote', async () => {
    const P6 = await mk(6); resetFake(); strong();
    await A.adminAction('', 'kill_all'); const c = await AUTO.runCycle(); await A.adminAction('', 'resume_all');
    assert.strictEqual(buys(P6), 0); assert(c.results.every((r) => r.skipped === 'kill_all' || r.opened === 0));
  });
  await t('mteja akizima auto kwenye dashboard: anatoka kwenye mzunguko', async () => {
    const P7 = await mk(7); await A.setSwitches(P7, { autoEnabled: false }); resetFake(); strong();
    await AUTO.runCycle(); assert.strictEqual(buys(P7), 0);
  });
  await t('revoke (admin): trading yote ya mteja inazimwa', async () => {
    const P8 = await mk(8); await A.adminAction(P8, 'revoke'); resetFake(); strong();
    await AUTO.runCycle(); assert.strictEqual(buys(P8), 0);
  });

  out('\n[4] Vikomo vya kila mteja vinaheshimiwa');
  await t('maxStake $1 → stake inapunguzwa hadi $1 (SL<=1)', async () => {
    const P = await mk(9, { limits: { maxStake: 1, maxTradesDay: 20, maxDailyLoss: 50, maxOpen: 5 } });
    resetFake(); strong(); await AUTO.runCycle();
    const props = F.requests.filter((r) => r.accountId === acctOf[P] && r.proposal);
    assert(props.length >= 1 && props.every((x) => x.amount === 1 && x.limit_order.stop_loss <= 1));
  });
  await t('maxOpen 1 → trade moja tu; zingine zinasimama (OPEN_LIMIT)', async () => {
    const P = await mk(10, { limits: { maxStake: 5, maxTradesDay: 20, maxDailyLoss: 50, maxOpen: 1 } });
    resetFake(); strong(); await AUTO.runCycle();
    assert.strictEqual(buys(P), 1);
  });
  await t('maxTradesDay 1 → trade moja tu kwa siku', async () => {
    const P = await mk(11, { limits: { maxStake: 5, maxTradesDay: 1, maxDailyLoss: 50, maxOpen: 5 } });
    resetFake(); strong(); await AUTO.runCycle();
    assert.strictEqual(buys(P), 1);
  });
  await t('maxDailyLoss ndogo (SL ya trade ingezidi bajeti) → hakuna trade', async () => {
    const P = await mk(12, { limits: { maxStake: 5, maxTradesDay: 20, maxDailyLoss: 0.5, maxOpen: 5 } });
    resetFake(); strong(); await AUTO.runCycle();
    assert.strictEqual(buys(P), 0);
  });

  out('\n[5] Signal na vichujio');
  await t('signal chini ya threshold / NEUTRAL / newsRisk / regime=false → hakuna trade', async () => {
    const P = await mk(13);
    for (const setup of [
      () => { SIG.EURUSD = { direction: 'BUY', strength: 60 }; },
      () => { SIG.EURUSD = { direction: 'NEUTRAL', strength: 90 }; },
      () => { SIG.EURUSD = { direction: 'BUY', strength: 90, newsRisk: true }; },
      () => { SIG.EURUSD = { direction: 'BUY', strength: 90 }; REGIME.EURUSD = false; },
      () => { SIG.EURUSD = { throws: true }; },
    ]) { clearSig(); setup(); resetFake(); await AUTO.runCycle(); assert.strictEqual(buys(P), 0); }
  });
  await t('hakuna wateja wa auto → signal haihesabiwi kabisa (hakuna matumizi ya API bure)', async () => {
    for (const p of Object.keys(acctOf).filter((k) => /^2557/.test(k))) { try { await A.setSwitches(p, { autoEnabled: false }); } catch {} }
    const c = await AUTO.runCycle(); assert.strictEqual(c.customers, 0);
  });

  out('\n[6] Cooldown baada ya hasara mfululizo (kutoka DB)');
  const insertClosed = (phone, profit, ageMs, strength = 75) => sqlite.prepare("INSERT INTO fx_auto_trades (contractId, code, symbol, direction, stake, slUsd, tpUsd, openedAt, closedAt, profit, ownerPhone, signalStrength) VALUES (?, 'AUDUSD', 'frxAUDUSD', 'BUY', 2, 1, 2, ?, ?, ?, ?, ?)").run('x' + Math.random().toString(16).slice(2), Date.now() - ageMs - 1000, Date.now() - ageMs, profit, phone, strength);
  await t('hasara 3 mfululizo za auto (ndani ya saa 4) → mteja huyo anapumzishwa; wengine hapana', async () => {
    const Pc = await mk(14), Po = await mk(15);
    for (let i = 0; i < 3; i++) insertClosed(Pc, -1, 60 * 1000 * (i + 1));
    resetFake(); strong(); await AUTO.runCycle();
    assert.strictEqual(buys(Pc), 0); assert.strictEqual(buys(Po), 2);
  });
  await t('faida katikati / hasara za zamani (>saa 4) / trade za mkono → hakuna cooldown', async () => {
    const Pw = await mk(16), Pold = await mk(17), Pman = await mk(18);
    insertClosed(Pw, -1, 3 * 60000); insertClosed(Pw, +2, 2 * 60000); insertClosed(Pw, -1, 60000);
    for (let i = 0; i < 3; i++) insertClosed(Pold, -1, 5 * 3600 * 1000 + i * 1000);
    for (let i = 0; i < 3; i++) insertClosed(Pman, -1, 60000, null);
    resetFake(); strong(); await AUTO.runCycle();
    assert(buys(Pw) > 0 && buys(Pold) > 0 && buys(Pman) > 0);
  });

  out('\n[7] Kutengwa kwa makosa (mteja mmoja akikwama, wengine wanaendelea)');
  await t('token ya mteja mmoja ikikataliwa na Deriv → huyo anaruka, wengine wanapata trades', async () => {
    const Pbad = await mk(19), Pgood = await mk(20);
    F.otp401.add(acctOf['tok' + Pbad]); resetFake(); strong();
    const c = await AUTO.runCycle();
    assert.strictEqual(buys(Pbad), 0); assert.strictEqual(buys(Pgood), 2);
    assert(c.results.some((r) => r.skipped && r.skipped !== 'cooldown'), 'mteja aliyekwama anaonekana kama ameruka');
  });

  out('\n[8] Arifa za kufungwa (SL/TP) — mara moja tu, kwa mteja husika');
  await t('Deriv ikifunga trade ya auto → arifa ya FAIDA/HASARA, rekodi ya DB; hakuna arifa mara mbili', async () => {
    const Pn = await mk(21); resetFake(); strong(); sent.length = 0; await AUTO.runCycle();
    const acc = ACCT[acctOf[Pn]]; const [first, second] = [...acc.contracts.values()];
    acc.contracts.delete(first.id); acc.history.unshift({ contract_id: first.id, buy_price: first.buy, sell_price: first.buy + 1.5, profit: 1.5 });
    acc.contracts.delete(second.id); acc.history.unshift({ contract_id: second.id, buy_price: second.buy, sell_price: second.buy - 1, profit: -1 });
    sent.length = 0; await AUTO.pollClosed();
    const mine = sent.filter((s) => s.phone === Pn);
    assert.strictEqual(mine.length, 2); assert(mine.some((s) => /FAIDA/.test(s.text) && /\+\$1\.50/.test(s.text))); assert(mine.some((s) => /HASARA/.test(s.text)));
    assert(sent.every((s) => s.phone === Pn));
    const closed = rowsOf(Pn).filter((x) => x.closedAt != null); assert.strictEqual(closed.length, 2);
    sent.length = 0; await AUTO.pollClosed(); assert.strictEqual(sent.length, 0, 'arifa mara mbili!');
  });
  await t('trade ya mkono ikifungwa na Deriv → hakuna arifa ya auto', async () => {
    const Pm = await mk(22, { auto: false }); resetFake();
    const r = await T.openTrade(Pm, { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2 });
    const acc = ACCT[acctOf[Pm]]; const c = acc.contracts.get(Number(r.contractId)); acc.contracts.delete(c.id); acc.history.unshift({ contract_id: c.id, buy_price: c.buy, sell_price: c.buy + 1, profit: 1 });
    sent.length = 0; await T.syncClosed(Pm); assert.strictEqual(sent.length, 0);
    assert.strictEqual(rowsOf(Pm)[0].closedAt != null, true);
  });

  out('\n[9] Hali ya injini (kwa admin) na usalama');
  await t('getStatus: haina namba kamili wala siri; running=true', async () => {
    const st = AUTO.getStatus(); assert.strictEqual(st.running, true); assert.strictEqual(st.enabled, true);
    const j = JSON.stringify(st); assert(!/255712\d{6}/.test(j) && !/tokD|OTPSECRET|4829/.test(j));
  });
  await t('stop() inasimamisha injini', async () => { AUTO.stop(); assert.strictEqual(AUTO.getStatus().running, false); });
  await t('hakuna siri kwenye logs', async () => {
    const all = logs.join('\n');
    for (const x of ['tokD', 'OTPSECRET', '4829', 'e'.repeat(64)]) assert(!all.includes(x), 'siri imevuja: ' + x);
  });

  S.closeAllSessions();
  const bad = results.filter((x) => !x).length;
  out(`\n${results.length - bad}/${results.length} zimepita`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { out('FATAL', e.stack); process.exit(2); });
