/**
 * derivCustomerAuto.js — AUTO-TRADE ya kila mteja wa pairing bot (hatua (d)). DEMO tu, kama hatua zilizotangulia.
 *
 * Kila mteja anatrade kwenye akaunti yake MWENYEWE ya Deriv (token yake, session yake, rekodi zake kwa ownerPhone).
 * Hakuna kinachoshirikiwa kati ya wateja isipokuwa SIGNAL ya soko (haina data ya mtu) — inahesabiwa MARA MOJA kwa kila mzunguko
 * kisha kila mteja anaipitisha kwenye vizuizi vyake. Mteja mmoja akikwama au akigonga kikomo, wengine hawaathiriki.
 *
 * Udhibiti wa admin (haujabadilika, unatumika moja kwa moja):
 *   - mteja anaingia kwenye mzunguko TU kama admin amemwidhinisha kutrade (approve) NA auto (approve_auto) NA mteja amewasha swichi zote mbili;
 *   - kill switch ya wote (kill_all), revoke / revoke_auto, na vikomo (stake, trades/siku, hasara/siku, trades wazi) vinakaguliwa KILA trade;
 *   - kila trade inapita derivCustomerTrader.openTrade(phone, params, { auto: true }) — LANGO LILELILE la trade za mkono,
 *     lenye mutex ya mteja, SL+TP lazima, reconcile na Deriv, na fail-closed ikiwa DB/Deriv ikishindwa.
 *
 * Mkakati: signal ileile ya owner (utils/forexSignal.js, strength >= AUTO_TRADE_STRENGTH_THRESHOLD, habari kubwa = ruka,
 * regime filter ileile) + SL/TP kwa ATR (formula ileile ya owner). Ulinzi wa ziada kwa kila mteja:
 *   - correlation guard (net exposure ya currency moja <= DERIV_AUTO_MAX_CURRENCY_EXPOSURE) kwa positions HALISI za Deriv ya mteja huyo;
 *   - cooldown baada ya hasara mfululizo za auto (DERIV_AUTO_MAX_CONSECUTIVE_LOSSES → DERIV_AUTO_COOLDOWN_MS), inahesabiwa kutoka DB (inadumu redeploy);
 *   - hasara ya siku / trades za siku / trades wazi: zinakaguliwa ndani ya openTrade (vikomo vya admin).
 *
 * Env (zote hiari):
 *   DERIV_CUSTOMER_AUTO_ENABLED         — "false" kuzima injini nzima (default: true; bado inahitaji idhini ya admin + mteja kwa kila akaunti)
 *   DERIV_AUTO_CHECK_INTERVAL_MS        — muda kati ya mizunguko (default: AUTO_TRADE_CHECK_INTERVAL_MS au saa 1)
 *   DERIV_AUTO_POLL_MS                  — muda wa kuangalia trades zilizofungwa kwa arifa (default: dakika 3)
 *   DERIV_AUTO_STAKE_USD                — stake ya auto-trade (default 2; inapunguzwa hadi maxStake ya mteja)
 *   DERIV_AUTO_MULTIPLIER               — 100/200/300/500/800 (default 100)
 *   DERIV_AUTO_MAX_CONSECUTIVE_LOSSES   — default 3
 *   DERIV_AUTO_COOLDOWN_MS              — default saa 4
 *   DERIV_AUTO_MAX_CURRENCY_EXPOSURE    — default 1
 *   DERIV_AUTO_PAIR_STAGGER_MS          — pause kati ya jozi (default: sekunde 3 kwa Deriv, 70 kwa Twelve — kama owner)
 *
 * Bado haipo (makusudi, hatua inayofuata): trailing stop / breakeven kwa wateja — trades zao zinalindwa na SL/TP za Deriv pekee.
 */

const accounts = require('./derivAccounts');
const trades = require('./derivTrades');
const customerTrader = require('./derivCustomerTrader');
const { getSession } = require('./derivSession');
const forexSignal = require('./forexSignal');
const autoTrader = require('./autoTrader');

