/**
 * newsTrader.js — News Trading kutokana na Economic Calendar (Deriv Multipliers).
 *
 * MKAKATI (post-release surprise, si "straddle" kabla ya habari):
 *   1) Tukio la High impact (hiari: Medium pia) linatoka na lina `actual` + `forecast` za namba.
 *   2) Tunalinganisha actual dhidi ya forecast (viashiria vya "chini ni bora" kama Unemployment vinageuzwa).
 *      Surprise lazima izidi `minSurprisePct` ili iwe na maana.
 *   3) Matukio kadhaa ya currency moja kwa dakika ile ile (mfano NFP + Unemployment + Earnings) yanahesabiwa
 *      pamoja; yakipingana (idadi sawa bullish/bearish) hatufanyi trade.
 *   4) Currency ikiimarika → BUY jozi ambayo ni base yake / SELL ambayo ni quote (na kinyume chake).
 *   5) Trade inafunguliwa na SL/TP (asilimia ya stake) + KUFUNGWA KWA MUDA (maxHoldMin) kwa sababu
 *      mwendo wa habari huisha haraka.
 *
 * USALAMA (zote ziko ndani ya code, si hiari):
 *   - Default ni IMEZIMWA. REAL inahitaji kuruhusiwa waziwazi (allowReal).
 *   - Kikomo cha trades wazi (maxOpen) na hasara ya siku (maxDailyLossUsd, kwa akaunti ya sasa, kutoka DB).
 *   - Hakuna trade kwa jozi ambayo tayari ina position yoyote wazi Deriv (auto/mkono/habari).
 *   - Kila tukio linashughulikiwa MARA MOJA tu (fx_news_events) — restart haitarudia.
 *   - Trades za habari zina table yake (fx_news_trades) — haziingii stats za auto-trader.
 *
 * ⚠️ Mipaka inayojulikana: data ya `actual` inatoka kwenye feed ya bure ya ForexFactory, ambayo inaweza
 * kuchelewa dakika chache baada ya release; bei inaweza kuwa imeshasogea kabla hatujaingia. Slippage/spread
 * wakati wa habari ni kubwa. Hii SI ushauri wa kifedha — anza na DEMO.
 */

const db = require('../pairing/db');
const economicCalendar = require('./economicCalendar');
const {
  placeMultiplier,
  getOpenPositions,
  getClosedContractFromHistory,
  closeContractWithPnL,
  getAccountMode,
  getAccountState,
  ALLOWED_MULTIPLIERS,
  MIN_STAKE_USD,
  MAX_STAKE_USD,
} = require('./derivTrader');

const TICK_MS = Math.max(5000, Number(process.env.NEWS_TRADE_TICK_MS || 15000));
const SETTLE_MIN = 3;                 // subiri hadi dakika 3 ili matukio yote ya kundi yapate `actual`
const FRESH_FEED_MS = 60 * 1000;      // wakati wa release, lazimisha feed isiyozidi dakika 1 (si cache ya dakika 15)
const MAX_MISSES = 40;                // ticks (~10 min) za kusubiri profit_table kabla ya kuweka "unknown"

// Currency → jozi inayotumika kuifanyia trade (zote ziko kwenye PAIRS za auto-trader / FX_SYMBOL_MAP).
const CURRENCY_PAIR = {
  USD: 'EURUSD',
  EUR: 'EURUSD',
  GBP: 'GBPUSD',
  JPY: 'USDJPY',
  AUD: 'AUDUSD',
  CAD: 'USDCAD',
  CHF: 'USDCHF',
  NZD: 'NZDUSD',
};
const CURRENCIES = Object.keys(CURRENCY_PAIR);

const DEFAULTS = {
  enabled: false,
  stake: 1,
  multiplier: 100,
  slPct: 50,          // SL = % ya stake
  tpPct: 100,         // TP = % ya stake
  maxHoldMin: 15,     // funga kwa muda kama SL/TP hazijafikiwa
  minSurprisePct: 10, // |actual-forecast| / |forecast| kwa asilimia
  windowMin: 10,      // dirisha la dakika baada ya release ambalo bado tunaingia
  maxOpen: 2,
  maxDailyLossUsd: 5,
  allowReal: false,
  includeMedium: false,
};

