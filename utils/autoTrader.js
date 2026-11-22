/**
 * autoTrader.js — Auto-trading kiotomatiki kwa jozi saba za forex (majors
 * 3: EUR/USD, GBP/USD, USD/JPY + crosses 4: EUR/GBP, EUR/JPY, GBP/JPY,
 * AUD/JPY — crosses zimeongezwa MAKUSUDI kupunguza correlation risk kwa
 * kuwa hazina USD, kila saa moja, kwa kutumia signal ile ile ya
 * utils/forexSignal.js (EMA9/EMA21, RSI14, MACD).
 *
 * Kanuni: kila saa (AUTO_TRADE_CHECK_INTERVAL_MS), bot inaangalia signal
 * ya kila jozi (kutoka utils/forexSignal.js — EMA9/EMA21, RSI14, MACD kwa
 * 1h, PAMOJA na uthibitisho wa mwelekeo wa 4h/HTF). Ikiwa signal INA
 * MWELEKEO (BUY/SELL) na nguvu (strength) >= AUTO_TRADE_STRENGTH_THRESHOLD
 * (default 67%, yaani angalau vigezo 3 kati ya 4: EMA crossover, RSI,
 * MACD, na mwelekeo wa 4h — signal lazima ithibitishwe na TIMEFRAME MBILI,
 * si moja), bot inafungua trade KIOTOMATIKO (Deriv Multipliers) na kutuma notification WhatsApp kwa DM
 * ya owner. Bot pia inaangalia kila baada ya dakika chache (POLL_MS) kama
 * trade yoyote iliyofunguliwa kiotomatiki imefungwa (SL/TP imegusa) na
 * kutuma notification ya matokeo (faida/hasara).
 *
 * ⚠️⚠️ HII INAFANYA TRADE ZA PESA HALISI KWA KUTUMIA LEVERAGE (Multipliers)
 * BILA UTHIBITISHO WA MTU KWA KILA TRADE — HATARI KUBWA YA KIFEDHA. Hii SI
 * ushauri wa kifedha wala wa uwekezaji. Zima wakati wowote kwa kuweka
 * AUTO_TRADE_ENABLED=false kwenye env (Railway variables) na ku-restart.
 *
 * Env vars (zote hiari isipokuwa AUTO_TRADE_ENABLED):
 *   AUTO_TRADE_ENABLED              — "true" kuwasha (default: "false" = imezimwa)
 *   AUTO_TRADE_CHECK_INTERVAL_MS    — muda kati ya ukaguzi wa signal (default: saa 1)
 *   AUTO_TRADE_POLL_MS              — muda kati ya ukaguzi wa trade zilizofungwa (default: dakika 1)
 *   AUTO_TRADE_STRENGTH_THRESHOLD   — asilimia ya chini ya signal (default: 100)
 *   AUTO_TRADE_STAKE_USD            — stake ya kila auto-trade (default: 5)
 *   AUTO_TRADE_MULTIPLIER           — moja ya 100/200/300/500/800 (default: 100)
 *   AUTO_TRADE_SL_ATR_MULT          — SL = mara ngapi za ATR(14) (default: 1)
 *   AUTO_TRADE_TP_ATR_MULT          — TP = mara ngapi za ATR(14) (default: 2 — risk:reward 1:2)
 *   AUTO_TRADE_SL_USD / AUTO_TRADE_TP_USD — dola fasta, hutumika TU kama
 *     ATR haipatikani kwa jozi husika (fallback)
 *   AUTO_TRADE_MIN_SL_USD            — kiwango cha chini cha SL (default: $1)
 *     — inazuia SL kuwa ndogo mno (senti chache) wakati wa soko tulivu,
 *     ambayo ilikuwa ikisababisha trade kufungwa haraka kwa noise ya bei
 *     badala ya mwenendo halisi. TP inapandishwa kwa uwiano uleule.
 *   AUTO_TRADE_PAIR_STAGGER_MS       — muda wa kusubiri kati ya jozi moja
 *     na nyingine ili kuepuka 429 ya Twelve Data (default: sekunde 70 —
 *     tahadhari, si lazima kwa ukali tena tangu forexSignal.js ibadilike
 *     kutumia raw candles (credits 2 tu kwa signal badala ya ~11), lakini
 *     bado ni desturi nzuri kuepuka mabump ya bahati mbaya)
 *   NEWS_RISK_WINDOW_MIN             — dakika kabla/baada ya tukio la High
 *     impact (utils/economicCalendar.js) ambazo auto-trade INASIMAMA
 *     kufungua trade MPYA (default: 30). Haiathiri trade zilizo wazi tayari.
 *
 * ── Circuit breakers (kuzuia hasara za mfululizo) ──────────────────────
 *   AUTO_TRADE_MAX_DAILY_LOSS_USD    — ukifika hasara hii kwa siku (UTC),
 *     bot inasimamisha kufungua trade mpya hadi siku ifuatayo (default: $15)
 *   AUTO_TRADE_MAX_CONSECUTIVE_LOSSES — hasara mfululizo (bila FAIDA
 *     katikati) zinazosababisha "cooldown" ya muda (default: 3)
 *   AUTO_TRADE_COOLDOWN_MS           — muda wa kusimama baada ya hasara
 *     mfululizo kufika kikomo (default: saa 4)
 *   AUTO_TRADE_MAX_CONCURRENT        — trades wazi kiwango cha juu wakati
 *     mmoja (jumla ya jozi zote) — inazuia exposure kubwa mno ikiwa jozi
 *     nyingi zinatoa signal wakati mmoja (default: 3; badilisha kwa env hii)
 *   AUTO_TRADE_MAX_CURRENCY_EXPOSURE — kikomo cha net exposure (units, si
 *     $) kwa currency MOJA (mfano USD) kutoka jozi zote zilizo wazi kwa
 *     pamoja (default: 1). Angalia "Correlation guard" chini — hii ndiyo
 *     inayozuia EUR/USD na GBP/USD zote kufunguliwa SHORT-USD wakati
 *     mmoja (dau moja lililojigawanya kwenye jozi mbili).
 *
 * ── Regime filter (walk-forward validation dhidi ya utils/backtest.js) ─
 *   AUTO_TRADE_REGIME_FILTER_ENABLED  — "true"/"false" (default: "true").
 *     Kabla ya kufungua trade MPYA, bot inaendesha backtest FUPI ya bars
 *     za HIVI KARIBUNI (si historia yote) kwa jozi husika. Ikiwa profit
 *     factor ya hivi karibuni iko CHINI ya kiwango, bot INAZUIA kufungua
 *     trade mpya kwa jozi hiyo — hata kama signal ya SASA "inaonekana
 *     nzuri" — mpaka mkakati uonyeshe tena una edge kwenye hali ya sasa
 *     ya soko. Trades zilizo wazi tayari HAZIGUSWI.
 *   AUTO_TRADE_REGIME_MIN_PROFIT_FACTOR — kiwango cha chini (default 1.2)
 *   AUTO_TRADE_REGIME_MIN_TRADES        — trades za chini kabisa ndani ya
 *     backtest fupi kabla ya kuamini profit factor yake (default 5) — sampuli
 *     ndogo mno haiaminiki, kwa hiyo bot HAIZUII kama data ni chache mno.
 *   AUTO_TRADE_REGIME_BACKTEST_BARS      — bars za backtest fupi (default 500)
 *   AUTO_TRADE_REGIME_CHECK_INTERVAL_MS  — mara ngapi backtest inarudiwa kwa
 *     jozi ile ile (cache) — default saa 24 (si kila mzunguko, ingekula
 *     credits nyingi za Twelve Data bure)
 *   Backtest ikishindwa (mfano rate limit ya API), regime filter "inashindwa
 *     wazi" (fail-open) — HAIZUII trade, inarudi kwenye tabia ya awali.
 *
 * Trades wazi TAYARI hazighairishwi na circuit breaker — SL/TP zake
 * zinaendelea kufanya kazi Deriv kama kawaida; kinachosimama ni KUFUNGUA
 * trade MPYA tu.
 */

const { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL, HTF_INTERVAL, DAILY_INTERVAL, HTF_GATE, DAILY_GATE, getTrends, DATA_SOURCE } = require('./forexSignal');
const { checkRoom, toPips } = require('./supportResistance');
const srAlerts = require('./srAlerts');
const tradeEstimate = require('./tradeEstimate');
const {
  placeMultiplier,
  getOpenPositions,
  getOpenPositionsLive,
  updateContractLimits,
  getContractDetails,
  getClosedContractFromHistory,
  getProfitTable,
  ALLOWED_MULTIPLIERS,
  toDerivSymbol,
  MIN_STAKE_USD,
  getAccountMode,
  getAccountState,
  onAccountSwitched,
  getRecentOpens,
} = require('./derivTrader');
// Turso (libSQL) — tayari inatumika na pairing/server.js kwa users/payments;
// hapa tunatumia kuhifadhi openAutoTrades ili isipotee kila redeploy/restart
// (angalia restoreOpenTradesFromDb() chini — hii ndiyo fix ya tatizo la
// "auto-trade inafungua mara mbili kwa jozi ile ile baada ya redeploy").
const fxTradesDb = require('../pairing/db');
const signalTargets = require('./signalTargets');
// News Trading (utils/newsTrader.js) ina table na ufuatiliaji wake — auto-trader isi-adopt wala isi-import trades hizo.
const newsTrader = require('./newsTrader');

