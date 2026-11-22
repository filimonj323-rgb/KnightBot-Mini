// Run: node tests/test-sr-alerts.js
const assert = require('assert');
const sa = require('../utils/srAlerts');

const atr = 0.0010;
const zRes = { price: 1.1050, low: 1.1048, high: 1.1052, touches: 3, tf: '4h' };
const zSup = { price: 1.0950, low: 1.0948, high: 1.0952, touches: 2, tf: '1h' };
const zones = [zSup, zRes];
const T = 1e12;
const roomOk = { ok: true, reason: 'ok' };
const roomBad = { ok: false, level: zRes, roomPrice: 0.0008, roomAtr: 0.8, reason: 'x' };

// ── Tracker ──
let t = sa.createTracker();
// uangalizi wa kwanza: hakuna blocked/broken (seed), lakini approach inaruhusiwa
let ev = t.observe({ code: 'EURUSD', price: 1.1000, atr, zones, direction: 'BUY', room: roomBad, now: T });
assert.deepStrictEqual(ev.map((e) => e.type), [], 'first observe seeds silently (far from zones)');
ev = t.observe({ code: 'EURUSD', price: 1.1001, atr, zones, direction: 'BUY', room: roomBad, now: T + 1 });
assert.deepStrictEqual(ev.map((e) => e.type), [], 'still blocked, no transition');
ev = t.observe({ code: 'EURUSD', price: 1.1002, atr, zones, direction: 'BUY', room: roomOk, now: T + 2 });
assert.deepStrictEqual(ev.map((e) => e.type), ['cleared']);
ev = t.observe({ code: 'EURUSD', price: 1.1003, atr, zones, direction: 'BUY', room: roomBad, now: T + 3 });
assert.deepStrictEqual(ev.map((e) => e.type), ['blocked']);
// cleared -> blocked tena ndani ya cooldown: blocked haitumwi mara ya pili
t.observe({ code: 'EURUSD', price: 1.1003, atr, zones, direction: 'BUY', room: roomOk, now: T + 4 });
ev = t.observe({ code: 'EURUSD', price: 1.1003, atr, zones, direction: 'BUY', room: roomBad, now: T + 5 });
assert.deepStrictEqual(ev.map((e) => e.type), [], 'blocked cooldown');
// approach: bei 1.1046 ni 0.2×ATR chini ya resistance
ev = t.observe({ code: 'EURUSD', price: 1.1046, atr, zones, direction: 'BUY', room: roomBad, now: T + 6 });
assert.deepStrictEqual(ev.map((e) => e.type), ['approach']);
assert.strictEqual(ev[0].side, 'resistance');
ev = t.observe({ code: 'EURUSD', price: 1.1047, atr, zones, direction: 'BUY', room: roomBad, now: T + 7 });
assert.deepStrictEqual(ev.map((e) => e.type), [], 'approach haijirudii wakati bado karibu');
// broken: bei inavuka juu ya zone (1.1052 + 0.1×ATR = 1.1053)
ev = t.observe({ code: 'EURUSD', price: 1.1060, atr, zones, direction: 'BUY', room: roomOk, now: T + 8 });
assert.ok(ev.some((e) => e.type === 'broken' && e.dir === 'UP'), 'breakout');
// breakdown ya support
let t2 = sa.createTracker();
t2.observe({ code: 'GBPUSD', price: 1.0960, atr, zones, direction: 'NEUTRAL', room: null, now: T });
ev = t2.observe({ code: 'GBPUSD', price: 1.0940, atr, zones, direction: 'NEUTRAL', room: null, now: T + 1 });
assert.ok(ev.some((e) => e.type === 'broken' && e.dir === 'DOWN'));
// reset
t2.reset();
ev = t2.observe({ code: 'GBPUSD', price: 1.0900, atr, zones, direction: 'NEUTRAL', room: null, now: T + 2 });
assert.deepStrictEqual(ev, [], 'baada ya reset hakuna broken');
// data mbovu
assert.deepStrictEqual(t.observe({ code: 'X', price: NaN, atr, zones }), []);

// ── slRisk / decision ──
assert.strictEqual(sa.slRisk({ profit: 1, stopPnl: -5 }).level, 0);
assert.strictEqual(sa.slRisk({ profit: -3.4, stopPnl: -5 }).level, 0);   // 68%
assert.strictEqual(sa.slRisk({ profit: -3.5, stopPnl: -5 }).level, 1);   // 70%
assert.strictEqual(sa.slRisk({ profit: -4.5, stopPnl: -5 }).level, 2);   // 90%
assert.strictEqual(sa.slRisk({ profit: -4.5, stopPnl: 2 }), null, 'SL ya faida iliyofungwa — hakuna hatari');
assert.strictEqual(sa.slRisk({ profit: NaN, stopPnl: -5 }), null);
assert.ok(Math.abs(sa.slRisk({ profit: -4, stopPnl: -5 }).remaining - 1) < 1e-9);

