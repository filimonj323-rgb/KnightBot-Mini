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
 *   AUTO_TRADE_POLL_MS              — muda kati ya ukaguzi wa trade zilizofungwa (default: dakika 5)
 *   AUTO_TRADE_STRENGTH_THRESHOLD   — asilimia ya chini ya signal (default: 67)
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
 *     nyingi zinatoa signal wakati mmoja (default: idadi ya PAIRS, yaani 7)
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

const { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL } = require('./forexSignal');
const {
  placeMultiplier,
  getOpenPositions,
  getOpenPositionsLive,
  updateContractLimits,
  getContractDetails,
  getClosedContractFromHistory,
  ALLOWED_MULTIPLIERS,
  toDerivSymbol,
  MIN_STAKE_USD,
} = require('./derivTrader');
// Turso (libSQL) — tayari inatumika na pairing/server.js kwa users/payments;
// hapa tunatumia kuhifadhi openAutoTrades ili isipotee kila redeploy/restart
// (angalia restoreOpenTradesFromDb() chini — hii ndiyo fix ya tatizo la
// "auto-trade inafungua mara mbili kwa jozi ile ile baada ya redeploy").
const fxTradesDb = require('../pairing/db');

const ENABLED = String(process.env.AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';
const CHECK_INTERVAL_MS = Number(process.env.AUTO_TRADE_CHECK_INTERVAL_MS || 60 * 60 * 1000); // saa 1
const POLL_CLOSED_MS = Number(process.env.AUTO_TRADE_POLL_MS || 5 * 60 * 1000); // dakika 5
const STRENGTH_THRESHOLD = Number(process.env.AUTO_TRADE_STRENGTH_THRESHOLD || 67);

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
const PAIR_STAGGER_MS = Number(process.env.AUTO_TRADE_PAIR_STAGGER_MS || 70 * 1000); // sekunde 70

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
];

// ── Circuit breakers — hulinda dhidi ya hasara za mfululizo/kubwa mno ──
const MAX_DAILY_LOSS_USD = Number(process.env.AUTO_TRADE_MAX_DAILY_LOSS_USD || 15);
const MAX_CONSECUTIVE_LOSSES = Number(process.env.AUTO_TRADE_MAX_CONSECUTIVE_LOSSES || 3);
const COOLDOWN_MS = Number(process.env.AUTO_TRADE_COOLDOWN_MS || 4 * 60 * 60 * 1000); // saa 4
const MAX_CONCURRENT_TRADES = Number(process.env.AUTO_TRADE_MAX_CONCURRENT || PAIRS.length);

// Kikomo cha net exposure (units, si $) kwa currency MOJA kabla ya
// kuzuia trade mpya — angalia computeCurrencyExposure()/
// wouldExceedCorrelationLimit() chini. Default 1 = usiruhusu currency
// yoyote iwe na zaidi ya "upande mmoja" wa net exposure kwa wakati mmoja
// kutoka kwenye jozi zote zilizo wazi (auto + za mkono).
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
async function dbSaveOpenTrade({ contractId, code, symbol, direction, stake, buyPrice, slUsd, tpUsd, openedAt, signalStrength }) {
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `INSERT INTO fx_auto_trades (contractId, code, symbol, direction, stake, buyPrice, slUsd, tpUsd, openedAt, signalStrength)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contractId) DO UPDATE SET
         code=excluded.code, symbol=excluded.symbol, direction=excluded.direction,
         stake=excluded.stake, buyPrice=excluded.buyPrice, slUsd=excluded.slUsd,
         tpUsd=excluded.tpUsd, openedAt=excluded.openedAt,
         signalStrength=COALESCE(excluded.signalStrength, fx_auto_trades.signalStrength)`,
      [contractId, code, symbol, direction, stake, buyPrice ?? null, slUsd ?? null, tpUsd ?? null, openedAt, signalStrength ?? null]
    );
  } catch (err) {
    console.error('[autoTrader] DB: imeshindwa kuhifadhi trade mpya (inaendelea na RAM pekee):', err.message);
  }
}