const ENABLED = String(process.env.AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';
// Swichi ya LIVE (dashboard): inaamua kama bot ifungue trades MPYA. Thamani ya mwanzo = AUTO_TRADE_ENABLED; ikibadilishwa
// kwenye dashboard inahifadhiwa kwenye DB (fx_auto_settings) na inashinda env. Kuzima HAKUGUSI trades zilizo wazi:
// ufuatiliaji, kurekodi trades zilizofungwa, trailing na profit lock vinaendelea.
let AUTO_ON = ENABLED;
const AUTO_ON_KEY = 'autoTradeOn';
// Kikomo cha trades wazi kwa akaunti ya REAL (zote kwenye Deriv: auto + mkono + News). Auto-trader haifungui mpya ikifika.
const REAL_MAX_OPEN = (() => {
  const v = parseInt(process.env.AUTO_TRADE_REAL_MAX_OPEN || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
})();
const CHECK_INTERVAL_MS = Number(process.env.AUTO_TRADE_CHECK_INTERVAL_MS || 60 * 60 * 1000); // saa 1
const POLL_CLOSED_MS = Number(process.env.AUTO_TRADE_POLL_MS || 60 * 1000); // dakika 1 (arifa ya SL/TP isichelewe)
// Default 100: auto-trader inafungua trade TU signal ikiwa na strength ya 100%. (Env var bado inaweza kubadilisha.)
const STRENGTH_THRESHOLD = Number(process.env.AUTO_TRADE_STRENGTH_THRESHOLD || 100);

// `let` badala ya `const` — inaweza kubadilishwa "live" wakati bot inaendelea
// kukimbia kupitia .fxautostake <kiasi>, bila kuhitaji ku-restart au
// kuhariri env var. Thamani ya AUTO_TRADE_STAKE_USD (au default 5) ni
// "chaguo-msingi ya kuanzia" tu — setStakeUsd() chini inaruhusu kuibadilisha
// na inahifadhi mabadiliko hayo kwenye database (fx_auto_settings) ili
// yasipotee baada ya redeploy/restart (angalia loadStakeOverrideFromDb()).
let STAKE_USD = Number(process.env.AUTO_TRADE_STAKE_USD || 5);
const STAKE_SETTING_KEY = 'stakeUsd';
const rawMultiplier = Number(process.env.AUTO_TRADE_MULTIPLIER || 100);
const MULTIPLIER = ALLOWED_MULTIPLIERS.includes(rawMultiplier) ? rawMultiplier : 100;

// Twelve Data (tier bure): 8 credits/dakika. Kila jozi inatumia credits 6
// (price+rsi+macd+ema9+ema21+atr) — kuangalia jozi zote mara moja
// kunavuka kikomo (18 credits > 8/dakika) na kusababisha "429". Kwa hiyo
// tunasubiri kidogo kati ya jozi moja na nyingine (stagger).
// Deriv haina kikomo cha 8 credits/dakika cha Twelve — sekunde 3 zinatosha. Twelve ikiwa
// chanzo kikuu, tumia sekunde 70 (au weka AUTO_TRADE_PAIR_STAGGER_MS mwenyewe).
const PAIR_STAGGER_MS = (() => {
  const v = Number(process.env.AUTO_TRADE_PAIR_STAGGER_MS);
  if (Number.isFinite(v) && v >= 0 && process.env.AUTO_TRADE_PAIR_STAGGER_MS !== undefined && process.env.AUTO_TRADE_PAIR_STAGGER_MS !== '') return v;
  return DATA_SOURCE === 'deriv' ? 3 * 1000 : 70 * 1000;
})();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// SL/TP kwa kutumia ATR (Average True Range) — hukua/hupungua kulingana na
// volatility halisi ya jozi wakati huo, badala ya dola fasta isiyobadilika.
const SL_ATR_MULT = Number(process.env.AUTO_TRADE_SL_ATR_MULT || 1);
const TP_ATR_MULT = Number(process.env.AUTO_TRADE_TP_ATR_MULT || 2); // risk:reward 1:2

// Dola fasta — hutumika TU kama ATR haipatikani (fallback ya usalama).
const FALLBACK_SL_USD = Number(process.env.AUTO_TRADE_SL_USD || 3);
const FALLBACK_TP_USD = Number(process.env.AUTO_TRADE_TP_USD || 6);

// Kiwango cha chini cha SL kwa auto-trade — ATR ndogo (soko tulivu)
// ilikuwa ikitoa SL ya senti chache, na Deriv ilikuwa inafunga trade
// kirahisi kwa mzunguko wa kawaida wa bei (noise) badala ya mwenendo
// halisi wa soko, hivyo hasara za mara kwa mara. SL haiwezi kuwa chini
// ya hii sasa (isipokuwa stake yenyewe iko chini yake).
const MIN_SL_USD = Number(process.env.AUTO_TRADE_MIN_SL_USD || 1);

// ── Trailing stop / breakeven-lock ──────────────────────────────────────
// Kama ulivyoomba: HAKUNA env vars hapa — vigezo vyote ni fasta ndani ya
// code, na WASHA kwa default. Kitu pekee kinachoweza kubadilishwa "live"
// (bila kuhariri code/redeploy) ni TRAILING_ENABLED — kupitia
// .fxtrailing on/off (commands/utility/fxtrailing.js) au dashboard
// (fxtrading.html), zote zikiita setTrailingEnabled() chini, ambayo
// inahifadhi uamuzi kwenye database (fx_auto_settings) ili ubaki hata
// baada ya redeploy — muundo uleule na STAKE_USD/setStakeUsd() juu.
//
// Hatua mbili, kila moja ikipimwa kwa "R" = profit ya sasa ($) ikigawanywa
// na hatari ya AWALI ya trade (slUsd iliyowekwa wakati wa kufungua):
//   R >= 1 (BREAKEVEN_TRIGGER_R)   -> songa SL karibu na breakeven
//                                     (hatari iliyobaki: MIN_SL_USD tu)
//   R >= 2 (PROFITLOCK_TRIGGER_R)  -> funga angalau nusu (PROFITLOCK_R)
//                                     ya hatari ya awali KAMA FAIDA
//                                     iliyohakikishwa (SL inakuwa HASI)
// SL HAIWEZI kurudi nyuma (haiwezi kuongeza hatari) — kila hatua ni
// "ratchet" moja tu kuelekea usalama/faida zaidi, kamwe kinyume chake.
const TRAIL_BREAKEVEN_TRIGGER_R = 1;
const TRAIL_PROFITLOCK_TRIGGER_R = 2;
const TRAIL_PROFITLOCK_R = 0.5;
const TRAILING_SETTING_KEY = 'trailingEnabled';
let TRAILING_ENABLED = true; // default: WASHA

// ── Profit-lock tier ya ziada: asilimia ya STAKE (kando na R-multiple hapo
// juu) ───────────────────────────────────────────────────────────────────
// R-multiple inatumia slUsd (hatari ya awali) kama kipimo — kwa stake kubwa
// na SL nyembamba, R=1 inaweza kuchukua muda. Tier hii inaongeza ulinzi wa
// MAPEMA zaidi, ukilenga moja kwa moja stake yenyewe: mara faida ikishafika
// 10% ya stake wakati wowote ("kilele"/peak), tunaendelea kuifuatilia; kama
// baadaye faida ikishuka kwa kiasi kikubwa (PROFIT_LOCK_GIVEBACK_PCT) kutoka
// kilele hicho — ishara kwamba bei imeanza kugeuka — tunasogeza SL karibu na
// kiwango hicho cha 10% (siyo lazima 10% kamili — tunaacha nafasi ndogo
// isije kutupwa nje na mtikisiko mdogo mara baada ya kusogeza). Kama tier ya
// R-multiple hapo juu tayari imeamua ratchet kali zaidi, hii haifanyi kazi
// (haiwezi kurudisha nyuma — rule ya ratchet-moja-tu-mbele bado inatumika).
const PROFIT_LOCK_STAKE_PCT_TRIGGER = 0.10; // faida >= 10% ya stake huanzisha ufuatiliaji
const PROFIT_LOCK_GIVEBACK_PCT = 0.30; // faida ikishuka 30% kutoka kilele = "imeanza kushuka"
const PROFIT_LOCK_KEEP_FRACTION = 0.8; // funga ~80% ya kiwango cha 10% (siyo 100%, kuacha nafasi)

/**
 * Badilisha ATR (katika bei, mfano 0.00120 kwa EURUSD) kuwa SL/TP kwa dola
 * — kulingana na fomula rasmi ya Deriv Multipliers:
 *   Profit/Loss ($) = Stake × Multiplier × (mabadiliko ya bei ÷ bei ya kuingia)
 * Kwa hiyo: SL/TP ($) = Stake × Multiplier × (ATR × mult) ÷ bei ya sasa
 */
function computeAtrBasedRisk({ atr, price, stake, multiplier }) {
  if (!(atr > 0) || !(price > 0)) return null;
  const pctPerAtr = atr / price;
  let sl = stake * multiplier * pctPerAtr * SL_ATR_MULT;
  let tp = stake * multiplier * pctPerAtr * TP_ATR_MULT;

  // SL haiwezi kuzidi stake yenyewe (Deriv Multipliers: hasara ya juu zaidi
  // inayowezekana ni stake yote — no negative balance).
  sl = Math.min(sl, stake);

  // Zuia SL isiwe chini ya MIN_SL_USD (ikiwa stake inaruhusu). Tunapopandisha
  // SL, tunapandisha TP kwa UWIANO ULEULE wa risk:reward uliokusudiwa
  // (SL_ATR_MULT : TP_ATR_MULT), si namba fasta — ili mkakati wa hatari
  // usibadilike, tu ukubwa wake.
  if (sl < MIN_SL_USD && stake >= MIN_SL_USD) {
    const ratio = sl > 0 ? tp / sl : TP_ATR_MULT / SL_ATR_MULT;
    sl = MIN_SL_USD;
    tp = sl * ratio;
  }

  return {
    sl: Number(sl.toFixed(2)),
    tp: Number(tp.toFixed(2)),
  };
}

// Jozi tatu maarufu/maarufu zaidi duniani kwenye forex trading.
const PAIRS = [
  { code: 'EURUSD', symbol: 'EUR/USD' },
  { code: 'GBPUSD', symbol: 'GBP/USD' },
  { code: 'USDJPY', symbol: 'USD/JPY' },
  // Crosses (hazina USD) — kwa MAKUSUDI kupunguza correlation risk:
  // majors zote 3 hapo juu zina USD, kwa hiyo signal zake mara nyingi
  // zinasukumwa na chanzo kimoja (nguvu/udhaifu wa Dola). Hizi chini
  // zinasukumwa na benki kuu TOFAUTI (ECB/BOE/BOJ/RBA), si Fed.
  { code: 'EURGBP', symbol: 'EUR/GBP' },
  { code: 'EURJPY', symbol: 'EUR/JPY' },
  { code: 'GBPJPY', symbol: 'GBP/JPY' },
  { code: 'AUDJPY', symbol: 'AUD/JPY' },
  // Majors za ziada (zina USD — correlation guard inazuia kufungua nyingi
  // zinazoelekea upande mmoja wa Dola).
  { code: 'AUDUSD', symbol: 'AUD/USD' },
  { code: 'USDCHF', symbol: 'USD/CHF' },
  { code: 'USDCAD', symbol: 'USD/CAD' },
  { code: 'NZDUSD', symbol: 'NZD/USD' },
  // Crosses za ziada (hazina USD) — zinaongeza chaguo za pairs zisizogongana na zile
  // zilizo wazi, correlation guard inapozuia trade ya wazo lilelile.
  { code: 'AUDCAD', symbol: 'AUD/CAD' },
  { code: 'CADJPY', symbol: 'CAD/JPY' },
  { code: 'NZDJPY', symbol: 'NZD/JPY' },
  { code: 'GBPCHF', symbol: 'GBP/CHF' },
  { code: 'EURCAD', symbol: 'EUR/CAD' },
  { code: 'EURAUD', symbol: 'EUR/AUD' },
];

// ── Circuit breakers — hulinda dhidi ya hasara za mfululizo/kubwa mno ──
const MAX_DAILY_LOSS_USD = Number(process.env.AUTO_TRADE_MAX_DAILY_LOSS_USD || 15);
const MAX_CONSECUTIVE_LOSSES = Number(process.env.AUTO_TRADE_MAX_CONSECUTIVE_LOSSES || 3);
const COOLDOWN_MS = Number(process.env.AUTO_TRADE_COOLDOWN_MS || 4 * 60 * 60 * 1000); // saa 4
// Max trades wazi kwa wakati mmoja — default 3. Badilisha kwa env:
//   AUTO_TRADE_MAX_CONCURRENT=5
// (thamani batili/0 → inarudi default 3). Hasara: AUTO_TRADE_MAX_CONSECUTIVE_LOSSES,
// AUTO_TRADE_MAX_DAILY_LOSS_USD (angalia juu).
const DEFAULT_MAX_CONCURRENT = 3;
const MAX_CONCURRENT_TRADES = (() => {
  const v = parseInt(process.env.AUTO_TRADE_MAX_CONCURRENT || '', 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_CONCURRENT;
})();

// Kikomo cha net exposure (units, si $) kwa currency MOJA kabla ya
// kuzuia trade mpya — angalia computeCurrencyExposure()/
// wouldExceedCorrelationLimit() chini. Default 1 = usiruhusu currency
// yoyote iwe na zaidi ya "upande mmoja" wa net exposure kwa wakati mmoja
// kutoka kwenye jozi zote zilizo wazi (auto + za mkono).
// ── Support/Resistance filter ───────────────────────────────────────────
// AUTO_TRADE_SR_FILTER=on  → usifungue trade kama resistance (BUY) / support (SELL) iko karibu mbele ya entry
//   (chini ya AUTO_TRADE_SR_MIN_ROOM_ATR × ATR, default 1.5). IMEZIMWA kwa default — jaribu kwanza kwa
//   `.fxbacktest <JOZI> sr` kulinganisha kabla/baada. Info ya S/R inaonekana kwenye signals hata ikiwa imezimwa.
// Sasa inabadilishwa "live" (bila restart): `.fxsrfilter on|off` au dashboard → setSrFilter(); uamuzi unahifadhiwa
// DB (fx_auto_settings) na unabaki baada ya redeploy. Env ndiyo default tu pale DB haina thamani.
let SR_FILTER = String(process.env.AUTO_TRADE_SR_FILTER || 'off').toLowerCase() === 'on';
const SR_MIN_ROOM_ATR = Number(process.env.AUTO_TRADE_SR_MIN_ROOM_ATR || 1.5);
const SR_FILTER_KEY = 'srFilter';
// Arifa za S/R (blocked/cleared/approach/broken) + onyo la trade kukaribia SL. Default ON.
// Kuzima/kuwasha: `.fxsralerts on|off` au dashboard → setSrAlerts() (inahifadhiwa DB).
let SR_ALERTS = String(process.env.AUTO_TRADE_SR_ALERTS || 'on').toLowerCase() !== 'off';
const SR_ALERTS_KEY = 'srAlerts';
const srTracker = srAlerts.createTracker();
const lastSrZones = new Map();   // code -> { zones, price, atr, at } (kwa ushauri wa S/R kwenye onyo la SL)
const slAlertState = new Map();  // contractId -> { level, stopPnl }

const MAX_CURRENCY_EXPOSURE = Number(process.env.AUTO_TRADE_MAX_CURRENCY_EXPOSURE || 1);

// ── Regime filter (walk-forward validation) ─────────────────────────────
// Kabla ya kufungua trade MPYA, bot inaangalia kama mkakati bado una "edge"
// kwenye DATA YA HIVI KARIBUNI (backtest fupi, si historia yote) — kama
// profit factor imeshuka chini ya kiwango, bot INAZUIA trade mpya kwa jozi
// hiyo hata kama signal ya SASA inaonekana nzuri. Matokeo yanahifadhiwa
// (cache) kwa REGIME_CHECK_INTERVAL_MS ili kila mzunguko usiendeshe
// backtest upya (ingekula credits za Twelve Data bila sababu).
const REGIME_FILTER_ENABLED = String(process.env.AUTO_TRADE_REGIME_FILTER_ENABLED ?? 'true').toLowerCase() === 'true';
const REGIME_MIN_PROFIT_FACTOR = Number(process.env.AUTO_TRADE_REGIME_MIN_PROFIT_FACTOR || 1.2);
const REGIME_MIN_TRADES = Number(process.env.AUTO_TRADE_REGIME_MIN_TRADES || 5);
const REGIME_BACKTEST_BARS = Number(process.env.AUTO_TRADE_REGIME_BACKTEST_BARS || 500);
const REGIME_CHECK_INTERVAL_MS = Number(process.env.AUTO_TRADE_REGIME_CHECK_INTERVAL_MS || 24 * 60 * 60 * 1000); // saa 24

// code -> { ok, skipped, profitFactor, winRate, totalTrades, enoughData, checkedAt, error? }
const regimeCache = new Map();

async function checkRegimeFilter(code, symbol) {
  if (!REGIME_FILTER_ENABLED) return { ok: true, skipped: true };

  const cached = regimeCache.get(code);
  if (cached && Date.now() - cached.checkedAt < REGIME_CHECK_INTERVAL_MS) {
    return cached;
  }

  try {
    // Lazy require (SI juu ya faili) — inazuia mzunguko wa require():
    // utils/backtest.js nayo inahitaji autoTrader.js (getStatus,
    // computeAtrBasedRisk). Kwa kuwa hii inaitwa WAKATI WA RUNTIME (bot
    // tayari inaendesha, si mwanzoni mwa module load), module zote mbili
    // huwa zimeshamaliza kupakia kikamilifu kabla hii haijaitwa.
    const { runBacktest } = require('./backtest');
    const result = await runBacktest({ code, symbol, bars: REGIME_BACKTEST_BARS });

    const enoughData = result.totalTrades >= REGIME_MIN_TRADES;
    const ok = !enoughData || (result.profitFactor !== null && result.profitFactor >= REGIME_MIN_PROFIT_FACTOR);

    const entry = {
      ok,
      skipped: false,
      profitFactor: result.profitFactor,
      winRate: result.winRate,
      totalTrades: result.totalTrades,
      enoughData,
      checkedAt: Date.now(),
    };
    regimeCache.set(code, entry);
    return entry;
  } catch (err) {
    console.error(
      `[autoTrader] Regime filter imeshindwa kwa ${code} (inaendelea BILA kuzuia — "fail-open"):`,
      err.message
    );
    const entry = { ok: true, skipped: true, error: err.message, checkedAt: Date.now() };
    regimeCache.set(code, entry);
    return entry;
  }
}

function utcDateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function endOfUtcDay(ts) {
  const d = new Date(ts);
  d.setUTCHours(24, 0, 0, 0); // saa 00:00 UTC ya kesho
  return d.getTime();
}

let ownerJid = null;
let waSock = null;
let startedAt = null;
let lastCycleAt = null;
let watchdogGraceFrom = 0;
let lastWatchdogAlertAt = null; // epuka kutuma DM ya watchdog kila baada ya POLL_CLOSED_MS wakati tatizo bado lipo

// contract_id -> { code, symbol, direction, stake, buyPrice, openedAt }
const openAutoTrades = new Map();
// code -> { direction, strength, price, atr, notes, checkedAt }
const lastSignals = new Map();
// contract_id -> asilimia kubwa zaidi ya faida (profit / stake) iliyowahi
// kufikiwa na trade hii — inatumika na profit-lock tier ya 10% ndani ya
// checkTrailingStops() kugundua "bei imeanza kushuka" baada ya kufikia
// kizingiti. RAM pekee (haihifadhiwi DB) — ikipotea kwa restart, athari ni
// ndogo tu: trade inaanza kufuatiliwa upya kutoka profit ya sasa.
const peakProfitPct = new Map();

// ── Uhifadhi wa openAutoTrades kwenye database (Turso) ──────────────────
// Map ya RAM (openAutoTrades) pekee ilikuwa ikifutwa kila redeploy/restart
// ya Railway, hivyo baada ya redeploy bot "ilisahau" kwamba tayari ina
// trade wazi kwa jozi fulani na kufungua NYINGINE kwa jozi ile ile signal
// ikionekana nzuri tena. Kazi hizi zinasoma/kuandika DB ili historia ya
// trades ZILIZO WAZI iendelee kuwepo hata bot ikizima kabisa. DB
// isipopatikana (Turso haijawekwa), kazi hizi zinashindwa kimya kimya
// (bot inaendelea kufanya kazi na Map ya RAM pekee, kama awali).
// ⚠️ fx_auto_trades pia ina trades za WATEJA (ownerPhone = namba ya mteja, utils/derivTrades.js).
// Query zote za owner/auto-trader hapa lazima zichuje `ownerPhone IS NULL` — vinginevyo trades za wateja
// zingeingia kwenye ufuatiliaji/stats za akaunti ya owner.
// Trades zinatenganishwa kwa akaunti (demo/real): history, stats na ufuatiliaji wa wazi vinaonyesha akaunti ya SASA tu.
// Kichujio ni KALI: demo inaona demo tu, real inaona real tu. Trades za zamani zisizo na alama (accountMode NULL)
// HAZIHESABIWI popote hadi uzipange (dashboard: History -> "Weka kama DEMO/REAL") — zamani ziliingia kwenye akaunti zote mbili.
function modeSql() { return getAccountMode() ? ' AND accountMode = ?' : ''; }
function modeArgs() { const m = getAccountMode(); return m ? [m] : []; }
// Hakikisha tunajua akaunti ya sasa kabla ya kusoma history/stats (vinginevyo kichujio kingeachwa).
async function ensureModeResolved() {
  if (getAccountMode()) return;
  try { await getAccountState(); } catch (_) { /* hakuna kichujio */ }
}

// Alama ya "historia ilifutwa" kwa kila akaunti (ms). reconcileHistoryFromDeriv() haitarudisha trades zilizofungwa kabla ya muda huu.
async function getClearedAt(mode) {
  try {
    const r = await fxTradesDb.query('SELECT settingValue FROM fx_auto_settings WHERE settingKey = ?', ['histClearedAt_' + mode]);
    const v = Number(r.rows && r.rows[0] && r.rows[0].settingValue);
    return Number.isFinite(v) ? v : 0;
  } catch (_) { return 0; }
}
async function setClearedAt(mode, ts) {
  await fxTradesDb.query(
    `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
    ['histClearedAt_' + mode, String(ts), ts]
  );
}

async function dbSaveOpenTrade({ contractId, code, symbol, direction, stake, buyPrice, slUsd, tpUsd, openedAt, signalStrength }) {
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `INSERT INTO fx_auto_trades (contractId, code, symbol, direction, stake, buyPrice, slUsd, tpUsd, openedAt, signalStrength, accountMode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contractId) DO UPDATE SET
         code=excluded.code, symbol=excluded.symbol, direction=excluded.direction,
         stake=excluded.stake, buyPrice=excluded.buyPrice, slUsd=excluded.slUsd,
         tpUsd=excluded.tpUsd, openedAt=excluded.openedAt,
         signalStrength=COALESCE(excluded.signalStrength, fx_auto_trades.signalStrength)`,
      [contractId, code, symbol, direction, stake, buyPrice ?? null, slUsd ?? null, tpUsd ?? null, openedAt, signalStrength ?? null, getAccountMode()]
    );
  } catch (err) {
    console.error('[autoTrader] DB: imeshindwa kuhifadhi trade mpya (inaendelea na RAM pekee):', err.message);
  }
}

// Trade ambayo Deriv inasema BADO WAZI lakini DB iliiweka imefungwa (kimakosa) → irudishe wazi
// ili restoreOpenTradesFromDb() ione tena baada ya redeploy ijayo.
async function dbReopenTrade(contractId) {
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `UPDATE fx_auto_trades SET closedAt = NULL, sellPrice = NULL, profit = NULL WHERE contractId = ? AND closedAt IS NOT NULL`,
      [contractId]
    );
  } catch (err) {
    console.error('[autoTrader] DB: imeshindwa kurudisha trade kuwa wazi:', err.message);
  }
}

async function dbMarkTradeClosed(contractId, { closedAt, sellPrice, profit }) {
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `UPDATE fx_auto_trades SET closedAt = ?, sellPrice = COALESCE(?, sellPrice), profit = COALESCE(?, profit),
         accountMode = COALESCE(accountMode, ?) WHERE contractId = ?`,
      [closedAt, Number.isFinite(sellPrice) ? sellPrice : null, Number.isFinite(profit) ? profit : null, getAccountMode() || null, contractId]
    );
  } catch (err) {
    console.error('[autoTrader] DB: imeshindwa kusasisha trade iliyofungwa:', err.message);
  }
}

// Mipaka ya "bucket" za signal strength kwa ripoti ya win-rate — muundo
// uleule wa kufikiri na regime filter/backtest: strength ya juu zaidi
// INATAKIWA (kama mkakati una maana) kuwa na win-rate ya juu zaidi. Kama
// data haionyeshi tofauti hiyo, ni ishara kuwa threshold ya sasa
// (STRENGTH_THRESHOLD) haitofautishi ubora vizuri.
const STRENGTH_BUCKETS = [
  { label: '86-100%', min: 86 },
  { label: '76-85%', min: 76 },
  { label: '67-75%', min: 67 },
  { label: '<67%', min: 0 }, // trades za zamani kabla ya kizingiti cha sasa, au zilizoandikwa bila signalStrength
];

function bucketFor(strength) {
  if (strength === null || strength === undefined) return null; // adopted trades (zilizofunguliwa kwa mkono) — hazina signal, hazihesabiwi
  for (const b of STRENGTH_BUCKETS) {
    if (strength >= b.min) return b.label;
  }
  return STRENGTH_BUCKETS[STRENGTH_BUCKETS.length - 1].label;
}

/**
 * Win-rate kwa kila "bucket" ya signal strength — kutoka trades
 * ZILIZOFUNGWA TU (closedAt IS NOT NULL). Inatumiwa na command .autostats
 * na dashboard ya fxtrading.html.
 *
 * Muundo wa matokeo:
 *   [{ bucket, total, wins, losses, winRatePct, totalProfit, avgProfit }, ...]
 * kwa mpangilio wa bucket ya juu kwenda chini, ikifuatiwa na safu ya
 * "OVERALL" (jumla ya buckets zote).
 */
/**
 * Historia ya trade zilizofungwa (mpya kwanza) kwa ajili ya tab ya
 * "History" kwenye fxtrading.html.
 */
// Inajaza/kurekebisha historia ya owner kutoka profit_table ya Deriv: trades zilizofungwa
// kwa mkono (dashboard/.fxclose/Deriv app), kwa SL/TP, au wakati bot imezimwa, ambazo
// hazikurekodiwa au zilirekodiwa bila faida (profit = NULL). Throttle: mara moja kwa sekunde 20.
let lastReconcileAt = 0;
let reconcileRunning = false;
async function reconcileHistoryFromDeriv(force = false) {
  if (reconcileRunning || (!force && Date.now() - lastReconcileAt < 20000)) return;
  reconcileRunning = true;
  try {
    await ensureModeResolved();
    const mode0 = getAccountMode(); // akaunti ambayo profit_table hii ni yake — usiichanganye ikibadilika katikati
    if (!mode0) return;
    const txs = await getProfitTable(100);
    if (!txs.length) return;
    if (getAccountMode() !== mode0) return; // akaunti ilibadilishwa wakati tunasubiri Deriv
    await fxTradesDb.initSchema();
    const clearedAt = await getClearedAt(mode0);
    const ids = txs.map((t) => String(t.contract_id));
    const existing = await fxTradesDb.query(
      `SELECT contractId, closedAt, profit, ownerPhone FROM fx_auto_trades WHERE contractId IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    const byId = new Map((existing.rows || []).map((r) => [String(r.contractId), r]));
    for (const t of txs) {
      const id = String(t.contract_id);
      if (newsTrader.isNewsContract(id)) continue; // trade ya News Trading — ina table yake
      const buy = Number(t.buy_price);
      const sell = Number(t.sell_price);
      if (!Number.isFinite(buy) || !Number.isFinite(sell)) continue;
      const profit = Number(t.profit);
      const pl = Number.isFinite(profit) ? profit : sell - buy;
      const row = byId.get(id);
      if (row) {
        if (row.ownerPhone) continue; // trade ya mteja — si ya owner
        if (row.closedAt === null || row.closedAt === undefined) {
          // Poller huifunga (na kutuma notification) TU ikiwa iko kwenye ufuatiliaji (RAM). Ikiwa DB inasema "wazi"
          // lakini Deriv imeshaiuza na bot haiifuatilii (mf. baada ya redeploy/kubadili akaunti) — ingebaki "wazi"
          // milele na isionekane kwenye History/Stats. Ifunge hapa kimya (bila notification) kwa data ya Deriv.
          if (!openAutoTrades.has(id)) {
            await fxTradesDb.query(
              'UPDATE fx_auto_trades SET closedAt = ?, sellPrice = ?, profit = ?, accountMode = COALESCE(accountMode, ?) WHERE contractId = ? AND closedAt IS NULL',
              [(Number(t.sell_time) || 0) * 1000 || Date.now(), sell, pl, mode0, id]
            );
            console.log(`[autoTrader] 🧾 Historia: trade ${id} ilikuwa "wazi" kwenye DB lakini Deriv imeiuza — imerekodiwa (faida $${pl}).`);
          }
          continue;
        }
        // Trade iliyofungwa lakini accountMode ni NULL → ilichujwa nje ya History/Stats. profit_table hii ni ya
        // akaunti ya sasa, kwa hiyo trade hii ni ya akaunti hii.
        await fxTradesDb.query('UPDATE fx_auto_trades SET accountMode = ? WHERE contractId = ? AND accountMode IS NULL', [mode0, id]);
        if (row.profit === null || row.profit === undefined) {
          await fxTradesDb.query('UPDATE fx_auto_trades SET sellPrice = ?, profit = ? WHERE contractId = ?', [sell, pl, id]);
        }
        continue;
      }
      const m = /^(MULTUP|MULTDOWN)_FRX([A-Z]{6})_/i.exec(String(t.shortcode || ''));
      if (!m) continue; // si multiplier ya forex
      const code = m[2].toUpperCase();
      if (clearedAt && ((Number(t.sell_time) || 0) * 1000) <= clearedAt) continue; // ilifutwa kwa makusudi — isirudishwe
      await fxTradesDb.query(
        `INSERT INTO fx_auto_trades (contractId, code, symbol, direction, stake, buyPrice, openedAt, closedAt, sellPrice, profit, accountMode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(contractId) DO NOTHING`,
        [id, code, 'frx' + code, m[1].toUpperCase() === 'MULTUP' ? 'BUY' : 'SELL', buy, buy,
          (Number(t.purchase_time) || 0) * 1000, (Number(t.sell_time) || 0) * 1000 || Date.now(), sell, pl, mode0]
      );
    }
    lastReconcileAt = Date.now();
  } catch (err) {
    console.error('[autoTrader] reconcileHistoryFromDeriv imeshindwa:', err.message);
  } finally {
    reconcileRunning = false;
  }
}

// Dashboard/command ikifunga trade kwa mkono — rekodi faida mara moja (poller isiiandike NULL baadaye).
async function recordClosedFromDashboard(contractId, { profit, soldFor } = {}) {
  await dbMarkTradeClosed(String(contractId), {
    closedAt: Date.now(),
    sellPrice: Number(soldFor),
    profit: Number(profit),
  });
  lastReconcileAt = 0; // historia ijazwe upya (kama trade haikuwa kwenye DB)
}

// ── Kufuta historia + takwimu (owner) ───────────────────────────────────────────────
// scope: 'demo' | 'real' (akaunti hiyo tu) | 'all' (zote mbili + zisizo na alama) | 'legacy' (zisizo na alama tu).
// Trades zilizo WAZI hazifutwi kamwe. Circuit breaker (dailyPnL/hasara mfululizo) HAIGUSWI kwa makusudi — ni kinga ya hatari, si takwimu.
function clearFilter(scope) {
  const base = 'closedAt IS NOT NULL AND ownerPhone IS NULL';
  if (scope === 'demo' || scope === 'real') return { where: base + ' AND accountMode = ?', params: [scope], label: 'Akaunti ya ' + scope.toUpperCase() };
  if (scope === 'legacy') return { where: base + ' AND accountMode IS NULL', params: [], label: 'Trades za zamani zisizo na alama ya akaunti' };
  if (scope === 'all') return { where: base, params: [], label: 'Historia YOTE (demo + real + zisizo na alama)' };
  return { error: 'scope lazima iwe demo, real, legacy au all.' };
}

async function previewClearHistory(scope) {
  const f = clearFilter(scope);
  if (f.error) return { ok: false, error: f.error };
  try {
    await fxTradesDb.initSchema();
    const r = await fxTradesDb.query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(CASE WHEN profit < 0 THEN 1 ELSE 0 END), 0) AS losses,
              COALESCE(SUM(profit), 0) AS net
         FROM fx_auto_trades WHERE ${f.where}`, f.params);
    const x = (r.rows && r.rows[0]) || {};
    const openQ = await fxTradesDb.query('SELECT COUNT(*) AS n FROM fx_auto_trades WHERE closedAt IS NULL AND ownerPhone IS NULL', []);
    return {
      ok: true, scope, label: f.label,
      count: Number(x.n) || 0, wins: Number(x.wins) || 0, losses: Number(x.losses) || 0,
      net: Math.round((Number(x.net) || 0) * 100) / 100,
      openProtected: Number(openQ.rows && openQ.rows[0] && openQ.rows[0].n) || 0,
    };
  } catch (err) {
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

async function clearHistory(scope) {
  const pv = await previewClearHistory(scope);
  if (!pv.ok) return pv;
  const f = clearFilter(scope);
  try {
    const now = Date.now();
    const r = await fxTradesDb.query(`DELETE FROM fx_auto_trades WHERE ${f.where}`, f.params);
    // Weka alama ya muda ili reconcileHistoryFromDeriv() isirudishe trades zilizofutwa kutoka profit_table ya Deriv.
    if (scope === 'demo' || scope === 'real') await setClearedAt(scope, now);
    else if (scope === 'all') { await setClearedAt('demo', now); await setClearedAt('real', now); }
    else if (getAccountMode()) await setClearedAt(getAccountMode(), now); // legacy: profit_table ni ya akaunti ya sasa tu
    const deleted = Number(r.rowsAffected);
    return { ...pv, deleted: Number.isFinite(deleted) ? deleted : pv.count };
  } catch (err) {
    console.error('[autoTrader] clearHistory imeshindwa:', err.message);
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

async function countLegacyTrades() {
  try {
    await fxTradesDb.initSchema();
    const r = await fxTradesDb.query('SELECT COUNT(*) AS n FROM fx_auto_trades WHERE ownerPhone IS NULL AND accountMode IS NULL AND closedAt IS NOT NULL', []);
    return Number(r.rows && r.rows[0] && r.rows[0].n) || 0;
  } catch (_) { return 0; }
}

// Panga trades za zamani zisizo na alama kwenye akaunti uliyochagua (mara moja tu, kwa makusudi).
async function assignLegacyTrades(mode) {
  if (mode !== 'demo' && mode !== 'real') return { ok: false, error: 'mode lazima iwe demo au real.' };
  try {
    await fxTradesDb.initSchema();
    const r = await fxTradesDb.query('UPDATE fx_auto_trades SET accountMode = ? WHERE ownerPhone IS NULL AND accountMode IS NULL', [mode]);
    return { ok: true, mode, assigned: Number(r.rowsAffected) || 0 };
  } catch (err) {
    return { ok: false, error: `Database imeshindwa: ${err.message}` };
  }
}

async function getTradeHistory(limit = 200) {
  await ensureModeResolved();
  await reconcileHistoryFromDeriv();
  await fxTradesDb.initSchema();
  const lim = Math.max(1, Math.min(1000, Number(limit) || 200));
  const result = await fxTradesDb.query(
    `SELECT contractId, code, direction, stake, buyPrice, sellPrice, profit, openedAt, closedAt, signalStrength
       FROM fx_auto_trades WHERE closedAt IS NOT NULL AND ownerPhone IS NULL${modeSql()} ORDER BY closedAt DESC LIMIT ?`,
    [...modeArgs(), lim]
  );
  return (result.rows || []).map((r) => ({
    contractId: String(r.contractId),
    code: r.code,
    direction: r.direction,
    stake: Number(r.stake) || 0,
    buyPrice: r.buyPrice === null ? null : Number(r.buyPrice),
    sellPrice: r.sellPrice === null ? null : Number(r.sellPrice),
    profit: Number(r.profit) || 0,
    // profit = NULL kwenye DB (Deriv bado haijatoa faida halisi) → isihesabiwe kama hasara kwenye stats.
    profitKnown: r.profit !== null && r.profit !== undefined && Number.isFinite(Number(r.profit)),
    openedAt: Number(r.openedAt) || null,
    closedAt: Number(r.closedAt) || null,
    signalStrength: r.signalStrength === null || r.signalStrength === undefined ? null : Number(r.signalStrength),
    source: r.signalStrength === null || r.signalStrength === undefined ? 'manual' : 'auto',
  }));
}

// Muhtasari wa trades ZOTE zilizofungwa (auto + mkono) — si mdogo kwa 300 za history.
// Inatumiwa na cards za stats kwenye fxtrading.html. Faida isiyojulikana (NULL) inahesabiwa kando (unknown).
function emptyBucket() {
  return { total: 0, wins: 0, losses: 0, breakeven: 0, unknown: 0, grossProfit: 0, grossLoss: 0, net: 0, best: 0, worst: 0 };
}
function finishBucket(b) {
  const r2 = (n) => Math.round(n * 100) / 100;
  const decided = b.wins + b.losses + b.breakeven;
  return {
    ...b,
    grossProfit: r2(b.grossProfit), grossLoss: r2(b.grossLoss), net: r2(b.net), best: r2(b.best), worst: r2(b.worst),
    winRatePct: decided ? Math.round((b.wins / decided) * 1000) / 10 : 0,
    avgProfit: decided ? r2(b.net / decided) : 0,
  };
}
async function getTradeSummary() {
  try {
    await ensureModeResolved();
    await reconcileHistoryFromDeriv();
    await fxTradesDb.initSchema();
    const result = await fxTradesDb.query(
      `SELECT signalStrength, profit, closedAt FROM fx_auto_trades WHERE closedAt IS NOT NULL AND ownerPhone IS NULL${modeSql()}`,
      modeArgs()
    );
    const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Africa/Dar_es_Salaam' });
    const todayK = dayKey(Date.now());
    const acc = { all: emptyBucket(), auto: emptyBucket(), manual: emptyBucket(), today: emptyBucket() };
    for (const r of result.rows || []) {
      const isAuto = r.signalStrength !== null && r.signalStrength !== undefined;
      const known = r.profit !== null && r.profit !== undefined && Number.isFinite(Number(r.profit));
      const p = known ? Number(r.profit) : 0;
      const closedAt = Number(r.closedAt);
      const targets = [acc.all, isAuto ? acc.auto : acc.manual];
      if (closedAt && dayKey(closedAt) === todayK) targets.push(acc.today);
      for (const b of targets) {
        b.total += 1;
        if (!known) { b.unknown += 1; continue; }
        if (p > 0) { b.wins += 1; b.grossProfit += p; }
        else if (p < 0) { b.losses += 1; b.grossLoss += p; }
        else b.breakeven += 1;
        b.net += p;
        if (p > b.best) b.best = p;
        if (p < b.worst) b.worst = p;
      }
    }
    return { all: finishBucket(acc.all), auto: finishBucket(acc.auto), manual: finishBucket(acc.manual), today: finishBucket(acc.today) };
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kupata trade summary:', err.message);
    return null;
  }
}

async function getWinRateStats() {
  try {
    await ensureModeResolved();
    await reconcileHistoryFromDeriv();
    await fxTradesDb.initSchema();
    const result = await fxTradesDb.query(
      `SELECT signalStrength, profit FROM fx_auto_trades WHERE closedAt IS NOT NULL AND ownerPhone IS NULL${modeSql()}`,
      modeArgs()
    );
    const rows = result.rows || [];

    const grouped = new Map(); // bucket -> { total, wins, totalProfit }
    for (const r of rows) {
      const strength = r.signalStrength === null || r.signalStrength === undefined ? null : Number(r.signalStrength);
      const bucket = bucketFor(strength);
      if (!bucket) continue; // trade iliyofunguliwa kwa mkono (bila signal) — haihesabiwi kwenye ubora wa signal
      if (r.profit === null || r.profit === undefined || !Number.isFinite(Number(r.profit))) continue; // faida bado haijulikani — usihesabu kama hasara
      const profit = Number(r.profit);
      const g = grouped.get(bucket) || { total: 0, wins: 0, totalProfit: 0 };
      g.total += 1;
      if (profit > 0) g.wins += 1;
      g.totalProfit += profit;
      grouped.set(bucket, g);
    }

    const stats = STRENGTH_BUCKETS.filter((b) => grouped.has(b.label)).map((b) => {
      const g = grouped.get(b.label);
      return {
        bucket: b.label,
        total: g.total,
        wins: g.wins,
        losses: g.total - g.wins,
        winRatePct: g.total ? Math.round((g.wins / g.total) * 1000) / 10 : 0,
        totalProfit: Math.round(g.totalProfit * 100) / 100,
        avgProfit: g.total ? Math.round((g.totalProfit / g.total) * 100) / 100 : 0,
      };
    });

    const overallTotal = stats.reduce((s, x) => s + x.total, 0);
    const overallWins = stats.reduce((s, x) => s + x.wins, 0);
    const overallProfit = stats.reduce((s, x) => s + x.totalProfit, 0);
    stats.push({
      bucket: 'OVERALL',
      total: overallTotal,
      wins: overallWins,
      losses: overallTotal - overallWins,
      winRatePct: overallTotal ? Math.round((overallWins / overallTotal) * 1000) / 10 : 0,
      totalProfit: Math.round(overallProfit * 100) / 100,
      avgProfit: overallTotal ? Math.round((overallProfit / overallTotal) * 100) / 100 : 0,
    });

    return stats;
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kupata win-rate stats:', err.message);
    return [];
  }
}

/**
 * Inaitwa na commands/utility/fxtrailing.js / dashboard — inabadilisha
 * TRAILING_ENABLED "live" (bila restart) na kuihifadhi DB ili ibaki
 * hivyo hata baada ya redeploy. Muundo uleule na setStakeUsd() juu.
 */
async function setTrailingEnabled(enabled) {
  TRAILING_ENABLED = !!enabled;
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
      [TRAILING_SETTING_KEY, TRAILING_ENABLED ? '1' : '0', Date.now()]
    );
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kuhifadhi mpangilio wa trailing (itafanya kazi hadi restart ijayo):', err.message);
  }
  return { ok: true, trailingEnabled: TRAILING_ENABLED };
}

/**
 * Inaitwa MARA MOJA kwenye start() — sawa na loadStakeOverrideFromDb(),
 * kama mtu ameshabadilisha .fxtrailing kabla ya redeploy/restart ya
 * mwisho, hii inarejesha uamuzi huo badala ya kurudi kwenye default (ON).
 */
async function loadTrailingOverrideFromDb() {
  try {
    await fxTradesDb.initSchema();
    const result = await fxTradesDb.query(
      'SELECT settingValue FROM fx_auto_settings WHERE settingKey = ?',
      [TRAILING_SETTING_KEY]
    );
    const row = (result.rows || [])[0];
    if (row) {
      TRAILING_ENABLED = row.settingValue === '1';
      console.log(`[autoTrader] 🪤 Trailing stop imerejeshwa kutoka database: ${TRAILING_ENABLED ? 'ON' : 'OFF'}`);
    }
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kusoma mpangilio wa trailing kutoka DB (inaendelea na default ON):', err.message);
  }
}

async function setAutoEnabled(on) {
  AUTO_ON = !!on;
  if (AUTO_ON) watchdogGraceFrom = Date.now(); // ilizimwa kwa muda — usiite "imekwama" kabla ya cycle ya kwanza baada ya kuwashwa
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
      [AUTO_ON_KEY, AUTO_ON ? '1' : '0', Date.now()]
    );
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kuhifadhi swichi ya auto-trade kwenye DB (inafanya kazi hadi restart):', err.message);
  }
  console.log(`[autoTrader] 🔘 Auto-trade imewekwa: ${AUTO_ON ? 'ON' : 'OFF'} (dashboard).`);
  return { ok: true, autoEnabled: AUTO_ON };
}

async function loadAutoOnFromDb() {
  try {
    await fxTradesDb.initSchema();
    const r = await fxTradesDb.query('SELECT settingValue FROM fx_auto_settings WHERE settingKey = ?', [AUTO_ON_KEY]);
    const row = (r.rows || [])[0];
    if (row) AUTO_ON = row.settingValue === '1';
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kusoma swichi ya auto-trade kutoka DB (inatumia env):', err.message);
  }
}

async function saveSetting(key, value) {
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
      [key, value, Date.now()]
    );
    return true;
  } catch (err) {
    console.error(`[autoTrader] Imeshindwa kuhifadhi mpangilio "${key}" (unafanya kazi hadi restart):`, err.message);
    return false;
  }
}

/**
 * Washa/zima kichujio cha S/R (kinazuia entry S/R ikiwa karibu). Inatuma arifa kwa owner kila hali inapobadilika,
 * isipokuwa `notifyOwner:false` (command ya WhatsApp tayari inajibu kwenye chat hiyo hiyo).
 */
async function setSrFilter(on, { source = 'dashboard', notifyOwner = true } = {}) {
  const next = !!on;
  const changed = next !== SR_FILTER;
  SR_FILTER = next;
  await saveSetting(SR_FILTER_KEY, SR_FILTER ? '1' : '0');
  console.log(`[autoTrader] 🧱 Kichujio cha S/R: ${SR_FILTER ? 'ON' : 'OFF'} (${source}).`);
  if (changed && notifyOwner) {
    await notify(
      `🧱 *KICHUJIO CHA S/R ${SR_FILTER ? '🟢 IMEWASHWA' : '🔴 IMEZIMWA'}* (${source})\n\n` +
        (SR_FILTER
          ? `Bot itaruka entry ikiwa resistance (BUY) / support (SELL) iko chini ya ${SR_MIN_ROOM_ATR}×ATR mbele.`
          : `Bot haitazuia entry kwa sababu ya S/R tena. S/R bado inaonekana kwenye signals na arifa.`) +
        `\n_Trades zilizo wazi hazibadiliki._`
    );
  }
  return { ok: true, srFilter: SR_FILTER, changed };
}

/** Washa/zima arifa za S/R + onyo la SL. Arifa ya mabadiliko inatumwa kila mara (isipokuwa notifyOwner:false). */
async function setSrAlerts(on, { source = 'dashboard', notifyOwner = true } = {}) {
  const next = !!on;
  const changed = next !== SR_ALERTS;
  SR_ALERTS = next;
  srTracker.reset();       // usilinganishe na bei ya zamani baada ya kuwashwa tena
  slAlertState.clear();
  await saveSetting(SR_ALERTS_KEY, SR_ALERTS ? '1' : '0');
  console.log(`[autoTrader] 🔔 Arifa za S/R + SL: ${SR_ALERTS ? 'ON' : 'OFF'} (${source}).`);
  if (changed && notifyOwner) {
    await notify(
      `🔔 *ARIFA ZA S/R & SL ${SR_ALERTS ? '🟢 ZIMEWASHWA' : '🔴 ZIMEZIMWA'}* (${source})\n\n` +
        (SR_ALERTS
          ? `Utapata arifa kwa jozi zenye trade WAZI tu: bei ikikaribia zone, zone ikivunjwa, na trade ikikaribia Stop Loss.`
          : `Hutapata tena arifa za S/R wala onyo la trade kukaribia SL. (Arifa za kufungua/kufunga trade zinaendelea.)`)
    );
  }
  return { ok: true, srAlerts: SR_ALERTS, changed };
}

async function loadSrSettingsFromDb() {
  try {
    await fxTradesDb.initSchema();
    for (const [key, apply] of [[SR_FILTER_KEY, (v) => { SR_FILTER = v; }], [SR_ALERTS_KEY, (v) => { SR_ALERTS = v; }]]) {
      const r = await fxTradesDb.query('SELECT settingValue FROM fx_auto_settings WHERE settingKey = ?', [key]);
      const row = (r.rows || [])[0];
      if (row) apply(row.settingValue === '1');
    }
    console.log(`[autoTrader] 🧱 S/R filter: ${SR_FILTER ? 'ON' : 'OFF'} • 🔔 Arifa za S/R+SL: ${SR_ALERTS ? 'ON' : 'OFF'} (kutoka DB/env).`);
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kusoma mipangilio ya S/R kutoka DB (inatumia env):', err.message);
  }
}

// Kikomo cha REAL: idadi ya trades wazi (hesabu kubwa kati ya Deriv live na RAM) imefika REAL_MAX_OPEN?
function realLimitReached(liveCount) {
  if (getAccountMode() !== 'real') return false;
  return Math.max(Number(liveCount) || 0, openAutoTrades.size) >= REAL_MAX_OPEN;
}

/**
 * Inaitwa kila POLL_CLOSED_MS (dakika chache), pamoja na pollClosedTrades()
 * — kwa kila trade iliyo WAZI TAYARI yenye slUsd inayojulikana (yaani
 * ilifunguliwa na signal yetu, si "adopted"), angalia profit ya SASA
 * (live) dhidi ya hatari ya awali (slUsd) na, kama R imefika kizingiti,
 * songa Stop Loss kwenye Deriv — KAMWE kuipeleka nyuma (ratchet moja tu
 * kuelekea usalama/faida zaidi).
 */
/**
 * S/R + bei ya sasa ya jozi kwa makadirio ya trade. Jaribu data MPYA (cache ya forexSignal ni dakika 3), na ukishindwa
 * tumia zones za mzunguko wa mwisho. Inarudisha null kama hakuna chochote.
 */
async function getSrContext(code) {
  try {
    const snap = await fetchForexSnapshot(`${code.slice(0, 3)}/${code.slice(3)}`, DEFAULT_INTERVAL);
    return { zones: snap.srZones || [], price: snap.price, atr: snap.atr };
  } catch (_) {
    return lastSrZones.get(code) || null;
  }
}

/**
 * Makadirio ya faida/hasara kulingana na entry — inatumika KABLA ya kufungua (bila contractId; entry = bei ya sasa)
 * na BAADA ya kufungua (entry halisi kutoka Deriv ikipatikana). Haitupi error kamwe kwa mwito wa arifa.
 */
async function buildTradeEstimate({ code, direction, stake, multiplier, slUsd, tpUsd, contractId = null, commission = null, ctx = null }) {
  const c = ctx || (await getSrContext(code));
  let entry = null;
  if (contractId) {
    try {
      const d = await getContractDetails(contractId);
      const e = Number(d?.entry_spot ?? d?.entry_tick);
      if (e > 0) entry = e;
    } catch (_) { /* tumia bei ya sasa */ }
  }
  if (!entry && c?.price > 0) entry = Number(c.price);
  const est = tradeEstimate.estimateTrade({
    code, direction, entry, stake, multiplier, slUsd, tpUsd, commission,
    atr: c?.atr, zones: c?.zones || [],
  });
  return { est, text: tradeEstimate.formatEstimate(est), ctx: c };
}

/**
 * Ikiwa mtumiaji ameweka SL/TP kwa PIPS, zibadilishe kuwa dola kwa fomula ya Deriv Multipliers kwa kutumia
 * bei ya sasa (entry). SL haiwezi kuzidi stake (hasara ya juu ya Multipliers). Bila pips, inarudisha dola ulizoweka.
 */
async function resolveManualLimits({ code, stake, multiplier, stopLoss, takeProfit, slPips, tpPips }) {
  const sp = Number(slPips); const tpp = Number(tpPips);
  if (!(sp > 0) && !(tpp > 0)) return { stopLoss: Number(stopLoss), takeProfit: Number(takeProfit), pipsMode: false, ctx: null };
  const ctx = await getSrContext(code);
  const entry = Number(ctx?.price);
  if (!(entry > 0)) throw new Error('Bei ya sasa ya ' + code + ' haikupatikana — haiwezi kubadilisha pips kuwa dola. Jaribu tena.');
  const st = Number(stake) || STAKE_USD; const mu = Number(multiplier) || MULTIPLIER;
  let sl = sp > 0 ? tradeEstimate.pipsToUsd({ code, pips: sp, entry, stake: st, multiplier: mu }) : Number(stopLoss);
  const tp = tpp > 0 ? tradeEstimate.pipsToUsd({ code, pips: tpp, entry, stake: st, multiplier: mu }) : Number(takeProfit);
  let slCapped = false;
  if (sl > st) { sl = st; slCapped = true; }
  if (!(sl > 0) || !(tp > 0)) throw new Error('SL/TP kwa pips ni ndogo/kubwa mno kwa stake hii — rekebisha pips.');
  return { stopLoss: sl, takeProfit: tp, pipsMode: true, slCapped, entry, ctx };
}

/** Onyesho KABLA ya kufungua trade ya mkono (dashboard): faida/hasara zinazotarajiwa + S/R. Haifungui kitu. */
async function previewManualTrade({ pair, direction, stake, stopLoss, takeProfit, multiplier, slPips, tpPips }) {
  const code = String(pair || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!code) throw new Error('Jozi (pair) inahitajika.');
  const dir = direction === 'SELL' ? 'SELL' : 'BUY';
  const lim = await resolveManualLimits({ code, stake, multiplier, stopLoss, takeProfit, slPips, tpPips });
  const { est, text, ctx } = await buildTradeEstimate({
    code, direction: dir, stake: Number(stake) || STAKE_USD, multiplier: Number(multiplier) || MULTIPLIER,
    slUsd: lim.stopLoss, tpUsd: lim.takeProfit, ctx: lim.ctx,
  });
  const sr = ctx && ctx.price > 0
    ? tradeEstimate.describeSr({ code, direction: dir, price: ctx.price, atr: ctx.atr, zones: ctx.zones, minRoomAtr: SR_MIN_ROOM_ATR })
    : null;
  return { ok: true, estimate: est, text, srVerdict: sr ? sr.verdict : null, srOk: sr ? sr.ok : null, pipsMode: lim.pipsMode, slCapped: !!lim.slCapped, slUsd: lim.stopLoss, tpUsd: lim.takeProfit };
}

// Ombi moja la positions za live linashirikiwa na trailing + onyo la SL (kila moja ingeomba contract_details upya kila dakika).
let liveCache = { at: 0, data: null };
let livePending = null;
const LIVE_CACHE_MS = Number(process.env.AUTO_TRADE_LIVE_CACHE_MS ?? 20000);
async function getLiveShared(maxAgeMs = LIVE_CACHE_MS) {
  if (liveCache.data && Date.now() - liveCache.at < maxAgeMs) return liveCache.data;
  if (!livePending) {
    livePending = getOpenPositionsLive()
      .then((d) => { liveCache = { at: Date.now(), data: d }; return d; })
      .finally(() => { livePending = null; });
  }
  return livePending;
}

/**
 * Onyo la trade kukaribia Stop Loss — trades ZOTE zilizo wazi za jozi zetu (auto + za mkono, zisizo za News).
 * Hasara ikifika 70% ya SL → ⚠️, 90% → 🚨, ikirudi chini ya 50% → ✅. Inajumuisha S/R iliyo karibu upande wa SL
 * ili mmiliki aone kama kuna sababu ya kusogeza SL. Haibadilishi SL yenyewe.
 */
async function checkSlProximity() {
  if (!SR_ALERTS) return;
  let live;
  try {
    live = await getLiveShared();
  } catch (err) {
    console.error('[autoTrader] Onyo la SL: imeshindwa kupata positions za live:', err.message);
    return;
  }
  const seen = new Set();
  for (const p of live) {
    const id = String(p.contract_id);
    seen.add(id);
    const code = String(p.symbol || '').replace(/^frx/i, '').toUpperCase();
    if (!PAIRS.some((x) => x.code === code)) continue;
    if (newsTrader.isNewsContract(id)) continue;
    const profit = Number(p.profit);
    if (!Number.isFinite(profit)) continue;

    const info = openAutoTrades.get(id);
    const dAmt = Number(p.limit_order?.stop_loss?.order_amount);
    let stopPnl = null; // P/L ambapo SL inagusa: hasi = hasara ya juu, chanya = faida iliyofungwa
    if (Number.isFinite(dAmt) && dAmt !== 0) {
      stopPnl = dAmt > 0 && info && info.slUsd > 0 ? -dAmt : dAmt; // Deriv hurudisha hasara kama namba hasi
    } else if (info && Number.isFinite(info.slUsd) && info.slUsd !== 0) {
      stopPnl = -info.slUsd; // slUsd chanya = hasara ya juu (muundo wa updateContractLimits)
    }
    if (stopPnl === null) { slAlertState.delete(id); continue; } // hakuna SL — hakuna cha kuonya

    const risk = srAlerts.slRisk({ profit, stopPnl });
    const prev = slAlertState.get(id);
    const { notify: kind, next } = srAlerts.slAlertDecision(prev, risk, stopPnl);
    if (next) slAlertState.set(id, next); else slAlertState.delete(id);
    if (!kind) continue;

    const direction = /up/i.test(p.contract_type || '') ? 'BUY' : 'SELL';
    const spot = Number(p.current_spot);
    const stake = Number(p.buy_price) || info?.stake;
    const multiplier = Number(p.multiplier) || MULTIPLIER;
    const dist = srAlerts.priceDistanceForUsd(risk.remaining, { spot, stake, multiplier });
    const slPrice = dist == null ? null : direction === 'BUY' ? spot - dist : spot + dist;
    const zinfo = lastSrZones.get(code);
    const adviceLines = zinfo && Number.isFinite(spot)
      ? srAlerts.slAdviceLines({ code, direction, price: spot, atr: zinfo.atr, zones: zinfo.zones, slPrice, profit, notional: stake * multiplier })
      : [];
    try {
      await notify(srAlerts.formatSlAlert(kind, {
        code, direction, contractId: id, profit, risk, stopPnl,
        pipsToSl: dist == null ? null : Math.abs(toPips(code, dist)),
        adviceLines,
      }));
      console.log(`[autoTrader] ⚠️ Onyo la SL (${kind}) ${code} ${id}: hasara $${fmt(risk.loss)} / SL $${fmt(risk.lossBudget)} (${risk.lossPct.toFixed(0)}%).`);
    } catch (err) {
      console.error('[autoTrader] Onyo la SL limeshindwa kutumwa:', err.message);
    }
  }
  for (const id of [...slAlertState.keys()]) if (!seen.has(id)) slAlertState.delete(id); // trade imefungwa
}

async function checkTrailingStops() {
  if (!TRAILING_ENABLED || openAutoTrades.size === 0) return;

  let livePositions;
  try {
    livePositions = await getLiveShared();
  } catch (err) {
    console.error('[autoTrader] Trailing: imeshindwa kupata positions za live:', err.message);
    return;
  }
  const liveByContract = new Map(livePositions.map((p) => [String(p.contract_id), p]));

  for (const [contractId, info] of [...openAutoTrades.entries()]) {
    if (!Number.isFinite(info.slUsd) || info.slUsd <= 0) continue; // haijulikani/adopted — ruka

    const live = liveByContract.get(String(contractId));
    const profit = Number(live?.profit);
    if (!Number.isFinite(profit)) continue;

    const r = profit / info.slUsd; // "R-multiple" — profit kama sehemu ya hatari ya awali
    let desiredSl = null;
    let viaStakeLock = false;

    if (r >= TRAIL_PROFITLOCK_TRIGGER_R) {
      desiredSl = -(info.slUsd * TRAIL_PROFITLOCK_R); // hasi = faida iliyofungwa
    } else if (r >= TRAIL_BREAKEVEN_TRIGGER_R) {
      desiredSl = MIN_SL_USD; // karibu na breakeven
    }

    // Tier ya ziada: profit-lock kwa asilimia ya stake (angalia maelezo
    // kwenye constants hapo juu). Inafanya kazi tu kama R-multiple hapo
    // juu haijaamua kitu tayari (ili isipingane na ratchet kali zaidi).
    if (desiredSl === null && info.stake > 0) {
      const stakeProfitPct = profit / info.stake;
      const prevPeak = peakProfitPct.get(contractId) || 0;
      const peak = Math.max(prevPeak, stakeProfitPct);
      peakProfitPct.set(contractId, peak);

      if (peak >= PROFIT_LOCK_STAKE_PCT_TRIGGER) {
        const gaveBackEnough = stakeProfitPct <= peak * (1 - PROFIT_LOCK_GIVEBACK_PCT);
        if (gaveBackEnough) {
          desiredSl = -(info.stake * PROFIT_LOCK_STAKE_PCT_TRIGGER * PROFIT_LOCK_KEEP_FRACTION);
          viaStakeLock = true;
        }
      }
    }

    if (desiredSl === null) continue;
    if (desiredSl >= info.slUsd) continue; // si "ratchet" ya kuelekea usalama zaidi — ruka (haiwezekani kurudi nyuma)

    try {
      await updateContractLimits(contractId, { stopLoss: desiredSl });
      const previousSl = info.slUsd;
      info.slUsd = desiredSl;
      openAutoTrades.set(String(contractId), info);
      await dbSaveOpenTrade({
        contractId: String(contractId),
        code: info.code,
        symbol: info.symbol,
        direction: info.direction,
        stake: info.stake,
        buyPrice: info.buyPrice,
        slUsd: desiredSl,
        tpUsd: info.tpUsd,
        openedAt: info.openedAt,
      });
      console.log(
        `[autoTrader] 🪤 Trailing${viaStakeLock ? ' (stake-lock 10%)' : ''}: ${info.code} SL imesogezwa kutoka $${fmt(previousSl)} kwenda ` +
          `$${fmt(desiredSl)} (${viaStakeLock ? `peak ${fmt(peakProfitPct.get(contractId) * 100, 1)}% ya stake` : `R=${r.toFixed(2)}`}, profit ya sasa $${fmt(profit)}).`
      );
      await notify(
        `🪤 *TRAILING STOP${viaStakeLock ? ' — LOCK YA 10%' : ''} — ${info.code}*\n\n` +
          `Faida ya sasa: $${fmt(profit)}` +
          (viaStakeLock
            ? ` (ilishafika ${fmt(peakProfitPct.get(contractId) * 100, 1)}% ya stake kisha ikaanza kushuka)`
            : ` (R ${r.toFixed(2)})`) +
          `\nSL imesogezwa: $${fmt(previousSl)} → $${fmt(desiredSl)}` +
          (desiredSl < 0 ? `\n✅ Faida ya angalau $${fmt(Math.abs(desiredSl))} imefungwa sasa.` : `\n✅ Trade iko karibu na breakeven — hatari imepungua.`) +
          `\n🆔 Contract ID: ${contractId}`
      );
    } catch (err) {
      console.error(`[autoTrader] Trailing: imeshindwa kusogeza SL ya ${info.code} (${contractId}):`, err.message);
    }
  }
}

/**
 * Inaitwa MARA MOJA kwenye start() — inasoma DB kwa trades ambazo bado
 * hazijafungwa (closedAt IS NULL) kutoka mzunguko wa kabla ya redeploy/
 * restart ya mwisho, na kuzirudisha kwenye openAutoTrades (Map ya RAM),
 * ili checkPairAndTrade() "ione" kwamba jozi hizo tayari zina trade wazi
 * na isifungue nyingine. pollClosedTrades() ya kwanza baada ya start()
 * itagundua kama yoyote kati ya hizi tayari ilifungwa wakati bot ilikuwa
 * imezimwa, na kusasisha DB + kutuma notification kama kawaida.
 */
async function restoreOpenTradesFromDb() {
  let rows = [];
  try {
    await fxTradesDb.initSchema();
    // Jua akaunti ya sasa (demo/real) kwanza — trades za akaunti nyingine HAZIRUDISHWI kwenye ufuatiliaji.
    // Mtandao ukikosa, inaendelea bila kichujio (tabia ya zamani).
    try { await getAccountState(); } catch (_) { /* hakuna kichujio */ }
    // Trades za zamani zilizo wazi (accountMode NULL, kabla ya swichi) → zipewe akaunti ya SASA, ili zisichanganywe
    // na akaunti nyingine ukibadili baadaye.
    if (getAccountMode()) {
      await fxTradesDb.query(
        'UPDATE fx_auto_trades SET accountMode = ? WHERE accountMode IS NULL AND closedAt IS NULL AND ownerPhone IS NULL',
        [getAccountMode()]
      );
    }
    const result = await fxTradesDb.query(
      `SELECT contractId, code, symbol, direction, stake, buyPrice, openedAt, slUsd, tpUsd FROM fx_auto_trades WHERE closedAt IS NULL AND ownerPhone IS NULL${modeSql()}`,
      modeArgs()
    );
    rows = result.rows || [];
  } catch (err) {
    console.error('[autoTrader] DB haipatikani — inaanza bila historia ya trades za awali:', err.message);
    return;
  }

  for (const r of rows) {
    openAutoTrades.set(String(r.contractId), {
      code: r.code,
      symbol: r.symbol,
      direction: r.direction,
      stake: Number(r.stake),
      buyPrice: Number(r.buyPrice),
      openedAt: Number(r.openedAt),
      slUsd: r.slUsd === null || r.slUsd === undefined ? null : Number(r.slUsd),
      tpUsd: r.tpUsd === null || r.tpUsd === undefined ? null : Number(r.tpUsd),
    });
  }

  if (rows.length) {
    console.log(
      `[autoTrader] ✅ Trades ${rows.length} zilizokuwa wazi kabla ya restart/redeploy zimerejeshwa kutoka database: ` +
        rows.map((r) => r.code).join(', ')
    );
  }
}

/**
 * Inaitwa MARA MOJA kwenye start() — ikiwa mtu ameshabadilisha stake kupitia
 * .fxautostake kabla ya redeploy/restart ya mwisho, hii inarejesha thamani
 * hiyo badala ya kurudi kwenye AUTO_TRADE_STAKE_USD/default 5 kimya kimya.
 */
async function loadStakeOverrideFromDb() {
  try {
    await fxTradesDb.initSchema();
    const result = await fxTradesDb.query(
      'SELECT settingValue FROM fx_auto_settings WHERE settingKey = ?',
      [STAKE_SETTING_KEY]
    );
    const row = (result.rows || [])[0];
    if (row) {
      const saved = Number(row.settingValue);
      if (Number.isFinite(saved) && saved > 0) {
        STAKE_USD = saved;
        console.log(`[autoTrader] 💵 Stake imerejeshwa kutoka database: $${STAKE_USD}`);
      }
    }
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kusoma stake override kutoka DB (inaendelea na default/env):', err.message);
  }
}

/**
 * Inaitwa na commands/owner/fxautostake.js — inabadilisha STAKE_USD "live"
 * (bila restart) na kuihifadhi kwenye database ili ibaki hivyo hata baada
 * ya redeploy. Inarudisha { ok, stake } au { ok: false, error }.
 */
async function setStakeUsd(newStake) {
  const amount = Number(newStake);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Weka namba sahihi, kubwa kuliko 0 (mfano 1 au 2.5).' };
  }
  if (amount < MIN_STAKE_USD) {
    return { ok: false, error: `Stake ni ndogo mno — Deriv inahitaji angalau $${MIN_STAKE_USD}.` };
  }

  const previous = STAKE_USD;
  STAKE_USD = amount;

  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
      [STAKE_SETTING_KEY, String(amount), Date.now()]
    );
  } catch (err) {
    // Thamani ya RAM (STAKE_USD) tayari imebadilika, hivyo trade zijazo
    // zitatumia stake mpya hata kama kuhifadhi DB kumeshindwa — lakini
    // baada ya restart/redeploy itarudi kwenye ile ya awali (previous).
    console.error('[autoTrader] Imeshindwa kuhifadhi stake mpya kwenye DB (itafanya kazi hadi restart ijayo):', err.message);
  }

  console.log(`[autoTrader] 💵 Stake imebadilishwa: $${previous} → $${STAKE_USD}`);
  return { ok: true, stake: STAKE_USD, previous };
}

// Hali ya circuit breaker
let dailyPnL = 0;
let dailyKey = utcDateKey(Date.now());
let consecutiveLosses = 0;
let pausedUntil = null; // timestamp (ms) — null = hakuna pause
let pauseReason = null; // 'daily_loss_limit' | 'consecutive_losses' | null

const pnlByMode = {}; // { demo: {dailyPnL, consecutiveLosses}, real: {...} } — kila akaunti ina circuit breaker yake

function ensureDailyResetIfNewDay() {
  const key = utcDateKey(Date.now());
  if (key === dailyKey) return;
  dailyKey = key;
  dailyPnL = 0;
  consecutiveLosses = 0;
  for (const k of Object.keys(pnlByMode)) delete pnlByMode[k];
  // Siku mpya = anza upya — ondoa pause ya "hasara ya siku" (si ya cooldown).
  if (pauseReason === 'daily_loss_limit') {
    pausedUntil = null;
    pauseReason = null;
  }
}

// true = bot isifungue trade mpya sasa hivi (bado katika kipindi cha pause).
function isPaused() {
  ensureDailyResetIfNewDay();
  if (!pausedUntil) return false;
  if (Date.now() < pausedUntil) return true;
  // Muda wa pause umekwisha — fungua tena kiotomatiki.
  pausedUntil = null;
  pauseReason = null;
  return false;
}

function fmt(n, d = 2) {
  return Number(n).toFixed(d);
}

// Arifa zilizoshindwa kutumwa (mfano WhatsApp imekatika kwa muda) zinahifadhiwa na kutumwa
// socket mpya ikipatikana — hivyo arifa za SL/TP hazipotei.
const pendingNotifs = [];
const NOTIFY_TIMEOUT_MS = 15000;

// Socket ya SASA ya WhatsApp: global.currentSock husasishwa kila bot inapounganishwa upya (ndiyo
// inayotumiwa na arifa za dashboard zinazofika). `waSock` ni nakala iliyochukuliwa wakati wa start()
// na inaweza kuwa chakavu — hivyo socket ya sasa inapewa kipaumbele.
const liveSock = () => global.currentSock || waSock;

function sendWithTimeout(text) {
  return Promise.race([
    liveSock().sendMessage(ownerJid, { text }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ya kutuma')), NOTIFY_TIMEOUT_MS)),
  ]);
}

async function notify(text) {
  if (!ownerJid) return;
  try {
    if (!liveSock()) throw new Error('WhatsApp haijaunganishwa');
    await sendWithTimeout(text);
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kutuma notification (itajaribiwa tena socket ikirudi):', err.message);
    pendingNotifs.push(text);
    if (pendingNotifs.length > 20) pendingNotifs.shift();
  }
}

async function flushPendingNotifs() {
  while (pendingNotifs.length && liveSock() && ownerJid) {
    const text = pendingNotifs.shift();
    try {
      await sendWithTimeout(`🕘 (arifa iliyochelewa)\n${text}`);
    } catch (_) {
      pendingNotifs.unshift(text);
      break;
    }
  }
}

// Currency kila jozi (mfano "EURUSD" -> base "EUR", quote "USD").
function pairLegs(code) {
  const c = String(code || '').toUpperCase();
  return { base: c.slice(0, 3), quote: c.slice(3, 6) };
}

// Kutoka orodha ya trades ({code, direction}), hesabu net exposure ya kila
// currency: BUY = +1 kwa base / -1 kwa quote, SELL kinyume chake. Hii ndiyo
// msingi wa correlation guard — jozi MBILI TOFAUTI zenye currency moja
// (mfano EUR/USD na GBP/USD, zote na USD upande wa quote) zinaonekana kama
// "dau MOJA" ikiwa zote zinasukuma currency hiyo upande uleule (mfano zote
// SHORT USD) — badala ya kuhesabiwa kama diversification ya kweli.
function computeCurrencyExposure(trades) {
  const exposure = {};
  for (const t of trades) {
    const { base, quote } = pairLegs(t.code);
    if (!base || !quote) continue;
    const sign = t.direction === 'BUY' ? 1 : -1;
    exposure[base] = (exposure[base] || 0) + sign;
    exposure[quote] = (exposure[quote] || 0) - sign;
  }
  return exposure;
}

// Je, kufungua trade MPYA (code/direction) kungesukuma exposure ya
// currency yoyote (base AU quote) juu ya kikomo? Trade inayo-OFFSET
// exposure iliyopo (mfano USD/JPY BUY baada ya EUR/USD BUY — zote
// zinahusisha USD lakini pande tofauti) HAIZUIWI, kwa sababu net exposure
// yake inashuka badala ya kupanda — ndiyo maana hii ni bora kuliko
// kuhesabu tu "idadi ya trades kwa currency".
function wouldExceedCorrelationLimit(exposure, code, direction) {
  const { base, quote } = pairLegs(code);
  const sign = direction === 'BUY' ? 1 : -1;
  const newBase = (exposure[base] || 0) + sign;
  const newQuote = (exposure[quote] || 0) - sign;
  return Math.abs(newBase) > MAX_CURRENCY_EXPOSURE || Math.abs(newQuote) > MAX_CURRENCY_EXPOSURE;
}

// In-flight lock kwa pair — inazuia ukaguzi/kufungua MBILI kwa wakati mmoja kwa
// jozi ile ile (vinginevyo jozi ile ile ingeweza kufunguliwa MARA MBILI). Ni kando
// na correlation guard (jozi TOFAUTI zenye currency moja).
const inFlightPairs = new Set();

// Hatua 1: hesabu signal + vizuizi, rudisha mgombea au null (HAIFUNGUI trade).
async function evaluatePair(pairInfo) {
  const { code } = pairInfo;
  if (inFlightPairs.has(code)) {
    console.log(`[autoTrader] ${code}: ukaguzi mwingine bado unaendelea (in-flight) — naruka huu kuzuia trade mbili.`);
    return null;
  }
  inFlightPairs.add(code);
  try {
    return await evaluatePairInner(pairInfo);
  } finally {
    inFlightPairs.delete(code);
  }
}

async function evaluatePairInner(pairInfo) {
  const { code, symbol } = pairInfo;

  // HATUA 1 — signal ya KILA jozi huhesabiwa kila mzunguko (hata ikiwa pause/
  // trades zimejaa) ili dashboard/.fxautostatus ziwe na signal mpya za jozi zote.
  let snapshot, sig;
  try {
    // daily:true => pia vuta trend ya 1day (cache saa 6, credit 1 kwa jozi
    // mara chache kwa siku) ili gate ya daily itumike kwa auto-trade.
    snapshot = await fetchForexSnapshot(symbol, DEFAULT_INTERVAL, { daily: true });
    sig = computeSignal(snapshot);
  } catch (err) {
    console.error(`[autoTrader] Imeshindwa kupata signal ya ${code}:`, err.message);
    lastSignals.set(code, { error: err.message, checkedAt: Date.now() });
    return null;
  }

  const srDir = sig.direction !== 'NEUTRAL' ? sig.direction : sig.rawDirection;
  let srInfo = null;
  let srRoom = null;
  if (srDir === 'BUY' || srDir === 'SELL') {
    srRoom = checkRoom({ direction: srDir, price: snapshot.price, atr: snapshot.atr, zones: snapshot.srZones || [], minRoomAtr: SR_MIN_ROOM_ATR });
    srInfo = {
      ok: srRoom.ok,
      direction: srDir,
      level: srRoom.level ? Number(srRoom.level.price.toFixed(5)) : null,
      touches: srRoom.level ? srRoom.level.touches : null,
      tf: srRoom.level ? srRoom.level.tf : null,
      roomAtr: srRoom.roomAtr == null ? null : Number(srRoom.roomAtr.toFixed(2)),
      roomPips: srRoom.roomPrice == null ? null : Number(toPips(code, srRoom.roomPrice).toFixed(1)),
    };
  }

  lastSrZones.set(code, { zones: snapshot.srZones || [], price: snapshot.price, atr: snapshot.atr, at: Date.now() });
  if (SR_ALERTS) {
    try {
      // Tracker inasasishwa kila mzunguko (ili isilinganishe na bei chakavu), lakini arifa zinatumwa TU kwa jozi
      // yenye trade WAZI (auto/mkono) — na tu matukio yanayohusu trade hiyo: kukaribia zone na kuvunjwa kwa zone.
      // (blocked/cleared ni kuhusu entry mpya, hazina maana kwa jozi iliyo na trade tayari.)
      const events = srTracker.observe({ code, price: snapshot.price, atr: snapshot.atr, zones: snapshot.srZones || [], direction: srDir, room: srRoom });
      const openTrade = [...openAutoTrades.values()].find((t) => t.code === code);
      if (openTrade) {
        for (const ev of events) {
          if (ev.type !== 'approach' && ev.type !== 'broken') continue;
          await notify(srAlerts.formatEvent(code, ev, {
            price: snapshot.price, atr: snapshot.atr, filterOn: SR_FILTER, minRoomAtr: SR_MIN_ROOM_ATR, tradeDirection: openTrade.direction,
          }));
        }
      }
    } catch (err) {
      console.error(`[autoTrader] Arifa za S/R za ${code} zimeshindwa:`, err.message);
    }
  }

  lastSignals.set(code, {
    sr: srInfo,
    direction: sig.direction,
    strength: sig.strength,
    price: snapshot.price,
    atr: snapshot.atr,
    notes: sig.notes,
    gated: sig.gated || null,
    rawDirection: sig.rawDirection,
    rawStrength: sig.rawStrength,
    trends: getTrends(snapshot),
    checkedAt: Date.now(),
  });

  if (sig.gated) {
    console.log(
      `[autoTrader] ${code}: skip — gate ya ${sig.gated === 'DAILY' ? DAILY_INTERVAL : HTF_INTERVAL} ` +
        `(1h: ${sig.rawDirection}, 4h: ${snapshot.htfTrend || 'N/A'}, 1day: ${snapshot.dailyTrend || 'N/A'}).`
    );
  }

  // HATUA 2 — vizuizi vya kufungua trade mpya.
  // Circuit breaker: hasara ya siku au mfululizo imefika kikomo — usifungue
  // trade mpya (trades zilizo wazi tayari haziguswi, zinaendelea Deriv).
  if (isPaused()) return null;

  // Zuia trades wazi nyingi mno kwa wakati mmoja (exposure kubwa).
  if (openAutoTrades.size >= MAX_CONCURRENT_TRADES) return null;
  if (realLimitReached(0)) return null; // REAL: kikomo cha trades wazi (RAM)

  // Zuia kufungua trade nyingine kwa jozi ile ile wakati moja tayari iko wazi.
  const alreadyOpen = [...openAutoTrades.values()].some((t) => t.code === code);
  if (alreadyOpen) return null;

  // Ukaguzi wa ZIADA moja kwa moja Deriv (si Map/DB yetu pekee) — inazuia
  // auto-trader kufungua trade NYINGINE kwa jozi ambayo tayari ina trade
  // wazi iliyofunguliwa KWA MKONO kupitia dashboard (fxtrading.html →
  // "Fungua Trade Mpya") au chanzo kingine chochote kisichopitia
  // checkPairAndTrade — trade za namna hiyo HAZIPO kwenye openAutoTrades,
  // hivyo ukaguzi wa juu (alreadyOpen) haziwezi kuziona. Ikigundulika,
  // tunai-"adopt" (kuiingiza openAutoTrades + database) ili ifuatiliwe
  // ipasavyo (arifa itakapofungwa, circuit breaker) badala ya kupuuzwa
  // kimya kimya — na auto-trader HAIFUNGUI nyingine kwa jozi hii mzunguko huu.
  let livePositions = [];
  let livePosition;
  try {
    const derivSymbol = toDerivSymbol(code);
    livePositions = await getOpenPositions();
    livePosition = livePositions.find((p) => p.symbol === derivSymbol && !newsTrader.isNewsContract(p.contract_id));
    // Jozi ina trade ya News Trading pekee — usi-adopt, na usifungue nyingine kwa jozi hii.
    if (!livePosition && livePositions.some((p) => p.symbol === derivSymbol)) return null;
  } catch (err) {
    console.error(
      `[autoTrader] ${code}: imeshindwa kuangalia positions za Deriv — SIFUNGUI trade mpya mzunguko huu (kuzuia marudio):`,
      err.message
    );
    return null; // fail-closed: bila uthibitisho wa Deriv, usihatarishe kufungua trade ya pili kwa jozi ile ile
  }

  if (livePosition) {
    const direction = /up/i.test(livePosition.contract_type || '') ? 'BUY' : 'SELL';
    const openedAt = Number(livePosition.purchase_time) ? Number(livePosition.purchase_time) * 1000 : Date.now();
    const adopted = {
      code,
      symbol,
      direction,
      stake: Number(livePosition.buy_price) || 0,
      buyPrice: Number(livePosition.buy_price),
      openedAt,
      slUsd: null, // haijulikani — trade hii haikufunguliwa na signal yetu, trailing itaipuuza
      tpUsd: null,
    };
    openAutoTrades.set(String(livePosition.contract_id), adopted);
    await dbSaveOpenTrade({ contractId: String(livePosition.contract_id), ...adopted, slUsd: null, tpUsd: null });
    await dbReopenTrade(String(livePosition.contract_id));
    console.log(
      `[autoTrader] ${code}: trade wazi tayari ipo kwenye Deriv (imefunguliwa kwa mkono/chanzo kingine) — ` +
        `imeandikishwa (adopted) 🆔 ${livePosition.contract_id}, auto-trader haitafungua nyingine mzunguko huu.`
    );
    return null;
  }

  if (sig.direction === 'NEUTRAL' || sig.strength < STRENGTH_THRESHOLD) return null;

  // Habari kubwa (High impact) iko karibu (dakika NEWS_RISK_WINDOW_MIN
  // kabla/baada — angalia utils/economicCalendar.js) — spread/slippage
  // huongezeka sana wakati huu, si wakati salama wa kufungua trade mpya
  // hata kama technicals zinaonekana nzuri. Trade zilizo wazi TAYARI
  // haziguswi (SL/TP zake zinaendelea Deriv) — hii inazuia trade MPYA tu.
  if (sig.newsRisk) {
    console.log(`[autoTrader] ${code}: skip — habari kubwa (High impact) iko karibu.`);
    return null;
  }

  // Support/Resistance: S/R iko karibu mbele ya entry → nafasi ya kwenda ni ndogo, TP/trend inaweza kugonga ukuta.
  if (SR_FILTER && srRoom && !srRoom.ok) {
    console.log(`[autoTrader] ${code}: skip — S/R (${srRoom.reason}).`);
    return null;
  }

  // ── Correlation guard ──────────────────────────────────────────────
  // Tumia positions HALISI za Deriv (tayari zimechukuliwa hapo juu kwa
  // ukaguzi wa "adopt" — hakuna ombi la ziada) badala ya openAutoTrades
  // pekee, ili trades zilizofunguliwa KWA MKONO pia zihesabiwe kwenye
  // exposure — currency haijali chanzo cha trade.
  const openForExposure = livePositions.map((p) => ({
    code: String(p.symbol || '').replace(/^frx/i, '').toUpperCase(),
    direction: /up/i.test(p.contract_type || '') ? 'BUY' : 'SELL',
  }));
  const exposureNow = computeCurrencyExposure(openForExposure);
  if (wouldExceedCorrelationLimit(exposureNow, code, sig.direction)) {
    console.log(
      `[autoTrader] ${code}: skip — correlation guard (exposure ya sasa: ${JSON.stringify(exposureNow)}, ` +
        `${sig.direction} ${code} ingezidisha kikomo cha ±${MAX_CURRENCY_EXPOSURE} kwa currency moja — ` +
        `hii ni "dau moja" lililojigawanya kwenye jozi mbili, si diversification ya kweli).`
    );
    lastSignals.set(code, { ...lastSignals.get(code), correlationBlocked: true });
    return null;
  }

  // Regime filter (walk-forward validation) — angalia kama mkakati bado
  // una edge kwenye data ya HIVI KARIBUNI kabla ya kufungua trade mpya.
  // Matokeo yanahifadhiwa kwenye lastSignals ili .fxautostatus ionyeshe.
  const regime = await checkRegimeFilter(code, symbol);
  lastSignals.set(code, { ...lastSignals.get(code), regime });
  if (!regime.ok) {
    console.log(
      `[autoTrader] ${code}: skip — regime filter (profit factor ya hivi karibuni ${regime.profitFactor} ` +
        `< kiwango ${REGIME_MIN_PROFIT_FACTOR}, kutoka trades ${regime.totalTrades} za backtest fupi).`
    );
    return null;
  }

  // Hesabu SL/TP kulingana na ATR (volatility halisi ya jozi wakati huo).
  const risk = computeAtrBasedRisk({
    atr: snapshot.atr,
    price: snapshot.price,
    stake: STAKE_USD,
    multiplier: MULTIPLIER,
  });

  let slUsd, tpUsd, riskSource;
  if (risk && risk.sl > 0 && risk.tp > 0) {
    slUsd = risk.sl;
    tpUsd = risk.tp;
    riskSource = `ATR(14): ${fmt(snapshot.atr, 5)}`;
  } else {
    // ATR haipatikani kwa jozi hii wakati huu — tumia dola fasta (fallback).
    slUsd = FALLBACK_SL_USD;
    tpUsd = FALLBACK_TP_USD;
    riskSource = 'dola fasta (ATR haikupatikana)';
  }

  // Mgombea (candidate) — hatafunguliwa hapa; runCycle() inapanga wote kwa strength.
  return { code, symbol, sig, snapshot, slUsd, tpUsd, riskSource };
}

// Hatua 2: fungua trade ya mgombea mmoja — baada ya kuthibitisha tena vizuizi,
// kwa sababu trades zilizofunguliwa mapema KWENYE MZUNGUKO HUU zinabadilisha
// nafasi (max concurrent) na exposure ya currency.
async function executeCandidate(c) {
  const { code, symbol, sig, slUsd, tpUsd, riskSource, snapshot: candSnap } = c;
  if (inFlightPairs.has(code)) return;
  inFlightPairs.add(code);
  try {
    if (isPaused()) {
      console.log(`[autoTrader] ${code}: skip — circuit breaker imewashwa katikati ya mzunguko.`);
      return;
    }
    if (openAutoTrades.size >= MAX_CONCURRENT_TRADES) {
      console.log(
        `[autoTrader] ${code}: skip — nafasi zimejaa (${openAutoTrades.size}/${MAX_CONCURRENT_TRADES}); ` +
          `jozi zenye strength kubwa zaidi zimepewa kipaumbele.`
      );
      return;
    }
    if ([...openAutoTrades.values()].some((t) => t.code === code)) return;

    // Exposure mpya kabisa (positions halisi za Deriv; kama imeshindwa, tumia trades zetu).
    let openForExposure;
    try {
      const live = await getOpenPositions();
      if (realLimitReached(live.length)) {
        console.log(`[autoTrader] ${code}: skip — REAL: trades wazi ${live.length}/${REAL_MAX_OPEN} (kikomo cha akaunti ya REAL).`);
        return;
      }
      openForExposure = live.map((p) => ({
        code: String(p.symbol || '').replace(/^frx/i, '').toUpperCase(),
        direction: /up/i.test(p.contract_type || '') ? 'BUY' : 'SELL',
      }));
    } catch (_) {
      openForExposure = [...openAutoTrades.values()].map((t) => ({ code: t.code, direction: t.direction }));
    }
    const exposureNow = computeCurrencyExposure(openForExposure);
    if (wouldExceedCorrelationLimit(exposureNow, code, sig.direction)) {
      console.log(
        `[autoTrader] ${code}: skip — correlation guard (exposure ya sasa: ${JSON.stringify(exposureNow)}, ` +
          `${sig.direction} ${code} ingezidisha kikomo cha ±${MAX_CURRENCY_EXPOSURE}).`
      );
      lastSignals.set(code, { ...lastSignals.get(code), correlationBlocked: true });
      return;
    }

  try {
    const result = await placeMultiplier({
      pair: code,
      direction: sig.direction,
      stake: STAKE_USD,
      stopLoss: slUsd,
      takeProfit: tpUsd,
      multiplier: MULTIPLIER,
    });

    // result.stop_loss/take_profit ni SL/TP HALISI zilizotumika — derivTrader
    // inaweza kuwa imezirekebisha kiotomatiki juu ya slUsd/tpUsd tulizoomba
    // hapo juu, ikiwa Deriv ilikataa kama ndogo mno kwa jozi hii wakati huo.
    const slFinal = Number.isFinite(result.stop_loss) ? result.stop_loss : slUsd;
    const tpFinal = Number.isFinite(result.take_profit) ? result.take_profit : tpUsd;
    const adjustedNote = (slFinal !== slUsd || tpFinal !== tpUsd)
      ? `\n_(Imerekebishwa kiotomatiki kutoka SL $${fmt(slUsd)}/TP $${fmt(tpUsd)} — Deriv ilihitaji kiwango cha juu zaidi kwa jozi hii wakati huo.)_\n`
      : '';

    const openedAt = Date.now();
    openAutoTrades.set(String(result.contract_id), {
      code,
      symbol,
      direction: sig.direction,
      stake: STAKE_USD,
      buyPrice: result.buy_price,
      openedAt,
      slUsd: slFinal,
      tpUsd: tpFinal,
    });
    await dbSaveOpenTrade({
      contractId: String(result.contract_id),
      code,
      symbol,
      direction: sig.direction,
      stake: STAKE_USD,
      buyPrice: result.buy_price,
      slUsd: slFinal,
      tpUsd: tpFinal,
      openedAt,
      signalStrength: sig.strength,
    });

    // Makadirio ya faida/hasara kulingana na entry + S/R (haizuii arifa kama yakishindwa).
    let estText = '';
    let srVerdict = '';
    try {
      const ctx = candSnap ? { zones: candSnap.srZones || [], price: candSnap.price, atr: candSnap.atr } : null;
      const { text } = await buildTradeEstimate({
        code, direction: sig.direction, stake: STAKE_USD, multiplier: MULTIPLIER,
        slUsd: slFinal, tpUsd: tpFinal, contractId: result.contract_id, commission: result.commission, ctx,
      });
      estText = `${text}\n\n`;
      if (ctx && ctx.price > 0) {
        srVerdict = tradeEstimate.describeSr({ code, direction: sig.direction, price: ctx.price, atr: ctx.atr, zones: ctx.zones, minRoomAtr: SR_MIN_ROOM_ATR }).verdict;
      }
    } catch (err) {
      console.error(`[autoTrader] Makadirio ya ${code} yameshindwa:`, err.message);
    }

    await notify(
      `🤖 *AUTO-TRADE IMEFUNGULIWA*\n\n` +
        `Jozi: *${code}*\n` +
        `Mwelekeo: ${sig.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'}\n` +
        `Nguvu ya Signal: ${sig.strength}%\n` +
        `Stake: $${fmt(STAKE_USD)}  |  SL: $${fmt(slFinal)}  |  TP: $${fmt(tpFinal)}\n` +
        adjustedNote +
        `Multiplier: x${MULTIPLIER}\n` +
        `Msingi wa SL/TP: ${riskSource}\n` +
        `Bei ya ununuzi: $${fmt(result.buy_price)}\n` +
        `🆔 Contract ID: ${result.contract_id}\n\n` +
        estText +
        (srVerdict ? `🧱 *S/R:* ${srVerdict}\n\n` : '') +
        (sig.notes.length ? `🧠 Sababu:\n${sig.notes.map((n) => `   • ${n}`).join('\n')}\n\n` : '') +
        `⚠️ Trade hii ilifunguliwa KIOTOMATIKO kutokana na signal. Hii SI ushauri wa kifedha.`
    );

    // Signal kwa group lililochaguliwa kwenye dashboard (ikiwa imewashwa).
    signalTargets.sendSignal(
      'deriv',
      `📡 *SIGNAL — ${code}* (Deriv)\n\n` +
        `${sig.direction === 'BUY' ? '🟢 BUY ⬆️' : '🔴 SELL ⬇️'}\n` +
        `💪 Nguvu: ${sig.strength}%\n` +
        (srVerdict ? `\n🧱 *S/R:* ${srVerdict}\n` : '') +
        (sig.notes.length ? `\n🧠 Sababu:\n${sig.notes.slice(0, 3).map((n) => `• ${n}`).join('\n')}\n` : '') +
        `\n⚠️ Hii SI ushauri wa kifedha. Trade kwa hatari yako mwenyewe.`
    ).catch(() => {});
  } catch (err) {
    console.error(`[autoTrader] Imeshindwa kufungua trade ${code}:`, err.message);
    // Ulinzi wa jozi moja umezuia (si hitilafu halisi) — usitume ❌ kwa WhatsApp.
    if (err.code !== 'DUPLICATE_OPEN') await notify(`❌ Bot imeshindwa kufungua auto-trade ya ${code}: ${err.message}`);
  }
  } finally {
    inFlightPairs.delete(code);
  }
}

let cycleRunning = false;
let cycleStartedAt = 0;

async function runCycle() {
  if (!AUTO_ON) return; // imezimwa kwenye dashboard — usifungue trades mpya
  // Zuia mizunguko miwili kuingiliana (ingeweza kupanga/kufungua mara mbili).
  // Mzunguko uliokwama kwa muda mrefu hauzuii mpya (ulinzi dhidi ya hang).
  const maxHoldMs = Math.max(CHECK_INTERVAL_MS * 2, 10 * 60 * 1000);
  if (cycleRunning && Date.now() - cycleStartedAt < maxHoldMs) {
    console.log('[autoTrader] runCycle iliyotangulia bado inaendelea — naruka mzunguko huu.');
    return;
  }
  cycleRunning = true;
  cycleStartedAt = Date.now();
  try {
    // HATUA 1: pitia jozi ZOTE — kila moja inapata signal mpya (inahifadhiwa kwenye lastSignals).
    const candidates = [];
    for (let i = 0; i < PAIRS.length; i++) {
      if (i > 0 && PAIR_STAGGER_MS > 0) await sleep(PAIR_STAGGER_MS);
      try {
        const c = await evaluatePair(PAIRS[i]);
        if (c) candidates.push(c);
      } catch (err) {
        // Jozi MOJA ikitupa error (mfano Deriv "zombie" connection), usisimamishe mzunguko mzima.
        console.error(`[autoTrader] runCycle: ${PAIRS[i].code} imeshindwa, inaendelea na jozi zingine:`, err.message);
      }
    }

    // HATUA 2: panga kwa strength (kubwa kwanza) na ufungue hadi nafasi zijae.
    // Sare ya strength: jozi iliyotangulia kwenye PAIRS (sort ni stable).
    candidates.sort((a, b) => b.sig.strength - a.sig.strength);
    if (candidates.length) {
      console.log(
        `[autoTrader] Wagombea (strength): ` +
          candidates.map((c) => `${c.code} ${c.sig.direction} ${c.sig.strength}%`).join(' > ') +
          ` | nafasi: ${openAutoTrades.size}/${MAX_CONCURRENT_TRADES}`
      );
    }
    for (const c of candidates) {
      if (openAutoTrades.size >= MAX_CONCURRENT_TRADES) {
        console.log(`[autoTrader] Nafasi zimejaa (${MAX_CONCURRENT_TRADES}) — wagombea waliobaki hawafunguliwi.`);
        break;
      }
      try {
        await executeCandidate(c);
      } catch (err) {
        console.error(`[autoTrader] executeCandidate ${c.code} imeshindwa:`, err.message);
      }
    }

    lastCycleAt = Date.now();
    lastWatchdogAlertAt = null; // cycle imefanikiwa — rudisha "kimya" kwa tatizo lijalo
  } finally {
    cycleRunning = false;
  }
}

// Watchdog/heartbeat: pollInterval (POLL_CLOSED_MS, dakika chache) inaendelea
// kuita hii hata kama runCycle imekwama kabisa (mfano crash isiyoshikwa ndani
// ya checkPairAndTrade, au Deriv connection kukatika bila auto-reconnect).
// Kama tangu ukaguzi wa mwisho wa signal (au tangu bot ilipoanza, kama bado
// haijawahi kukamilisha cycle moja) imepita zaidi ya mara mbili ya muda wa
// kawaida kati ya cycle, tunatuma DM moja kwa owner. Halafu tunanyamaza hadi
// angalau CHECK_INTERVAL_MS nyingine ipite (badala ya kutuma DM kila
// POLL_CLOSED_MS wakati tatizo bado halijatatuliwa), na tunarudisha "kimya"
// mara runCycle inapofanikiwa tena.
function checkWatchdog() {
  // Auto-trade ikizimwa kwenye dashboard, runCycle inarudi mapema kwa makusudi (haisasishi lastCycleAt) —
  // hiyo si hitilafu, kwa hiyo watchdog isitume onyo la uongo.
  if (!AUTO_ON) return;
  const reference = Math.max(lastCycleAt || 0, watchdogGraceFrom || 0) || startedAt;
  if (!reference) return;

  const staleFor = Date.now() - reference;
  if (staleFor <= CHECK_INTERVAL_MS * 2) return;

  if (lastWatchdogAlertAt && Date.now() - lastWatchdogAlertAt < CHECK_INTERVAL_MS) return;
  lastWatchdogAlertAt = Date.now();

  notify(
    `⚠️ *WATCHDOG* — Bot haijafanya ukaguzi wa signal (runCycle) kwa dakika ${Math.round(staleFor / 60000)} ` +
      `(kawaida ni kila ${Math.round(CHECK_INTERVAL_MS / 60000)}). Huenda process imekwama, Railway restart ` +
      `haijaanzisha vizuri, au Deriv connection imekatika — angalia Railway logs.`
  ).catch((err) => console.error('[autoTrader] Imeshindwa kutuma watchdog alert:', err.message));
}

// Mara ngapi (poll) trade iliyokosekana kwenye portfolio bila ushahidi wa kuuzwa ndipo ichukuliwe imefungwa.
const CLOSE_CONFIRM_POLLS = 3;
const closeMisses = new Map(); // contractId -> idadi ya polls zilizokosa

async function pollClosedTrades() {
  if (openAutoTrades.size === 0) return;

  let openIds;
  try {
    const positions = await getOpenPositions();
    // String(): Deriv inarudisha contract_id kama NAMBA, wakati keys za openAutoTrades zilizorejeshwa
    // kutoka DB ni STRING — bila kusawazisha, trades zote zilizorejeshwa baada ya redeploy zilionekana
    // "zimefungwa" kimakosa na auto-trader ikafungua mpya kwa jozi ile ile.
    openIds = new Set(positions.map((p) => String(p.contract_id)));
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kuangalia positions:', err.message);
    return;
  }

  for (const [contractId, info] of [...openAutoTrades.entries()]) {
    if (openIds.has(String(contractId))) { closeMisses.delete(contractId); continue; } // bado wazi

    // Kutokuwepo kwenye portfolio PEKEE hakutoshi (portfolio inaweza kurudi tupu/pungufu
    // muda mfupi baada ya redeploy au WebSocket kuunganishwa upya). Thibitisha na Deriv
    // kwamba contract IMEUZWA kweli kabla ya kuifunga kwenye DB.
    let verify = null;
    try { verify = await getContractDetails(contractId); } catch (_) { /* hakuna ushahidi */ }
    if (verify && Number(verify.is_sold) === 0 && verify.status !== 'sold') {
      closeMisses.delete(contractId);
      console.log(`[autoTrader] ${info.code} (${contractId}): haipo kwenye portfolio lakini Deriv inasema BADO WAZI — inaendelea kufuatiliwa.`);
      continue;
    }
    let soldProof = !!(verify && Number(verify.is_sold) === 1);
    if (!soldProof) {
      try { soldProof = !!(await getClosedContractFromHistory(contractId)); } catch (_) { /* hakuna ushahidi */ }
    }
    if (!soldProof) {
      const misses = (closeMisses.get(contractId) || 0) + 1;
      closeMisses.set(contractId, misses);
      if (misses < CLOSE_CONFIRM_POLLS) {
        console.log(`[autoTrader] ${info.code} (${contractId}): haipo kwenye portfolio lakini kufungwa hakujathibitishwa (${misses}/${CLOSE_CONFIRM_POLLS}) — naendelea kuifuatilia.`);
        continue;
      }
    }
    closeMisses.delete(contractId);

    openAutoTrades.delete(contractId);
    peakProfitPct.delete(contractId); // trade imefungwa — futa historia ya peak ya profit-lock

    // Hatua 1: proposal_open_contract — kazi vizuri contract ikitoka tu
    // kwenye portfolio, lakini mara nyingi haitoi tena sell_price/profit
    // sahihi contract ikishafungwa kikamilifu.
    let sellPrice, profit;
    try {
      const details = await getContractDetails(contractId);
      sellPrice = Number(details?.sell_price);
      profit = Number(details?.profit);
    } catch (err) {
      console.error(`[autoTrader] proposal_open_contract imeshindwa (${contractId}):`, err.message);
    }

    // Hatua 2: profit_table (historia ya transactions zilizofungwa) — chanzo
    // cha kuaminika zaidi kwa contract iliyoshafungwa kabisa.
    if (!Number.isFinite(profit) || !Number.isFinite(sellPrice)) {
      try {
        const closed = await getClosedContractFromHistory(contractId);
        if (closed) {
          sellPrice = Number.isFinite(sellPrice) ? sellPrice : Number(closed.sell_price);
          profit = Number.isFinite(Number(closed.profit))
            ? Number(closed.profit)
            : sellPrice - Number(closed.buy_price);
        }
      } catch (err) {
        console.error(`[autoTrader] profit_table imeshindwa (${contractId}):`, err.message);
      }
    }

    // Hatua 3: fallback ya mwisho — kama tuna bei ya kufunga (sellPrice) tu,
    // hesabu faida/hasara halisi wenyewe kutoka bei ya ununuzi tuliyohifadhi
    // wakati trade ilipofunguliwa (info.buyPrice). Kwa Multipliers, profit
    // halisi = sellPrice - buyPrice (thamani tayari ina multiplier ndani).
    if (!Number.isFinite(profit) && Number.isFinite(sellPrice) && Number.isFinite(info.buyPrice)) {
      profit = sellPrice - info.buyPrice;
    }

    // Sasisha DB SASA (kabla ya matawi ya notify hapa chini) — hii ndiyo
    // "history hadi trade itakapo close": row inabaki (si kufutwa) lakini
    // closedAt inajazwa, hivyo restoreOpenTradesFromDb() haitaigusa tena
    // kwenye restart ijayo (query yake ni closedAt IS NULL pekee).
    await dbMarkTradeClosed(contractId, { closedAt: Date.now(), sellPrice, profit });

    if (Number.isFinite(profit)) {
      const won = profit >= 0;

      // Circuit breaker — sasisha takwimu za siku (UTC) na mfululizo wa hasara.
      ensureDailyResetIfNewDay();
      dailyPnL += profit;
      consecutiveLosses = won ? 0 : consecutiveLosses + 1;

      await notify(
        `${won ? '✅' : '🔴'} *AUTO-TRADE IMEFUNGWA — ${info.code}*\n\n` +
          `Mwelekeo: ${info.direction}\n` +
          `Matokeo: ${won ? 'FAIDA 📈' : 'HASARA 📉'}  $${fmt(Math.abs(profit))}\n` +
          `Bei ya ununuzi: $${fmt(info.buyPrice)}\n` +
          `Bei ya kufunga: $${Number.isFinite(sellPrice) ? fmt(sellPrice) : 'N/A'}\n` +
          `🆔 Contract ID: ${contractId}`
      );

      // Matokeo (profit/loss) kwa group lililochaguliwa kwenye dashboard (ikiwa imewashwa).
      signalTargets.sendResult(
        'deriv',
        `${won ? '✅ *WIN*' : '🔴 *LOSS*'} — ${info.code} ${info.direction}\n` +
          `💵 ${won ? '+' : '-'}$${fmt(Math.abs(profit))}`
      ).catch(() => {});

      // Kikomo cha hasara ya SIKU (UTC) — kinapewa kipaumbele juu ya
      // "consecutive losses" (havichanganywi — kimoja tu kwa wakati mmoja).
      if (dailyPnL <= -MAX_DAILY_LOSS_USD && pauseReason !== 'daily_loss_limit') {
        pausedUntil = endOfUtcDay(Date.now());
        pauseReason = 'daily_loss_limit';
        await notify(
          `🛑 *AUTO-TRADE IMESIMAMISHWA KWA LEO*\n\n` +
            `Hasara ya jumla ya leo imefika $${fmt(Math.abs(dailyPnL))} (kikomo: $${fmt(MAX_DAILY_LOSS_USD)}).\n` +
            `Bot HAITAFUNGUA trade mpya hadi saa 24 UTC ijayo. Trades zilizo wazi tayari haziguswi na zitaendelea kufunga zenyewe (SL/TP).`
        );
      } else if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES && !pauseReason) {
        pausedUntil = Date.now() + COOLDOWN_MS;
        pauseReason = 'consecutive_losses';
        consecutiveLosses = 0; // anza kuhesabu upya baada ya cooldown kwisha
        await notify(
          `🛑 *AUTO-TRADE IMESIMAMISHWA KWA MUDA*\n\n` +
            `Hasara ${MAX_CONSECUTIVE_LOSSES} mfululizo bila FAIDA katikati — inaashiria soko ` +
            `halilingani na signal yetu wakati huu. Bot inasimama kwa saa ${Math.round(COOLDOWN_MS / 3600000)} ` +
            `kabla ya kuendelea kufungua trade mpya.`
        );
      }
    } else {
      await notify(
        `ℹ️ *AUTO-TRADE IMEFUNGWA — ${info.code}*\n(Imeshindwa kupata faida/hasara halisi hata baada ya kuangalia historia ya transactions — angalia .positions au Deriv moja kwa moja.)\n🆔 Contract ID: ${contractId}`
      );
    }
  }
}