let cfg = { ...DEFAULTS };
let cfgLoaded = false;
let waSock = null;
let ownerJid = null;
let timer = null;
let ticking = false;
let starting = false;
let lastBlocked = null;               // sababu ya sasa ya kutofanya trade (kwa dashboard)
let lastTickAt = 0;
const handled = new Set();            // eventKey zilizoshughulikiwa
const newsContractIds = new Set();    // contract IDs zote za habari (auto-trader inazipuuza)
const missCount = new Map();          // contractId -> ticks bila kupata data ya kufungwa
const decisions = [];                 // ring buffer ya maamuzi ya mwisho (kwa dashboard)

function isNewsContract(id) { return newsContractIds.has(String(id)); }

function pushDecision(level, text, extra = {}) {
  decisions.unshift({ at: Date.now(), level, text, ...extra });
  if (decisions.length > 40) decisions.length = 40;
}

async function notify(text) {
  if (!waSock || !ownerJid) return;
  try { await waSock.sendMessage(ownerJid, { text }); }
  catch (err) { console.error('[newsTrader] Imeshindwa kutuma notification:', err.message); }
}

// ── Config (inahifadhiwa kama JSON kwenye fx_auto_settings, key "news_config") ─────────────────
function num(v, name, min, max, int = false) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new Error(`${name} lazima iwe ${int ? 'namba kamili ' : ''}kati ya ${min} na ${max}.`);
  }
  return n;
}

function validateConfig(input) {
  const c = { ...DEFAULTS, ...input };
  const out = {
    enabled: c.enabled === true,
    stake: num(c.stake, 'Stake', MIN_STAKE_USD, Math.min(MAX_STAKE_USD, 1000)),
    multiplier: Number(c.multiplier),
    slPct: num(c.slPct, 'Stop Loss (%)', 10, 100),
    tpPct: num(c.tpPct, 'Take Profit (%)', 10, 500),
    maxHoldMin: num(c.maxHoldMin, 'Muda wa juu (dakika)', 1, 120, true),
    minSurprisePct: num(c.minSurprisePct, 'Surprise ya chini (%)', 1, 500),
    windowMin: num(c.windowMin, 'Dirisha baada ya release (dakika)', 1, 30, true),
    maxOpen: num(c.maxOpen, 'Trades wazi za juu', 1, 5, true),
    maxDailyLossUsd: num(c.maxDailyLossUsd, 'Hasara ya juu ya siku ($)', 1, 1000),
    allowReal: c.allowReal === true,
    includeMedium: c.includeMedium === true,
  };
  if (!ALLOWED_MULTIPLIERS.includes(out.multiplier)) {
    throw new Error(`Multiplier lazima iwe mojawapo ya: ${ALLOWED_MULTIPLIERS.join(', ')}.`);
  }
  return out;
}

async function loadConfig() {
  try {
    await db.initSchema();
    const r = await db.query('SELECT settingValue FROM fx_auto_settings WHERE settingKey = ?', ['news_config']);
    const raw = r.rows && r.rows[0] && r.rows[0].settingValue;
    if (raw) cfg = validateConfig(JSON.parse(raw));
  } catch (err) {
    console.error('[newsTrader] Config ya DB haikusomeka, natumia default (IMEZIMWA):', err.message);
    cfg = { ...DEFAULTS };
  }
  cfgLoaded = true;
}

