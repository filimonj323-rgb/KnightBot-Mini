// Majaribio: utils/supportResistance.js, utils/excursion.js na backtest (interval/S-R/excursion) — data ya bandia, hakuna mtandao.
// Tumia: node tests/test-sr-excursion.js "$(pwd)"
const Module = require('module'); const assert = require('assert');
const root = process.argv[2];
const orig = Module._load;
const MIN = { '5min': 5, '15min': 15, '1h': 60, '2h': 120, '4h': 240, '1day': 1440 };
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
function gen(interval, n) {
  const m = MIN[interval]; const out = []; let p = 1.1000; const t0 = Date.parse('2026-01-05T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / (400 / (m / 15 + 1))) * 0.0004 * Math.sqrt(m / 15 + 1);
    const o = p; const c = o + wave * 0.25 + (rnd() - 0.5) * 0.0006 * Math.sqrt(m / 15 + 1);
    const h = Math.max(o, c) + rnd() * 0.0003; const l = Math.min(o, c) - rnd() * 0.0003; p = c;
    const d = new Date(t0 + i * m * 60000).toISOString().replace('T', ' ').slice(0, interval === '1day' ? 10 : 19);
    out.push({ datetime: d, open: String(o), high: String(h), low: String(l), close: String(c) });
  }
  return out;
}
Module._load = function (req, ...a) {
  if (/forexSignal$/.test(req)) return {
    fetchCandles: async (sym, iv, size) => gen(iv, Math.min(size, 3000)),
    computeSignal: (s) => (s.ema9 > s.ema21 ? { direction: 'BUY', strength: 100 } : { direction: 'SELL', strength: 100 }),
    DEFAULT_INTERVAL: '1h', HTF_INTERVAL: '4h', DAILY_INTERVAL: '1day', HTF_GATE: true, DAILY_GATE: true, CANDLE_PATTERNS: false,
    getActiveSessions: () => ['LONDON'], CCY_PRIMARY_SESSION: { EUR: 'LONDON', USD: 'NEWYORK' },
  };
  if (/autoTrader$/.test(req)) return {
    getStatus: () => ({ stake: 5, multiplier: 100, strengthThreshold: 100, slAtrMult: 1, tpAtrMult: 2, fallbackSl: 3, fallbackTp: 6 }),
    computeAtrBasedRisk: ({ atr, price, stake, multiplier }) => { let sl = stake * multiplier * (atr / price); if (sl < 1) sl = 1; return { sl: +sl.toFixed(2), tp: +(sl * 2).toFixed(2) }; },
  };
  return orig.call(this, req, ...a);
};
const SR = require(root + '/utils/supportResistance.js');
const EX = require(root + '/utils/excursion.js');
let n = 0; const ok = async (name, f) => { await f(); n++; console.log('  ✓', name); };
const C = (h, l) => ({ high: h, low: l, open: (h + l) / 2, close: (h + l) / 2 });

