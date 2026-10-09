// Majaribio ya hatua (c): derivSession + derivTrades + derivCustomerTrader + commands + routes za dashboard + lango la handler.
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
const KEEP = new Set(['pairing/server.js', 'pairing/adminAuth.js', 'pairing/pairingConfig.js', 'pairing/db.js', 'utils/forexAccess.js', 'utils/derivAccounts.js', 'utils/derivCrypto.js', 'utils/derivPin.js', 'utils/derivValidate.js', 'utils/derivSession.js', 'utils/derivTrades.js', 'utils/derivCustomerTrader.js', 'utils/derivCustomerCommands.js']);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return axiosShim;
  if (request === 'ws') return FakeWS;
  let resolved; try { resolved = Module._resolveFilename(request, parent, isMain); } catch { return mk(); }
  if (resolved.startsWith(ROOT)) {
    const rel = path.relative(ROOT, resolved);
    if (rel === 'pairing/instanceManager.js') return instanceStub;
    if (!KEEP.has(rel)) return mk();
  }
  return origLoad.apply(this, arguments);
};

const results = [];
async function t(name, fn) { try { await fn(); results.push(1); out('  ✓', name); } catch (e) { results.push(0); out('  ✗', name, '\n     ', (e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); } }
async function rej(fn, code) { try { await fn(); } catch (e) { if (code) assert.strictEqual(e.code, code, `ilitarajiwa ${code}, ikapata ${e.code}: ${e.userMessage || e.message}`); return e; } assert.fail('ilitarajiwa kutupa ' + (code || '')); }

(async () => {
  const A = require(R('utils/derivAccounts.js'));
  const S = require(R('utils/derivSession.js'));
  const T = require(R('utils/derivCustomerTrader.js'));
  const D = require(R('utils/derivTrades.js'));
  const FA = require(R('utils/forexAccess.js'));
  const CMD = require(R('utils/derivCustomerCommands.js'));

  async function mkCustomer(key, token, accountId, pin = '4829', limits) {
    const phone = PHONES[key];
    addAccount(token, accountId);
    await A.setPin(phone, pin);
    await A.connect(phone, token, pin);
    await A.adminAction(phone, 'approve');
    await A.setSwitches(phone, { userEnabled: true, pin });
    if (limits) await A.adminAction(phone, 'set_limits', { limits });
    return phone;
  }
  const trade = (phone, o = {}) => T.openTrade(phone, { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2, multiplier: 100, ...o });
  const resetFake = () => { F.buys = 0; F.sells = 0; F.proposals = []; F.requests = []; F.failProposal = null; F.minSl = 0.45; F.nextPnl = 0.5; F.dropBuyReply = false; F.mutePong = false; };
  const buysOf = (acc) => F.requests.filter((r) => r.accountId === acc && r.buy).length;

  out('\n[1] Lango (gate)');
  const PA = await mkCustomer('A', 'tokA-demo-000000001', 'VRTC0000001', '4829', { maxStake: 5, maxTradesDay: 20, maxDailyLoss: 20, maxOpen: 2 });
  await t('mteja asiyeidhinishwa/aliyezimwa/kill: trade inakataliwa BILA kuguswa Deriv', async () => {
    const P = PHONES.B; addAccount('tokB-demo-000000001', 'VRTC0000002'); await A.setPin(P, '5920'); await A.connect(P, 'tokB-demo-000000001', '5920');
    resetFake();
    let e = await rej(() => trade(P), 'DENIED'); assert.strictEqual(e.reason, 'not_approved');
    await A.adminAction(P, 'approve'); e = await rej(() => trade(P), 'DENIED'); assert.strictEqual(e.reason, 'user_disabled');
    await A.setSwitches(P, { userEnabled: true, pin: '5920' });
    await A.adminAction('', 'kill_all'); e = await rej(() => trade(P), 'DENIED'); assert.strictEqual(e.reason, 'kill_all'); await A.adminAction('', 'resume_all');
    assert.strictEqual(F.requests.length, 0, 'Deriv iliguswa!');
    assert.strictEqual(sqlite.prepare('SELECT COUNT(*) c FROM fx_auto_trades WHERE ownerPhone=?').get(P).c, 0);
  });

  out('\n[2] Kufungua trade — njia sahihi');
  await t('trade inafunguliwa; payload ya Deriv ni sahihi; DB ina ownerPhone', async () => {
    resetFake();
    const r = await trade(PA);
    assert(r.contractId && r.tracked); assert.strictEqual(r.pair, 'EURUSD');
    const prop = F.proposals[0];
    assert.strictEqual(prop.underlying_symbol, 'frxEURUSD'); assert.strictEqual(prop.contract_type, 'MULTUP'); assert.strictEqual(prop.multiplier, 100);
    assert.strictEqual(prop.amount, 2); assert.deepStrictEqual(prop.limit_order, { stop_loss: 1, take_profit: 2 }); assert.strictEqual(prop.currency, 'USD');
    const row = sqlite.prepare('SELECT * FROM fx_auto_trades WHERE contractId=?').get(r.contractId);
    assert.strictEqual(row.ownerPhone, PA); assert.strictEqual(row.slUsd, 1); assert.strictEqual(row.closedAt, null); assert.strictEqual(row.buyPrice, 2);
    await T.closeAll(PA);
  });
  await t('SELL → MULTDOWN', async () => {
    resetFake(); await trade(PA, { pair: 'GBPUSD', direction: 'SELL' });
    assert.strictEqual(F.proposals[0].contract_type, 'MULTDOWN'); assert.strictEqual(F.proposals[0].underlying_symbol, 'frxGBPUSD');
    await T.closeAll(PA);
  });

  out('\n[3] Uthibitishaji wa vigezo (hakuna ombi la Deriv)');
  const bad = [
    [{ pair: 'BTCUSD' }, 'BAD_PAIR'], [{ pair: 'EURUSD; DROP' }, 'BAD_PAIR'], [{ direction: 'HOLD' }, 'BAD_DIRECTION'],
    [{ stake: 5.01 }, 'STAKE_LIMIT'], [{ stake: 'abc' }, 'BAD_STAKE'], [{ stake: 0 }, 'BAD_STAKE'], [{ stake: -2 }, 'BAD_STAKE'], [{ stake: 0.5 }, 'BAD_STAKE'],
    [{ stopLoss: 0 }, 'NEED_SL_TP'], [{ takeProfit: undefined }, 'NEED_SL_TP'], [{ stopLoss: 3 }, 'BAD_SL'], [{ multiplier: 150 }, 'BAD_MULTIPLIER'],
  ];
  for (const [o, code] of bad) {
    await t(`${JSON.stringify(o)} → ${code}`, async () => {
      resetFake(); await rej(() => trade(PA, o), code);
      assert.strictEqual(F.requests.filter((r) => r.proposal || r.buy).length, 0);
      assert.strictEqual(sqlite.prepare("SELECT COUNT(*) c FROM fx_auto_trades WHERE ownerPhone=? AND contractId LIKE 'pending:%'").get(PA).c, 0);
    });
  }
  await t('stake inayozidi kikomo inakataliwa (HAIPUNGUZWI kimya)', async () => {
    const e = await rej(() => trade(PA, { stake: 20 }), 'STAKE_LIMIT'); assert(/5/.test(e.userMessage));
  });

  out('\n[4] Vikomo');
  await t('maxOpen=2: ya tatu inakataliwa; duplicate ya jozi inakataliwa', async () => {
    resetFake(); await sleep(8100); // dirisha la marudio
    await trade(PA, { pair: 'EURUSD' });
    let e = await rej(() => trade(PA, { pair: 'EURUSD', direction: 'SELL' }), 'DUPLICATE_OPEN');
    await trade(PA, { pair: 'GBPUSD' });
    e = await rej(() => trade(PA, { pair: 'USDJPY' }), 'OPEN_LIMIT'); assert(/kikomo chako ni 2/.test(e.userMessage));
    assert.strictEqual(buysOf('VRTC0000001'), 2);
    await T.closeAll(PA);
  });
  const PC = await mkCustomer('C', 'tokC-demo-000000001', 'VRTC0000003', '3857', { maxStake: 5, maxTradesDay: 3, maxDailyLoss: 10, maxOpen: 3 });
  await t('maxTradesDay=3: ya nne inakataliwa hata baada ya kufunga zote', async () => {
    resetFake(); F.nextPnl = 0.2;
    for (const pr of ['EURUSD', 'GBPUSD', 'USDJPY']) { const r = await trade(PC, { pair: pr }); await T.closeTrade(PC, r.contractId); }
    const e = await rej(() => trade(PC, { pair: 'AUDUSD' }), 'DAY_LIMIT'); assert(/3/.test(e.userMessage));
    assert.strictEqual(buysOf('VRTC0000003'), 3);
  });
  const PD = await mkCustomer('D', 'tokD-demo-000000001', 'VRTC0000004', '6283', { maxStake: 5, maxTradesDay: 10, maxDailyLoss: 3, maxOpen: 3 });
  await t('hasara ya siku: LOSS_BUDGET (hasara+SL > kikomo) kisha LOSS_LIMIT', async () => {
    resetFake(); F.nextPnl = -2;
    const r = await trade(PD, { pair: 'EURUSD', stopLoss: 2 }); await T.closeTrade(PD, r.contractId); // hasara ya leo = 2
    assert.strictEqual((await D.todayStats(PD)).lossToday, 2);
    const e = await rej(() => trade(PD, { pair: 'GBPUSD', stopLoss: 2 }), 'LOSS_BUDGET'); assert(/kikomo cha hasara/.test(e.userMessage));
    F.nextPnl = -1; const r2 = await trade(PD, { pair: 'GBPUSD', stopLoss: 1 }); await T.closeTrade(PD, r2.contractId); // 2+1=3
    await rej(() => trade(PD, { pair: 'USDJPY', stopLoss: 1 }), 'LOSS_LIMIT');
  });
  await t('faida haipunguzi hasara ya siku (kipimo ni hasara tu)', async () => {
    const P = await mkCustomer('E', 'tokE-demo-000000001', 'VRTC0000005', '7391', { maxStake: 5, maxTradesDay: 10, maxDailyLoss: 3, maxOpen: 3 });
    resetFake(); F.nextPnl = -1.5; let r = await trade(P, { pair: 'EURUSD' }); await T.closeTrade(P, r.contractId);
    F.nextPnl = 4; r = await trade(P, { pair: 'GBPUSD' }); await T.closeTrade(P, r.contractId);
    const st = await D.todayStats(P); assert.strictEqual(st.lossToday, 1.5); assert.strictEqual(st.pnlToday, 2.5);
  });

  out('\n[5] Mbio (race) — maombi ya wakati mmoja');
  await t('maxOpen=1: maombi 6 ya wakati mmoja → trade MOJA tu', async () => {
    const P = await mkCustomer('G', 'tokG-demo-000000001', 'VRTC0000006', '8264', { maxStake: 5, maxTradesDay: 20, maxDailyLoss: 50, maxOpen: 1 });
    resetFake();
    const pairs = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD'];
    const res = await Promise.allSettled(pairs.map((p) => trade(P, { pair: p })));
    assert.strictEqual(res.filter((r) => r.status === 'fulfilled').length, 1);
    assert(res.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'OPEN_LIMIT'));
    assert.strictEqual(buysOf('VRTC0000006'), 1);
    await T.closeAll(P);
  });
  await t('maxTradesDay=2, maxOpen=5: maombi 6 → trades mbili tu', async () => {
    const P = PHONES.G; await A.adminAction(P, 'set_limits', { limits: { maxStake: 5, maxTradesDay: 20, maxDailyLoss: 50, maxOpen: 5 } });
    const before = (await D.todayStats(P)).opened; await A.adminAction(P, 'set_limits', { limits: { maxTradesDay: before + 2 } });
    resetFake();
    const res = await Promise.allSettled(['USDCAD', 'AUDUSD', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY'].map((p) => trade(P, { pair: p })));
    assert.strictEqual(res.filter((r) => r.status === 'fulfilled').length, 2);
    assert(res.filter((r) => r.status === 'rejected').every((r) => ['DAY_LIMIT'].includes(r.reason.code)), JSON.stringify(res.map((r) => r.reason && r.reason.code)));
    await T.closeAll(P);
  });
  await t('mbio: wateja tofauti hawazuiani (mutex ni kwa mteja)', async () => {
    resetFake(); await sleep(8100);
    const [x, y] = await Promise.allSettled([trade(PA, { pair: 'NZDUSD' }), trade(PC === PA ? PD : PHONES.E, { pair: 'NZDUSD' })]);
    assert.strictEqual(x.status, 'fulfilled'); assert.strictEqual(y.status === 'fulfilled' || y.reason.code !== undefined, true);
    await T.closeAll(PA);
  });

  out('\n[6] Kufunga na reconcile');
  await t('trade iliyofungwa na Deriv (SL) inaunganishwa: profit halisi inaingia kwenye hasara ya siku', async () => {
    const P = await mkCustomer('H', 'tokH-demo-000000001', 'VRTC0000007', '9142', { maxStake: 5, maxTradesDay: 10, maxDailyLoss: 10, maxOpen: 3 });
    resetFake(); const r = await trade(P);
    const acc = ACCT.VRTC0000007; const c = acc.contracts.get(Number(r.contractId)); acc.contracts.delete(c.id); acc.history.unshift({ contract_id: c.id, buy_price: 2, sell_price: 1, profit: -1 }); // SL
    const o = await T.overview(P);
    assert.strictEqual(o.positions.length, 0); assert.strictEqual(o.today.lossToday, 1);
    const row = sqlite.prepare('SELECT * FROM fx_auto_trades WHERE contractId=?').get(r.contractId); assert.strictEqual(row.profit, -1); assert(row.closedAt);
  });
  await t('profit isiyojulikana (haipo kwenye history) → inahesabiwa hasara mbaya zaidi (SL), si sifuri', async () => {
    const P = PHONES.H; resetFake(); await sleep(8100);
    const r = await trade(P, { pair: 'GBPUSD', stopLoss: 1.5 });
    const acc = ACCT.VRTC0000007; acc.contracts.delete(Number(r.contractId)); // imetoweka bila history
    const before = (await D.todayStats(P)).lossToday;
    await T.overview(P);
    const after = (await D.todayStats(P)).lossToday;
    assert.strictEqual(Number((after - before).toFixed(2)), 1.5);
  });
  await t('overview ina balance, vikomo, canTrade, recent; haina siri', async () => {
    const o = await T.overview(PA);
    assert.strictEqual(o.balance.amount, 10000); assert.strictEqual(o.limits.maxOpen, 2); assert.strictEqual(o.canTrade, true); assert(Array.isArray(o.recent));
    assert(!/OTPSECRET|tokA-demo|VRTC0000001/.test(JSON.stringify(o)));
  });
  await t('KUFUNGA kunafanya kazi wakati wa kill switch / trading imezimwa / idhini imeondolewa', async () => {
    resetFake(); await sleep(8100);
    const r1 = await trade(PA, { pair: 'USDCHF' });
    await A.adminAction('', 'kill_all');
    try {
      await rej(() => trade(PA, { pair: 'USDCAD' }), 'DENIED');
      const c = await T.closeTrade(PA, r1.contractId); assert.strictEqual(c.contractId, r1.contractId);
    } finally { await A.adminAction('', 'resume_all'); }
    const r2 = await trade(PA, { pair: 'USDCAD' }); // jozi tofauti — dirisha la marudio la sekunde 8 ni kwa jozi+upande
    await A.setSwitches(PA, { userEnabled: false }); await A.adminAction(PA, 'revoke');
    const all = await T.closeAll(PA); assert(all.length >= 1 && all.every((x) => x.ok));
    await A.adminAction(PA, 'approve'); await A.setSwitches(PA, { userEnabled: true, pin: '4829' });
  });
  await t('closeTrade: id batili → BAD_ID bila ombi; id isiyo yako → kosa la Deriv lililotafsiriwa', async () => {
    resetFake(); await rej(() => T.closeTrade(PA, 'abc'), 'BAD_ID'); await rej(() => T.closeTrade(PA, ''), 'BAD_ID');
    assert.strictEqual(F.requests.length, 0);
    const e = await rej(() => T.closeTrade(PA, '999999'), 'DERIV'); assert(/Contract not found/.test(e.userMessage));
  });

  out('\n[7] Hitilafu za Deriv / mtandao');
  await t('SL ndogo mno → inarekebishwa kiotomatiki (uwiano uleule) na trade inafunguka', async () => {
    resetFake(); await sleep(8100); const r = await trade(PA, { pair: 'AUDUSD', stopLoss: 0.3, takeProfit: 0.6 });
    assert.strictEqual(r.stopLoss, 0.46); assert.strictEqual(r.takeProfit, 0.92); assert.strictEqual(F.proposals.length, 2);
    await T.closeAll(PA);
  });
  await t('kosa la proposal (soko limefungwa) → ujumbe wa Deriv; hakuna rekodi iliyobaki; hakuhesabiwi kwenye trades za siku', async () => {
    resetFake(); await sleep(8100); const before = (await D.todayStats(PA)).opened;
    F.failProposal = 'Market is closed';
    const e = await rej(() => trade(PA, { pair: 'NZDUSD' }), 'DERIV'); assert(/Market is closed/.test(e.userMessage));
    assert.strictEqual((await D.todayStats(PA)).opened, before); assert.strictEqual(F.buys, 0);
  });
  await t('buy bila jibu (timeout) → UNKNOWN_OUTCOME, rekodi inabaki (inahesabiwa), trade INAWEZA kuwa wazi', async () => {
    resetFake(); await sleep(8100); const before = (await D.todayStats(PA)).opened;
    F.dropBuyReply = true;
    const e = await rej(() => trade(PA, { pair: 'EURGBP' }), 'UNKNOWN_OUTCOME'); assert(/positions/.test(e.userMessage));
    assert.strictEqual((await D.todayStats(PA)).opened, before + 1);
    assert.strictEqual(sqlite.prepare("SELECT COUNT(*) c FROM fx_auto_trades WHERE ownerPhone=? AND contractId LIKE 'pending:%'").get(PA).c, 1);
    await T.closeAll(PA); // ya Deriv iliyofunguliwa kimya inafungwa
  });
  await t('DB ikiharibika kabla ya kununua → trade HAIFUNGUKI (fail-closed)', async () => {
    resetFake(); await sleep(8100); failDb = true;
    const e = await rej(() => trade(PA, { pair: 'EURJPY' })); failDb = false; await A.getKillAll(true); // kill switch ya fail-closed ilikuwa imewashwa kwa muda — isomwe upya
    assert.strictEqual(F.buys, 0); assert(/haikufunguliwa|Hitilafu|DENIED/i.test(e.userMessage + e.code), e.userMessage);
  });
  await t('portfolio ya Deriv ikishindwa → trade HAIFUNGUKI', async () => {
    resetFake(); await sleep(100);
    const sess = S.getSession(PA); const orig = sess.getPortfolio.bind(sess); sess.getPortfolio = async () => { throw new S.SessionError('Muda wa ombi la Deriv umeisha.', 'TIMEOUT'); };
    await rej(() => trade(PA, { pair: 'GBPJPY' }), 'TIMEOUT'); sess.getPortfolio = orig; assert.strictEqual(F.buys, 0);
  });

  out('\n[8] Muunganisho (session)');
  await t('socket ikifungwa na server → reconnect otomatiki (OTP mpya), amri inafanikiwa', async () => {
    F.otpCalls = 0; for (const s of [...F.sockets]) s.terminate(); await sleep(30);
    const o = await T.overview(PA); assert.strictEqual(o.balance.amount, 10000); assert(F.otpCalls >= 1);
  });
  await t('heartbeat: pong ikikosekana → socket inauawa na kuunganishwa upya', async () => {
    await T.overview(PA); const n = F.sockets.size; F.mutePong = true; F.otpCalls = 0; await sleep(250); F.mutePong = false;
    assert.strictEqual(S.getSession(PA).ready, false); await T.overview(PA); assert(F.otpCalls >= 1);
  });
  await t('maombi ya wakati mmoja yanashiriki muunganisho MMOJA (OTP moja)', async () => {
    S.closeSession(PA); F.otpCalls = 0;
    await Promise.all([T.overview(PA), T.overview(PA), T.overview(PA)]);
    assert.strictEqual(F.otpCalls, 1);
  });
  await t('token mpya (connect) → session ya zamani inafungwa', async () => {
    await T.overview(PA); assert.strictEqual(S.getSession(PA).ready, true); const sess = S.getSession(PA);
    await A.connect(PA, 'tokA-demo-000000001', '4829'); assert.strictEqual(sess.ready, false);
    await A.adminAction(PA, 'approve'); await A.setSwitches(PA, { userEnabled: true, pin: '4829' });
  });
  await t('Deriv ikikataa token (401 kwenye OTP) → status invalid, swichi zimezimwa, trade inakataliwa', async () => {
    const P = PHONES.B; await A.setSwitches(P, { userEnabled: true, pin: '5920' }).catch(() => {});
    F.otp401.add('tokB-demo-000000001'); S.closeSession(P);
    const e = await rej(() => T.overview(P), 'TOKEN_REJECTED');
    const a = await A.getPublic(P); assert.strictEqual(a.status, 'invalid'); assert.strictEqual(a.userEnabled, false);
    await rej(() => trade(P), 'DENIED'); F.otp401.delete('tokB-demo-000000001');
  });
  await t('kikomo cha miunganisho: ya ziada → BUSY (ujumbe wa Kiswahili)', async () => {
    S.closeAllSessions(); S._setMaxSessions(4);
    let err; try { for (let i = 1; i <= 5; i++) S.getSession('25579999999' + i); } catch (e) { err = e; }
    assert(err && err.code === 'BUSY' && /Jaribu tena/.test(err.userMessage));
    assert.strictEqual(S._sessionCount(), 4);
    S.closeAllSessions(); S._setMaxSessions(50);
  });
  await t('kusoma/kufunga kunakataliwa baada ya mteja kuondoa akaunti', async () => {
    const P = PHONES.C; await A.disconnect(P); S.closeSession(P);
    await rej(() => T.overview(P), 'DENIED'); await rej(() => T.closeAll(P), 'DENIED');
  });

  out('\n[9] Kutenganisha wateja + owner');
  await t('trades/stats za mteja mmoja hazionekani kwa mwingine; rekodi za owner (NULL) hazihesabiwi', async () => {
    sqlite.prepare("INSERT INTO fx_auto_trades (contractId, code, symbol, direction, stake, openedAt, closedAt, profit, ownerPhone) VALUES ('999111','EURUSD','frxEURUSD','BUY',5,?,?,-4,NULL)").run(Date.now(), Date.now());
    const sa = await D.todayStats(PHONES.A), sd = await D.todayStats(PHONES.D);
    assert(sa.opened > 0 && sd.opened > 0);
    const rowsD = await D.history(PHONES.D, 100); assert(rowsD.every((r) => String(r.contractId) !== '999111'));
    const ha = await D.history(PHONES.A, 100); const idsD = new Set(rowsD.map((r) => r.contractId));
    assert(ha.every((r) => !idsD.has(r.contractId)));
    assert.strictEqual(sd.lossToday, 3); // 2 + 1 tu — hasara ya owner (-4) haingii
  });
  await t('autoTrader.js: kila SELECT ya fx_auto_trades inachuja ownerPhone IS NULL', async () => {
    const src = fs.readFileSync(R('utils/autoTrader.js'), 'utf8');
    const sel = src.match(/SELECT[^`']*?FROM fx_auto_trades[^`']*/g) || [];
    assert(sel.length >= 3, 'SELECT ' + sel.length);
    for (const q of sel) assert(/ownerPhone IS NULL/.test(q), 'haina kichujio: ' + q.slice(0, 80));
    // na query hizo halisi hazirudishi trades za wateja:
    const open = sqlite.prepare("SELECT contractId FROM fx_auto_trades WHERE closedAt IS NULL AND ownerPhone IS NULL").all();
    assert(open.every((r) => !String(r.contractId).startsWith('pending:')));
  });

  out('\n[10] Lango la handler + commands');
  await t('forexAccess.classify/decide: jedwali kamili', async () => {
    for (const c of ['fxbuy', 'fxsell', 'positions', 'panic', 'fxclose']) assert.strictEqual(FA.classify({ name: c }), 'own', c);
    for (const c of ['fxautostake', 'fxtrailing', 'fxautostatus', 'autostats', 'fxcheck', 'fxbacktest', 'pobuy', 'podelete']) assert.strictEqual(FA.classify({ name: c }), 'account', c);
    assert.strictEqual(FA.classify({ name: 'forex' }), 'signal'); assert.strictEqual(FA.classify({ name: 'menu' }), null);
    const d = FA.decide;
    assert.strictEqual(d({ fxClass: 'own', isGlobalOwner: false, isSelf: true }), 'allow');
    assert.strictEqual(d({ fxClass: 'own', isGlobalOwner: true, isSelf: false }), 'self_only', 'global owner hapaswi kutrade kwa akaunti ya mteja');
    assert.strictEqual(d({ fxClass: 'own', isGlobalOwner: false, isSelf: false }), 'self_only');
    assert.strictEqual(d({ fxClass: 'own', isGlobalOwner: true, isSelf: true }), 'allow');
    assert.strictEqual(d({ fxClass: 'account', isGlobalOwner: false, isSelf: true }), 'locked_account');
    assert.strictEqual(d({ fxClass: 'account', isGlobalOwner: true, isSelf: false }), 'allow');
    assert.strictEqual(d({ fxClass: 'signal', isGlobalOwner: false, isSelf: true, signalAllowed: false }), 'locked_signal');
    assert.strictEqual(d({ fxClass: 'signal', isGlobalOwner: false, isSelf: true, signalAllowed: true }), 'allow');
    assert.strictEqual(d({ fxClass: null, isGlobalOwner: false, isSelf: false }), 'allow');
  });
  await t('handler.js inatumia decide() na haina tena njia ya global-owner kupita kwa commands za "own"', async () => {
    const src = fs.readFileSync(R('handler.js'), 'utf8');
    assert(/forexAccess\.decide\(/.test(src)); assert(/self_only/.test(src));
    assert(!/if \(!isGlobalOwner\) \{\s*\n\s*if \(fxClass === 'account'\)/.test(src));
  });
  const mkSock = (phone) => { const m = []; return { pairingOwnerId: phone, sendMessage: async (jid, c) => { m.push(c.text); }, m }; };
  const msg = { key: { remoteJid: '255@s.whatsapp.net' } };
  await t('commands za mteja: usage, fungua, positions, fxclose, panic, makosa ya Kiswahili', async () => {
    const P = PHONES.A; await sleep(8100); resetFake(); const s = mkSock(P);
    await CMD.buy(s, msg, []); assert(/Tumia: \.fxbuy/.test(s.m.pop()));
    await CMD.buy(s, msg, ['EURUSD', '2', '1', '2']); const ok = s.m.pop(); assert(/BUY imefunguliwa — EURUSD/.test(ok) && /DEMO/.test(ok), ok);
    await CMD.positions(s, msg); const pos = s.m.pop(); assert(/Akaunti Yangu ya Deriv/.test(pos) && /Balance: USD/.test(pos) && /Leo: trades/.test(pos), pos);
    const id = /Contract: (\d+)/.exec(ok)[1];
    await CMD.sell(s, msg, ['EURUSD', '99', '1', '2']); assert(/❌ .*kikomo/.test(s.m.pop()));
    await CMD.close(s, msg, [id]); assert(/imefungwa/.test(s.m.pop())); await CMD.close(s, msg, []); assert(/Tumia: \.fxclose/.test(s.m.pop()));
    await CMD.panic(s, msg); assert(/Hakuna trade/.test(s.m.pop()));
  });
  await t('command bila akaunti/idhini → ujumbe wazi, si crash', async () => {
    const s = mkSock('255700555555'); await CMD.buy(s, msg, ['EURUSD', '2', '1', '2']); assert(/❌ Hujaunganisha/.test(s.m.pop()));
    await CMD.positions(s, msg); assert(/❌/.test(s.m.pop()));
  });

  out('\n[11] Routes za dashboard (HTTP halisi za server.js)');
  const srv = require(R('pairing/server.js'));
  const web = http.createServer((q, s) => srv.handlePairingRequest(q, s)); await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${web.address().port}`;
  const nativeFetch = fetch;
  const call = async (method, url, body) => { const r = await nativeFetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch {} return { status: r.status, data, text }; };
  const PH = await mkCustomer('H', 'tokH2-demo-00000001', 'VRTC0000007', '9142', { maxStake: 5, maxTradesDay: 20, maxDailyLoss: 50, maxOpen: 3 }).catch(() => PHONES.H);
  const url = (sub, tok = 'tok-H') => `/api/dashboard/${tok}/deriv/${sub}`;
  await t('GET /overview → balance + positions, bila siri', async () => {
    const r = await call('GET', url('overview', 'tok-H1')); assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.data.ok, true); assert(r.data.balance && Array.isArray(r.data.positions));
    assert(!/OTPSECRET|tokH|encToken|pinHash/.test(r.text));
  });
  await t('POST /trade bila PIN/PIN mbaya → 400 PIN_WRONG na HAKUNA ombi la Deriv', async () => {
    resetFake(); await sleep(8100);
    let r = await call('POST', url('trade', 'tok-H2'), { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2 }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'PIN_WRONG');
    r = await call('POST', url('trade', 'tok-H2'), { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2, pin: '0001' }); assert.strictEqual(r.data.code, 'PIN_WRONG');
    assert.strictEqual(F.requests.filter((x) => x.proposal || x.buy).length, 0);
  });
  await t('POST /trade kwa PIN sahihi → 200; vikomo vinatumika kupitia HTTP (stake > kikomo → 400)', async () => {
    resetFake(); await sleep(8100);
    let r = await call('POST', url('trade', 'tok-H3'), { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2, multiplier: 100, pin: '9142' });
    assert.strictEqual(r.status, 200, r.text); assert(r.data.trade.contractId); global.HID = r.data.trade.contractId;
    r = await call('POST', url('trade', 'tok-H3'), { pair: 'GBPUSD', direction: 'BUY', stake: 50, stopLoss: 1, takeProfit: 2, pin: '9142' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'STAKE_LIMIT');
  });
  await t('POST /close na /closeall hazihitaji PIN na zinafanya kazi wakati wa kill switch', async () => {
    await A.adminAction('', 'kill_all');
    let r = await call('POST', url('close', 'tok-H4'), { contractId: global.HID }); assert.strictEqual(r.status, 200, r.text);
    r = await call('POST', url('closeall', 'tok-H4'), {}); assert.strictEqual(r.status, 200); assert(Array.isArray(r.data.results));
    r = await call('POST', url('trade', 'tok-H4'), { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2, pin: '9142' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'DENIED');
    await A.adminAction('', 'resume_all');
  });
  await t('contractId batili kupitia HTTP → 400 BAD_ID', async () => {
    const r = await call('POST', url('close', 'tok-H4'), { contractId: 'abc' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'BAD_ID');
  });
  await t('PIN ya trade: majaribio mabaya mengi yanaifunga (lockout) hata kupitia /trade', async () => {
    let last; for (let i = 0; i < 6; i++) last = await call('POST', url('trade', 'tok-H5'), { pair: 'EURUSD', direction: 'BUY', stake: 2, stopLoss: 1, takeProfit: 2, pin: '1357' });
    assert(['PIN_LOCKED', 'RATE_LIMIT'].includes(last.data.code), last.text);
    sqlite.prepare('UPDATE deriv_accounts SET pinFails=0, pinLockedUntil=NULL WHERE phoneNumber=?').run(PHONES.H);
  });
  await t('/overview kwa mteja asiye na akaunti → 400 ujumbe, si 500', async () => {
    const r = await call('GET', url('overview', 'tok-A9')); assert(r.status === 400 || r.status === 200); assert.notStrictEqual(r.status, 500);
  });
  web.close();

  out('\n[12] Siri kwenye logs/makosa');
  await t('hakuna token, OTP, PIN wala ufunguo kwenye logs', async () => {
    const all = logs.join('\n');
    for (const x of ['tokA-demo', 'tokB-demo', 'tokC-demo', 'tokD-demo', 'tokH-demo', 'tokH2-demo', 'OTPSECRET', '4829', '9142', '5920', '3857', '6283', 'e'.repeat(64)]) assert(!all.includes(x), 'siri kwenye log: ' + x);
  });

  S.closeAllSessions();
  const bad2 = results.filter((x) => !x).length;
  out(`\n${results.length - bad2}/${results.length} zimepita`);
  process.exit(bad2 ? 1 : 0);
})().catch((e) => { out('FATAL', e.stack); process.exit(2); });