let cycleInterval = null;
let pollInterval = null;
let starting = false; // guard dhidi ya kuanza mara mbili wakati restore ya DB (async) bado inaendelea

/**
 * Anzisha auto-trading. Itwe MARA MOJA tu, connection ya WhatsApp ikiwa
 * tayari "open" (mfano index.js, ndani ya connection.update === 'open').
 */
function start({ sock, notifyJid }) {
  if (!ENABLED) {
    // Usirudi mapema: ufuatiliaji wa trades zilizo wazi (kurekodi zilizofungwa, trailing, profit lock) lazima ufanye kazi
    // hata auto-trade ikiwa OFF. Kufungua trades mpya kunadhibitiwa na swichi (AUTO_ON) — inaweza kuwashwa kwenye dashboard.
    console.log('[autoTrader] AUTO_TRADE_ENABLED si "true" — kufungua trades mpya kumezimwa (washa kwenye dashboard); ufuatiliaji unaendelea.');
  }
  // Sasisha socket/owner DAIMA, hata ikiwa tayari imeanzishwa: WhatsApp ikiunganishwa upya `sock` ni kitu
  // KIPYA. Kikibaki cha zamani, arifa zote (SL/TP zilizofungwa n.k.) zinashindwa kimya.
  if (sock) waSock = sock;
  if (notifyJid) ownerJid = notifyJid;
  if (cycleInterval || starting) {
    setTimeout(() => flushPendingNotifs().catch(() => {}), 2000);
    return; // tayari imeanzishwa (mfano baada ya reconnect)
  }

  waSock = sock;
  ownerJid = notifyJid;
  startedAt = Date.now();
  starting = true;

  console.log(
    `[autoTrader] ✅ Auto-trading IMEWASHWA — jozi: ${PAIRS.map((p) => p.code).join(', ')}, ` +
      `kila dakika ${Math.round(CHECK_INTERVAL_MS / 60000)}, threshold: ${STRENGTH_THRESHOLD}%, ` +
      `stake: $${STAKE_USD}, multiplier: x${MULTIPLIER}, SL/TP: ATR×${SL_ATR_MULT}/ATR×${TP_ATR_MULT} ` +
      `(fallback ya dola fasta: $${FALLBACK_SL_USD}/$${FALLBACK_TP_USD}). ` +
      `Circuit breakers: max daily loss $${MAX_DAILY_LOSS_USD}, max ${MAX_CONSECUTIVE_LOSSES} hasara mfululizo ` +
      `(cooldown saa ${Math.round(COOLDOWN_MS / 3600000)}), max ${MAX_CONCURRENT_TRADES} trades wazi kwa wakati mmoja. ` +
      `Regime filter: ${REGIME_FILTER_ENABLED ? `ON (min PF ${REGIME_MIN_PROFIT_FACTOR}, bars ${REGIME_BACKTEST_BARS})` : 'OFF'}. ` +
      `Trailing stop: ${TRAILING_ENABLED ? `ON (breakeven @R${TRAIL_BREAKEVEN_TRIGGER_R}, profit-lock @R${TRAIL_PROFITLOCK_TRIGGER_R})` : 'OFF'}.`
  );

  // Kwanza rejesha trades zilizokuwa wazi kabla ya restart/redeploy hii
  // (kutoka database), kisha angalia MARA MOJA kama yoyote kati yake
  // tayari ilifungwa wakati bot ilikuwa imezimwa (reuse pollClosedTrades
  // iliyopo — hakuna logic mpya ya kuhesabu faida/hasara). Cycle ya kwanza
  // ya kuangalia signal mpya (runCycle) na interval zote HAZIANZI mpaka
  // hatua hii ikamilike, ili checkPairAndTrade isipate nafasi ya kufungua
  // trade "mpya" ya jozi ambayo kwa kweli tayari ina trade wazi.
  (async () => {
    await loadStakeOverrideFromDb();
    await loadTrailingOverrideFromDb();
    await loadAutoOnFromDb();
    await loadSrSettingsFromDb();
    await restoreOpenTradesFromDb();
    await pollClosedTrades();
    await adoptAllLivePositions();
  })()
    .catch((err) => console.error('[autoTrader] Imeshindwa kurejesha/kusasisha trades kutoka DB:', err.message))
    .finally(() => {
      starting = false;
      runCycle().catch((err) => console.error('[autoTrader] runCycle error:', err.message));
      cycleInterval = setInterval(() => {
        runCycle().catch((err) => console.error('[autoTrader] runCycle error:', err.message));
      }, CHECK_INTERVAL_MS);

      pollInterval = setInterval(() => {
        pollClosedTrades().catch((err) => console.error('[autoTrader] pollClosedTrades error:', err.message));
        checkSlProximity().catch((err) => console.error('[autoTrader] checkSlProximity error:', err.message));
        checkTrailingStops().catch((err) => console.error('[autoTrader] checkTrailingStops error:', err.message));
        checkWatchdog();
      }, POLL_CLOSED_MS);
    });
}