let st; let d;
d = sa.slAlertDecision(undefined, sa.slRisk({ profit: -3.6, stopPnl: -5 }), -5); assert.strictEqual(d.notify, 'warn'); st = d.next;
d = sa.slAlertDecision(st, sa.slRisk({ profit: -3.8, stopPnl: -5 }), -5); assert.strictEqual(d.notify, null); st = d.next;       // hakuna kurudia
d = sa.slAlertDecision(st, sa.slRisk({ profit: -4.6, stopPnl: -5 }), -5); assert.strictEqual(d.notify, 'danger'); st = d.next;
d = sa.slAlertDecision(st, sa.slRisk({ profit: -3.0, stopPnl: -5 }), -5); assert.strictEqual(d.notify, null); st = d.next;       // hysteresis (60% > 50%)
assert.strictEqual(st.level, 2);
d = sa.slAlertDecision(st, sa.slRisk({ profit: -2.0, stopPnl: -5 }), -5); assert.strictEqual(d.notify, 'recovered'); st = d.next;
assert.strictEqual(st.level, 0);
d = sa.slAlertDecision(st, sa.slRisk({ profit: -3.6, stopPnl: -5 }), -5); assert.strictEqual(d.notify, 'warn'); // inaarifu tena
// SL ikisogezwa (stopPnl mpya) → anza upya
d = sa.slAlertDecision({ level: 2, stopPnl: -5 }, sa.slRisk({ profit: -1.5, stopPnl: -2 }), -2); assert.strictEqual(d.notify, 'warn');
// SL imefungwa faida → state inafutwa
d = sa.slAlertDecision({ level: 2, stopPnl: -5 }, null, 2); assert.deepStrictEqual(d, { notify: null, next: null });

// ── umbali wa bei ──
// stake 10 × mult 100 = notional 1000; $1 = 0.1% ya bei
assert.ok(Math.abs(sa.priceDistanceForUsd(1, { spot: 1.1, stake: 10, multiplier: 100 }) - 0.0011) < 1e-9);
assert.strictEqual(sa.priceDistanceForUsd(1, { spot: 1.1, stake: 0, multiplier: 100 }), null);

// ── ushauri wa S/R (BUY: support chini; SL iko pembeni ya support) ──
let lines = sa.slAdviceLines({ code: 'EURUSD', direction: 'BUY', price: 1.0990, atr, zones, slPrice: 1.0900, profit: -3, notional: 1000 });
assert.ok(/kabla ya SL/.test(lines[0]), lines.join('|'));
// SL iko karibu kuliko support
lines = sa.slAdviceLines({ code: 'EURUSD', direction: 'BUY', price: 1.0990, atr, zones, slPrice: 1.0975, profit: -3, notional: 1000 });
assert.ok(/SL iko karibu zaidi/.test(lines[0]) && /inaongeza hatari/.test(lines[1]), lines.join('|'));
// SELL: resistance juu
lines = sa.slAdviceLines({ code: 'EURUSD', direction: 'SELL', price: 1.1010, atr, zones, slPrice: 1.1100, profit: -3, notional: 1000 });
assert.ok(/Resistance/.test(lines[0]) && /kabla ya SL/.test(lines[0]), lines.join('|'));
// hakuna zone upande wa SL
lines = sa.slAdviceLines({ code: 'EURUSD', direction: 'BUY', price: 1.0900, atr, zones: [zRes], slPrice: 1.0850, profit: -3, notional: 1000 });
assert.ok(/Hakuna zone/.test(lines[0]));

// ── Muundo wa ujumbe ──
const msgW = sa.formatSlAlert('warn', { code: 'EURUSD', direction: 'BUY', contractId: 1, profit: -3.6, risk: sa.slRisk({ profit: -3.6, stopPnl: -5 }), stopPnl: -5, pipsToSl: 12.3, adviceLines: ['x'] });
assert.ok(/INAKARIBIA SL/.test(msgW) && /72%/.test(msgW) && /12\.3 pips/.test(msgW), msgW);
assert.ok(/HATARI/.test(sa.formatSlAlert('danger', { code: 'E', direction: 'SELL', contractId: 1, profit: -4.6, risk: sa.slRisk({ profit: -4.6, stopPnl: -5 }), stopPnl: -5 })));
for (const type of ['blocked', 'cleared', 'approach', 'broken']) {
  const m = sa.formatEvent('EURUSD', { type, direction: 'BUY', room: roomBad, zone: zRes, side: 'resistance', dir: 'UP', distAtr: 0.3 }, { price: 1.1, atr, filterOn: true, minRoomAtr: 1.5 });
  assert.ok(m.includes('EURUSD'), type);
}
assert.ok(/haitafunguliwa/.test(sa.formatEvent('EURUSD', { type: 'blocked', direction: 'BUY', room: roomBad }, { price: 1.1, atr, filterOn: true, minRoomAtr: 1.5 })));
assert.ok(/haizuiwi/.test(sa.formatEvent('EURUSD', { type: 'blocked', direction: 'BUY', room: roomBad }, { price: 1.1, atr, filterOn: false, minRoomAtr: 1.5 })));
console.log('✅ test-sr-alerts: zote zimepita');

// ── Muktadha wa trade ──
{
  const ctx = (type, extra, dir) => sa.tradeContextLine({ type, ...extra }, dir);
  assert.ok(/kufunga faida/.test(ctx('approach', { side: 'resistance' }, 'BUY')));
  assert.ok(/SL iko hatarini/.test(ctx('approach', { side: 'support' }, 'BUY')));
  assert.ok(/kufunga faida/.test(ctx('approach', { side: 'support' }, 'SELL')));
  assert.ok(/KWA FAIDA/.test(ctx('broken', { dir: 'UP' }, 'BUY')));
  assert.ok(/DHIDI/.test(ctx('broken', { dir: 'DOWN' }, 'BUY')));
  assert.ok(/KWA FAIDA/.test(ctx('broken', { dir: 'DOWN' }, 'SELL')));
  assert.strictEqual(ctx('approach', { side: 'support' }, undefined), '');
  const m = sa.formatEvent('EURUSD', { type: 'approach', zone: zRes, side: 'resistance', distAtr: 0.3 }, { price: 1.1, atr, tradeDirection: 'BUY' });
  assert.ok(/Trade yako ya BUY/.test(m), m);
  console.log('✅ test-sr-alerts (muktadha wa trade): zimepita');
}
