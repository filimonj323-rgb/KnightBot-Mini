/**
 * pocketAutoTrader.js — Auto-trade ya Pocket Option (Binary/Turbo).
 *
 * Inafanya kazi ile ile ya Deriv autoTrader.js, lakini kwa Pocket Option:
 *   1. Kila candle ikifungwa (+3s), inachanganua jozi kwa kutumia pocketSignal.js
 *      (EMA, MACD, RSI, Bollinger, StochRSI + ADX filter).
 *   2. Signal ikiwa BUY/SELL na nguvu >= minStrength (default 70 = STRONG), na
 *      imepita vichujio vyote vya usalama, bot inafungua trade MOJA KWA MOJA
 *      (UP = CALL, DOWN = PUT) kupitia pocketOptionTrader.placeOrder(). Expiry =
 *      timeframe ya signal (1m -> 60s).
 *   3. Matokeo (win/loss) yanafuatiliwa na pocketOptionTrader (yanahifadhiwa Turso,
 *      yanaendelea baada ya restart) na kutumwa DM kwa owner.
 *
 * Vichujio vya usalama (vyote vinaweza kubadilishwa kwa .poauto):
 *   - Late-entry guard : signal inayochelewa kuingia (> ~24s baada ya candle kufungwa) inarukwa
 *   - Max concurrent   : trades wazi kwa wakati mmoja (default 2)
 *   - Same-pair guard  : hakuna trade ya pili kwenye jozi ile ile ikiwa ya kwanza bado wazi
 *   - Correlation guard: net exposure ya currency moja (mfano USD) <= 1
 *   - News filter      : High-impact news karibu (economicCalendar.js) = hakuna trade mpya
 *   - Circuit breakers : hasara ya siku (UTC), hasara mfululizo -> cooldown, max trades/siku
 *   - Real-account guard: akaunti REAL inahitaji `.poauto on confirm`; demo -> real baada ya
 *                         restart inazima auto yenyewe.
 *   - Dry-run          : `.poauto dry on` — inaonyesha ingefanya nini bila kufungua trade.
 *
 * ⚠️ HII INAFANYA TRADE ZA PESA HALISI BILA UTHIBITISHO WA MTU KWA KILA TRADE (ukiwasha
 * kwenye akaunti REAL). Binary option: break-even ≈ 54% kwa payout 85%. Hakuna signal
 * inayohakikisha faida. Anza na DEMO. Zima wakati wowote: `.poauto off`.
 *
 * Env (hiari — thamani za kuanzia tu; `.poauto` inazibadilisha na kuzihifadhi Turso):
 *   POCKET_AUTO_STAKE        stake ya kuanzia (default 1)
 *   POCKET_AUTO_MAX_STAKE    kikomo kigumu cha stake (default 25) — kinazuia makosa ya kuandika
 *   POCKET_AUTO_MAX_DELAY_MS kuchelewa kwa juu kuingia baada ya candle kufungwa (default 25000)
 */

const pocketTrader = require('./pocketOptionTrader');
const pocketStore = require('./pocketStore');
const pocketSignal = require('./pocketSignal');
const signalTracker = require('./signalTracker');
const signalTargets = require('./signalTargets');
const notifyPrefs = require('./notifyPrefs');

const CONFIG_KEY = 'autotrade:config';
const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD']);
const HARD_MAX_STAKE = Number(process.env.POCKET_AUTO_MAX_STAKE || 25);
const MAX_DELAY_MS = Number(process.env.POCKET_AUTO_MAX_DELAY_MS || 25000);
const MIN_STAKE = 1; // Pocket Option: kiwango cha chini cha trade

const DEFAULTS = Object.freeze({
  enabled: false,
  dryRun: false,
  enabledOnDemo: null, // akaunti ilikuwa demo (true) au real (false) wakati ilipowashwa
  stake: Math.min(HARD_MAX_STAKE, Math.max(MIN_STAKE, Number(process.env.POCKET_AUTO_STAKE || 1))),
  tf: 60, // sekunde — timeframe ya signal = expiry ya trade
  minStrength: 70,
  mode: 'forex', // forex | smart | otc | real | all  (angalia pocketSignal.SCAN_MODES)
  maxConcurrent: 2,
  maxDailyLoss: 10, // USD, siku ya UTC
  maxConsecLosses: 3,
  cooldownMin: 60,
  maxTradesPerDay: 30,
  maxCurrencyExposure: 1,
  newsFilter: true,
  minBacktest: 0, // % — 0 = imezimwa. >0: backtest ya "strong" lazima ifikie hii (angalau signals 8)
});