function stop() {
  if (cycleInterval) clearInterval(cycleInterval);
  if (pollInterval) clearInterval(pollInterval);
  cycleInterval = null;
  pollInterval = null;
}

/**
 * Muhtasari kamili wa hali ya sasa ya auto-trading — inatumika na
 * commands/utility/fxautostatus.js kuonyesha kama iko ON/OFF, jozi
 * zinazofuatiliwa, signal ya mwisho ya kila jozi, na trades wazi.
 */
// Akaunti ya Deriv ikibadilika (demo <-> real): futa ufuatiliaji wa trades za akaunti ya zamani (ziko salama
// kwenye DB na zinarudi ukirudi huko), pakia za akaunti mpya, na tumia circuit breaker ya akaunti hiyo.
// Trades za akaunti ya zamani ZISIPOONDOLEWA hapa, pollClosedTrades() ingeziona "hazipo" na kuzifunga kimakosa.
onAccountSwitched(async (newMode, prevMode) => {
  if (prevMode) pnlByMode[prevMode] = { dailyPnL, consecutiveLosses };
  const next = pnlByMode[newMode] || { dailyPnL: 0, consecutiveLosses: 0 };
  dailyPnL = next.dailyPnL;
  consecutiveLosses = next.consecutiveLosses;
  const dropped = openAutoTrades.size;
  openAutoTrades.clear();
  peakProfitPct.clear();
  closeMisses.clear();
  slAlertState.clear();
  liveCache = { at: 0, data: null };
  console.log(`[autoTrader] 🔄 Akaunti: ${prevMode || '?'} → ${newMode}. Trades ${dropped} za akaunti ya zamani zimeachwa kwenye DB (hazifuatiliwi sasa).`);
  await restoreOpenTradesFromDb();
  await pollClosedTrades();
  await adoptAllLivePositions();
});

