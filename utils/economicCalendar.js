/**
 * economicCalendar.js — Economic calendar (habari za kiuchumi) kwa ajili ya
 * kuongeza "context" kwenye forex signal (utils/forexSignal.js).
 *
 * Chanzo cha data: ForexFactory calendar feed (JSON, HAIHITAJI API key —
 * ni feed ya umma inayotumiwa na miradi mingi ya open-source):
 *   https://nfs.faireconomy.media/ff_calendar_thisweek.json
 *
 * Feed hii inarudisha matukio ya WIKI HII TU (Jumatatu-Jumapili, muda wa
 * server). Kila tukio lina: title, country (currency code — mfano "USD",
 * "EUR"), date (ISO), impact ("High"/"Medium"/"Low"/"Holiday"), forecast,
 * previous, actual.
 *
 * Matumizi mawili kwenye signal:
 *   1) ONYO LA HATARI (risk warning) — kama kuna tukio la "High" impact
 *      linalokaribia (ndani ya NEWS_RISK_WINDOW_MIN kabla/baada), signal
 *      HAIONGEZWI vote ya ziada — badala yake inawekwa bendera ya
 *      "newsRisk: true" inayozuia auto-trade (spread/slippage kubwa
 *      wakati wa habari kubwa — sio wakati mzuri wa kuingia trade mpya
 *      hata kama technicals zinaonekana nzuri).
 *   2) VOTE YA ZIADA (surprise index) — kama tukio la High/Medium impact
 *      LIMESHATOKEA hivi karibuni (ndani ya SURPRISE_WINDOW_MIN iliyopita)
 *      na lina "actual" tayari, tunalinganisha actual dhidi ya forecast:
 *      actual > forecast = "chanya" kwa currency husika (kwa default —
 *      tazama INVERSE_INDICATORS hapa chini kwa vielelezo ambavyo
 *      "chini ni bora", mfano Unemployment Rate).
 *
 * ⚠️ Hii ni HEURISTIC rahisi (si uchambuzi kamili wa "market reaction") —
 * si vigezo vyote vinafuata kanuni "juu = chanya" (mfano CPI ikiwa juu
 * mno inaweza kuonekana "hasi" kwa hisia za soko hata ikiwa ni "chanya"
 * kwa currency kwa muda mfupi kupitia matarajio ya riba). Tumia kama
 * KIGEZO KIMOJA ZAIDI miongoni mwa vingine, si ukweli kamili.
 */

const axios = require('axios');

const FEED_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const TIMEOUT_MS = 10000;
const CACHE_MS = 15 * 60 * 1000; // dakika 15 — calendar haibadiliki mara kwa mara

// Dakika kabla/baada ya tukio la "High" impact ambazo tunachukulia kama
// "hatari ya kiwango cha juu" (spread/slippage) — auto-trade inapaswa
// kuepuka kufungua trade mpya wakati huu.
const NEWS_RISK_WINDOW_MIN = parseInt(process.env.NEWS_RISK_WINDOW_MIN || '30', 10);

// Dirisha la "tukio limeshatokea hivi karibuni" kwa ajili ya surprise vote.
const SURPRISE_WINDOW_MIN = parseInt(process.env.NEWS_SURPRISE_WINDOW_MIN || '60', 10);

// Vigezo ambavyo "chini ni bora" kwa currency (thamani ndogo ya actual
// dhidi ya forecast = chanya, si hasi) — orodha si kamili, ni vielelezo
// vya kawaida zaidi vinavyoonekana kwenye calendar ya ForexFactory.
const INVERSE_KEYWORDS = [
  'unemployment',
  'jobless',
  'initial claims',
  'continuing claims',
  'inventories',
  'trade balance deficit',
  'default rate',
  'bankruptc',
];

let cache = { data: null, at: 0 };

function isInverseIndicator(title) {
  const t = (title || '').toLowerCase();
  return INVERSE_KEYWORDS.some((k) => t.includes(k));
}

function parseNumeric(v) {
  if (v == null || v === '') return null;
  // Feed huweka "%", "K", "M", "B", "T" wakati mwingine kama string —
  // tunaondoa alama zisizo za nambari (ikibaki chanya/hasi na desimali).
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isNaN(n) ? null : n;
}

async function fetchCalendarRaw() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }
  const { data } = await axios.get(FEED_URL, { timeout: TIMEOUT_MS });
  if (!Array.isArray(data)) {
    throw new Error('Economic calendar: muundo wa data haukutarajiwa');
  }
  cache = { data, at: Date.now() };
  return data;
}

/**
 * Rudisha "context" ya calendar kwa jozi ya currency mbili (mfano "EUR", "USD").
 * Haitupi error kamwe kwa juu — ikishindwa kupata data, inarudisha context
 * tupu (signal ya kiufundi lazima iendelee kufanya kazi hata kama calendar
 * haipatikani, mfano feed iko down au network imezuiwa).
 */