async function setConfig(patch = {}) {
  if (!cfgLoaded) await loadConfig();
  const next = validateConfig({ ...cfg, ...patch });
  await db.initSchema();
  const now = Date.now();
  await db.query(
    `INSERT INTO fx_auto_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
    ['news_config', JSON.stringify(next), now]
  );
  const wasEnabled = cfg.enabled;
  cfg = next;
  if (wasEnabled !== next.enabled) pushDecision('info', next.enabled ? '▶️ News Trading IMEWASHWA' : '⏹️ News Trading IMEZIMWA');
  return cfg;
}

// ── Msaada ───────────────────────────────────────────────────────────────────────────────────
const r2 = (n) => Math.round(Number(n) * 100) / 100;
function startOfUtcDay(ts) { const d = new Date(ts); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }

function pairDirection(currency, bullish) {
  const code = CURRENCY_PAIR[currency];
  if (!code) return null;
  const isBase = code.slice(0, 3) === currency;
  return { pair: code, direction: bullish === isBase ? 'BUY' : 'SELL' };
}

async function resolveMode() {
  let m = getAccountMode();
  if (!m) { try { await getAccountState(); } catch (_) { /* hakuna */ } m = getAccountMode(); }
  return m || null;
}

async function markHandled(key, outcome, detail = '') {
  handled.add(key);
  try {
    await db.query(
      `INSERT INTO fx_news_events (eventKey, handledAt, outcome, detail) VALUES (?, ?, ?, ?)
       ON CONFLICT(eventKey) DO NOTHING`,
      [key, Date.now(), outcome, String(detail).slice(0, 500)]
    );
  } catch (err) { console.error('[newsTrader] markHandled imeshindwa:', err.message); }
}

// ── Kuchambua kundi la matukio (currency moja, dakika moja) ───────────────────────────────────
function buildGroups(events, now) {
  const impacts = cfg.includeMedium ? ['high', 'medium'] : ['high'];
  const groups = new Map();
  for (const e of events || []) {
    if (!impacts.includes(String(e.impact).toLowerCase())) continue;
    if (!CURRENCY_PAIR[e.country]) continue;
    const t = new Date(e.date).getTime();
    if (!Number.isFinite(t)) continue;
    const ageMin = (now - t) / 60000;
    if (ageMin < 0 || ageMin > cfg.windowMin) continue;
    const key = `${e.country}|${new Date(t).toISOString().slice(0, 16)}`;
    if (!groups.has(key)) groups.set(key, { key, currency: e.country, t, ageMin, events: [] });
    groups.get(key).events.push(e);
  }
  return [...groups.values()];
}

function hasValue(v) { return v !== null && v !== undefined && v !== ''; }

/** @returns {{state:'pending'|'done'|'trade', ...}} */
function evaluateGroup(g) {
  const withForecast = g.events.filter((e) => economicCalendar.parseNumeric(e.forecast) != null);
  if (!withForecast.length) return { state: 'done', outcome: 'no_numbers', text: 'hakuna forecast ya namba (hotuba/taarifa) — imepuuzwa' };

  const allHaveActual = withForecast.every((e) => hasValue(e.actual) && economicCalendar.parseNumeric(e.actual) != null);
  if (!allHaveActual && g.ageMin < SETTLE_MIN) return { state: 'pending' };

  const usable = withForecast.filter((e) => economicCalendar.parseNumeric(e.actual) != null);
  if (!usable.length) return { state: 'pending' }; // bado hakuna actual — subiri hadi dirisha liishe

  let net = 0;
  let maxPct = 0;
  const lines = [];
  for (const e of usable) {
    const actual = economicCalendar.parseNumeric(e.actual);
    const forecast = economicCalendar.parseNumeric(e.forecast);
    const diff = actual - forecast;
    const pct = (Math.abs(diff) / Math.max(Math.abs(forecast), 0.1)) * 100;
    let vote = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (economicCalendar.isInverseIndicator(e.title)) vote = -vote;
    if (pct < cfg.minSurprisePct) vote = 0;
    net += vote;
    if (vote !== 0) maxPct = Math.max(maxPct, pct);
    lines.push(`${e.title}: ${e.actual} vs ${e.forecast} (${r2(pct)}%${vote === 0 ? ', haitoshi' : vote > 0 ? ', ↑' : ', ↓'})`);
  }
  const summary = lines.join(' | ');
  if (net === 0) return { state: 'done', outcome: 'no_edge', text: `hakuna mwelekeo wazi (surprise ndogo au zinapingana) — ${summary}` };

  const pd = pairDirection(g.currency, net > 0);
  return {
    state: 'trade',
    pair: pd.pair,
    direction: pd.direction,
    bullish: net > 0,
    surprisePct: r2(maxPct),
    titles: usable.map((e) => e.title).join('; '),
    summary,
  };
}

// ── Kufungua trade ────────────────────────────────────────────────────────────────────────────
async function dailyPnl(mode) {
  const r = await db.query(
    'SELECT COALESCE(SUM(profit), 0) AS pnl FROM fx_news_trades WHERE accountMode = ? AND closedAt >= ? AND profit IS NOT NULL',
    [mode, startOfUtcDay(Date.now())]
  );
  return Number(r.rows && r.rows[0] && r.rows[0].pnl) || 0;
}

async function openCount(mode) {
  const r = await db.query('SELECT COUNT(*) AS n FROM fx_news_trades WHERE closedAt IS NULL AND accountMode = ?', [mode]);
  return Number(r.rows && r.rows[0] && r.rows[0].n) || 0;
}

async function placeFor(g, ev, mode) {
  const stake = Math.min(cfg.stake, MAX_STAKE_USD);
  const slUsd = Math.max(0.01, r2(stake * cfg.slPct / 100));
  const tpUsd = Math.max(0.01, r2(stake * cfg.tpPct / 100));
  const result = await placeMultiplier({
    pair: ev.pair, direction: ev.direction, stake, stopLoss: slUsd, takeProfit: tpUsd, multiplier: cfg.multiplier,
  });
  const slFinal = Number.isFinite(result.stop_loss) ? result.stop_loss : slUsd;
  const tpFinal = Number.isFinite(result.take_profit) ? result.take_profit : tpUsd;
  const id = String(result.contract_id);
  newsContractIds.add(id);
  const openedAt = Date.now();
  // Trade ISHAFUNGULIWA Deriv — usiitupe kimya kimya DB ikishindwa; tuma onyo na uendelee (tukio lisirudiwe).
  await markHandled(g.key, 'traded', `${ev.pair} ${ev.direction}`);
  try {
    await db.query(
      `INSERT INTO fx_news_trades (contractId, eventKey, currency, eventTitles, pair, direction, stake, slUsd, tpUsd, multiplier,
         maxHoldMin, surprisePct, buyPrice, openedAt, accountMode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contractId) DO NOTHING`,
      [id, g.key, g.currency, ev.titles.slice(0, 300), ev.pair, ev.direction, stake, slFinal, tpFinal, cfg.multiplier,
        cfg.maxHoldMin, ev.surprisePct, Number(result.buy_price) || null, openedAt, mode]
    );
  } catch (dbErr) {
    console.error('[newsTrader] Trade imefunguliwa lakini DB imeshindwa kuihifadhi:', dbErr.message);
    await notify(`⚠️ News trade ${ev.pair} ${ev.direction} (🆔 ${id}) imefunguliwa Deriv lakini HAIKUHIFADHIWA kwenye database (${dbErr.message}). Ifuatilie/ifunge kwa mkono.`);
  }
  pushDecision('trade', `📰 ${g.currency}: ${ev.direction} ${ev.pair} — ${ev.summary}`, { contractId: id });
  await notify(
    `📰 *NEWS TRADE IMEFUNGULIWA* (${mode.toUpperCase()})\n\n` +
      `Currency: *${g.currency}* ${ev.bullish ? '🟢 inaimarika' : '🔴 inadhoofika'}\n` +
      `Jozi: *${ev.pair}* ${ev.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'}\n` +
      `Surprise: ${ev.surprisePct}%\n` +
      `Stake: $${r2(stake)} | SL: $${r2(slFinal)} | TP: $${r2(tpFinal)} | x${cfg.multiplier}\n` +
      `Funga kwa muda baada ya: dakika ${cfg.maxHoldMin}\n` +
      `📊 ${ev.summary}\n🆔 ${id}\n\n⚠️ Trade ya habari — hatari kubwa. SI ushauri wa kifedha.`
  );
}

async function scanAndTrade(mode) {
  lastBlocked = null;
  if (mode === 'real' && !cfg.allowReal) { lastBlocked = 'Akaunti ni REAL na "Ruhusu REAL" haijawashwa.'; return; }

  const pnl = await dailyPnl(mode);
  if (pnl <= -cfg.maxDailyLossUsd) { lastBlocked = `Hasara ya siku ($${r2(-pnl)}) imefika kikomo ($${cfg.maxDailyLossUsd}) — imesimama hadi kesho (UTC).`; return; }

  let view = await economicCalendar.getWeekView(CURRENCIES);
  if (!view.available) { lastBlocked = 'Economic calendar haipatikani kwa sasa.'; return; }

  const now = Date.now();
  let groups = buildGroups(view.events, now).filter((g) => !handled.has(g.key));
  if (!groups.length) return;

  // Kuna tukio lililotoka — lazimisha feed mpya (si cache ya dakika 15) ili tupate `actual` haraka.
  if (groups.some((g) => g.events.some((e) => !hasValue(e.actual)))) {
    const fresh = await economicCalendar.getWeekView(CURRENCIES, { maxAgeMs: FRESH_FEED_MS });
    if (fresh.available) { view = fresh; groups = buildGroups(view.events, Date.now()).filter((g) => !handled.has(g.key)); }
  }

  for (const g of groups) {
    const ev = evaluateGroup(g);
    if (ev.state === 'pending') continue;
    if (ev.state === 'done') {
      await markHandled(g.key, ev.outcome, ev.text);
      pushDecision('skip', `⏭️ ${g.currency}: ${ev.text}`);
      continue;
    }

    // Walinzi kabla ya kufungua (hali za muda mfupi HAZIWEKI alama ya "handled" — tutajaribu tena ndani ya dirisha).
    if ((await openCount(mode)) >= cfg.maxOpen) { lastBlocked = `Trades wazi zimejaa (${cfg.maxOpen}).`; continue; }
    let live;
    try { live = await getOpenPositions(); } catch (err) { lastBlocked = 'Deriv haipatikani (positions) — sifungui trade.'; return; }
    const sym = 'frx' + ev.pair;
    if (live.some((p) => String(p.symbol || '').toUpperCase() === sym.toUpperCase())) {
      lastBlocked = `${ev.pair} ina position wazi tayari — subiri ifungwe.`;
      continue;
    }
    try {
      await placeFor(g, ev, mode);
    } catch (err) {
      console.error(`[newsTrader] Imeshindwa kufungua ${ev.pair}:`, err.message);
      await markHandled(g.key, 'error', err.message);
      pushDecision('error', `❌ ${g.currency}: ${ev.pair} imeshindwa — ${err.message}`);
      await notify(`❌ News trade ya ${ev.pair} imeshindwa: ${err.message}`);
    }
  }
}

// ── Kufuatilia trades wazi: kufungwa (SL/TP/mkono) + kufunga kwa muda ─────────────────────────
async function recordClose(row, { closedAt, sellPrice, profit, exitType }) {
  const p = Number.isFinite(Number(profit)) ? r2(profit) : null;
  const sp = Number.isFinite(Number(sellPrice)) ? Number(sellPrice) : null;
  await db.query(
    'UPDATE fx_news_trades SET closedAt = ?, sellPrice = ?, profit = ?, exitType = ? WHERE contractId = ? AND closedAt IS NULL',
    [closedAt, sp, p, exitType, row.contractId]
  );
  missCount.delete(row.contractId);
  const win = p != null && p > 0;
  pushDecision(p == null ? 'info' : win ? 'win' : 'loss', `${p == null ? '❔' : win ? '✅' : '❌'} ${row.pair} ${row.direction} imefungwa (${exitType}) ${p == null ? '' : (p >= 0 ? '+' : '-') + '$' + Math.abs(p).toFixed(2)}`);
  await notify(
    `${p == null ? '❔' : win ? '✅' : '❌'} *NEWS TRADE IMEFUNGWA* (${String(row.accountMode || '').toUpperCase()})\n\n` +
      `Jozi: *${row.pair}* ${row.direction}\n` +
      `Matokeo: ${p == null ? 'haijulikani' : (p >= 0 ? '+' : '-') + '$' + Math.abs(p).toFixed(2)}\n` +
      `Sababu ya kufunga: ${exitType === 'time' ? 'muda umeisha' : exitType === 'unknown' ? 'haikupatikana kwenye historia' : 'SL/TP/mkono'}\n🆔 ${row.contractId}`
  );
}

async function trackOpenTrades(mode) {
  const r = await db.query('SELECT * FROM fx_news_trades WHERE closedAt IS NULL AND accountMode = ?', [mode]);
  const rows = r.rows || [];
  if (!rows.length) return;
  let live;
  try { live = await getOpenPositions(); } catch (_) { return; } // fail-closed: bila uthibitisho wa Deriv usibadilishe chochote
  const liveIds = new Set(live.map((p) => String(p.contract_id)));

  for (const row of rows) {
    const id = String(row.contractId);
    try {
      if (liveIds.has(id)) {
        const holdMs = Math.max(1, Number(row.maxHoldMin) || cfg.maxHoldMin) * 60000;
        if (Date.now() - Number(row.openedAt) >= holdMs) {
          const res = await closeContractWithPnL(id);
          await recordClose(row, { closedAt: Date.now(), sellPrice: res.sold_for, profit: res.profit, exitType: 'time' });
        }
        continue;
      }
      // Haipo tena kwenye portfolio → imefungwa (SL/TP/mkono). Chukua matokeo halisi kutoka profit_table.
      let closed = null;
      try { closed = await getClosedContractFromHistory(id); } catch (_) { /* jaribu tena tick ijayo */ }
      if (closed) {
        const cp = Number(closed.profit);
        const profit = Number.isFinite(cp) ? cp : Number(closed.sell_price) - Number(closed.buy_price);
        await recordClose(row, {
          closedAt: (Number(closed.sell_time) || 0) * 1000 || Date.now(),
          sellPrice: closed.sell_price, profit, exitType: 'auto',
        });
      } else {
        const n = (missCount.get(id) || 0) + 1;
        missCount.set(id, n);
        if (n >= MAX_MISSES) await recordClose(row, { closedAt: Date.now(), sellPrice: null, profit: null, exitType: 'unknown' });
      }
    } catch (err) {
      console.error(`[newsTrader] Ufuatiliaji wa ${id} umeshindwa:`, err.message);
    }
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!cfgLoaded) await loadConfig();
    lastTickAt = Date.now();
    const mode = await resolveMode();
    if (!mode) { lastBlocked = 'Akaunti ya Deriv haijulikani bado.'; return; }
    await trackOpenTrades(mode);          // trades zilizo wazi zinasimamiwa HATA ukizima News Trading
    if (!cfg.enabled) { lastBlocked = null; return; }
    await scanAndTrade(mode);
  } catch (err) {
    console.error('[newsTrader] tick error:', err.message);
  } finally {
    ticking = false;
  }
}