function getStatus() {
  return {
    enabled: AUTO_ON,
    envEnabled: ENABLED,
    realMaxOpen: REAL_MAX_OPEN,
    accountMode: getAccountMode(),
    running: cycleInterval !== null,
    startedAt,
    lastCycleAt,
    checkIntervalMs: CHECK_INTERVAL_MS,
    dataSource: DATA_SOURCE, // 'deriv' | 'twelve' (kwa dashboard)
    twelveFallback: Boolean(process.env.TWELVE_DATA_API_KEY), // Twelve ipo kama mbadala wa Deriv?
    pollMs: POLL_CLOSED_MS,
    strengthThreshold: STRENGTH_THRESHOLD,
    htfInterval: HTF_INTERVAL,
    htfGate: HTF_GATE,
    dailyInterval: DAILY_INTERVAL,
    dailyGate: DAILY_GATE,
    stake: STAKE_USD,
    multiplier: MULTIPLIER,
    slAtrMult: SL_ATR_MULT,
    tpAtrMult: TP_ATR_MULT,
    srFilter: SR_FILTER,
    srMinRoomAtr: SR_MIN_ROOM_ATR,
    srAlerts: SR_ALERTS,
    slWarnPct: srAlerts.CFG.slWarnPct,
    slDangerPct: srAlerts.CFG.slDangerPct,
    fallbackSl: FALLBACK_SL_USD,
    fallbackTp: FALLBACK_TP_USD,
    pairs: PAIRS.map((p) => p.code),
    signals: PAIRS.map((p) => ({ code: p.code, ...(lastSignals.get(p.code) || {}) })),
    openTrades: [...openAutoTrades.entries()].map(([contractId, info]) => ({ contractId, ...info })),
    // Circuit breaker
    dailyPnL: Number(dailyPnL.toFixed(2)),
    consecutiveLosses,
    maxDailyLossUsd: MAX_DAILY_LOSS_USD,
    maxConsecutiveLosses: MAX_CONSECUTIVE_LOSSES,
    maxConcurrentTrades: MAX_CONCURRENT_TRADES,
    maxCurrencyExposure: MAX_CURRENCY_EXPOSURE,
    currencyExposure: computeCurrencyExposure([...openAutoTrades.values()]),
    isPaused: isPaused(),
    pausedUntil,
    pauseReason,
    // Trailing stop / breakeven-lock
    trailingEnabled: TRAILING_ENABLED,
    trailBreakevenTriggerR: TRAIL_BREAKEVEN_TRIGGER_R,
    trailProfitlockTriggerR: TRAIL_PROFITLOCK_TRIGGER_R,
    trailProfitlockR: TRAIL_PROFITLOCK_R,
    // Regime filter (walk-forward validation)
    regimeFilter: {
      enabled: REGIME_FILTER_ENABLED,
      minProfitFactor: REGIME_MIN_PROFIT_FACTOR,
      minTrades: REGIME_MIN_TRADES,
      backtestBars: REGIME_BACKTEST_BARS,
      checkIntervalMs: REGIME_CHECK_INTERVAL_MS,
    },
  };
}

