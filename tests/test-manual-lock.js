const Module = require('module'); const assert = require('assert');
const root = process.argv[2];
const orig = Module._load;
Module._load = function (req, ...a) { if (/derivTrader$/.test(req)) return {}; return orig.call(this, req, ...a); };
const m = require(root + '/utils/manualProfitLock.js');
// decideLock: TP $4, trigger 80% = $3.20, lock 50% = $2.00
assert.strictEqual(m.decideLock(3.19, 4), null);
assert.strictEqual(m.decideLock(3.2, 4), -2);
assert.strictEqual(m.decideLock(3.9, 4), -2);
assert.strictEqual(m.decideLock(5, 0), null);
assert.strictEqual(m.decideLock(NaN, 4), null);
(async () => {
  const calls = []; const msgs = [];
  const pos = [
    { contract_id: 1, profit: 3.5, limit_order: { take_profit: { order_amount: 4 } } },   // lock
    { contract_id: 2, profit: 1.0, limit_order: { take_profit: { order_amount: 4 } } },   // bado
    { contract_id: 3, profit: 9.0, limit_order: { take_profit: { order_amount: 4 } } },   // auto-tracked — ruka
    { contract_id: 4, profit: 9.0, limit_order: { take_profit: { order_amount: 4 } } },   // news — ruka
    { contract_id: 5, profit: 9.0, limit_order: {} },                                      // bila TP — ruka
  ];
  const deps = { getOpenPositionsLive: async () => pos, updateContractLimits: async (id, o) => { calls.push([id, o.stopLoss]); },
    isTrackedByAuto: (id) => id === '3', isNews: (id) => id === '4' };
  await m.tick(deps); await m.tick(deps); // tick ya pili isirudie
  assert.deepStrictEqual(calls, [['1', -2]]);
  // kushindwa mara 3 kisha kuacha
  const fail = { ...deps, getOpenPositionsLive: async () => [pos[0] && { ...pos[0], contract_id: 9 }], updateContractLimits: async () => { throw new Error('Deriv imekataa'); } };
  const origErr = console.error; console.error = () => {};
  for (let i = 0; i < 5; i++) await m.tick(fail);
  console.error = origErr;
  assert.deepStrictEqual(m.getStatus().gaveUp, ['9']);
  console.log('OK — manualProfitLock: decideLock, ruka (auto/news/bila TP), lock mara moja, kuacha baada ya 3');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