(async () => {
  await ok('pipSize: JPY 0.01, nyingine 0.0001; toPips', () => {
    assert.strictEqual(SR.pipSize('USDJPY'), 0.01); assert.strictEqual(SR.pipSize('EUR/USD'), 0.0001);
    assert.strictEqual(Math.round(SR.toPips('EURUSD', 0.0021)), 21); assert.strictEqual(Math.round(SR.toPips('USDJPY', 0.21)), 21);
  });
  await ok('findPivots: swing high/low sahihi na HAKUNA lookahead', () => {
    const cs = []; for (let i = 0; i < 30; i++) cs.push(C(1.1 + (i === 15 ? 0.01 : 0), 1.09));
    cs[22] = C(1.1, 1.08); // swing low
    const p = SR.findPivots(cs, 29, { left: 3, right: 3 });
    assert.deepStrictEqual(p.highs.map((x) => x.i), [15]); assert.deepStrictEqual(p.lows.map((x) => x.i), [22]);
    // upTo=17 -> pivot 15 inahitaji bar 18 (right=3) => bado haijathibitishwa
    assert.strictEqual(SR.findPivots(cs, 17, { left: 3, right: 3 }).highs.length, 0);
    assert.strictEqual(SR.findPivots(cs, 18, { left: 3, right: 3 }).highs.length, 1);
  });
  await ok('buildZones: pivots karibu zinaungana, minTouches inachuja', () => {
    const cs = []; for (let i = 0; i < 80; i++) cs.push(C(1.1, 1.09));
    cs[10] = C(1.1100, 1.09); cs[30] = C(1.1104, 1.09); cs[50] = C(1.1200, 1.09);
    const z = SR.buildZones(cs, 79, 0.001, { left: 3, right: 3, mergeAtr: 0.5, minTouches: 2 });
    assert.strictEqual(z.length, 1); assert.strictEqual(z[0].touches, 2); assert.ok(Math.abs(z[0].price - 1.1102) < 1e-6);
    assert.strictEqual(SR.buildZones(cs, 79, 0.001, { left: 3, right: 3, minTouches: 1 }).length >= 2, true);
  });
  await ok('nearestLevels + checkRoom: BUY inatazama resistance, SELL support', () => {
    const zones = [{ price: 1.0950, low: 1.0948, high: 1.0952, touches: 3 }, { price: 1.1020, low: 1.1018, high: 1.1022, touches: 2 }];
    const nl = SR.nearestLevels(zones, 1.1000);
    assert.strictEqual(nl.support.price, 1.0950); assert.strictEqual(nl.resistance.price, 1.1020);
    const buyNear = SR.checkRoom({ direction: 'BUY', price: 1.1000, atr: 0.0010, zones, minRoomAtr: 1.5 }); // 0.0018/0.001 = 1.8 -> ok
    assert.strictEqual(buyNear.ok, true); assert.ok(Math.abs(buyNear.roomAtr - 1.8) < 1e-6);
    const buyTight = SR.checkRoom({ direction: 'BUY', price: 1.1000, atr: 0.0020, zones, minRoomAtr: 1.5 }); // 0.9 -> blocked
    assert.strictEqual(buyTight.ok, false);
    const sell = SR.checkRoom({ direction: 'SELL', price: 1.0960, atr: 0.0010, zones, minRoomAtr: 1.5 }); // room 0.0008 -> 0.8 blocked
    assert.strictEqual(sell.ok, false);
    assert.strictEqual(SR.checkRoom({ direction: 'BUY', price: 1.2, atr: 0.001, zones }).ok, true); // hakuna S/R mbele
  });
  await ok('forwardExcursion: MFE/MAE/first-touch + hasara kwanza kwenye candle moja', () => {
    const cs = [C(1.1000, 1.1000), C(1.1008, 1.0997), C(1.1012, 1.1003), C(1.1015, 1.0985)];
    const e = EX.forwardExcursion({ candles: cs, entryIndex: 0, direction: 'BUY', entryPrice: 1.1000, horizon: 3, pair: 'EURUSD', thresholds: [5, 10, 15] });
    assert.strictEqual(e.mfe, 15); assert.strictEqual(e.mae, 15); assert.strictEqual(e.complete, true);
    assert.strictEqual(e.firstTouch[5], 'WIN'); assert.strictEqual(e.firstTouch[10], 'WIN');
    assert.strictEqual(e.firstTouch[15], 'LOSS'); // candle ya 3 ilifika +15 na -15: hasara kwanza
    assert.strictEqual(e.barsToFav[5], 1);
    const s = EX.forwardExcursion({ candles: cs, entryIndex: 0, direction: 'SELL', entryPrice: 1.1000, horizon: 3, pair: 'EURUSD', thresholds: [5] });
    assert.strictEqual(s.firstTouch[5], 'LOSS'); // candle 1: juu +8 pips kinyume kabla ya favorable
    assert.strictEqual(EX.forwardExcursion({ candles: cs, entryIndex: 2, direction: 'BUY', entryPrice: 1.1, horizon: 5, pair: 'EURUSD' }).complete, false);
  });
  await ok('summarizeExcursions: median/%, na incomplete hazihesabiwi', () => {
    const mk = (mfe, mae, ft) => ({ complete: true, mfe, mae, firstTouch: { 5: ft }, barsToFav: { 5: mfe >= 5 ? 2 : null } });
    const s = EX.summarizeExcursions([mk(10, 4, 'WIN'), mk(3, 8, 'LOSS'), mk(20, 2, 'WIN'), { complete: false }], [5]);
    assert.strictEqual(s.n, 3); assert.strictEqual(s.skippedIncomplete, 1); assert.strictEqual(s.mfe.median, 10);
    assert.strictEqual(s.byThreshold[5].reachedPct, 66.7); assert.strictEqual(s.byThreshold[5].winFirstPct, 66.7);
  });
  await ok('backtest 1h: inaleta excursion, pips za SL/TP, sr info', async () => {
    const { runBacktest } = require(root + '/utils/backtest.js');
    const r = await runBacktest({ code: 'EURUSD', symbol: 'EUR/USD', bars: 1500 });
    assert.strictEqual(r.interval, '1h'); assert.strictEqual(r.htfInterval, '4h');
    assert.ok(r.entries > 3, 'entries ' + r.entries); assert.ok(r.excursion.n > 0);
    assert.ok(r.avgSlPips > 0 && r.avgTpPips > r.avgSlPips - 0.01);
    assert.ok(r.excursion.mfe.median >= 0 && r.excursion.mae.median >= 0);
  });
  await ok('backtest 15min: htf=1h, na S/R filter inapunguza/haiongezi entries', async () => {
    const { runBacktest } = require(root + '/utils/backtest.js');
    const a = await runBacktest({ code: 'EURUSD', symbol: 'EUR/USD', bars: 2000, interval: '15min' });
    const b = await runBacktest({ code: 'EURUSD', symbol: 'EUR/USD', bars: 2000, interval: '15min', sr: true });
    assert.strictEqual(a.interval, '15min'); assert.strictEqual(a.htfInterval, '1h'); assert.strictEqual(a.horizon, 24);
    assert.strictEqual(a.sr.blocked, 0); assert.ok(b.sr.blocked > 0, 'blocked ' + b.sr.blocked);
    assert.ok(b.sr.filter === true);
  });
  console.log(`\n${n} majaribio yamepita`);
})().catch((e) => { console.error(e); process.exit(1); });