async function start({ sock, notifyJid } = {}) {
  waSock = sock || waSock;
  ownerJid = notifyJid || ownerJid;
  if (timer || starting) return;
  starting = true;
  try {
    await db.initSchema();
    await loadConfig();
    const ids = await db.query('SELECT contractId FROM fx_news_trades', []);
    for (const row of ids.rows || []) newsContractIds.add(String(row.contractId));
    const ev = await db.query('SELECT eventKey FROM fx_news_events WHERE handledAt >= ?', [Date.now() - 7 * 86400000]);
    for (const row of ev.rows || []) handled.add(String(row.eventKey));
  } catch (err) {
    console.error('[newsTrader] Imeshindwa kuanza kutoka DB:', err.message);
  }
  console.log(`[newsTrader] ✅ Imeanza — ${cfg.enabled ? 'IMEWASHWA' : 'imezimwa (washa kwenye dashboard)'}, tick kila sekunde ${Math.round(TICK_MS / 1000)}.`);
  timer = setInterval(() => { tick().catch((e) => console.error('[newsTrader] tick:', e.message)); }, TICK_MS);
  if (timer.unref) timer.unref();
  starting = false;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

// ── Kwa dashboard ─────────────────────────────────────────────────────────────────────────────
async function getSummary(mode) {
  if (!mode) return null;
  const r = await db.query(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END), 0) AS wins,
            COALESCE(SUM(CASE WHEN profit < 0 THEN 1 ELSE 0 END), 0) AS losses,
            COALESCE(SUM(profit), 0) AS net
       FROM fx_news_trades WHERE closedAt IS NOT NULL AND accountMode = ?`, [mode]);
  const x = (r.rows && r.rows[0]) || {};
  const wins = Number(x.wins) || 0;
  const losses = Number(x.losses) || 0;
  return {
    closed: Number(x.n) || 0, wins, losses,
    winRate: wins + losses ? r2((wins / (wins + losses)) * 100) : 0,
    net: r2(Number(x.net) || 0),
    today: r2(await dailyPnl(mode)),
  };
}

async function getStatus() {
  if (!cfgLoaded) await loadConfig();
  await db.initSchema();
  const mode = getAccountMode() || (await resolveMode());
  const now = Date.now();

  let upcoming = [];
  try {
    const view = await economicCalendar.getWeekView(CURRENCIES);
    const impacts = cfg.includeMedium ? ['high', 'medium'] : ['high'];
    upcoming = (view.events || [])
      .filter((e) => impacts.includes(String(e.impact).toLowerCase()))
      .map((e) => ({ e, t: new Date(e.date).getTime() }))
      .filter((x) => Number.isFinite(x.t) && x.t >= now - cfg.windowMin * 60000 && x.t <= now + 48 * 3600000)
      .slice(0, 14)
      .map(({ e, t }) => {
        const bull = pairDirection(e.country, true);
        return {
          title: e.title, currency: e.country, impact: e.impact, date: e.date,
          minutesFromNow: Math.round((t - now) / 60000),
          forecast: e.forecast ?? null, previous: e.previous ?? null, actual: e.actual ?? null,
          pair: bull ? bull.pair : null,
          ifBeat: bull ? bull.direction : null, // direction ikiwa currency itaimarika
          numeric: economicCalendar.parseNumeric(e.forecast) != null,
        };
      });
  } catch (_) { /* calendar haipatikani */ }

  const open = mode
    ? (await db.query('SELECT contractId, pair, direction, stake, slUsd, tpUsd, openedAt, maxHoldMin, currency FROM fx_news_trades WHERE closedAt IS NULL AND accountMode = ? ORDER BY openedAt DESC', [mode])).rows
    : [];
  return {
    config: cfg,
    mode,
    running: !!timer,
    lastTickAt,
    blocked: lastBlocked,
    open,
    summary: await getSummary(mode),
    upcoming,
    decisions: decisions.slice(0, 25),
    limits: { minStake: MIN_STAKE_USD, maxStake: MAX_STAKE_USD, multipliers: ALLOWED_MULTIPLIERS },
  };
}

async function getHistory(limit = 100) {
  await db.initSchema();
  const mode = getAccountMode() || (await resolveMode());
  if (!mode) return [];
  const n = Math.max(1, Math.min(Number(limit) || 100, 500));
  const r = await db.query(
    `SELECT contractId, currency, eventTitles, pair, direction, stake, surprisePct, openedAt, closedAt, profit, exitType
       FROM fx_news_trades WHERE closedAt IS NOT NULL AND accountMode = ? ORDER BY closedAt DESC LIMIT ?`,
    [mode, n]
  );
  return r.rows;
}

// Futa historia ya News Trading (zilizofungwa tu). scope: 'demo' | 'real' | 'all'.
function clearWhere(scope) {
  if (scope === 'demo' || scope === 'real') return { where: 'closedAt IS NOT NULL AND accountMode = ?', params: [scope], label: 'News trades za ' + scope.toUpperCase() };
  if (scope === 'all') return { where: 'closedAt IS NOT NULL', params: [], label: 'News trades ZOTE (demo + real)' };
  return null;
}

async function previewClear(scope) {
  const f = clearWhere(scope);
  if (!f) return { ok: false, error: 'scope lazima iwe demo, real au all.' };
  await db.initSchema();
  const r = await db.query(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END), 0) AS wins,
            COALESCE(SUM(CASE WHEN profit < 0 THEN 1 ELSE 0 END), 0) AS losses,
            COALESCE(SUM(profit), 0) AS net
       FROM fx_news_trades WHERE ${f.where}`, f.params);
  const x = (r.rows && r.rows[0]) || {};
  return { ok: true, scope, label: f.label, count: Number(x.n) || 0, wins: Number(x.wins) || 0, losses: Number(x.losses) || 0, net: r2(Number(x.net) || 0) };
}

async function clearHistory(scope) {
  const pv = await previewClear(scope);
  if (!pv.ok) return pv;
  const f = clearWhere(scope);
  const r = await db.query(`DELETE FROM fx_news_trades WHERE ${f.where}`, f.params);
  const deleted = Number(r.rowsAffected);
  return { ...pv, deleted: Number.isFinite(deleted) ? deleted : pv.count };
}

module.exports = {
  start,
  stop,
  tick,
  isNewsContract,
  getConfig: async () => { if (!cfgLoaded) await loadConfig(); return cfg; },
  setConfig,
  getStatus,
  getHistory,
  previewClear,
  clearHistory,
  CURRENCY_PAIR,
  // Kwa majaribio
  _evaluateGroup: evaluateGroup,
  _buildGroups: buildGroups,
  _pairDirection: pairDirection,
};