async function getCalendarContext(currencyA, currencyB) {
  const currencies = [currencyA, currencyB].filter(Boolean).map((c) => c.toUpperCase());
  const empty = { available: false, upcomingHighImpact: [], recentReleases: [], newsRisk: false };

  let events;
  try {
    events = await fetchCalendarRaw();
  } catch (err) {
    console.error('economicCalendar fetch error:', err.message);
    return empty;
  }

  const now = Date.now();
  const relevant = events.filter((e) => currencies.includes((e.country || '').toUpperCase()));

  const upcomingHighImpact = [];
  const recentReleases = [];

  for (const e of relevant) {
    if (!e.date) continue;
    const t = new Date(e.date).getTime();
    if (Number.isNaN(t)) continue;
    const diffMin = (t - now) / 60000; // chanya = bado haijafika, hasi = imeshapita

    // (1) Tukio la "High" impact linalokaribia au limepita hivi karibuni
    // ndani ya dirisha la hatari (kabla NA baada, kwa sababu slippage
    // inaweza kuendelea dakika chache baada ya release).
    if (
      String(e.impact).toLowerCase() === 'high' &&
      Math.abs(diffMin) <= NEWS_RISK_WINDOW_MIN
    ) {
      upcomingHighImpact.push({
        title: e.title,
        country: e.country,
        date: e.date,
        minutesFromNow: Math.round(diffMin),
      });
    }

    // (2) Tukio limeshatokea hivi karibuni na lina "actual" — surprise vote.
    if (
      diffMin <= 0 &&
      Math.abs(diffMin) <= SURPRISE_WINDOW_MIN &&
      ['high', 'medium'].includes(String(e.impact).toLowerCase())
    ) {
      const actual = parseNumeric(e.actual);
      const forecast = parseNumeric(e.forecast);
      if (actual != null && forecast != null) {
        const inverse = isInverseIndicator(e.title);
        let surprise = 'neutral';
        if (actual > forecast) surprise = inverse ? 'bearish' : 'bullish';
        else if (actual < forecast) surprise = inverse ? 'bullish' : 'bearish';

        recentReleases.push({
          title: e.title,
          country: (e.country || '').toUpperCase(),
          impact: e.impact,
          actual: e.actual,
          forecast: e.forecast,
          previous: e.previous,
          surprise,
          minutesAgo: Math.round(-diffMin),
        });
      }
    }
  }

  return {
    available: true,
    upcomingHighImpact,
    recentReleases,
    newsRisk: upcomingHighImpact.length > 0,
  };
}

/**
 * Geuza calendar context kuwa "vote" ya ziada + notes, kwa muundo uleule
 * wa "votes" unaotumika kwenye computeSignal() (utils/forexSignal.js).
 *
 * baseCurrency/quoteCurrency: kwa jozi EUR/USD, base="EUR", quote="USD".
 * Surprise "bullish" kwa base currency = BUY vote; "bullish" kwa quote
 * currency ni SELL vote kwa jozi (currency ya quote ikiimarika inamaanisha
 * jozi inashuka), na kinyume chake.
 */
function computeCalendarVote(context, baseCurrency, quoteCurrency) {
  const notes = [];
  let bullish = 0;
  let bearish = 0;

  if (!context || !context.available) {
    return { bullish, bearish, notes, newsRisk: false };
  }

  for (const r of context.recentReleases) {
    if (r.surprise === 'neutral') continue;
    const isBase = r.country === baseCurrency;
    const isQuote = r.country === quoteCurrency;
    if (!isBase && !isQuote) continue;

    // surprise "bullish" kwa currency husika inamaanisha currency HIYO
    // inaimarika — kwa jozi, hilo ni BUY kama ni base, SELL kama ni quote.
    const voteForPair =
      (isBase && r.surprise === 'bullish') || (isQuote && r.surprise === 'bearish')
        ? 'BUY'
        : 'SELL';

    if (voteForPair === 'BUY') bullish += 1;
    else bearish += 1;

    notes.push(
      `📰 ${r.title} (${r.country}, ${r.minutesAgo}min zilizopita): actual ${r.actual} vs forecast ${r.forecast} → ${voteForPair}`
    );
  }

  if (context.newsRisk) {
    const list = context.upcomingHighImpact
      .map((e) => `${e.title} (${e.country}, ${e.minutesFromNow >= 0 ? 'ndani ya' : 'ilipita'} ${Math.abs(e.minutesFromNow)}min)`)
      .join('; ');
    notes.push(`⚠️ Habari kubwa (High impact) karibu: ${list} — hatari ya spread/slippage kuongezeka.`);
  }

  return { bullish, bearish, notes, newsRisk: context.newsRisk };
}

// Currencies kuu 8 zinazoonekana kwenye FX_SYMBOL_MAP (pairing/server.js) —
// ndizo zinazotumika kama default ya getWeekView() kwa ajili ya dashboard
// (fxtrading.html), ili kutoonyesha "noise" ya currencies zisizohusika.
const MAJOR_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD'];

/**
 * Rudisha matukio YOTE ya wiki hii kwa currencies zilizoombwa (default:
 * MAJOR_CURRENCIES), yamepangwa kwa tarehe — kwa ajili ya kuonyesha
 * "economic calendar" nzima kwenye dashboard (tofauti na getCalendarContext
 * ambayo inarudisha "vote"/muktasari kwa jozi MOJA tu).
 *
 * Haitupi error kamwe kwa juu — ikishindwa, inarudisha { available:false }.
 */
async function getWeekView(currencies = MAJOR_CURRENCIES) {
  const wanted = currencies.filter(Boolean).map((c) => c.toUpperCase());

  let events;
  try {
    events = await fetchCalendarRaw();
  } catch (err) {
    console.error('economicCalendar getWeekView error:', err.message);
    return { available: false, events: [], error: err.message };
  }

  const now = Date.now();
  const list = events
    .filter((e) => wanted.includes((e.country || '').toUpperCase()))
    .map((e) => {
      const t = e.date ? new Date(e.date).getTime() : NaN;
      return {
        title: e.title,
        country: (e.country || '').toUpperCase(),
        date: e.date,
        impact: e.impact || 'Low',
        forecast: e.forecast ?? null,
        previous: e.previous ?? null,
        actual: e.actual ?? null,
        isPast: !Number.isNaN(t) && t < now,
      };
    })
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return { available: true, events: list };
}

module.exports = {
  getCalendarContext,
  computeCalendarVote,
  getWeekView,
  MAJOR_CURRENCIES,
  NEWS_RISK_WINDOW_MIN,
  SURPRISE_WINDOW_MIN,
};
