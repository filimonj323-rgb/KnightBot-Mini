/**
 * actualsProvider.js — chanzo cha PILI cha `actual` kwa economic calendar.
 *
 * TATIZO: feed ya bure (nfs.faireconomy.media/ff_calendar_thisweek.json) haitoi `actual` kabisa
 * (ina title/country/date/impact/forecast/previous tu). Kwa hiyo News Trader haikuwahi kuona actual.
 *
 * SULUHISHO: tunasoma ukurasa wa ForexFactory wenyewe (ule ule unaouona kwenye simu) na kuunganisha
 * actual/forecast/previous kwenye matukio ya feed. Vyanzo (kwa mpangilio):
 *   1) NEWS_ACTUALS_URL (hiari) — JSON array yako mwenyewe; kila kipengele:
 *        { title, country|currency, date (ISO) | timestamp (sekunde), actual, forecast, previous, impact, id }
 *   2) ForexFactory: https://www.forexfactory.com/calendar?week=this
 *        - inasoma JSON iliyopachikwa (`calendarComponentStates`), na kama haipo, inasoma safu za HTML.
 *      Zima kwa NEWS_FF_SCRAPE=false.
 *
 * ⚠️ ForexFactory iko nyuma ya Cloudflare; IP za datacenter wakati mwingine hupewa 403. Kama hilo
 * likitokea, tumia NEWS_ACTUALS_URL (au NEWS_FF_PROXY_URL kama una proxy ya HTTP) — logi itasema wazi.
 * Moduli hii HAITUPI error kwa juu: ikishindwa, feed ya kawaida inaendelea kufanya kazi.
 */

const axios = require('axios');

const FF_URL = process.env.NEWS_FF_URL || 'https://www.forexfactory.com/calendar?week=this';
const CUSTOM_URL = process.env.NEWS_ACTUALS_URL || '';
const FF_ENABLED = String(process.env.NEWS_FF_SCRAPE || 'true').toLowerCase() !== 'false';
const TIMEOUT_MS = 12000;
const ERROR_COOLDOWN_MS = 90 * 1000;          // baada ya hitilafu
const BLOCK_COOLDOWN_MS = 15 * 60 * 1000;     // baada ya 403/429 (imezuiwa)
const MIN_GAP_MS = 20 * 1000;                 // usigonge chanzo mara nyingi zaidi ya hapa

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

let state = { data: null, at: 0, source: null, lastError: null };
let blockedUntil = 0;
let inflight = null;
let lastLogAt = 0;

const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const clean = (v) => (hasValue(v) ? String(v).replace(/\s+/g, ' ').trim() : null);

function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

function normImpact(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('high') || s.includes('red')) return 'High';
  if (s.includes('med') || s.includes('ora')) return 'Medium';
  if (s.includes('low') || s.includes('yel')) return 'Low';
  if (s.includes('hol') || s.includes('gra')) return 'Holiday';
  return null;
}

// ── ForexFactory: JSON iliyopachikwa kwenye ukurasa ───────────────────────────────────────
function extractBalancedJson(text, startIdx) {
  const open = text[startIdx];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return text.slice(startIdx, i + 1); }
  }
  return null;
}

function parseFfEmbedded(html) {
  const marker = html.indexOf('calendarComponentStates');
  if (marker < 0) return null;
  const out = [];
  const re = /calendarComponentStates\s*\[\s*\d+\s*\]\s*=\s*/g;
  re.lastIndex = marker;
  let m;
  while ((m = re.exec(html))) {
    const json = extractBalancedJson(html, re.lastIndex);
    if (!json) continue;
    let obj;
    try { obj = JSON.parse(json); } catch (_) { continue; }
    for (const day of obj.days || []) {
      for (const ev of day.events || []) {
        const ts = Number(ev.dateline);
        if (!Number.isFinite(ts) || !ev.name) continue;
        out.push({
          id: ev.id != null ? String(ev.id) : null,
          title: clean(ev.name),
          country: String(ev.currency || '').toUpperCase(),
          ts: ts * 1000,
          impact: normImpact(ev.impactName || ev.impactTitle),
          actual: clean(ev.actual),
          forecast: clean(ev.forecast),
          previous: clean(ev.previous),
        });
      }
    }
  }
  return out.length ? out : null;
}

