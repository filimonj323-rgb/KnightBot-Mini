/**
 * manualProfitLock.js — Profit lock kwa trades za MKONO (na zile zisizo na SL ya auto-trader).
 *
 * SHERIA (tofauti na trailing ya auto-trader, ambayo inatumia R-multiple/asilimia ya stake):
 *   Faida ya sasa ikifika MANUAL_LOCK_TRIGGER_PCT% (default 80) ya Take Profit ya trade hiyo,
 *   Stop Loss inasogezwa kuwa FAIDA ILIYOFUNGWA ya MANUAL_LOCK_KEEP_PCT% (default 50) ya Take Profit.
 *   Mfano: TP $4 → faida ikifika $3.20 → SL inakuwa -$2.00 (hata bei ikigeuka, trade inafunga na angalau +$2).
 *   Lock inawekwa MARA MOJA kwa kila trade (haifuatilii juu zaidi, na haiwezi kupunguza hatari ya mtu aliyoiweka).
 *
 * TRADES ZINAZOHUSIKA: kila trade iliyo wazi kwenye akaunti ya sasa ya Deriv ISIPOKUWA:
 *   - trades za auto-trader zenye SL inayojulikana (zina trailing yake kwenye autoTrader.js)
 *   - trades za News Trading (zina SL/TP na kufungwa kwa muda wake)
 *   - trades zisizo na Take Profit (hakuna kipimo cha 80%)
 *
 * ENV (zote hiari):
 *   MANUAL_LOCK_ENABLED=false     zima kabisa (default: imewashwa)
 *   MANUAL_LOCK_TRIGGER_PCT=80    % ya TP inayoanzisha lock
 *   MANUAL_LOCK_KEEP_PCT=50       % ya TP inayofungwa kama faida (lazima iwe chini ya TRIGGER)
 *   MANUAL_LOCK_TICK_MS=10000     ukaguzi kila sekunde ngapi (chini kabisa 5000)
 *
 * ⚠️ Deriv inahitaji SL hasi (faida iliyofungwa) ikubaliwe kwenye contract_update; ikikataliwa, jaribio
 * linarudiwa mara 3 kisha linaachwa na owner anapewa ujumbe wa Deriv. Hii SI ushauri wa kifedha.
 */

const derivTrader = require('./derivTrader');

const ENABLED = String(process.env.MANUAL_LOCK_ENABLED || 'true').toLowerCase() !== 'false';
const TRIGGER_PCT = Math.min(99, Math.max(1, Number(process.env.MANUAL_LOCK_TRIGGER_PCT) || 80));
let KEEP_PCT = Math.max(1, Number(process.env.MANUAL_LOCK_KEEP_PCT) || 50);
if (KEEP_PCT >= TRIGGER_PCT) KEEP_PCT = Math.max(1, TRIGGER_PCT - 20); // lock lazima iwe chini ya faida ya sasa
const TICK_MS = Math.max(5000, Number(process.env.MANUAL_LOCK_TICK_MS) || 10000);
const MAX_ATTEMPTS = 3;

let timer = null;
let busy = false;
let notifyFn = null;
const locked = new Set();          // contract IDs zilizoshawekewa lock
const attempts = new Map();        // contractId -> idadi ya majaribio yaliyoshindwa
const gaveUp = new Set();
const minLockSeen = new Map();   // contractId -> kiwango cha chini cha lock kilichojulikana kutoka Deriv (kuepuka maombi yanayorudiwa)

const fmt = (n) => Number(n).toFixed(2);

/** Kazi safi (inajaribika): rudisha SL mpya (hasi) au null kama lock haihitajiki bado. */
function decideLock(profit, tp, triggerPct = TRIGGER_PCT, keepPct = KEEP_PCT) {
  const p = Number(profit);
  const t = Math.abs(Number(tp));
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return null;
  if (p < t * (triggerPct / 100)) return null;
  const lockAmount = Math.round(t * (keepPct / 100) * 100) / 100;
  if (lockAmount <= 0 || lockAmount >= p) return null; // Deriv haikubali kufunga faida kubwa kuliko ya sasa
  return -lockAmount;
}

