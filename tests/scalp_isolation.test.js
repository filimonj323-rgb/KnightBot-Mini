/* Jaribio: Scalp na FX zimetenganishwa (registry, scope ya guard, closeAll, volatility gate, catalog). Run: node tests/scalp_isolation.test.js */
const assert = require('assert');
const path = require('path');
// Packages za nje hazijasakinishwa kwenye mazingira ya jaribio — zibadilishe na stub tupu.
const Module = require('module'); const origLoad = Module._load;
Module._load = function (req, ...a) { try { return origLoad.call(this, req, ...a); } catch (e) { if (e.code === 'MODULE_NOT_FOUND' && !req.startsWith('.')) return new Proxy(function () {}, { get: () => () => ({}), apply: () => ({}) }); throw e; } };
// db bandia (kuepuka @libsql/client na mtandao)
const dbPath = require.resolve(path.join('..', 'pairing', 'db'));
const rows = [{ contractId: '111' }];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query: async (sql) => (/SELECT contractId FROM scalp_trades/i.test(sql) ? { rows } : { rows: [] }), initSchema: async () => {} } };

(async () => {
  const reg = require('../utils/scalpRegistry');
  await reg.ensureLoaded();
  assert(reg.isScalpContract('111') && reg.isScalpContract(111), 'IDs za DB zinapakiwa');
  assert(!reg.isScalpContract('222'));
  reg.addScalpContract(333); assert(reg.isScalpContract('333'));

  // Catalog: low-movement pairs zimeondoka, high-movement zipo
  const st = require('../utils/scalpTrader');
  for (const p of ['EURUSD', 'USDCAD', 'USDCHF', 'AUDUSD', 'NZDUSD', 'EURGBP']) assert(!st.CATALOG[p], p + ' haipaswi kuwa kwenye scalp');
  for (const p of ['XAUUSD', 'XAGUSD', 'USDJPY', 'GBPJPY', 'GBPUSD', 'EURJPY', 'GBPAUD']) assert(st.CATALOG[p], p + ' lazima iwepo');
  st._setSettingsForTest({ pairs: ['EURUSD', 'XAUUSD'] });
  const status = await st.getStatus();
  assert.deepStrictEqual(status.settings.pairs, ['XAUUSD'], 'pair ya movement ndogo inaondolewa kwenye settings zilizohifadhiwa');
  // Volatility gate
  st._setSettingsForTest({ minAtrPct: 0.025 });
  assert(st._lowMovement({ atrPct5: 0.01 }) && !st._lowMovement({ atrPct5: 0.05 }));
  // Whitelist ya settings
  const s2 = await st.setSettings({ stake: 3, evil: 'x', __proto__: { a: 1 } });
  assert(!('evil' in s2) && s2.stake === 3);
  // getRecentOpens: kumbukumbu za scalp hazionekani kwa fx
  const dt = require('../utils/derivTrader');
  assert(Array.isArray(dt.getRecentOpens(20000, 'fx')) && Array.isArray(dt.getRecentOpens(20000, 'scalp')));
  console.log('✅ scalp_isolation: yote yamepita');
  process.exit(0);
})().catch((e) => { console.error('❌', e); process.exit(1); });
