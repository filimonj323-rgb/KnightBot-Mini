// Run: node tests/test-sl-proximity.js  — integration: autoTrader.checkSlProximity() na setSrFilter()/setSrAlerts() kwa deps zilizoigwa.
const Module = require('module'); const assert = require('assert'); const path = require('path');
const sent = [];
let positions = [];
const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => deep(), construct: () => deep() });
const derivStub = {
  getOpenPositionsLive: async () => positions, getOpenPositions: async () => positions,
  getAccountMode: () => 'demo', onAccountSwitched: () => {}, updateContractLimits: async () => {},
  ALLOWED_MULTIPLIERS: [10, 20, 50, 100, 200, 300, 500, 1000], MIN_STAKE_USD: 1, toDerivSymbol: (s) => s,
  getContractDetails: async () => ({}), getClosedContractFromHistory: async () => null, getProfitTable: async () => [], getAccountState: () => ({}), getRecentOpens: () => [], placeMultiplier: async () => ({}),
};
const orig = Module._load;
Module._load = function (req, parent, ...r) {
  if (/(^|\/)derivTrader$/.test(req)) return derivStub;
  if (/pairing\/db$/.test(req)) return { initSchema: async () => {}, query: async () => ({ rows: [] }) };
  if (/(^|\/)newsTrader$/.test(req)) return { isNewsContract: (id) => id === 'NEWS', start: async () => {} };
  try { return orig.call(this, req, parent, ...r); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' || /fx.*Db|db/i.test(req)) return deep(); throw e; }
};
process.env.AUTO_TRADE_POLL_MS = '999999'; process.env.AUTO_TRADE_LIVE_CACHE_MS = '0';
const a = require(path.resolve(__dirname, '../utils/autoTrader.js'));
a.start({ sock: { sendMessage: async (jid, m) => { sent.push(m.text); } }, notifyJid: 'owner@s.whatsapp.net' });
const live = (id, profit, sl, extra = {}) => ({ contract_id: id, symbol: 'frxEURUSD', contract_type: 'MULTUP', buy_price: 10, multiplier: 100, current_spot: 1.0990, profit, limit_order: { stop_loss: { order_amount: sl } }, ...extra });
(async () => {
  global.currentSock = { sendMessage: async (jid, m) => { sent.push(m.text); } };
  positions = [live('1', -1, -5)];
  await a.checkSlProximity(); assert.strictEqual(sent.length, 0, 'bado salama');
  positions = [live('1', -3.6, -5)]; await a.checkSlProximity();
  assert.strictEqual(sent.length, 1); assert.ok(/INAKARIBIA SL/.test(sent[0]) && /72%/.test(sent[0]), sent[0]);
  await a.checkSlProximity(); assert.strictEqual(sent.length, 1, 'hakuna kurudia');
  positions = [live('1', -4.6, -5)]; await a.checkSlProximity();
  assert.strictEqual(sent.length, 2); assert.ok(/HATARI/.test(sent[1]));
  positions = [live('1', -1, -5)]; await a.checkSlProximity();
  assert.strictEqual(sent.length, 3); assert.ok(/IMEREJEA/.test(sent[2]));
  positions = [live('NEWS', -4.9, -5), live('2', -4.9, 2), { ...live('3', -4.9, -5), symbol: 'frxXAUUSD' }];
  await a.checkSlProximity(); assert.strictEqual(sent.length, 3, 'news / SL ya faida / jozi nje — ruka');
  // toggles
  const before = sent.length;
  let r = await a.setSrFilter(true, { source: 'test' }); assert.strictEqual(r.srFilter, true);
  assert.ok(/IMEWASHWA/.test(sent[before]) && /S\/R/.test(sent[before]), sent[before]);
  r = await a.setSrFilter(true, { source: 'test' }); assert.strictEqual(r.changed, false); assert.strictEqual(sent.length, before + 1, 'hakuna arifa bila mabadiliko');
  await a.setSrFilter(false, { source: 'test' }); assert.ok(/IMEZIMWA/.test(sent[before + 1]));
  await a.setSrAlerts(false, { source: 'test' }); assert.ok(/ZIMEZIMWA/.test(sent[before + 2]));
  positions = [live('9', -4.9, -5)]; const n = sent.length; await a.checkSlProximity(); assert.strictEqual(sent.length, n, 'alerts OFF — kimya');
  await a.setSrAlerts(true, { source: 'test', notifyOwner: false }); assert.strictEqual(sent.length, n + 0);
  await a.checkSlProximity(); assert.strictEqual(sent.length, n + 1, 'alerts ON tena — onyo la 9 linakuja'); assert.ok(/HATARI/.test(sent[n]));
  console.log('✅ test-sl-proximity: zote zimepita'); a.stop(); process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