// Inaitwa mara moja kwenye start(): ingiza kwenye ufuatiliaji trades ZOTE za jozi zetu zilizo wazi
// Deriv (zilizofunguliwa kwa mkono, au zilizofungwa kimakosa kwenye DB) KABLA ya cycle ya kwanza,
// ili auto-trader isifungue nyingine kwa jozi hizo.
async function adoptAllLivePositions() {
  let live;
  try {
    live = await getOpenPositions();
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kusoma positions za Deriv wakati wa kuanza:', err.message);
    return 0;
  }
  let n = 0;
  for (const p of live) {
    const id = String(p.contract_id);
    if (openAutoTrades.has(id)) continue;
    if (newsTrader.isNewsContract(id)) continue; // trade ya News Trading
    const code = String(p.symbol || '').replace(/^frx/i, '').toUpperCase();
    if (!PAIRS.some((x) => x.code === code)) continue; // si jozi ya FX yetu
    const info = {
      code,
      symbol: p.symbol,
      direction: /up/i.test(p.contract_type || '') ? 'BUY' : 'SELL',
      stake: Number(p.buy_price) || 0,
      buyPrice: Number(p.buy_price),
      openedAt: Number(p.purchase_time) ? Number(p.purchase_time) * 1000 : Date.now(),
      slUsd: null, // haijulikani — trailing itaipuuza
      tpUsd: null,
    };
    openAutoTrades.set(id, info);
    await dbSaveOpenTrade({ contractId: id, ...info });
    await dbReopenTrade(id);
    n++;
  }
  if (n) console.log(`[autoTrader] ✅ Trades ${n} zilizo wazi Deriv zimeingizwa kwenye ufuatiliaji wakati wa kuanza (hazitafunguliwa upya).`);
  return n;
}