const ENABLED = String(process.env.DERIV_CUSTOMER_AUTO_ENABLED ?? 'true').toLowerCase() !== 'false';
const CHECK_INTERVAL_MS = Number(process.env.DERIV_AUTO_CHECK_INTERVAL_MS || process.env.AUTO_TRADE_CHECK_INTERVAL_MS || 60 * 60 * 1000);
const POLL_MS = Number(process.env.DERIV_AUTO_POLL_MS || 3 * 60 * 1000);
const AUTO_STAKE = Number(process.env.DERIV_AUTO_STAKE_USD || 2);
const MULTIPLIER = (() => {
  const m = Number(process.env.DERIV_AUTO_MULTIPLIER || 100);
  return [100, 200, 300, 500, 800].includes(m) ? m : 100;
})();
const MAX_CONSEC_LOSSES = Number(process.env.DERIV_AUTO_MAX_CONSECUTIVE_LOSSES || 3);
const COOLDOWN_MS = Number(process.env.DERIV_AUTO_COOLDOWN_MS || 4 * 60 * 60 * 1000);
const MAX_CURRENCY_EXPOSURE = Number(process.env.DERIV_AUTO_MAX_CURRENCY_EXPOSURE || 1);
const PAIR_STAGGER_MS = (() => {
  const raw = process.env.DERIV_AUTO_PAIR_STAGGER_MS;
  if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw);
  return forexSignal.DATA_SOURCE === 'deriv' ? 3000 : 70000;
})();

// Makosa ambayo yakitokea kwa mteja mmoja, hakuna maana kuendelea na wagombea wengine wa mteja huyo mzunguko huu.
const STOP_CODES = new Set(['DENIED', 'OPEN_LIMIT', 'DAY_LIMIT', 'LOSS_LIMIT', 'LOSS_BUDGET', 'UNKNOWN_OUTCOME', 'DERIV', 'INTERNAL']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n, d = 2) => Number(n).toFixed(d);

let notifier = async () => false;
let cycleTimer = null;
let pollTimer = null;
let cycleRunning = false;
let cycleStartedAt = 0;
let lastCycle = null;
let startedAt = null;
let listening = false;

// ── msaada: currency exposure (nakala ya mantiki ya owner — haishirikishi state yoyote) ──────────
function pairLegs(code) {
  const c = String(code || '').toUpperCase();
  return { base: c.slice(0, 3), quote: c.slice(3, 6) };
}
function computeExposure(list) {
  const e = {};
  for (const t of list) {
    const { base, quote } = pairLegs(t.code);
    if (!base || !quote) continue;
    const sign = t.direction === 'BUY' ? 1 : -1;
    e[base] = (e[base] || 0) + sign;
    e[quote] = (e[quote] || 0) - sign;
  }
  return e;
}
function wouldExceed(exposure, code, direction) {
  const { base, quote } = pairLegs(code);
  const sign = direction === 'BUY' ? 1 : -1;
  return Math.abs((exposure[base] || 0) + sign) > MAX_CURRENCY_EXPOSURE || Math.abs((exposure[quote] || 0) - sign) > MAX_CURRENCY_EXPOSURE;
}

/** SL/TP ya dola kwa ATR (formula ya owner); ATR ikikosekana → SL = nusu ya stake (angalau $1 ikiwezekana), TP = mara 2. */
function riskFor(c, stake) {
  const r = autoTrader.computeAtrBasedRisk({ atr: c.snapshot.atr, price: c.snapshot.price, stake, multiplier: MULTIPLIER });
  if (r && r.sl > 0 && r.tp > 0) return { sl: Math.min(r.sl, stake), tp: r.tp, source: 'ATR' };
  const sl = Number(Math.min(stake, Math.max(1, stake * 0.5)).toFixed(2));
  return { sl, tp: Number((sl * 2).toFixed(2)), source: 'fixed' };
}

async function say(phone, text) {
  try { await notifier(String(phone), text); } catch (e) { console.error('[derivCustomerAuto] arifa imeshindwa:', e.message); }
}

// ── signal: inahesabiwa MARA MOJA kwa wateja wote ──────────────────────────────────────────────
async function computeCandidates() {
  const out = [];
  const pairs = autoTrader.PAIRS;
  const threshold = autoTrader.STRENGTH_THRESHOLD;
  for (let i = 0; i < pairs.length; i++) {
    if (i > 0 && PAIR_STAGGER_MS > 0) await sleep(PAIR_STAGGER_MS);
    const { code, symbol } = pairs[i];
    try {
      const snapshot = await forexSignal.fetchForexSnapshot(symbol, forexSignal.DEFAULT_INTERVAL, { daily: true });
      const sig = forexSignal.computeSignal(snapshot);
      if (sig.direction !== 'BUY' && sig.direction !== 'SELL') continue;
      if (sig.strength < threshold) continue;
      if (sig.newsRisk) continue; // habari kubwa karibu — usifungue mpya
      const regime = await autoTrader.checkRegimeFilter(code, symbol);
      if (!regime.ok) continue;
      out.push({ code, symbol, sig, snapshot });
    } catch (err) {
      console.error(`[derivCustomerAuto] signal ya ${code} imeshindwa:`, err.message);
    }
  }
  out.sort((a, b) => b.sig.strength - a.sig.strength);
  return out;
}

