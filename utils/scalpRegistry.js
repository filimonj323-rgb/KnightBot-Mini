/**
 * scalpRegistry.js — rejista ndogo inayojua contract IDs zipi ni za SCALP.
 *
 * Kusudi: Scalp na FX (autoTrader) zinatumia akaunti MOJA ya Deriv, kwa hiyo bila utenganisho trades za scalp
 * zilikuwa zinanaswa (adopt) na autoTrader, kuingia kwenye History/Stats za fx, na kuzuia pair ile ile kufunguliwa
 * upande wa pili. Kila sehemu ya fx inauliza hapa: isScalpContract(id) → ipuuze trade hiyo.
 * Haina utegemezi wa scalpTrader.js (kuepuka mzunguko wa require); inasoma scalp_trades moja kwa moja kutoka DB.
 */
// db inapakiwa lazily (angalia ensureLoaded)

const ids = new Set();
let loaded = false;
let loading = null;

function isScalpContract(id) { return id != null && ids.has(String(id)); }
function addScalpContract(id) { if (id != null) ids.add(String(id)); }
function size() { return ids.size; }
function _ids() { return [...ids]; }

/** Pakia IDs zote za scalp_trades (zilizo wazi na zilizofungwa) mara moja. Salama kuitwa mara nyingi. */
async function ensureLoaded() {
  if (loaded) return;
  if (!loading) {
    loading = (async () => {
      try {
        const r = await require('../pairing/db').query('SELECT contractId FROM scalp_trades', []);
        for (const row of r.rows || []) ids.add(String(row.contractId));
        loaded = true;
      } catch (err) {
        // Table haijaundwa bado = hakuna trades za scalp; kosa lingine (DB) → jaribu tena wakati ujao.
        if (/no such table|does not exist/i.test(String(err && err.message))) loaded = true;
        else console.error('[scalpRegistry] imeshindwa kusoma scalp_trades:', err.message);
      }
    })().finally(() => { loading = null; });
  }
  await loading;
}

module.exports = { isScalpContract, addScalpContract, ensureLoaded, size, _ids, _reset: () => { ids.clear(); loaded = false; loading = null; } };