// ── Kufungua trade KWA MKONO (dashboard / .fxbuy / .fxsell) ─────────────────
// Njia moja salama: inazuia trade ya pili kwa jozi ambayo bado ina trade wazi (kwa kuangalia Deriv
// moja kwa moja), inazuia kubonyeza mara mbili, na inaandikisha trade kwenye ufuatiliaji + database
// ili ipone redeploy na auto-trader isiifungue upya.
// ── Ulinzi wa correlation: zuia trade ya mkono yenye wazo lilelile ───────────
// BUY AAABBB = A imara (+A), B dhaifu (-B). SELL AAABBB = A dhaifu (-A), B imara (+B).
// Trade mpya inagongana na iliyo wazi ikiwa zinashiriki currency MOJA upande ULEULE
// (mfano SELL EURJPY + SELL EURUSD = zote "EUR dhaifu").
const corrError = (msg, conflicts) => Object.assign(new Error(msg), { code: 'CORRELATED_OPEN', conflicts });

function pairExposure(code, dir) {
  const c = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (c.length !== 6) return null;
  const a = c.slice(0, 3);
  const b = c.slice(3);
  return dir === 'SELL' ? { [a]: -1, [b]: 1 } : { [a]: 1, [b]: -1 };
}

function positionDirection(p) {
  const t = String(p?.contract_type || '').toUpperCase();
  if (t.includes('DOWN')) return 'SELL';
  if (t.includes('UP')) return 'BUY';
  return null;
}

