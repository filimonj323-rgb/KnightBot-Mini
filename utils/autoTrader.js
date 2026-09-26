/**
 * autoTrader.js — Auto-trading kiotomatiki kwa jozi tatu maarufu zaidi za
 * forex (EUR/USD, GBP/USD, USD/JPY), kila saa moja, kwa kutumia signal
 * ile ile ya utils/forexSignal.js (EMA9/EMA21, RSI14, MACD).
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
 *     nyingi zinatoa signal wakati mmoja (default: idadi ya PAIRS, yaani 3)
 *
 * Trades wazi TAYARI hazighairishwi na circuit breaker — SL/TP zake
 * zinaendelea kufanya kazi Deriv kama kawaida; kinachosimama ni KUFUNGUA
 * trade MPYA tu.
 */

const { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL } = require('./forexSignal');
const {
  placeMultiplier,
  getOpenPositions,
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
];

// ── Circuit breakers — hulinda dhidi ya hasara za mfululizo/kubwa mno ──
const MAX_DAILY_LOSS_USD = Number(process.env.AUTO_TRADE_MAX_DAILY_LOSS_USD || 15);
const MAX_CONSECUTIVE_LOSSES = Number(process.env.AUTO_TRADE_MAX_CONSECUTIVE_LOSSES || 3);
const COOLDOWN_MS = Number(process.env.AUTO_TRADE_COOLDOWN_MS || 4 * 60 * 60 * 1000); // saa 4
const MAX_CONCURRENT_TRADES = Number(process.env.AUTO_TRADE_MAX_CONCURRENT || PAIRS.length);

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

// contract_id -> { code, symbol, direction, stake, buyPrice, openedAt }
const openAutoTrades = new Map();
// code -> { direction, strength, price, atr, notes, checkedAt }
const lastSignals = new Map();

// ── Uhifadhi wa openAutoTrades kwenye database (Turso) ──────────────────
// Map ya RAM (openAutoTrades) pekee ilikuwa ikifutwa kila redeploy/restart
// ya Railway, hivyo baada ya redeploy bot "ilisahau" kwamba tayari ina
// trade wazi kwa jozi fulani na kufungua NYINGINE kwa jozi ile ile signal
// ikionekana nzuri tena. Kazi hizi zinasoma/kuandika DB ili historia ya
// trades ZILIZO WAZI iendelee kuwepo hata bot ikizima kabisa. DB
// isipopatikana (Turso haijawekwa), kazi hizi zinashindwa kimya kimya
// (bot inaendelea kufanya kazi na Map ya RAM pekee, kama awali).
async function dbSaveOpenTrade({ contractId, code, symbol, direction, stake, buyPrice, slUsd, tpUsd, openedAt }) {
  try {
    await fxTradesDb.initSchema();
    await fxTradesDb.query(
      `INSERT INTO fx_auto_trades (contractId, code, symbol, direction, stake, buyPrice, slUsd, tpUsd, openedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contractId) DO UPDATE SET
         code=excluded.code, symbol=excluded.symbol, direction=excluded.direction,
         stake=excluded.stake, buyPrice=excluded.buyPrice, slUsd=excluded.slUsd,
         tpUsd=excluded.tpUsd, openedAt=excluded.openedAt`,
      [contractId, code, symbol, direction, stake, buyPrice ?? null, slUsd ?? null, tpUsd ?? null, openedAt]
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
      'SELECT contractId, code, symbol, direction, stake, buyPrice, openedAt FROM fx_auto_trades WHERE closedAt IS NULL'
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
  let livePosition;
  try {
    const derivSymbol = toDerivSymbol(code);
    const livePositions = await getOpenPositions();
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
    await checkPairAndTrade(PAIRS[i]);
  }
  lastCycleAt = Date.now();
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
      `(cooldown saa ${Math.round(COOLDOWN_MS / 3600000)}), max ${MAX_CONCURRENT_TRADES} trades wazi kwa wakati mmoja.`
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
    isPaused: isPaused(),
    pausedUntil,
    pauseReason,
  };
}

module.exports = { start, stop, getStatus, setStakeUsd, PAIRS, STRENGTH_THRESHOLD, openAutoTrades };