/** Hasara mfululizo za auto za mteja huyu → muda wa kuruhusiwa tena (ms) au null. */
async function cooldownUntil(phone) {
  if (!(MAX_CONSEC_LOSSES > 0)) return null;
  const rows = await trades.recentAuto(phone, MAX_CONSEC_LOSSES);
  if (rows.length < MAX_CONSEC_LOSSES) return null;
  if (!rows.every((r) => r.profit == null || Number(r.profit) < 0)) return null;
  const until = Math.max(...rows.map((r) => Number(r.closedAt) || 0)) + COOLDOWN_MS;
  return Date.now() < until ? until : null;
}

/** Mteja MMOJA: pitisha wagombea kwenye vizuizi vyake na ufungue kupitia lango la pekee. Haitupi kosa. */
async function processCustomer(phone, candidates) {
  const res = { phone: String(phone), opened: 0, skipped: null };
  try {
    const gate = await accounts.canTrade(phone, { auto: true });
    if (!gate.ok) { res.skipped = gate.reason; return res; }

    const until = await cooldownUntil(phone);
    if (until) { res.skipped = 'cooldown'; return res; }

    let live;
    try { live = await getSession(phone).getPortfolio(); } catch (err) { res.skipped = 'portfolio'; return res; }
    const openList = live.map((p) => ({ code: String(p.symbol || '').replace(/^frx/i, '').toUpperCase(), direction: /up/i.test(p.contract_type || '') ? 'BUY' : 'SELL' }));

    const stake = Math.min(AUTO_STAKE, gate.limits.maxStake);
    for (const c of candidates) {
      const dir = c.sig.direction;
      if (openList.some((p) => p.code === c.code)) continue;
      if (wouldExceed(computeExposure(openList), c.code, dir)) continue;
      const risk = riskFor(c, stake);
      try {
        const r = await customerTrader.openTrade(
          phone,
          { pair: c.code, direction: dir, stake, stopLoss: risk.sl, takeProfit: risk.tp, multiplier: MULTIPLIER },
          { auto: true, signalStrength: c.sig.strength }
        );
        openList.push({ code: c.code, direction: dir });
        res.opened += 1;
        await say(phone,
          `🤖 *Auto-Trade (DEMO)*\n${dir === 'BUY' ? '🟢 BUY' : '🔴 SELL'} *${c.code}* — nguvu ya signal ${fmt(c.sig.strength, 0)}%\n` +
          `Stake $${fmt(r.stake)} • x${r.multiplier} • SL $${fmt(risk.sl)} • TP $${fmt(risk.tp)}\n🆔 ${r.contractId}\n` +
          `_Zima kwenye dashboard (Deriv → Auto-Trader) wakati wowote._`);
      } catch (err) {
        if (err && err.code && STOP_CODES.has(err.code)) { res.skipped = err.code; break; }
        // makosa mengine (stake, SL, marudio…) — jaribu mgombea anayefuata
      }
    }
  } catch (err) {
    console.error(`[derivCustomerAuto] mteja ${String(phone).slice(-4)} imeshindwa:`, err.message);
    res.skipped = 'error';
  }
  return res;
}

async function runCycle() {
  const maxHold = Math.max(CHECK_INTERVAL_MS * 2, 10 * 60 * 1000);
  if (cycleRunning && Date.now() - cycleStartedAt < maxHold) return { skipped: 'running' };
  cycleRunning = true;
  cycleStartedAt = Date.now();
  try {
    const phones = await accounts.listAutoReady();
    if (!phones.length) { lastCycle = { at: Date.now(), customers: 0, candidates: 0, opened: 0, results: [] }; return lastCycle; }
    const candidates = await computeCandidates();
    const results = [];
    if (candidates.length) {
      for (const phone of phones) {
        results.push(await processCustomer(phone, candidates));
        await sleep(150); // usishambulie Deriv/DB kwa wakati mmoja
      }
    }
    lastCycle = {
      at: Date.now(),
      customers: phones.length,
      candidates: candidates.map((c) => ({ code: c.code, direction: c.sig.direction, strength: c.sig.strength })),
      opened: results.reduce((a, r) => a + r.opened, 0),
      // namba za mwisho tu — hakuna namba kamili ya mteja kwenye hali ya umma
      results: results.map((r) => ({ customer: `…${String(r.phone).slice(-4)}`, opened: r.opened, skipped: r.skipped })),
    };
    return lastCycle;
  } finally {
    cycleRunning = false;
  }
}

