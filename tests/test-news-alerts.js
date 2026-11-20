// Majaribio: utils/newsAlerts.js (arifa kabla/actual) na arifa za hali za utils/newsTrader.js (washa/zima, REAL, kubadili akaunti).
// Tumia: node tests/test-news-alerts.js "$(pwd)"
const Module = require('module'); const assert = require('assert');
const root = process.argv[2];
const orig = Module._load;
const sentMsgs = []; let mode = 'demo'; let switchListener = null;
const dbRows = {};
Module._load = function (req, ...a) {
  if (req === 'axios') return { get: async () => ({ data: [] }), create: () => ({ get: async () => ({ data: [] }) }) };
  if (/pocketStore$/.test(req)) return { saveSetting: async () => {}, loadSettings: async () => [] };
  if (/autoTrader$/.test(req)) return { getStatus: () => ({ pairs: ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'AUDUSD'], strengthThreshold: 67,
    signals: [{ code: 'EURUSD', direction: 'SELL', strength: 72 }], openTrades: [{ code: 'GBPUSD', direction: 'BUY' }] }), openAutoTrades: new Map() };
  if (/pairing\/db$/.test(req)) return { initSchema: async () => {}, query: async (sql) => ({ rows: /COUNT/i.test(sql) ? [{ n: 1 }] : [] }) };
  if (/newsObserver$/.test(req)) return { start: async () => {}, attach: async (x) => x };
  if (/derivTrader$/.test(req)) return { placeMultiplier: async () => ({}), getOpenPositions: async () => [], getClosedContractFromHistory: async () => null,
    closeContractWithPnL: async () => ({}), getAccountMode: () => mode, getAccountState: async () => ({}), onAccountSwitched: (fn) => { switchListener = fn; },
    getCandles: async () => [], ALLOWED_MULTIPLIERS: [100, 200, 300, 500, 800], MIN_STAKE_USD: 1, MAX_STAKE_USD: 100 };
  return orig.call(this, req, ...a);
};
const na = require(root + '/utils/newsAlerts.js');
const nt = require(root + '/utils/newsTrader.js');
let n = 0; const ok = async (name, f) => { await f(); n++; console.log('  ✓', name); };
const U = (s) => Date.parse(s + 'Z');
const ev = (o) => ({ title: 'Non-Farm Employment Change', country: 'USD', impact: 'High', forecast: '180K', previous: '150K', actual: null, date: '2026-11-20T13:30:00Z', ...o });