async function dbMarkTradeClosed(contractId, { closedAt, sellPrice, profit }) {
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `UPDATE fx_auto_trades SET closedAt = ?, sellPrice = ?, profit = ? WHERE contractId = ?`,
      [closedAt, Number.isFinite(sellPrice) ? sellPrice : null, Number.isFinite(profit) ? profit : null, contractId]
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
async function getWinRateStats() {
  try {
    await fxTradesDb.initSchema();
    const result = await fxTradesDb.query(
      `SELECT signalStrength, profit FROM fx_auto_trades WHERE closedAt IS NOT NULL`
    );
    const rows = result.rows || [];

    const grouped = new Map(); // bucket -> { total, wins, totalProfit }
    for (const r of rows) {
      const strength = r.signalStrength === null || r.signalStrength === undefined ? null : Number(r.signalStrength);
      const bucket = bucketFor(strength);
      if (!bucket) continue; // trade iliyofunguliwa kwa mkono (bila signal) — haihesabiwi kwenye ubora wa signal
      const profit = Number(r.profit) || 0;
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

/**
 * Inaitwa kila POLL_CLOSED_MS (dakika chache), pamoja na pollClosedTrades()
 * — kwa kila trade iliyo WAZI TAYARI yenye slUsd inayojulikana (yaani
 * ilifunguliwa na signal yetu, si "adopted"), angalia profit ya SASA
 * (live) dhidi ya hatari ya awali (slUsd) na, kama R imefika kizingiti,
 * songa Stop Loss kwenye Deriv — KAMWE kuipeleka nyuma (ratchet moja tu
 * kuelekea usalama/faida zaidi).
 */
async function checkTrailingStops() {
  if (!TRAILING_ENABLED || openAutoTrades.size === 0) return;

  let livePositions;
  try {
    livePositions = await getOpenPositionsLive();
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
      openAutoTrades.set(contractId, info);
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
    const result = await fxTradesDb.query(
      'SELECT contractId, code, symbol, direction, stake, buyPrice, openedAt, slUsd, tpUsd FROM fx_auto_trades WHERE closedAt IS NULL'
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

function ensureDailyResetIfNewDay() {
  const key = utcDateKey(Date.now());
  if (key === dailyKey) return;
  dailyKey = key;
  dailyPnL = 0;
  consecutiveLosses = 0;
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

async function notify(text) {
  if (!waSock || !ownerJid) return;
  try {
    await waSock.sendMessage(ownerJid, { text });
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kutuma notification:', err.message);
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

async function checkPairAndTrade(pairInfo) {
  const { code, symbol } = pairInfo;

  // Circuit breaker: hasara ya siku au mfululizo imefika kikomo — usifungue
  // trade mpya (trades zilizo wazi tayari haziguswi, zinaendelea Deriv).
  if (isPaused()) return;

  // Zuia trades wazi nyingi mno kwa wakati mmoja (exposure kubwa).
  if (openAutoTrades.size >= MAX_CONCURRENT_TRADES) return;

  // Zuia kufungua trade nyingine kwa jozi ile ile wakati moja tayari iko wazi.
  const alreadyOpen = [...openAutoTrades.values()].some((t) => t.code === code);
  if (alreadyOpen) return;

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
    livePosition = livePositions.find((p) => p.symbol === derivSymbol);
  } catch (err) {
    console.error(
      `[autoTrader] ${code}: imeshindwa kuangalia positions za Deriv moja kwa moja (inaendelea na ukaguzi wa ndani pekee):`,
      err.message
    );
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
    console.log(
      `[autoTrader] ${code}: trade wazi tayari ipo kwenye Deriv (imefunguliwa kwa mkono/chanzo kingine) — ` +
        `imeandikishwa (adopted) 🆔 ${livePosition.contract_id}, auto-trader haitafungua nyingine mzunguko huu.`
    );
    return;
  }

  let snapshot, sig;
  try {
    snapshot = await fetchForexSnapshot(symbol, DEFAULT_INTERVAL);
    sig = computeSignal(snapshot);
  } catch (err) {
    console.error(`[autoTrader] Imeshindwa kupata signal ya ${code}:`, err.message);
    lastSignals.set(code, { error: err.message, checkedAt: Date.now() });
    return;
  }

  lastSignals.set(code, {
    direction: sig.direction,
    strength: sig.strength,
    price: snapshot.price,
    atr: snapshot.atr,
    notes: sig.notes,
    checkedAt: Date.now(),
  });

  if (sig.direction === 'NEUTRAL' || sig.strength < STRENGTH_THRESHOLD) return;

  // Habari kubwa (High impact) iko karibu (dakika NEWS_RISK_WINDOW_MIN
  // kabla/baada — angalia utils/economicCalendar.js) — spread/slippage
  // huongezeka sana wakati huu, si wakati salama wa kufungua trade mpya
  // hata kama technicals zinaonekana nzuri. Trade zilizo wazi TAYARI
  // haziguswi (SL/TP zake zinaendelea Deriv) — hii inazuia trade MPYA tu.
  if (sig.newsRisk) {
    console.log(`[autoTrader] ${code}: skip — habari kubwa (High impact) iko karibu.`);
    return;
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
    return;
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
    return;
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
    openAutoTrades.set(result.contract_id, {
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
        (sig.notes.length ? `🧠 Sababu:\n${sig.notes.map((n) => `   • ${n}`).join('\n')}\n\n` : '') +
        `⚠️ Trade hii ilifunguliwa KIOTOMATIKO kutokana na signal. Hii SI ushauri wa kifedha.`
    );
  } catch (err) {
    console.error(`[autoTrader] Imeshindwa kufungua trade ${code}:`, err.message);
    await notify(`❌ Bot imeshindwa kufungua auto-trade ya ${code}: ${err.message}`);
  }
}

async function runCycle() {
  for (let i = 0; i < PAIRS.length; i++) {
    if (i > 0) await sleep(PAIR_STAGGER_MS); // epuka 429 (kikomo cha Twelve Data)
    try {
      await checkPairAndTrade(PAIRS[i]);
    } catch (err) {
      // MUHIMU: jozi MOJA ikitupa error isiyoshikwa (mfano Deriv "zombie"
      // connection — inaonekana bado open lakini haijibu, hivyo kila ombi
      // linangoja sekunde 15 kisha ku-timeout), HATUACHI mzunguko mzima
      // usimame hapo — vinginevyo jozi zilizobaki hazikaguliwi kabisa
      // ("bot imelala"), na lastCycleAt haisasishwi kamwe ikiwa tatizo
      // lilelile linajirudia kila mzunguko (watchdog haisaidii kama huu
      // ndio unaotupa error kila wakati badala ya ku-hang kimya kimya).
      console.error(`[autoTrader] runCycle: ${PAIRS[i].code} imeshindwa, inaendelea na jozi zingine:`, err.message);
    }
  }
  lastCycleAt = Date.now();
  lastWatchdogAlertAt = null; // cycle imefanikiwa — rudisha "kimya" kwa tatizo lijalo
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
  const reference = lastCycleAt || startedAt;
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

async function pollClosedTrades() {
  if (openAutoTrades.size === 0) return;

  let openIds;
  try {
    const positions = await getOpenPositions();
    openIds = new Set(positions.map((p) => p.contract_id));
  } catch (err) {
    console.error('[autoTrader] Imeshindwa kuangalia positions:', err.message);
    return;
  }

  for (const [contractId, info] of [...openAutoTrades.entries()]) {
    if (openIds.has(contractId)) continue; // bado wazi

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
    console.log('[autoTrader] AUTO_TRADE_ENABLED si "true" — auto-trading imezimwa.');
    return;
  }
  if (cycleInterval || starting) return; // tayari imeanzishwa (mfano baada ya reconnect)

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
    await restoreOpenTradesFromDb();
    await pollClosedTrades();
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
function getStatus() {
  return {
    enabled: ENABLED,
    running: cycleInterval !== null,
    startedAt,
    lastCycleAt,
    checkIntervalMs: CHECK_INTERVAL_MS,
    pollMs: POLL_CLOSED_MS,
    strengthThreshold: STRENGTH_THRESHOLD,
    stake: STAKE_USD,
    multiplier: MULTIPLIER,
    slAtrMult: SL_ATR_MULT,
    tpAtrMult: TP_ATR_MULT,
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

module.exports = {
  start,
  stop,
  getStatus,
  setStakeUsd,
  setTrailingEnabled,
  getWinRateStats,
  PAIRS,
  STRENGTH_THRESHOLD,
  openAutoTrades,
  // Kwa ajili ya utils/backtest.js — formula HII HII inatumika live, ili
  // matokeo ya backtest yaendane na kile bot inachofanya kweli.
  computeAtrBasedRisk,
};