// ── ForexFactory: fallback ya safu za HTML (cheerio) ──────────────────────────────────────
function parseFfRows(html) {
  let cheerio;
  try { cheerio = require('cheerio'); } catch (_) { return null; }
  const $ = cheerio.load(html);
  const out = [];
  let dayStart = null;   // epoch ya siku ya sasa (UTC midnight ya tarehe iliyoandikwa)
  let lastTime = null;
  $('tr.calendar__row').each((_, tr) => {
    const row = $(tr);
    const dl = row.attr('data-day-start') || row.attr('data-dayline');
    if (dl && Number.isFinite(Number(dl))) dayStart = Number(dl) * 1000;
    const title = clean(row.find('.calendar__event-title').first().text());
    const cur = clean(row.find('.calendar__currency').first().text());
    if (!title || !cur) return;
    const ts = Number(row.attr('data-timestamp') || row.attr('data-dateline'));
    let when = Number.isFinite(ts) ? ts * 1000 : null;
    const timeTxt = clean(row.find('.calendar__time').first().text());
    if (when == null && dayStart != null) {
      const t = timeTxt || lastTime;
      const mm = t && /^(\d{1,2}):(\d{2})(am|pm)$/i.exec(t.replace(/\s+/g, ''));
      if (mm) {
        let h = Number(mm[1]) % 12;
        if (/pm/i.test(mm[3])) h += 12;
        when = dayStart + (h * 60 + Number(mm[2])) * 60000;
      }
    }
    if (timeTxt) lastTime = timeTxt;
    if (when == null) return;
    const impactCls = (row.find('.calendar__impact span').first().attr('class') || '') + ' ' + (row.find('.calendar__impact span').first().attr('title') || '');
    out.push({
      id: row.attr('data-event-id') || row.attr('data-eventid') || null,
      title,
      country: cur.toUpperCase(),
      ts: when,
      impact: normImpact(impactCls),
      actual: clean(row.find('.calendar__actual').first().text()),
      forecast: clean(row.find('.calendar__forecast').first().text()),
      previous: clean(row.find('.calendar__previous').first().text()),
    });
  });
  return out.length ? out : null;
}

function parseFfPage(html) {
  return parseFfEmbedded(html) || parseFfRows(html);
}

// ── Chanzo maalum cha JSON (NEWS_ACTUALS_URL) ─────────────────────────────────────────────
function parseCustom(data) {
  const arr = Array.isArray(data) ? data : (data && (data.events || data.data)) || [];
  const out = [];
  for (const e of arr) {
    const ts = e.timestamp != null ? Number(e.timestamp) * (Number(e.timestamp) < 1e12 ? 1000 : 1) : new Date(e.date).getTime();
    const country = String(e.country || e.currency || '').toUpperCase();
    if (!Number.isFinite(ts) || !e.title || !country) continue;
    out.push({
      id: e.id != null ? String(e.id) : null,
      title: clean(e.title),
      country,
      ts,
      impact: normImpact(e.impact),
      actual: clean(e.actual),
      forecast: clean(e.forecast),
      previous: clean(e.previous),
    });
  }
  return out.length ? out : null;
}

function logOnce(msg) {
  if (Date.now() - lastLogAt > 5 * 60 * 1000) { lastLogAt = Date.now(); console.error(msg); }
}

async function fetchSources() {
  const axiosOpts = { timeout: TIMEOUT_MS, headers: HEADERS, maxRedirects: 3, responseType: 'text', transformResponse: (r) => r };
  if (process.env.NEWS_FF_PROXY_URL) {
    try {
      const u = new URL(process.env.NEWS_FF_PROXY_URL);
      axiosOpts.proxy = { protocol: u.protocol.replace(':', ''), host: u.hostname, port: Number(u.port) || 80,
        ...(u.username ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } } : {}) };
    } catch (_) { /* proxy batili — puuza */ }
  }

  if (CUSTOM_URL) {
    try {
      const r = await axios.get(CUSTOM_URL, { ...axiosOpts, headers: { ...HEADERS, Accept: 'application/json' } });
      const parsed = parseCustom(typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
      if (parsed) return { data: parsed, source: 'custom' };
      logOnce('actualsProvider: NEWS_ACTUALS_URL imerudisha data tupu/muundo usiojulikana.');
    } catch (err) {
      logOnce(`actualsProvider: NEWS_ACTUALS_URL imeshindwa: ${err.message}`);
    }
  }

  if (FF_ENABLED) {
    const r = await axios.get(FF_URL, axiosOpts);
    const parsed = parseFfPage(String(r.data || ''));
    if (!parsed) throw new Error('ForexFactory: ukurasa umepatikana lakini hakuna matukio yaliyosomeka (muundo umebadilika au ukurasa wa Cloudflare)');
    return { data: parsed, source: 'forexfactory' };
  }
  return null;
}

