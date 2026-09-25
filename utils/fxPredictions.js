/**
 * fxPredictions.js — "Predictions" za jozi za FX kwa ajili ya dashboard
 * (pairing/public/fxtrading.html), zinazounganisha vitu VITATU:
 *
 *   1) Signal ya kiufundi (RSI/MACD/EMA/ADX/BBands — utils/forexSignal.js).
 *      Hii ndiyo INAAMUA outlook (BUY/SELL/NEUTRAL) — AI HAIBADILISHI
 *      mwelekeo huu, inaufafanua tu kwa lugha ya kawaida.
 *   2) Muktadha wa economic calendar (utils/economicCalendar.js) — habari
 *      za hivi karibuni (surprise) na zinazokuja (newsRisk) kwa currency
 *      za jozi husika.
 *   3) Ufafanuzi wa AI (Groq, JSON mode) unaounganisha (1) na (2) kuwa
 *      muhtasari MFUPI wa Kiswahili unaosomeka kirahisi kwenye dashboard.
 *
 * ⚠️ Groq HUITWA MARA MOJA TU kwa kila cache-refresh (jozi ZOTE 7 kwenye
 * ombi MOJA la JSON), si mara 7 tofauti — inapunguza gharama/muda na
 * kuepuka rate limits. Refresh hufanyika kila PREDICTIONS_CACHE_MIN
 * dakika (default 20) — si kila poll ya dashboard (ile ni ya sekunde 5
 * tu, kwa ajili ya bei/positions, si kwa AI insight).
 *
 * Kama GROQ_API_KEY haipo au ombi likishindwa, inarudisha predictions
 * zenye source:'technical-only' (bila maandishi ya AI, outlook/confidence
 * kutoka kwa signal ya kiufundi pekee) — dashboard inaendelea kuonyesha
 * kitu badala ya kuvunjika.
 *
 * Hii SI ushauri wa kifedha wala wa uwekezaji.
 */

const Groq = require('groq-sdk');
const { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL } = require('./forexSignal');
const { getCalendarContext } = require('./economicCalendar');

const PAIRS = [
  { code: 'EURUSD', symbol: 'EUR/USD', base: 'EUR', quote: 'USD' },
  { code: 'GBPUSD', symbol: 'GBP/USD', base: 'GBP', quote: 'USD' },
  { code: 'USDJPY', symbol: 'USD/JPY', base: 'USD', quote: 'JPY' },
  { code: 'AUDUSD', symbol: 'AUD/USD', base: 'AUD', quote: 'USD' },
  { code: 'USDCHF', symbol: 'USD/CHF', base: 'USD', quote: 'CHF' },
  { code: 'USDCAD', symbol: 'USD/CAD', base: 'USD', quote: 'CAD' },
  { code: 'NZDUSD', symbol: 'NZD/USD', base: 'NZD', quote: 'USD' },
];

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const CACHE_MS = (parseInt(process.env.PREDICTIONS_CACHE_MIN, 10) || 20) * 60 * 1000;
// Signal ya autoTrader (ikiwepo, kwa EURUSD/GBPUSD/USDJPY) inachukuliwa kama
// "bado mpya" kwa dakika hizi — badala ya kuomba Twelve Data upya bure bure.
const REUSE_SIGNAL_MAX_AGE_MS = 10 * 60 * 1000;

let groqClient = null;
function getGroq() {
  if (!groqClient) {
    const key = process.env.GROQ_API_KEY;
    if (!key) return null;
    groqClient = new Groq({ apiKey: key });
  }
  return groqClient;
}

let cache = { data: null, at: 0 };
let inFlight = null;

async function gatherPairData(pairInfo, existingSignals) {
  const cached = existingSignals ? existingSignals[pairInfo.code] : null;
  let direction = 'NEUTRAL';
  let strength = 0;
  let notes = [];
  let price = null;
  let atr = null;
  let error = null;

  if (cached && cached.checkedAt && Date.now() - cached.checkedAt < REUSE_SIGNAL_MAX_AGE_MS && !cached.error) {
    direction = cached.direction;
    strength = cached.strength;
    notes = cached.notes || [];
    price = cached.price;
    atr = cached.atr;
  } else {
    try {
      const snapshot = await fetchForexSnapshot(pairInfo.symbol, DEFAULT_INTERVAL);
      const sig = computeSignal(snapshot);
      direction = sig.direction;
      strength = sig.strength;
      notes = sig.notes;
      price = snapshot.price;
      atr = snapshot.atr;
    } catch (err) {
      error = err.message;
      notes = [`Imeshindwa kupata signal: ${err.message}`];
    }
  }

  let calendar = { available: false, upcomingHighImpact: [], recentReleases: [], newsRisk: false };
  try {
    calendar = await getCalendarContext(pairInfo.base, pairInfo.quote);
  } catch (_) {
    // getCalendarContext yenyewe haitupi juu (angalia economicCalendar.js),
    // lakini try/catch ya ziada hapa kwa usalama.
  }

  return { ...pairInfo, direction, strength, notes, price, atr, error, calendar };
}

function fallbackPrediction(p) {
  return {
    pair: p.code,
    outlook: p.direction,
    confidence: p.strength,
    summary: p.error
      ? `Signal ya kiufundi haipatikani kwa sasa (${p.error}).`
      : (p.notes || []).slice(0, 3).join(' ') || 'Hakuna mwelekeo dhahiri kwa sasa (NEUTRAL).',
    keyDrivers: [],
    newsRisk: !!p.calendar.newsRisk,
    price: p.price,
    source: 'technical-only',
  };
}