function findCorrelatedOpen(code, dir, live) {
  const mine = pairExposure(code, dir);
  if (!mine) return [];
  const out = [];
  for (const p of live || []) {
    const pCode = String(p.symbol || '').replace(/^frx/i, '').toUpperCase();
    const pDir = positionDirection(p);
    const theirs = pDir ? pairExposure(pCode, pDir) : null;
    if (!theirs) continue;
    const shared = Object.keys(mine).filter((cur) => theirs[cur] && theirs[cur] === mine[cur]);
    if (shared.length) {
      out.push({
        pair: pCode,
        direction: pDir,
        contractId: p.contract_id,
        shared: shared.map((cur) => `${cur} ${mine[cur] < 0 ? 'dhaifu' : 'imara'}`),
      });
    }
  }
  return out;
}

function correlatedMessage(code, dir, conflicts) {
  return (
    `${dir} ${code} imezuiwa: inaongeza hatari kwenye wazo lilelile la trade zilizo wazi:\n` +
    conflicts.map((c) => `• ${c.direction} ${c.pair} (${c.shared.join(', ')})`).join('\n') +
    `\nFunga trade hizo kwanza au chagua pair isiyohusiana.`
  );
}

// Trades wazi za Deriv + zile zilizofunguliwa sekunde chache zilizopita (portfolio inaweza kuchelewa).
async function getLiveWithRecent() {
  const live = await getOpenPositions();
  const seen = new Set(live.map((p) => p.symbol));
  return live.concat(getRecentOpens().filter((r) => !seen.has(r.symbol)));
}

// Kwa dashboard: angalia KABLA ya kufungua (haifungui kitu).
async function checkCorrelatedExposure(pair, direction) {
  const code = String(pair || '').toUpperCase().replace(/[^A-Z]/g, '');
  const dir = direction === 'SELL' ? 'SELL' : 'BUY';
  const live = await getLiveWithRecent();
  const same = live.filter((p) => p.symbol === toDerivSymbol(code));
  if (same.length) {
    const dirs = same.map((p) => positionDirection(p) || '?').join(', ');
    return {
      pair: code, direction: dir, conflicts: [], samePair: true,
      message: `${code} tayari ina trade WAZI (${dirs}) — haiwezi kufunguliwa nyingine (hata kwa mwelekeo tofauti) hadi ifungwe.`,
    };
  }
  const conflicts = findCorrelatedOpen(code, dir, live);
  return { pair: code, direction: dir, conflicts, message: conflicts.length ? correlatedMessage(code, dir, conflicts) : '' };
}

const manualLock = { busy: false, recent: new Map() };
const dupError = (msg) => Object.assign(new Error(msg), { code: 'DUPLICATE_OPEN' });

async function placeManualTrade({ pair, direction, stake, stopLoss, takeProfit, multiplier, slPips, tpPips, allowDuplicate = false, allowCorrelated = false }) {
  const code = String(pair || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!code) throw new Error('Jozi (pair) inahitajika.');
  const dir = direction === 'SELL' ? 'SELL' : 'BUY';
  const key = `${code}|${dir}`;

  if (manualLock.busy) throw dupError('Order nyingine ya mkono inashughulikiwa — subiri sekunde chache.');
  if (Date.now() - (manualLock.recent.get(key) || 0) < 8000) {
    throw dupError('Order inayofanana ilifunguliwa sekunde chache zilizopita — imezuiwa kuzuia marudio.');
  }
  manualLock.busy = true;
  try {
    if (!allowDuplicate) {
      let live;
      try {
        live = await getLiveWithRecent();
      } catch (err) {
        throw new Error(`Imeshindwa kuthibitisha trades wazi za Deriv (${err.message}) — jaribu tena.`);
      }
      const derivSymbol = toDerivSymbol(code);
      if (live.some((p) => p.symbol === derivSymbol)) {
        throw dupError(`${code} tayari ina trade WAZI kwenye Deriv — haifunguliwi nyingine hadi ifungwe.`);
      }
      const conflicts = findCorrelatedOpen(code, dir, live);
      if (conflicts.length && !allowCorrelated) throw corrError(correlatedMessage(code, dir, conflicts), conflicts);
    }
    // Pips zikitolewa, zibadilishe kuwa dola (kwa bei ya sasa) kabla ya kutuma Deriv.
    const lim = await resolveManualLimits({ code, stake, multiplier, stopLoss, takeProfit, slPips, tpPips });
    stopLoss = lim.stopLoss; takeProfit = lim.takeProfit;
    manualLock.recent.set(key, Date.now());
    const result = await placeMultiplier({ pair: code, direction: dir, stake, stopLoss, takeProfit, multiplier });

    try {
      const info = {
        code,
        symbol: toDerivSymbol(code),
        direction: dir,
        stake: Number(stake) || Number(result.buy_price) || 0,
        buyPrice: Number(result.buy_price),
        openedAt: Date.now(),
        slUsd: null, // trade ya mkono — trailing haigusi SL/TP ulizoweka
        tpUsd: null,
      };
      openAutoTrades.set(String(result.contract_id), info);
      await dbSaveOpenTrade({ contractId: String(result.contract_id), ...info });
    } catch (err) {
      console.error('[autoTrader] Imeshindwa kuandikisha trade ya mkono (trade yenyewe imefunguliwa):', err.message);
    }
    try {
      const { text } = await buildTradeEstimate({
        code, direction: dir, stake: Number(stake) || Number(result.buy_price) || 0,
        multiplier: Number(multiplier) || MULTIPLIER,
        slUsd: Number.isFinite(result.stop_loss) ? result.stop_loss : Number(stopLoss),
        tpUsd: Number.isFinite(result.take_profit) ? result.take_profit : Number(takeProfit),
        contractId: result.contract_id, commission: result.commission,
      });
      result.estimateText = text; // dashboard/commands wanaiongeza kwenye arifa
    } catch (err) {
      console.error('[autoTrader] Makadirio ya trade ya mkono yameshindwa:', err.message);
    }
    return result;
  } finally {
    manualLock.busy = false;
  }
}

module.exports = {
  start,
  stop,
  getStatus,
  setStakeUsd,
  setTrailingEnabled,
  setSrFilter,
  setSrAlerts,
  setAutoEnabled,
  placeManualTrade,
  previewManualTrade,
  checkCorrelatedExposure,
  getWinRateStats,
  getTradeHistory,
  getTradeSummary,
  previewClearHistory,
  clearHistory,
  countLegacyTrades,
  assignLegacyTrades,
  recordClosedFromDashboard,
  reconcileHistoryFromDeriv,
  checkSlProximity, // onyo la trade kukaribia SL (inaitwa kila POLL_CLOSED_MS; pia inajaribika kwa mkono)
  PAIRS,
  STRENGTH_THRESHOLD,
  openAutoTrades,
  // Kwa ajili ya utils/backtest.js — formula HII HII inatumika live, ili
  // matokeo ya backtest yaendane na kile bot inachofanya kweli.
  computeAtrBasedRisk,
  // Kwa injini ya auto-trade ya wateja (utils/derivCustomerAuto.js) — cache ileile ya regime filter inashirikiwa.
  checkRegimeFilter,
};