/** Rudisha matukio yenye actual (au null). Haitupi error. maxAgeMs = umri wa juu wa cache. */
async function getActuals(maxAgeMs = 5 * 60 * 1000) {
  const now = Date.now();
  if (!FF_ENABLED && !CUSTOM_URL) return null;
  const age = now - state.at;
  if (state.data && age < Math.max(maxAgeMs, MIN_GAP_MS)) return state.data;
  if (now < blockedUntil) return state.data;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetchSources();
      if (res) state = { data: res.data, at: Date.now(), source: res.source, lastError: null };
      blockedUntil = 0;
    } catch (err) {
      const status = err.response && err.response.status;
      const wait = status === 403 || status === 429 ? BLOCK_COOLDOWN_MS : ERROR_COOLDOWN_MS;
      blockedUntil = Date.now() + wait;
      state.lastError = status ? `HTTP ${status}` : err.message;
      logOnce(`actualsProvider: ${state.lastError}${status === 403 ? ' (Cloudflare imezuia IP ya server — tumia NEWS_ACTUALS_URL au NEWS_FF_PROXY_URL)' : ''}; nitajaribu tena baada ya dakika ${Math.round(wait / 60000 * 10) / 10}.`);
    } finally {
      inflight = null;
    }
    return state.data;
  })();
  return inflight;
}

/**
 * Unganisha actuals kwenye matukio ya feed (nakala mpya, hazibadilishi cache ya feed).
 * Mechi = currency + title (iliyosafishwa) + muda ndani ya saa 3.
 */
function mergeActuals(events, actuals) {
  if (!Array.isArray(events) || !actuals || !actuals.length) return events;
  const idx = new Map();
  for (const a of actuals) {
    const k = `${a.country}|${normTitle(a.title)}`;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(a);
  }
  return events.map((e) => {
    const t = new Date(e.date).getTime();
    const cands = idx.get(`${String(e.country || '').toUpperCase()}|${normTitle(e.title)}`);
    if (!cands || !Number.isFinite(t)) return e;
    let best = null;
    let bestD = 3 * 3600 * 1000 + 1;
    for (const c of cands) {
      const d = Math.abs(c.ts - t);
      if (d < bestD) { best = c; bestD = d; }
    }
    if (!best) return e;
    const out = { ...e };
    if (best.id) out.ffId = best.id;
    if (!hasValue(out.actual) && hasValue(best.actual)) { out.actual = best.actual; out.actualSource = state.source || 'ff'; }
    if (!hasValue(out.forecast) && hasValue(best.forecast)) out.forecast = best.forecast;
    if (!hasValue(out.previous) && hasValue(best.previous)) out.previous = best.previous;
    return out;
  });
}

/** Kama feed kuu imeshindwa kabisa, tengeneza matukio ya msingi kutoka actuals (FF kama chanzo kikuu). */
function toBaseEvents(actuals) {
  return (actuals || []).map((a) => ({
    title: a.title, country: a.country, date: new Date(a.ts).toISOString(), impact: a.impact || 'Low',
    forecast: a.forecast || '', previous: a.previous || '', actual: a.actual || '', ffId: a.id || undefined,
    actualSource: a.actual ? (state.source || 'ff') : undefined,
  }));
}

function getStatus() {
  return { source: state.source, lastFetchAt: state.at || null, count: state.data ? state.data.length : 0, lastError: state.lastError, blockedUntil: blockedUntil || null, enabled: FF_ENABLED || !!CUSTOM_URL };
}

module.exports = { getActuals, mergeActuals, toBaseEvents, getStatus, parseFfPage, parseFfEmbedded, parseFfRows, parseCustom, normTitle };