let cfg = { ...DEFAULTS };

// ── Hali ya runtime ─────────────────────────────────────────────────────
let waSock = null;
let notifyJid = null;
let started = false;
let timer = null;
let running = false;
let nextCycleAt = null;
let lastCycleAt = null;
let lastSkipReason = null;
let lastBridge = null; // { ok, connected, demo }
let orderFailStreak = 0;
let seq = 0;

// orderId (au "pending:N" wakati order inafunguliwa) -> { pair, key, direction, stake, strength, openedAt }
const positions = new Map();
const seenSignals = new Set(); // pair|direction|candleTime — kuzuia kuingia mara mbili kwenye candle ileile
const stats = { cycles: 0, signals: 0, opened: 0, dry: 0, late: 0, blocked: 0, failed: 0 };

// Kumbukumbu ya matukio ya hivi karibuni (RAM) — inaonyeshwa kwenye dashboard.
const events = [];
const MAX_EVENTS = 40;
function logEvent(type, text) {
  events.unshift({ at: Date.now(), type, text });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

let dailyKey = utcDateKey(Date.now());
let dailyPnl = 0;
let tradesToday = 0;
let consecutiveLosses = 0;
let pausedUntil = null;
let pauseReason = null;

// ── Msaada ──────────────────────────────────────────────────────────────
function utcDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
function startOfUtcDay(ts) {
  const d = new Date(ts);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfUtcDay(ts) {
  const d = new Date(ts);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
function money(n) {
  const v = Number(n) || 0;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
}
function fmtDuration(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `saa ${Math.floor(m / 60)} dk ${m % 60}` : `dakika ${m}`;
}
function toMs(t) {
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
}
// "EURUSD_otc" -> "EURUSD" (kwa same-pair guard — EURUSD na EURUSD_otc ni dau lile lile)
function pairKey(pair) {
  return String(pair || '').replace(/_otc$/i, '').toUpperCase();
}
function legs(pair) {
  const m = /^([A-Z]{3})([A-Z]{3})$/.exec(pairKey(pair));
  if (!m || !CURRENCIES.has(m[1]) || !CURRENCIES.has(m[2])) return null; // si forex (crypto, hisa, n.k.)
  return { base: m[1], quote: m[2] };
}
function accountLabel() {
  if (!lastBridge || lastBridge.demo == null) return '❓';
  return lastBridge.demo ? '🧪 DEMO' : '💰 REAL';
}

// DM ya notification yenye aina — inaheshimu swichi/foleni/muhtasari za notifyPrefs.
async function notifyAs(category, text) {
  const sock = global.currentSock || waSock;
  if (!sock || !notifyJid) return;
  try {
    await notifyPrefs.dm(category, text, { sock, jid: notifyJid });
  } catch (err) {
    console.error('[pocketAuto] Imeshindwa kutuma notification:', err.message);
  }
}
const notify = (text) => notifyAs('warnings', text);

// ── Config (inahifadhiwa Turso) ─────────────────────────────────────────
async function saveConfig() {
  await pocketStore.saveSetting(CONFIG_KEY, cfg);
}

async function loadConfig() {
  const rows = await pocketStore.loadSettings(CONFIG_KEY);
  const row = rows.find((r) => r.key === CONFIG_KEY);
  if (!row) return;
  try {
    const saved = JSON.parse(row.value);
    cfg = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (saved[k] !== undefined) cfg[k] = saved[k];
    cfg.stake = Math.min(HARD_MAX_STAKE, Math.max(MIN_STAKE, Number(cfg.stake) || DEFAULTS.stake));
  } catch (err) {
    console.error('[pocketAuto] Config iliyohifadhiwa si sahihi, natumia default:', err.message);
  }
}

const bool = (v) => ['on', 'true', '1', 'yes', 'ndio'].includes(String(v).toLowerCase());

/**
 * Thibitisha setting moja BILA kuihifadhi. Rudisha { ok, field, value } au { ok:false, error }.
 * Funguo: stake, strength, tf, mode, max, maxloss, losses, cooldown, perday, exposure, news, backtest, dry
 */
function parseSetting(name, raw) {
  const key = String(name || '').toLowerCase();
  const num = Number(raw);
  const rangeErr = (what) => ({ ok: false, error: what });
  let field;
  let value;

  switch (key) {
    case 'stake':
      if (!Number.isFinite(num) || num < MIN_STAKE) return rangeErr(`Stake lazima iwe angalau $${MIN_STAKE}.`);
      if (num > HARD_MAX_STAKE) return rangeErr(`Stake kubwa mno — kikomo ni $${HARD_MAX_STAKE} (POCKET_AUTO_MAX_STAKE).`);
      field = 'stake'; value = num; break;
    case 'strength':
      if (!Number.isFinite(num) || num < 50 || num > 100) return rangeErr('Nguvu ya chini iwe kati ya 50 na 100 (STRONG = 70+).');
      field = 'minStrength'; value = Math.round(num); break;
    case 'tf': {
      const sec = pocketSignal.parseTimeframe(raw, null);
      if (!sec || sec < 30 || sec > 300) return rangeErr('Timeframe iwe kati ya 30s na 5m. Mfano: 1m, 5m, 30s. (1m ndiyo ya kuaminika zaidi.)');
      field = 'tf'; value = sec; break;
    }
    case 'mode': {
      const m = String(raw || '').toLowerCase();
      if (!pocketSignal.SCAN_MODES.includes(m)) return rangeErr(`Mode: ${pocketSignal.SCAN_MODES.join(' | ')}`);
      field = 'mode'; value = m; break;
    }
    case 'max':
      if (!Number.isInteger(num) || num < 1 || num > 10) return rangeErr('Trades wazi za juu: namba kamili 1-10.');
      field = 'maxConcurrent'; value = num; break;
    case 'maxloss':
      if (!Number.isFinite(num) || num <= 0) return rangeErr('Kikomo cha hasara ya siku: namba kubwa kuliko 0 (USD).');
      field = 'maxDailyLoss'; value = num; break;
    case 'losses':
      if (!Number.isInteger(num) || num < 1 || num > 20) return rangeErr('Hasara mfululizo: namba kamili 1-20.');
      field = 'maxConsecLosses'; value = num; break;
    case 'cooldown':
      if (!Number.isFinite(num) || num < 5 || num > 1440) return rangeErr('Cooldown (dakika): 5-1440.');
      field = 'cooldownMin'; value = Math.round(num); break;
    case 'perday':
      if (!Number.isInteger(num) || num < 1 || num > 200) return rangeErr('Trades za juu kwa siku: namba kamili 1-200.');
      field = 'maxTradesPerDay'; value = num; break;
    case 'exposure':
      if (!Number.isInteger(num) || num < 1 || num > 5) return rangeErr('Exposure ya currency moja: namba kamili 1-5.');
      field = 'maxCurrencyExposure'; value = num; break;
    case 'news':
      field = 'newsFilter'; value = bool(raw); break;
    case 'dry':
      field = 'dryRun'; value = bool(raw); break;
    case 'backtest':
      if (!Number.isFinite(num) || num < 0 || num > 100) return rangeErr('Backtest ya chini (%): 0 (zima) hadi 100. Mfano 55.');
      field = 'minBacktest'; value = num; break;
    default:
      return rangeErr(`Setting "${name}" haijulikani.`);
  }

  return { ok: true, field, value };
}

/** Badilisha setting moja na kuihifadhi. Rudisha { ok, key, value, previous } au { ok:false, error }. */
async function setSetting(name, raw) {
  const p = parseSetting(name, raw);
  if (!p.ok) return p;
  const previous = cfg[p.field];
  cfg[p.field] = p.value;
  await saveConfig();
  // tf/mode zimebadilika -> panga upya mzunguko ujao kwenye candle sahihi
  if ((p.field === 'tf' || p.field === 'mode') && cfg.enabled && started) schedule();
  console.log(`[pocketAuto] ${p.field}: ${previous} -> ${p.value}`);
  return { ok: true, key: p.field, value: p.value, previous };
}

/**
 * Badilisha settings NYINGI kwa pamoja (dashboard). Zote zinathibitishwa KWANZA — kama moja
 * ni batili hakuna inayohifadhiwa. Rudisha { ok, changed:[{key,previous,value}] } | { ok:false, error }.
 */
async function setSettings(map) {
  const parsed = [];
  for (const [name, raw] of Object.entries(map || {})) {
    const p = parseSetting(name, raw);
    if (!p.ok) return { ok: false, error: `${name}: ${p.error}` };
    parsed.push(p);
  }
  const changed = [];
  let reschedule = false;
  for (const p of parsed) {
    if (cfg[p.field] === p.value) continue;
    changed.push({ key: p.field, previous: cfg[p.field], value: p.value });
    cfg[p.field] = p.value;
    if (p.field === 'tf' || p.field === 'mode') reschedule = true;
  }
  if (changed.length) {
    await saveConfig();
    if (reschedule && cfg.enabled && started) schedule();
    console.log(`[pocketAuto] settings: ${changed.map((c) => `${c.key} ${c.previous}->${c.value}`).join(', ')}`);
  }
  return { ok: true, changed };
}

/** Ondoa pause (cooldown / hasara ya siku) kwa mkono. Breakers zinaendelea kuhesabu upya. */
function resume() {
  const was = isPaused();
  const reason = pauseReason;
  pausedUntil = null;
  pauseReason = null;
  consecutiveLosses = 0;
  orderFailStreak = 0;
  if (was) logEvent('resume', `Pause (${PAUSE_TEXT[reason] || reason}) imeondolewa kwa mkono`);
  return { ok: true, was };
}

// ── Circuit breakers ────────────────────────────────────────────────────
function ensureDailyReset() {
  const key = utcDateKey(Date.now());
  if (key === dailyKey) return;
  dailyKey = key;
  dailyPnl = 0;
  tradesToday = 0;
  consecutiveLosses = 0;
  if (pauseReason === 'daily_loss_limit' || pauseReason === 'consecutive_losses') {
    pausedUntil = null;
    pauseReason = null;
  }
}

function isPaused() {
  ensureDailyReset();
  if (!pausedUntil) return false;
  if (Date.now() < pausedUntil) return true;
  pausedUntil = null;
  pauseReason = null;
  return false;
}

function evaluateBreakers() {
  if (-dailyPnl >= cfg.maxDailyLoss && pauseReason !== 'daily_loss_limit') {
    pausedUntil = endOfUtcDay(Date.now());
    pauseReason = 'daily_loss_limit';
    logEvent('pause', `Hasara ya siku ${money(dailyPnl)} — imesimama hadi kesho`);
    notifyAs('breakers',
      `🛑 *Pocket Auto-Trade imesimama kwa leo*\n\n` +
        `Hasara ya siku imefika ${money(dailyPnl)} (kikomo: $${cfg.maxDailyLoss}).\n` +
        `Itaendelea kiotomatiki kesho (00:00 UTC). Trades zilizo wazi zinaendelea kufuatiliwa.`
    );
  } else if (consecutiveLosses >= cfg.maxConsecLosses && pauseReason !== 'daily_loss_limit') {
    pausedUntil = Date.now() + cfg.cooldownMin * 60000;
    pauseReason = 'consecutive_losses';
    logEvent('pause', `Hasara ${consecutiveLosses} mfululizo — cooldown ${fmtDuration(cfg.cooldownMin * 60000)}`);
    notifyAs('breakers',
      `⏸️ *Pocket Auto-Trade: cooldown*\n\n` +
        `Hasara ${consecutiveLosses} mfululizo. Nasimama ${fmtDuration(cfg.cooldownMin * 60000)} kabla ya kufungua trade mpya.`
    );
    consecutiveLosses = 0; // cooldown ikiisha, hesabu inaanza upya
  }
}

const PAUSE_TEXT = {
  daily_loss_limit: 'kikomo cha hasara ya siku kimefikiwa',
  consecutive_losses: 'cooldown baada ya hasara mfululizo',
  order_failures: 'orders zimeshindwa mfululizo (pause fupi)',
};

// Je, trade MPYA inaruhusiwa sasa hivi? (ukaguzi wa synchronous — salama kwa reservation)
function canOpenNew() {
  if (!cfg.enabled) return { ok: false, reason: 'imezimwa' };
  if (isPaused()) return { ok: false, reason: PAUSE_TEXT[pauseReason] || 'imesimamishwa kwa muda' };
  if (-dailyPnl >= cfg.maxDailyLoss) {
    evaluateBreakers();
    return { ok: false, reason: 'kikomo cha hasara ya siku kimefikiwa' };
  }
  if (tradesToday >= cfg.maxTradesPerDay) return { ok: false, reason: `trades ${cfg.maxTradesPerDay} za leo zimekamilika` };
  if (positions.size >= cfg.maxConcurrent) return { ok: false, reason: `trades wazi ${positions.size}/${cfg.maxConcurrent}` };
  return { ok: true };
}

function currencyExposure() {
  const exposure = {};
  for (const p of positions.values()) {
    const l = legs(p.pair);
    if (!l) continue;
    const sign = p.direction === 'BUY' ? 1 : -1;
    exposure[l.base] = (exposure[l.base] || 0) + sign;
    exposure[l.quote] = (exposure[l.quote] || 0) - sign;
  }
  return exposure;
}

function wouldExceedExposure(pair, direction) {
  const l = legs(pair);
  if (!l) return false;
  const e = currencyExposure();
  const sign = direction === 'BUY' ? 1 : -1;
  return (
    Math.abs((e[l.base] || 0) + sign) > cfg.maxCurrencyExposure ||
    Math.abs((e[l.quote] || 0) - sign) > cfg.maxCurrencyExposure
  );
}

async function newsBlock(pair) {
  if (!cfg.newsFilter) return null;
  const l = legs(pair);
  if (!l) return null;
  try {
    const { getCalendarContext } = require('./economicCalendar');
    const ctx = await getCalendarContext(l.base, l.quote);
    if (ctx && ctx.newsRisk && ctx.upcomingHighImpact.length) {
      const e = ctx.upcomingHighImpact[0];
      return `${e.country} ${e.title} (${e.minutesFromNow >= 0 ? `baada ya dk ${e.minutesFromNow}` : `dk ${-e.minutesFromNow} zilizopita`})`;
    }
  } catch (err) {
    // fail-open: calendar ikishindwa, technicals ziendelee (kama Deriv autoTrader)
  }
  return null;
}

// ── Kufungua trade ──────────────────────────────────────────────────────
function skip(r, why, counter) {
  if (counter) stats[counter]++;
  lastSkipReason = `${r.pair} ${r.direction} ${r.strength}% — ${why}`;
  logEvent('skip', lastSkipReason);
  console.log(`[pocketAuto] RUKA ${lastSkipReason}`);
}

async function considerSignal(r) {
  if (!cfg.enabled) return;
  if (!r || r.direction === 'NEUTRAL' || r.weakMarket || r.strength < cfg.minStrength) return;
  stats.signals++;

  // 1) Late-entry guard — signal inatokana na candle iliyofungwa; ikichelewa, bei imeshasogea.
  const openMs = toMs(r.candleTime);
  if (openMs != null) {
    const delay = Date.now() - (openMs + cfg.tf * 1000);
    const maxDelay = Math.min(MAX_DELAY_MS, cfg.tf * 1000 * 0.4);
    if (delay > maxDelay) return skip(r, `imechelewa (${Math.round(delay / 1000)}s > ${Math.round(maxDelay / 1000)}s)`, 'late');
  }

  // 2) Mara moja kwa candle
  const sigKey = `${r.pair}|${r.direction}|${r.candleTime}`;
  if (seenSignals.has(sigKey)) return;
  seenSignals.add(sigKey);
  if (seenSignals.size > 400) seenSignals.delete(seenSignals.values().next().value);

  // 3) Backtest gate (hiari)
  if (cfg.minBacktest > 0) {
    const b = r.backtest && r.backtest.strong;
    if (!b || b.trades < 8 || b.winRate == null || b.winRate < cfg.minBacktest) {
      return skip(r, `backtest dhaifu (${b && b.trades ? `${b.winRate}% / ${b.trades}` : 'data haitoshi'} < ${cfg.minBacktest}%)`, 'blocked');
    }
  }

  // 4) Ukaguzi wa haraka (sync)
  const quick = canOpenNew();
  if (!quick.ok) return skip(r, quick.reason, null);
  const key = pairKey(r.pair);
  for (const p of positions.values()) if (p.key === key) return skip(r, 'jozi hii ina trade wazi tayari', 'blocked');
  if (wouldExceedExposure(r.pair, r.direction)) return skip(r, 'correlation guard (exposure ya currency)', 'blocked');

  // 5) News (async) — kabla ya reservation
  const news = await newsBlock(r.pair);
  if (news) return skip(r, `habari kubwa: ${news}`, 'blocked');

  // 6) Re-check sync + RESERVE (hakuna await kati ya ukaguzi na reservation => hakuna race
  //    kati ya workers 3 zinazochanganua kwa pamoja)
  const gate = canOpenNew();
  if (!gate.ok) return skip(r, gate.reason, null);
  for (const p of positions.values()) if (p.key === key) return skip(r, 'jozi hii ina trade wazi tayari', 'blocked');
  if (wouldExceedExposure(r.pair, r.direction)) return skip(r, 'correlation guard (exposure ya currency)', 'blocked');

  const resKey = `pending:${++seq}`;
  const pos = { pair: r.pair, key, direction: r.direction, stake: cfg.stake, strength: r.strength, openedAt: Date.now() };
  positions.set(resKey, pos);
  tradesToday++;
  signalTracker.record(r, cfg.dryRun ? 'dry' : 'autotrade');

  const arrow = r.direction === 'BUY' ? '🟢 UP (BUY) ⬆️' : '🔴 DOWN (SELL) ⬇️';
  const reasons = (r.notes || []).slice(0, 4).map((n) => `• ${n}`).join('\n');

  if (cfg.dryRun) {
    positions.delete(resKey);
    tradesToday--;
    stats.dry++;
    console.log(`[pocketAuto] DRY ${r.pair} ${r.direction} ${r.strength}%`);
    logEvent('dry', `${r.pair} ${r.direction} ${r.strength}% (dry-run)`);
    return notifyAs('dryRun',
      `🧪 *DRY-RUN — ingefungua trade*\n\n${arrow} *${r.pair}*\n💪 ${r.grade} ${r.strength}% • ⏱️ ${pocketSignal.tfLabel(r.expirySec)} • 💵 $${cfg.stake}\n\n${reasons}\n\n_Hakuna trade iliyofunguliwa. Zima dry-run: .poauto dry off_`
    );
  }

  try {
    const res = await pocketTrader.placeOrder({
      pair: r.pair,
      direction: r.direction,
      amount: cfg.stake,
      expirySeconds: r.expirySec,
      source: 'auto',
    });
    positions.delete(resKey);
    positions.set(String(res.orderId), pos);
    orderFailStreak = 0;
    stats.opened++;
    console.log(`[pocketAuto] ✅ ${r.pair} ${r.direction} ${r.strength}% stake=$${cfg.stake} order=${res.orderId}`);
    logEvent('open', `${r.pair} ${r.direction === 'BUY' ? 'UP' : 'DOWN'} ${r.strength}% • $${cfg.stake} • ${pocketSignal.tfLabel(r.expirySec)}`);
    await notifyAs('opened',
      `🤖 *AUTO-TRADE imefunguliwa* ${accountLabel()}\n\n` +
        `${arrow} *${r.pair}*\n` +
        `💪 ${r.grade} ${r.strength}%${r.adx != null ? ` • ADX ${r.adx.toFixed(0)}` : ''}\n` +
        `💵 Stake: $${cfg.stake} • ⏱️ Expiry: ${pocketSignal.tfLabel(r.expirySec)}\n` +
        `🆔 ${res.orderId}\n\n${reasons}\n\n` +
        `_Leo: trades ${tradesToday}/${cfg.maxTradesPerDay} • P/L ${money(dailyPnl)}. Zima: .poauto off_`
    );

    // Signal kwa group lililochaguliwa kwenye dashboard (ikiwa imewashwa).
    signalTargets.sendSignal(
      'po',
      `📡 *SIGNAL — ${r.pair}* (Pocket Option)\n\n` +
        `${arrow}\n` +
        `💪 ${r.grade} ${r.strength}% • ⏱️ Expiry: ${pocketSignal.tfLabel(r.expirySec)}\n\n` +
        `${reasons}\n\n⚠️ Hii SI ushauri wa kifedha.`
    ).catch(() => {});
  } catch (err) {
    positions.delete(resKey);
    tradesToday--;
    stats.failed++;
    orderFailStreak++;
    console.error(`[pocketAuto] ❌ Imeshindwa kufungua ${r.pair}:`, err.message);
    logEvent('fail', `${r.pair} ${r.direction}: ${err.message}`);
    if (orderFailStreak === 1 || orderFailStreak % 5 === 0) {
      await notifyAs('warnings', `⚠️ *Auto-trade: order imeshindwa* — ${r.pair} ${r.direction}\n${err.message}`);
    }
    if (orderFailStreak >= 3 && !isPaused()) {
      pausedUntil = Date.now() + 10 * 60000;
      pauseReason = 'order_failures';
      await notifyAs('breakers', '⏸️ Orders 3 zimeshindwa mfululizo — nasimama dakika 10 (angalia bridge/SSID/market).');
    }
  }
}

// ── Matokeo ya trade (kutoka pocketOptionTrader.onSettled) ──────────────
async function handleSettled({ orderId, status, result }) {
  const id = String(orderId);
  const pos = positions.get(id);
  if (!pos) return; // si trade ya auto (au imeshashughulikiwa)
  positions.delete(id);
  ensureDailyReset();

  const label = `${pos.pair} ${pos.direction === 'BUY' ? 'UP' : 'DOWN'}`;
  if (status === 'win') {
    const p = Number(result && (result.profit ?? result.pnl));
    const gain = Number.isFinite(p) && p > 0 ? p : 0;
    dailyPnl += gain;
    consecutiveLosses = 0;
    logEvent('win', `${label} ${gain > 0 ? '+' + money(gain) : ''}`.trim());
    await notifyAs('results',
      `✅ *WIN* — ${label}\n💵 ${gain > 0 ? `+${money(gain)}` : 'faida haijulikani'} • 🆔 ${id}\n📊 Leo: ${money(dailyPnl)} (trades ${tradesToday})`
    );
    signalTargets.sendResult('po', `✅ *WIN* — ${label}\n💵 ${gain > 0 ? `+${money(gain)}` : 'faida haijulikani'}`).catch(() => {});
  } else if (status === 'loss') {
    dailyPnl -= pos.stake;
    consecutiveLosses++;
    logEvent('loss', `${label} -${money(pos.stake)}`);
    await notifyAs('results',
      `🔴 *LOSS* — ${label}\n💵 -${money(pos.stake)} • 🆔 ${id}\n📊 Leo: ${money(dailyPnl)} • hasara mfululizo: ${consecutiveLosses}/${cfg.maxConsecLosses}`
    );
    signalTargets.sendResult('po', `🔴 *LOSS* — ${label}\n💵 -${money(pos.stake)}`).catch(() => {});
    evaluateBreakers();
  } else if (status === 'unconfirmed') {
    tradesToday = Math.max(0, tradesToday - 1); // haikufunguliwa kweli
    await notify(`⚠️ Order ${id} (${label}) haikuthibitishwa na Pocket Option — huenda haikufunguliwa. Angalia app.`);
  } else {
    await notify(`❓ Matokeo ya order ${id} (${label}) hayakupatikana. Angalia history kwenye app ya Pocket Option.`);
  }
}

// ── Mzunguko wa kuchanganua ─────────────────────────────────────────────
function msUntilNextCandle(tfSec) {
  const tfMs = tfSec * 1000;
  return tfMs - (Date.now() % tfMs) + 3000; // +3s: candle imefungwa kabisa upande wa server
}

function schedule() {
  if (timer) clearTimeout(timer);
  if (!cfg.enabled || !started) return;
  const wait = msUntilNextCandle(cfg.tf);
  nextCycleAt = Date.now() + wait;
  timer = setTimeout(async () => {
    try {
      await runCycle();
    } catch (err) {
      console.error('[pocketAuto] runCycle error:', err.message);
    } finally {
      schedule();
    }
  }, wait);
}

async function runCycle() {
  if (running || !cfg.enabled) return;
  running = true;
  try {
    ensureDailyReset();
    const gate = canOpenNew();
    if (!gate.ok) {
      lastSkipReason = `mzunguko umerukwa — ${gate.reason}`;
      return;
    }
    const st = await pocketTrader.getBridgeStatus();
    lastBridge = { ok: st.ok === true, connected: st.connected === true, demo: st.demo };
    if (!lastBridge.ok || !lastBridge.connected) {
      lastSkipReason = 'bridge haijaunganishwa na Pocket Option';
      return;
    }
    // Demo -> Real baada ya restart/SSID mpya: usiendelee kimya kimya.
    if (cfg.enabledOnDemo === true && st.demo === false) {
      cfg.enabled = false;
      await saveConfig();
      lastSkipReason = 'akaunti imekuwa REAL — auto imezimwa';
      await notifyAs('breakers',
        `🛑 *Pocket Auto-Trade imezimwa*\n\nUliiwasha kwenye akaunti DEMO, lakini bridge sasa inatumia akaunti *REAL*.\n` +
          `Ukitaka kuendelea kwenye REAL: *.poauto on confirm*`
      );
      return;
    }

    stats.cycles++;
    lastCycleAt = Date.now();
    const opts = { minStrength: cfg.minStrength, onResult: considerSignal };
    if (cfg.mode === 'smart') await pocketSignal.scanPrioritized(cfg.tf, opts);
    else await pocketSignal.scanPairs(await pocketSignal.getUniverse(cfg.mode), cfg.tf, opts);
  } finally {
    running = false;
  }
}

// ── API ya nje ──────────────────────────────────────────────────────────
async function restoreState() {
  const open = await pocketStore.getOpenAutoTrades();
  if (open) {
    for (const t of open) {
      positions.set(String(t.orderId), {
        pair: t.pair, key: pairKey(t.pair), direction: t.direction,
        stake: Number(t.stake), strength: null, openedAt: Number(t.openedAt),
      });
    }
    if (open.length) console.log(`[pocketAuto] Auto-trades ${open.length} zilizokuwa wazi zimerejeshwa.`);
  } else {
    console.error('[pocketAuto] ⚠️ DB haikupatikana — circuit breakers zinaanza upya kutoka sifuri.');
  }
  const risk = await pocketStore.getAutoRiskState(startOfUtcDay(Date.now()));
  if (risk) {
    dailyPnl = risk.dailyPnl;
    tradesToday = risk.tradesToday;
    consecutiveLosses = risk.consecutiveLosses;
    if (-dailyPnl >= cfg.maxDailyLoss) {
      pausedUntil = endOfUtcDay(Date.now());
      pauseReason = 'daily_loss_limit';
    } else if (consecutiveLosses >= cfg.maxConsecLosses && risk.lastLossAt) {
      const until = risk.lastLossAt + cfg.cooldownMin * 60000;
      if (until > Date.now()) { pausedUntil = until; pauseReason = 'consecutive_losses'; }
      else consecutiveLosses = 0;
    }
  }
}

/**
 * Inaitwa na index.js bot ikiunganishwa. Salama kuitwa tena baada ya reconnect.
 * Haiwashi auto-trade yenyewe isipokuwa ilikuwa imewashwa kwa `.poauto on` (imehifadhiwa Turso).
 */
async function start({ sock, notifyJid: jid }) {
  waSock = sock;
  notifyJid = jid;
  if (started) return;
  started = true;
  pocketTrader.onSettled(handleSettled); // KWANZA — kabla ya restoreOpenTrades kuanza kufuatilia
  try {
    await loadConfig();
    await restoreState();
  } catch (err) {
    console.error('[pocketAuto] Imeshindwa kurejesha hali:', err.message);
  }
  if (cfg.enabled) {
    console.log(
      `[pocketAuto] ✅ IMEWASHWA (imerejeshwa) — tf ${pocketSignal.tfLabel(cfg.tf)}, nguvu >=${cfg.minStrength}%, ` +
        `stake $${cfg.stake}, mode ${cfg.mode}${cfg.dryRun ? ', DRY-RUN' : ''}`
    );
    schedule();
  } else {
    console.log('[pocketAuto] Imezimwa (washa kwa .poauto on).');
  }
}

/**
 * Washa. Akaunti REAL (au isiyojulikana) inahitaji confirmReal=true.
 * Rudisha { ok } | { ok:false, needsConfirm, demo } | { ok:false, error }.
 */
async function enable({ confirmReal = false } = {}) {
  if (!started) return { ok: false, error: 'Auto-trader bado haijaanza (bot inaunganisha). Jaribu tena baada ya sekunde chache.' };
  const st = await pocketTrader.getBridgeStatus();
  if (!st.ok) return { ok: false, error: `Bridge ya Pocket Option haipatikani: ${st.error || 'haijibu'}. Angalia logs/SSID.` };
  lastBridge = { ok: true, connected: st.connected === true, demo: st.demo };
  if (st.demo !== true && !confirmReal) return { ok: false, needsConfirm: true, demo: st.demo };

  cfg.enabled = true;
  cfg.enabledOnDemo = st.demo === true;
  await saveConfig();
  schedule();
  logEvent('on', `Imewashwa (${st.demo ? 'DEMO' : 'REAL'})`);
  console.log(`[pocketAuto] ✅ Imewashwa (${st.demo ? 'DEMO' : 'REAL'}).`);
  return { ok: true, demo: st.demo === true, nextCycleAt };
}

async function disable() {
  const was = cfg.enabled;
  cfg.enabled = false;
  if (timer) clearTimeout(timer);
  timer = null;
  nextCycleAt = null;
  await saveConfig();
  logEvent('off', 'Imezimwa');
  console.log('[pocketAuto] 🛑 Imezimwa.');
  return { ok: true, was, openTrades: positions.size };
}

function getStatus() {
  ensureDailyReset();
  return {
    started,
    ...cfg,
    running,
    nextCycleAt,
    lastCycleAt,
    lastSkipReason,
    bridge: lastBridge,
    isPaused: isPaused(),
    pausedUntil,
    pauseReason,
    dailyPnl: Number(dailyPnl.toFixed(2)),
    tradesToday,
    consecutiveLosses,
    openTrades: [...positions.entries()].map(([orderId, p]) => ({ orderId, ...p })),
    exposure: currencyExposure(),
    stats: { ...stats },
    events: events.slice(),
    hardMaxStake: HARD_MAX_STAKE,
  };
}

async function getStats() {
  return pocketStore.getAutoStats(500);
}

module.exports = {
  start,
  enable,
  disable,
  setSetting,
  setSettings,
  resume,
  getStatus,
  getStats,
  DEFAULTS,
  PAUSE_TEXT,
  _internals: { runCycle, considerSignal, handleSettled }, // kwa majaribio tu
};