async function tick(deps = {}) {
  const d = {
    getOpenPositionsLive: derivTrader.getOpenPositionsLive,
    updateContractLimits: derivTrader.updateContractLimits,
    getAccountMode: derivTrader.getAccountMode,
    isTrackedByAuto: (id) => {
      try { const a = require('./autoTrader').openAutoTrades.get(String(id)); return !!(a && Number.isFinite(a.slUsd) && a.slUsd > 0); } catch (_) { return false; }
    },
    isNews: (id) => { try { return require('./newsTrader').isNewsContract(id) || require('./scalpRegistry').isScalpContract(id); } catch (_) { return false; } }, // news + scalp zina usimamizi wao
    ...deps,
  };
  if (busy) return;
  busy = true;
  try {
    try { await require('./scalpRegistry').ensureLoaded(); } catch (_) { /* endelea */ }
    let positions;
    try { positions = await d.getOpenPositionsLive(); } catch (_) { return; } // hakuna muunganiko/Deriv imekataa — jaribu tena tick ijayo
    const openIds = new Set(positions.map((p) => String(p.contract_id)));
    for (const id of [...locked, ...minLockSeen.keys()]) if (!openIds.has(id)) { locked.delete(id); attempts.delete(id); gaveUp.delete(id); minLockSeen.delete(id); } // trade imefungwa

    for (const p of positions) {
      const id = String(p.contract_id);
      if (locked.has(id) || gaveUp.has(id)) continue;
      if (d.isTrackedByAuto(id) || d.isNews(id)) continue;
      const tp = Number(p.limit_order && p.limit_order.take_profit && p.limit_order.take_profit.order_amount);
      let newSl = decideLock(p.profit, tp);
      if (newSl === null) continue;
      const known = minLockSeen.get(id);
      if (known != null) { // tayari tunajua kiwango cha chini cha Deriv kwa trade hii
        if (known >= Number(p.profit)) continue; // faida bado ndogo — usiulize Deriv tena
        newSl = -Math.max(-newSl, known);
      }

      try {
        try {
          await d.updateContractLimits(id, { stopLoss: newSl });
        } catch (firstErr) {
          // Deriv ina kiwango cha chini cha lock (mfano "angalau $0.28"). Rekebisha mara moja hadi kiwango hicho,
          // lakini TU kama bado kiko chini ya faida ya sasa; la sivyo subiri faida iongezeke (bila kurudia maombi).
          const m = /angalau\s*\$?\s*(\d+(?:\.\d+)?)/i.exec(String(firstErr && firstErr.message));
          const minLock = m ? Math.round((Number(m[1]) + 0.01) * 100) / 100 : NaN;
          if (!Number.isFinite(minLock)) throw firstErr;
          minLockSeen.set(id, minLock);
          if (minLock >= Number(p.profit)) continue; // faida bado ndogo kuliko kiwango cha chini cha Deriv — subiri faida iongezeke
          newSl = -minLock;
          await d.updateContractLimits(id, { stopLoss: newSl });
        }
        locked.add(id);
        console.log(`[manualProfitLock] 🔒 ${id}: faida $${fmt(p.profit)} (≥${TRIGGER_PCT}% ya TP $${fmt(tp)}) → SL ${fmt(newSl)} (faida ya $${fmt(-newSl)} imefungwa).`);
        if (notifyFn) await notifyFn(
          `🔒 *PROFIT LOCK (trade ya mkono)*\n\n` +
          `Faida ya sasa: $${fmt(p.profit)} (${Math.round((Number(p.profit) / Math.abs(tp)) * 100)}% ya Take Profit $${fmt(tp)})\n` +
          `✅ Faida ya angalau $${fmt(-newSl)} imefungwa sasa.\n🆔 Contract ID: ${id}`
        );
      } catch (err) {
        if (err && err.code === 'CONTRACT_CLOSED') { locked.add(id); continue; } // imeshafungwa/kwisha — hakuna cha kulinda, usitume arifa ya uongo
        const n = (attempts.get(id) || 0) + 1;
        attempts.set(id, n);
        console.error(`[manualProfitLock] imeshindwa kuweka lock ya ${id} (jaribio ${n}/${MAX_ATTEMPTS}):`, err.message);
        if (n >= MAX_ATTEMPTS) {
          gaveUp.add(id);
          if (notifyFn) await notifyFn(`⚠️ *PROFIT LOCK IMESHINDWA* — ${id}\nDeriv imekataa: ${err.message}\nFaida ya sasa $${fmt(p.profit)}. Funga au weka SL kwa mkono.`);
        }
      }
    }
  } finally {
    busy = false;
  }
}

function start({ notify } = {}) {
  if (!ENABLED) { console.log('[manualProfitLock] imezimwa (MANUAL_LOCK_ENABLED=false).'); return; }
  if (timer) return;
  notifyFn = typeof notify === 'function' ? notify : null;
  timer = setInterval(() => { tick().catch((e) => console.error('[manualProfitLock]', e.message)); }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log(`[manualProfitLock] ✅ Imeanza — lock ikifika ${TRIGGER_PCT}% ya TP, inafunga ${KEEP_PCT}% ya TP (ukaguzi kila sekunde ${Math.round(TICK_MS / 1000)}).`);
}

function stop() { if (timer) clearInterval(timer); timer = null; }
function getStatus() { return { enabled: ENABLED, triggerPct: TRIGGER_PCT, keepPct: KEEP_PCT, lockedCount: locked.size, gaveUp: [...gaveUp] }; }

module.exports = { start, stop, tick, decideLock, getStatus, TRIGGER_PCT, KEEP_PCT };