async function buildPredictions(existingSignals) {
  const pairsData = await Promise.all(PAIRS.map((p) => gatherPairData(p, existingSignals)));

  const groq = getGroq();
  if (!groq) {
    return {
      generatedAt: Date.now(),
      source: 'technical-only',
      note: 'GROQ_API_KEY haijawekwa — AI insight imezimwa, signal ya kiufundi tu.',
      predictions: pairsData.map(fallbackPrediction),
    };
  }

  const compactPayload = pairsData.map((p) => ({
    pair: p.code,
    price: p.price,
    technicalDirection: p.direction,
    technicalStrength: p.strength,
    technicalNotes: p.notes,
    newsRisk: p.calendar.newsRisk,
    upcomingHighImpact: (p.calendar.upcomingHighImpact || []).map(
      (e) => `${e.title} (${e.country}, ${e.minutesFromNow >= 0 ? 'ndani ya' : 'ilipita'} ${Math.abs(e.minutesFromNow)}min)`
    ),
    recentReleases: (p.calendar.recentReleases || []).map(
      (r) => `${r.title} (${r.country}, ${r.minutesAgo}min zilizopita): actual ${r.actual} vs forecast ${r.forecast} → ${r.surprise}`
    ),
  }));

  const system = `
Wewe ni mchambuzi wa soko la fedha za kigeni (forex) anayeandika kwa Kiswahili
kwa dashboard ya ndani ya biashara ndogo. Umepewa, kwa kila jozi ya sarafu,
matokeo ya signal ya kiufundi ambayo TAYARI IMEHESABIWA (RSI/MACD/EMA/ADX) —
USIHESABU tena wala usibadili "technicalDirection"/"technicalStrength", ni
DATA HALISI, siyo maoni. Umepewa pia matukio ya economic calendar (habari za
kiuchumi, chanzo ForexFactory).

Kazi yako, kwa KILA jozi kwenye orodha: andika muhtasari MFUPI (sentensi 1-2,
Kiswahili) unaounganisha technicals + habari za kiuchumi, ukielezea KWA NINI
(mfano "EMA9 iko juu ya EMA21 na RSI bado haijafika overbought, hakuna habari
kubwa inayosubiriwa" au "ingawa technicals zinaonyesha BUY, habari kubwa ya
NFP iko ndani ya dakika 20 — tahadhari ya spread"). "outlook" LAZIMA ilingane
na "technicalDirection" iliyotolewa (usibadili mwelekeo) — "confidence" ni
"technicalStrength" ile ile isipokuwa uwe na sababu KALI sana ya kuipunguza
kidogo (mfano habari kubwa inayopingana moja kwa moja imepita hivi karibuni),
kamwe usiiongeze zaidi ya ilivyotolewa. Weka "keyDrivers" (orodha ya pointi
1-3 fupi, kila moja neno chache) za sababu kuu zilizosababisha muhtasari wako.

Hii SI ushauri wa kifedha wala wa uwekezaji — tumia maneno kama "inaashiria"/
"inaweza", si "nunua"/"uza" kwa uhakika.

Rudisha JSON PEKEE (hakuna maandishi mengine kabisa nje ya JSON), muundo:
{"predictions":[{"pair":"EURUSD","outlook":"BUY|SELL|NEUTRAL","confidence":0-100,"summary":"...","keyDrivers":["...","..."]}]}
`.trim();

  const user = `Data ya jozi zote (JSON):\n${JSON.stringify(compactPayload, null, 2)}`;

  try {
    const resp = await groq.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 1600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });

    const raw = resp.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(raw);
    const byPair = new Map((parsed.predictions || []).map((p) => [String(p.pair || '').toUpperCase(), p]));

    const predictions = pairsData.map((p) => {
      const ai = byPair.get(p.code);
      if (!ai) return fallbackPrediction(p);
      return {
        pair: p.code,
        // outlook/confidence: technicals ndio chanzo cha ukweli — AI
        // haijaruhusiwa kubadili mwelekeo, hii ni ulinzi wa ziada upande
        // wa server ikiwa Groq "itasahau" maagizo.
        outlook: p.direction,
        confidence: p.strength,
        summary: ai.summary || fallbackPrediction(p).summary,
        keyDrivers: Array.isArray(ai.keyDrivers) ? ai.keyDrivers.slice(0, 3) : [],
        newsRisk: !!p.calendar.newsRisk,
        price: p.price,
        source: 'ai',
      };
    });

    return { generatedAt: Date.now(), source: 'ai', predictions };
  } catch (err) {
    console.error('[fxPredictions] Groq error:', err.message);
    return {
      generatedAt: Date.now(),
      source: 'technical-only',
      note: `AI insight imeshindikana (${err.message}) — signal ya kiufundi tu.`,
      predictions: pairsData.map(fallbackPrediction),
    };
  }
}

/**
 * Pata predictions (cached kwa PREDICTIONS_CACHE_MIN dakika).
 * existingSignalsArray: hiari — matokeo ya autoTrader.getStatus().signals
 * (array ya {code, direction, strength, price, atr, notes, checkedAt}),
 * hutumika kuepuka kuomba Twelve Data upya bure kwa jozi ambazo tayari
 * zina signal mpya kutoka kwa auto-trader.
 */
async function getPredictions(existingSignalsArray) {
  const now = Date.now();
  if (cache.data && now - cache.at < CACHE_MS) return cache.data;
  if (inFlight) return inFlight;

  const existingSignals = {};
  (existingSignalsArray || []).forEach((s) => {
    if (s && s.code) existingSignals[s.code] = s;
  });

  inFlight = buildPredictions(existingSignals)
    .then((data) => {
      cache = { data, at: Date.now() };
      inFlight = null;
      return data;
    })
    .catch((err) => {
      inFlight = null;
      throw err;
    });

  return inFlight;
}

module.exports = { getPredictions, PAIRS, CACHE_MS };