/** Angalia trades za AUTO zilizo wazi: zikifungwa na Deriv, derivCustomerTrader inatoa 'auto-closed' → arifa. */
async function pollClosed() {
  let phones;
  try { phones = await trades.phonesWithOpenAuto(); } catch (err) { console.error('[derivCustomerAuto] poll imeshindwa:', err.message); return; }
  for (const phone of phones) {
    try { await customerTrader.syncClosed(phone); } catch { /* mteja mmoja akikwama, wengine waendelee */ }
    await sleep(100);
  }
}

function onAutoClosed(ev) {
  const p = Number(ev.profit);
  const known = Number.isFinite(p);
  const head = !known ? '⚪ *Auto-Trade imefungwa*' : p >= 0 ? '✅ *Auto-Trade imefungwa kwa FAIDA*' : '❌ *Auto-Trade imefungwa kwa HASARA*';
  say(ev.phone, `${head} (DEMO)\n${ev.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'} *${ev.code}*` + (known ? `\nMatokeo: ${p >= 0 ? '+' : '-'}$${fmt(Math.abs(p))}` : '\nMatokeo hayajulikani — angalia dashboard.') + `\n🆔 ${ev.contractId}`);
}

/**
 * @param {{notify?: (phone: string, text: string) => Promise<any>}} opts — notify = kutuma ujumbe kwenye self-chat ya mteja
 */
function start({ notify } = {}) {
  if (!ENABLED) { console.log('[derivCustomerAuto] DERIV_CUSTOMER_AUTO_ENABLED=false — injini ya auto-trade ya wateja imezimwa.'); return false; }
  if (cycleTimer) return true;
  if (typeof notify === 'function') notifier = notify;
  startedAt = Date.now();
  if (!listening) { customerTrader.events.on('auto-closed', onAutoClosed); listening = true; }
  console.log(`[derivCustomerAuto] ✅ IMEWASHWA — kila ${Math.round(CHECK_INTERVAL_MS / 60000)} dk, stake $${AUTO_STAKE} x${MULTIPLIER}, threshold ${autoTrader.STRENGTH_THRESHOLD}% (DEMO tu).`);
  // Mzunguko wa kwanza umechelewa kidogo ili restoreAllInstances/DB zitulie.
  setTimeout(() => runCycle().catch((e) => console.error('[derivCustomerAuto] runCycle:', e.message)), 45 * 1000).unref?.();
  cycleTimer = setInterval(() => runCycle().catch((e) => console.error('[derivCustomerAuto] runCycle:', e.message)), CHECK_INTERVAL_MS);
  pollTimer = setInterval(() => pollClosed().catch((e) => console.error('[derivCustomerAuto] pollClosed:', e.message)), POLL_MS);
  cycleTimer.unref?.(); pollTimer.unref?.();
  return true;
}

function stop() {
  if (cycleTimer) clearInterval(cycleTimer);
  if (pollTimer) clearInterval(pollTimer);
  cycleTimer = pollTimer = null;
  if (listening) { customerTrader.events.off('auto-closed', onAutoClosed); listening = false; }
}

/** Hali ya injini kwa admin (hakuna siri; wateja wanatajwa kwa tarakimu 4 za mwisho). */
function getStatus() {
  return {
    enabled: ENABLED,
    running: cycleTimer !== null,
    startedAt,
    checkIntervalMs: CHECK_INTERVAL_MS,
    pollMs: POLL_MS,
    stake: AUTO_STAKE,
    multiplier: MULTIPLIER,
    strengthThreshold: autoTrader.STRENGTH_THRESHOLD,
    maxConsecutiveLosses: MAX_CONSEC_LOSSES,
    cooldownMs: COOLDOWN_MS,
    lastCycle,
  };
}

module.exports = { start, stop, runCycle, pollClosed, getStatus, _processCustomer: processCustomer, _riskFor: riskFor };