(async () => {
  await ok('buildGroups: High pekee, currency zinazojulikana; Medium inajumuishwa kwa ombi; dakika moja = kundi moja', async () => {
    const evs = [ev({}), ev({ title: 'Unemployment Rate', forecast: '4.1%' }), ev({ impact: 'Medium', title: 'X' }), ev({ impact: 'Low' }), ev({ country: 'CNY' })];
    assert.strictEqual(na.buildGroups(evs).length, 1);
    assert.strictEqual(na.buildGroups(evs)[0].events.length, 2);
    assert.strictEqual(na.buildGroups(evs, ['high', 'medium'])[0].events.length, 3);
  });
  await ok('affectedPairs: USD ikiimarika → SELL EURUSD/GBPUSD, BUY USDJPY; pair kuu EURUSD ⭐', async () => {
    const p = na.affectedPairs('USD', true, ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP']);
    assert.deepStrictEqual(p.map((x) => `${x.code}:${x.direction}`), ['EURUSD:SELL', 'GBPUSD:SELL', 'USDJPY:BUY']);
    assert.strictEqual(p[0].main, true);
    const w = na.affectedPairs('USD', false, ['EURUSD', 'USDJPY']);
    assert.deepStrictEqual(w.map((x) => x.direction), ['BUY', 'SELL']);
  });
  await ok('affectedPairs: JPY ikiimarika → SELL USDJPY (pair kuu), EUR ikiimarika → BUY EURUSD', async () => {
    assert.deepStrictEqual(na.affectedPairs('JPY', true, ['USDJPY', 'EURJPY']).map((x) => `${x.code}:${x.direction}`), ['USDJPY:SELL', 'EURJPY:SELL']);
    assert.strictEqual(na.affectedPairs('EUR', true, ['EURUSD', 'EURGBP'])[0].code + na.affectedPairs('EUR', true, ['EURUSD'])[0].direction, 'EURUSDBUY');
  });
  await ok('arifa ya KABLA: ina tukio, forecast/previous, pairs, mwelekeo wa pande zote mbili, tahadhari na trades wazi', async () => {
    const g = na.buildGroups([ev({})])[0];
    const t = na.msgPre(g, 30, { now: g.t - 30 * 60000, pairs: ['EURUSD', 'GBPUSD', 'USDJPY'], openTrades: [{ code: 'GBPUSD', direction: 'BUY' }], newsTradingLine: '📡 News Trading: *IMEZIMWA*' });
    for (const re of [/BAADA YA DK 30/, /Non-Farm Employment Change/, /Forecast 180K/, /Previous 150K/, /Pairs zitakazoathirika:\* EURUSD, GBPUSD, USDJPY/, /USD inaimarika/, /USD inadhoofika/, /⭐ EURUSD 🔴 SELL/, /Pair kuu ya kutrade:\* EURUSD/, /GBPUSD BUY/, /News Trading: \*IMEZIMWA\*/]) assert.ok(re.test(t), String(re) + '\n' + t);
  });
  await ok('arifa ya kabla: kiashiria cha "chini ni bora" (Unemployment) kinageuza maelezo', async () => {
    const g = na.buildGroups([ev({ title: 'Unemployment Rate', forecast: '4.1%' })])[0];
    const t = na.msgPre(g, 5, { now: g.t - 5 * 60000, pairs: ['EURUSD'] });
    assert.ok(/CHINI ya forecast \(bora/.test(t) && /🚨/.test(t), t);
  });
  await ok('arifa ya ACTUAL (bora): USD inaimarika, SELL EURUSD, signal ya auto-trader inakubaliana', async () => {
    const g = na.buildGroups([ev({ actual: '220K' })])[0];
    const t = na.msgActual(g, { now: g.t + 90000, pairs: ['EURUSD', 'GBPUSD', 'USDJPY'], signals: [{ code: 'EURUSD', direction: 'SELL', strength: 72 }] });
    for (const re of [/ACTUAL IMETOKA — USD/, /\*220K\* vs forecast 180K \(previous 150K\)/, /bora kuliko forecast/, /USD 🟢 INAIMARIKA/, /Ya kutrade:\* 🔴 SELL \*EURUSD\*/, /inakubaliana/]) assert.ok(re.test(t), String(re) + '\n' + t);
  });
  await ok('arifa ya ACTUAL (mbaya): USD inadhoofika → BUY EURUSD; signal inayopingana inaonywa', async () => {
    const g = na.buildGroups([ev({ actual: '120K' })])[0];
    const t = na.msgActual(g, { now: g.t + 60000, pairs: ['EURUSD'], signals: [{ code: 'EURUSD', direction: 'SELL', strength: 72 }] });
    assert.ok(/INADHOOFIKA/.test(t) && /🟢 BUY \*EURUSD\*/.test(t) && /INAPINGANA/.test(t), t);
  });
  await ok('arifa ya ACTUAL: Unemployment juu ya forecast = mbaya kwa USD (inverse); surprise ndogo = usitrade', async () => {
    const g = na.buildGroups([ev({ title: 'Unemployment Rate', forecast: '4.0%', actual: '4.6%' })])[0];
    assert.ok(/INADHOOFIKA/.test(na.msgActual(g, { now: g.t + 60000, pairs: ['EURUSD'] })));
    const flat = na.buildGroups([ev({ actual: '181K' })])[0];
    const t = na.msgActual(flat, { now: flat.t + 60000, pairs: ['EURUSD'] });
    assert.ok(/hakuna mwelekeo wazi/.test(t) && /Usitrade kwa habari hii/.test(t), t);
  });
  await ok('dueAlerts: kabla (dk 30 na dk 5) mara moja tu ndani ya dirisha; si mapema/si baada ya release', async () => {
    const g = na.buildGroups([ev({})])[0];
    const st = { leads: [30, 5], sent: {}, firstActual: new Map() };
    assert.deepStrictEqual(na.dueAlerts([g], g.t - 45 * 60000, st), []);
    assert.deepStrictEqual(na.dueAlerts([g], g.t - 29 * 60000, st).map((d) => d.key), ['pre:' + g.key + ':30']);
    st.sent['pre:' + g.key + ':30'] = 1;
    assert.deepStrictEqual(na.dueAlerts([g], g.t - 28.5 * 60000, st), []);
    assert.deepStrictEqual(na.dueAlerts([g], g.t - 4 * 60000, st).map((d) => d.key), ['pre:' + g.key + ':5']);
    assert.deepStrictEqual(na.dueAlerts([g], g.t - 20 * 60000, st), []); // bot ilikuwa imezimwa wakati wa dirisha la dk 30 — hairudiwi baadaye
  });
  await ok('dueAlerts: actual — inatumwa actual zote zikiingia au baada ya sekunde za kusubiri; mara moja tu; si bila namba', async () => {
    const two = [ev({ actual: '220K' }), ev({ title: 'Unemployment Rate', forecast: '4.1%', actual: null })];
    const g = na.buildGroups(two)[0];
    const st = { leads: [], sent: {}, firstActual: new Map() };
    assert.deepStrictEqual(na.dueAlerts([g], g.t + 30000, st), []);          // actual moja tu, bado inasubiri
    st.firstActual.set(g.key, g.t + 30000);
    assert.deepStrictEqual(na.dueAlerts([g], g.t + 100000, st).map((d) => d.kind), ['actual']); // sekunde 60+ zimepita
    const done = na.buildGroups([ev({ actual: '220K' })])[0];
    assert.deepStrictEqual(na.dueAlerts([done], done.t + 5000, { leads: [], sent: {}, firstActual: new Map() }).map((d) => d.kind), ['actual']);
    assert.deepStrictEqual(na.dueAlerts([done], done.t + 5000, { leads: [], sent: { ['act:' + done.key]: 1 }, firstActual: new Map() }), []);
    const speech = na.buildGroups([ev({ title: 'FOMC Member Speaks', forecast: null, actual: null })])[0];
    assert.deepStrictEqual(na.dueAlerts([speech], speech.t + 5000, { leads: [30], sent: {}, firstActual: new Map() }), []);
  });
  await ok('parseLeads: "30,5" → [30,5]; takataka zinapuuzwa; juu ya 240 inakataliwa', async () => {
    assert.deepStrictEqual(na.parseLeads('5, 30'), [30, 5]);
    assert.deepStrictEqual(na.parseLeads('abc,999,0'), []);
  });

  // ── newsTrader: arifa za hali ──
  global.currentSock = { sendMessage: async (jid, m) => { sentMsgs.push(m.text); } };
  await nt.start({ sock: global.currentSock, notifyJid: '1@s.whatsapp.net' });
  const last = () => sentMsgs[sentMsgs.length - 1] || '';
  await ok('News Trading kuwashwa (DEMO) → arifa yenye akaunti, mipangilio na "Itafanya trade (DEMO)"', async () => {
    sentMsgs.length = 0; mode = 'demo';
    await nt.setConfig({ enabled: true });
    assert.ok(/NEWS TRADING IMEWASHWA/.test(last()) && /DEMO/.test(last()) && /Itafanya trade \(DEMO\)/.test(last()) && /Stake \$1/.test(last()), last());
  });
  await ok('kuzima → arifa ya kuzimwa + trades wazi zinaendelea kufuatiliwa', async () => {
    sentMsgs.length = 0;
    await nt.setConfig({ enabled: false });
    assert.ok(/NEWS TRADING IMEZIMWA/.test(last()) && /bado wazi/.test(last()), last());
  });
  await ok('config nyingine (stake) bila kubadili enabled/allowReal → hakuna arifa', async () => {
    sentMsgs.length = 0;
    await nt.setConfig({ stake: 2 });
    assert.strictEqual(sentMsgs.length, 0);
  });
  await ok('ruhusa ya REAL kuwashwa (akaunti DEMO) → arifa ya onyo; kuzimwa → arifa ya kufungwa', async () => {
    sentMsgs.length = 0; mode = 'demo';
    await nt.setConfig({ allowReal: true });
    assert.ok(/RUHUSA YA REAL IMEWASHWA/.test(last()) && /pesa halisi/.test(last()), last());
    await nt.setConfig({ allowReal: false });
    assert.ok(/RUHUSA YA REAL IMEZIMWA/.test(last()), last());
  });
  await ok('ruhusa ya REAL ikiwashwa wakati akaunti ni REAL na News Trading imewashwa → "ITAFANYA trade kwa PESA HALISI"', async () => {
    sentMsgs.length = 0; mode = 'real';
    await nt.setConfig({ enabled: true, allowReal: true });
    const all = sentMsgs.join('\n');
    assert.ok(/RUHUSA YA REAL IMEWASHWA/.test(all) && /PESA HALISI/.test(all) && /NEWS TRADING IMEWASHWA/.test(all), all);
  });
  await ok('kubadili akaunti → arifa: REAL bila ruhusa = HAITAFANYA trade; REAL na ruhusa = ITAFANYA; DEMO = itafanya DEMO', async () => {
    assert.strictEqual(typeof switchListener, 'function');
    await nt.setConfig({ enabled: true, allowReal: false }); sentMsgs.length = 0;
    await switchListener('real', 'demo'); await new Promise((r) => setTimeout(r, 20));
    assert.ok(/AKAUNTI IMEBADILIKA/.test(last()) && /HAITAFANYA trade/.test(last()), last());
    await nt.setConfig({ allowReal: true }); sentMsgs.length = 0;
    await switchListener('real', 'demo'); await new Promise((r) => setTimeout(r, 20));
    assert.ok(/ITAFANYA trade kwa PESA HALISI/.test(last()), last());
    sentMsgs.length = 0; await switchListener('demo', 'real'); await new Promise((r) => setTimeout(r, 20));
    assert.ok(/Itafanya trade \(DEMO\)/.test(last()), last());
  });
  console.log(`\nOK — ${n} majaribio ya newsAlerts/newsTrader yamepita`);
  nt.stop(); process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
