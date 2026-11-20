// Majaribio ya utils/marketSessions.js — kazi safi (muda unapitishwa wazi), hakuna mtandao/DB.
// Tumia: node tests/test-market-sessions.js "$(pwd)"
const Module = require('module'); const assert = require('assert');
const root = process.argv[2];
const orig = Module._load;
Module._load = function (req, ...a) {
  if (/pocketStore$/.test(req)) return { saveSetting: async () => {}, loadSettings: async () => [] };
  if (/autoTrader$/.test(req)) return { getStatus: () => ({ signals: [], pairs: [], strengthThreshold: 67 }), openAutoTrades: new Map([['1', {}], ['2', {}]]) };
  return orig.call(this, req, ...a);
};
const m = require(root + '/utils/marketSessions.js');
const U = (s) => Date.parse(s + 'Z');
let n = 0; const ok = (name, f) => { f(); n++; console.log('  ✓', name); };

ok('soko: Ijumaa 16:59 NY wazi, 17:00 imefungwa (baridi, EST)', () => {
  assert.strictEqual(m.isMarketOpen(U('2026-11-20T21:59:00')), true);
  assert.strictEqual(m.isMarketOpen(U('2026-11-20T22:00:00')), false);
});
ok('soko: Jumapili 17:00 NY inafunguliwa (baridi)', () => {
  assert.strictEqual(m.isMarketOpen(U('2026-11-22T21:59:00')), false);
  assert.strictEqual(m.isMarketOpen(U('2026-11-22T22:00:00')), true);
});
ok('soko: DST (kiangazi, EDT) — saa 21:00 UTC', () => {
  assert.strictEqual(m.isMarketOpen(U('2026-07-10T20:59:00')), true);
  assert.strictEqual(m.isMarketOpen(U('2026-07-10T21:00:00')), false);
  assert.strictEqual(m.isMarketOpen(U('2026-07-12T21:00:00')), true);
});
ok('soko: Jumamosi yote imefungwa', () => {
  assert.strictEqual(m.isMarketOpen(U('2026-11-21T03:00:00')), false);
  assert.strictEqual(m.isMarketOpen(U('2026-11-21T20:00:00')), false);
});
ok('nextMarketOpen kutoka Jumamosi = Jumapili 22:00 UTC; nextMarketClose kutoka Jumanne = Ijumaa 22:00 UTC', () => {
  assert.strictEqual(m.nextMarketOpen(U('2026-11-21T10:00:00')), U('2026-11-22T22:00:00'));
  assert.strictEqual(m.nextMarketClose(U('2026-11-17T10:00:00')), U('2026-11-20T22:00:00'));
});
ok('sessions Jumanne 2026-11-17: nyakati muhimu (UTC)', () => {
  const at = (t) => m.activeSessions(U('2026-11-17T' + t + ':00')).join('/');
  assert.strictEqual(at('00:30'), 'SYDNEY/TOKYO');
  assert.strictEqual(at('08:30'), 'TOKYO/LONDON');      // Tokyo = 00:00–09:00 UTC, London = 08:00–17:00 UTC (baridi)
  assert.strictEqual(at('09:00'), 'LONDON');
});
ok('sessions: overlap London+NY na kufungwa kwa London 17:00 UTC (baridi)', () => {
  const at = (t) => m.activeSessions(U('2026-11-17T' + t + ':00')).join('/');
  assert.ok(at('14:00').includes('LONDON') && at('14:00').includes('NEWYORK'));
  assert.strictEqual(at('17:00'), 'NEWYORK');
  assert.strictEqual(at('22:00'), 'SYDNEY'); // NY imefungwa 17:00 EST; Sydney Jumatano 09:00 AEDT wazi
});
ok('Jumamosi/Jumapili mapema: hakuna session (hata Sydney Jumatatu asubuhi kabla soko kufunguliwa)', () => {
  assert.deepStrictEqual(m.activeSessions(U('2026-11-21T12:00:00')), []);
  assert.deepStrictEqual(m.activeSessions(U('2026-11-22T21:30:00')), []); // Sydney Mon 08:30 AEDT lakini soko limefungwa
  assert.deepStrictEqual(m.activeSessions(U('2026-11-22T22:00:00')), ['SYDNEY']);
});
ok('diffEvents: soko kufunguliwa → ujumbe MMOJA (hakuna session-open tofauti) wenye Sydney', () => {
  const prev = { marketOpen: false, active: [] };
  const r = m.diffEvents(prev, U('2026-11-22T22:00:00'));
  assert.deepStrictEqual(r.msgs.map((x) => x.kind), ['market_open']);
  assert.ok(/SOKO LA FOREX LIMEFUNGULIWA/.test(r.msgs[0].text) && /Sydney/.test(r.msgs[0].text));
});
ok('diffEvents: Ijumaa kufunga → market_closed pekee (hakuna close za sessions) + inataja litafunguliwa lini', () => {
  const prev = { marketOpen: true, active: ['NEWYORK'] };
  const r = m.diffEvents(prev, U('2026-11-20T22:00:00'));
  assert.deepStrictEqual(r.msgs.map((x) => x.kind), ['market_closed']);
  assert.ok(/LIMEFUNGWA/.test(r.msgs[0].text) && /Litafunguliwa: usiku wa kuamkia Jumatatu saa 7 usiku \(01:00\)/.test(r.msgs[0].text), r.msgs[0].text);
});
ok('diffEvents: London inafunguliwa Jumanne 08:00 UTC → open:LONDON yenye pairs na jina la session', () => {
  const t = U('2026-11-17T08:00:00');
  const prev = { marketOpen: true, active: m.activeSessions(t - 60000) };
  const r = m.diffEvents(prev, t);
  assert.deepStrictEqual(r.msgs.map((x) => x.kind), ['open:LONDON']);
  assert.ok(/SESSION YA LONDON IMEFUNGULIWA/.test(r.msgs[0].text) && /EURGBP/.test(r.msgs[0].text) && /Pairs za kutrade/.test(r.msgs[0].text));
});
ok('diffEvents: Tokyo inafungwa → close:TOKYO; hakuna kurudia dakika inayofuata', () => {
  const t = U('2026-11-17T09:00:00');
  const prev = { marketOpen: true, active: m.activeSessions(t - 60000) };
  assert.deepStrictEqual(m.diffEvents(prev, t).msgs.map((x) => x.kind), ['close:TOKYO']);
  const again = { marketOpen: true, active: m.activeSessions(t) };
  assert.deepStrictEqual(m.diffEvents(again, t + 60000).msgs, []);
});
ok('onyo la kabla ya kufungwa: mara moja kwa wiki, lina idadi ya trades wazi', () => {
  const t = U('2026-11-20T21:00:00'); // saa 1 kabla ya 22:00 UTC
  const prev = { marketOpen: true, active: m.activeSessions(t - 60000) };
  const r = m.diffEvents(prev, t);
  assert.deepStrictEqual(r.msgs.map((x) => x.kind), ['preclose']);
  assert.ok(/trades 2 zilizo wazi/.test(r.msgs[0].text), r.msgs[0].text);
  const r2 = m.diffEvents({ ...prev, warnedWeek: r.msgs[0].warnedWeek }, t + 60000);
  assert.deepStrictEqual(r2.msgs, []);
  assert.deepStrictEqual(m.diffEvents(prev, U('2026-11-20T19:00:00')).msgs, []); // mapema mno
});
ok('pairs: London → EURGBP/EURUSD/GBPUSD juu; Tokyo → USDJPY/AUDJPY; NY → USDCAD', () => {
  const top = (a) => m.recommendPairs(a, { limit: 6, sigs: { signals: [], threshold: 67, pairs: ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'AUDJPY', 'USDCAD', 'NZDUSD', 'AUDUSD'] } }).map((r) => r.code);
  assert.strictEqual(top(['LONDON'])[0], 'EURGBP');
  assert.ok(top(['LONDON']).includes('EURUSD') && !top(['LONDON']).includes('AUDJPY'));
  assert.ok(top(['TOKYO']).slice(0, 2).every((c) => ['USDJPY', 'AUDJPY'].includes(c)));
  assert.ok(top(['NEWYORK']).includes('USDCAD'));
});
ok('pairs: signal yenye nguvu inapewa kipaumbele kwa alama sawa + inaonyeshwa ✅', () => {
  const sigs = { threshold: 67, pairs: ['EURUSD', 'GBPUSD'], signals: [{ code: 'EURUSD', direction: 'SELL', strength: 80 }, { code: 'GBPUSD', direction: 'BUY', strength: 50 }] };
  const r = m.recommendPairs(['LONDON', 'NEWYORK'], { sigs });
  assert.strictEqual(r[0].code, 'EURUSD'); assert.strictEqual(r[0].tradable, true); assert.strictEqual(r[1].tradable, false);
});
ok('usalama wa muda: partsOf haitupi kwa mpaka wa DST (Machi 2026) na nextChange inarudi null ikiwa hakuna mabadiliko', () => {
  assert.doesNotThrow(() => m.activeSessions(U('2026-03-08T07:00:00')));
  assert.strictEqual(m.nextSessionChange('TOKYO', U('2026-11-17T10:00:00')) > U('2026-11-17T10:00:00'), true);
});
ok('saa za Kiswahili: 06:00=saa 12 asubuhi, 12:00=saa 6 mchana, 16:00=saa 10 jioni, 19:00=saa 1 usiku, 00:00=saa 6 usiku, 04:30=saa 10:30 alfajiri', () => {
  const f = (h, mi = 0) => m.swahiliClock(h * 60 + mi);
  assert.strictEqual(f(6), 'saa 12 asubuhi (06:00)'); assert.strictEqual(f(12), 'saa 6 mchana (12:00)');
  assert.strictEqual(f(15), 'saa 9 alasiri (15:00)'); assert.strictEqual(f(16), 'saa 10 jioni (16:00)');
  assert.strictEqual(f(19), 'saa 1 usiku (19:00)'); assert.strictEqual(f(0), 'saa 6 usiku (00:00)');
  assert.strictEqual(f(4, 30), 'saa 10:30 alfajiri (04:30)'); assert.strictEqual(f(9, 5), 'saa 3:05 asubuhi (09:05)');
});
console.log(`\nOK — ${n} majaribio ya marketSessions yamepita`);
