// Run: node tests/test-trade-estimate.js
const assert = require('assert');
const te = require('../utils/tradeEstimate');
const atr = 0.0010;
const zones = [
  { price: 1.0950, low: 1.0948, high: 1.0952, touches: 2, tf: '1h' },
  { price: 1.1050, low: 1.1048, high: 1.1052, touches: 3, tf: '4h' },
];

// nguvu ya zone
assert.strictEqual(te.zoneStrength({ touches: 2, tf: '1h' }).label, 'dhaifu');
assert.strictEqual(te.zoneStrength({ touches: 3, tf: '1h' }).label, 'wastani');
assert.strictEqual(te.zoneStrength({ touches: 3, tf: '4h' }).label, 'imara');
assert.strictEqual(te.zoneStrength({ touches: 5, tf: '1h' }).label, 'imara');

// ── estimateTrade: BUY, stake 10 × 100 = 1000 notional. SL $3 → 0.3% ; TP $6 → 0.6%
let e = te.estimateTrade({ code: 'EURUSD', direction: 'BUY', entry: 1.1000, stake: 10, multiplier: 100, slUsd: 3, tpUsd: 6, atr, zones });
assert.ok(Math.abs(e.slPrice - (1.1 - 0.0033)) < 1e-9, e.slPrice);
assert.ok(Math.abs(e.tpPrice - (1.1 + 0.0066)) < 1e-9, e.tpPrice);
assert.strictEqual(e.slPips, 33); assert.strictEqual(e.tpPips, 66);
assert.strictEqual(e.rr, 2); assert.strictEqual(e.lossPctOfStake, 30); assert.strictEqual(e.profitPctOfStake, 60);
// resistance 1.1048 iko kabla ya TP 1.1066 → blocked ; support 1.0952 iko JUU ya SL 1.0967? SL=1.0967 → support (high 1.0952) iko chini ya SL → haikingi
assert.strictEqual(e.srTp.blocked, true); assert.strictEqual(e.srTp.pips, 48);
assert.strictEqual(e.srSl.protected, false);
// SL kubwa zaidi → support inalinda
e = te.estimateTrade({ code: 'EURUSD', direction: 'BUY', entry: 1.1000, stake: 10, multiplier: 100, slUsd: 6, tpUsd: 3, atr, zones });
assert.strictEqual(e.srSl.protected, true); assert.strictEqual(e.srTp.blocked, false);
// SELL ni kioo
e = te.estimateTrade({ code: 'EURUSD', direction: 'SELL', entry: 1.1000, stake: 10, multiplier: 100, slUsd: 3, tpUsd: 6, atr, zones });
assert.ok(e.slPrice > 1.1 && e.tpPrice < 1.1);
assert.strictEqual(e.srTp.blocked, true); // support 1.0952 iko kabla ya TP 1.0934
// JPY pips
e = te.estimateTrade({ code: 'USDJPY', direction: 'BUY', entry: 150, stake: 10, multiplier: 100, slUsd: 5, tpUsd: 10, zones: [] });
assert.ok(Math.abs(e.slPips - 75) < 1e-6, e.slPips); // 0.5% ya 150 = 0.75 = 75 pips
// bila entry → $ tu
e = te.estimateTrade({ code: 'EURUSD', direction: 'BUY', entry: null, stake: 5, multiplier: 100, slUsd: 3, tpUsd: 6 });
assert.strictEqual(e.slPrice, null); assert.strictEqual(e.rr, 2);
const t0 = te.formatEstimate(e);
assert.ok(/\+\$6\.00/.test(t0) && /-\$3\.00/.test(t0) && !/Entry/.test(t0), t0);
// RR < 1 onyo
e = te.estimateTrade({ code: 'EURUSD', direction: 'BUY', entry: 1.1, stake: 5, multiplier: 100, slUsd: 6, tpUsd: 3 });
assert.ok(/faida lengwa ndogo/.test(te.formatEstimate(e)));
// data mbovu
e = te.estimateTrade({ code: 'EURUSD', direction: 'BUY', entry: 1.1, stake: 0, multiplier: 100, slUsd: NaN, tpUsd: 'x' });
assert.strictEqual(e.maxLoss, null); assert.strictEqual(e.target, null);
te.formatEstimate(e);
// full format
e = te.estimateTrade({ code: 'EURUSD', direction: 'BUY', entry: 1.1000, stake: 10, multiplier: 100, slUsd: 3, tpUsd: 6, zones, commission: 0.12 });
const txt = te.formatEstimate(e);
for (const k of ['Entry ≈ 1.10000', '+$6.00', '66 pips', '-$3.00', '33 pips', '1 : 2', 'kabla ya TP', 'Commission: $0.12']) assert.ok(txt.includes(k), k + '\n' + txt);

// ── describeSr ──
let d = te.describeSr({ code: 'EURUSD', direction: 'BUY', price: 1.1000, atr, zones });
assert.strictEqual(d.above[0].pips, 48); assert.strictEqual(d.below[0].pips, 48);
assert.strictEqual(d.ok, true); assert.ok(/S\/R haizuii/.test(d.verdict), d.verdict);      // 48 pips = 4.8×ATR
// karibu na resistance: bei 1.1042 → 6 pips = 0.6×ATR → onyo
d = te.describeSr({ code: 'EURUSD', direction: 'BUY', price: 1.1042, atr, zones });
assert.strictEqual(d.ok, false); assert.ok(/karibu mno/.test(d.verdict), d.verdict);
// SELL karibu na support kutoka juu: bei 1.0958 → 0.6×ATR
d = te.describeSr({ code: 'EURUSD', direction: 'SELL', price: 1.0958, atr, zones });
assert.strictEqual(d.ok, false);
// NEUTRAL
d = te.describeSr({ code: 'EURUSD', direction: 'NEUTRAL', price: 1.1000, atr, zones });
assert.ok(/Hakuna signal/.test(d.verdict) && d.ok === null);
// ndani ya zone
d = te.describeSr({ code: 'EURUSD', direction: 'BUY', price: 1.1050, atr, zones });
assert.ok(/NDANI ya zone/.test(d.verdict));
// hakuna zones
d = te.describeSr({ code: 'EURUSD', direction: 'BUY', price: 1.1, atr, zones: [] });
assert.ok(d.ok === true && /njia iko wazi/.test(d.verdict));
assert.ok(d.lines.join('\n').includes('Resistance') && d.lines.join('\n').includes('Support'));
console.log('✅ test-trade-estimate: zote zimepita');
