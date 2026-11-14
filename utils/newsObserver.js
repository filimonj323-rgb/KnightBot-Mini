/**
 * newsObserver.js — kumbukumbu ya matukio ya economic calendar.
 *
 * KAZI 1 — Kurekodi LINI `actual` ilipatikana:
 *   Kila sekunde ~20 (HATA News Trading ikiwa imezimwa) bot inaangalia feed. Tukio la High/Medium lililotoka likiwa
 *   bila actual linafuatiliwa (feed mpya angalau kila dakika 1). Actual ikionekana, tunahifadhi muda huo
 *   (fx_calendar_obs.firstSeenAt) ili ulinganishe na muda uliotangazwa (scheduledAt). `exact=1` = tuliliona bila actual
 *   kabla (usahihi ~sekunde 20-60); `exact=0` = actual ilikuwa tayari ipo tulipoliona kwa mara ya kwanza ("≤").
 *
 * KAZI 2 — Uchunguzi wa chanzo: inahesabu matukio yaliyokwisha toka yenye actual vs yasiyo nayo (coverage). Vyanzo vingine
 *   vinasema feed ya bure ya ForexFactory haitoi `actual` kabisa — kama coverage ni 0, News Trading haiwezi kufanya kazi
 *   kwa feed hii na dashboard inaonya waziwazi.
 *
 * KAZI 3 — Data ya backtest: kila tukio lililoonekana lina actual huhifadhiwa kabisa (feed ya wiki hii hupotea wiki ijayo),
 *   na unaweza kuingiza (import) historia kutoka CSV/JSON (source='import').
 */
const db = require('../pairing/db');
const economicCalendar = require('./economicCalendar');
const { CURRENCY_PAIR } = require('./newsLogic');

const CURRENCIES = Object.keys(CURRENCY_PAIR);
const TICK_MS = Math.max(10000, Number(process.env.NEWS_OBSERVE_TICK_MS || 20000));
const OBS_WINDOW_MS = 15 * 60000;     // fuatilia actual hadi dakika 15 baada ya release
const FRESH_FEED_MS = 60 * 1000;      // feed mpya angalau kila dakika 1 wakati wa kusubiri actual (kinga ya rate-limit)
const UNKNOWN_AFTER_MS = 30 * 60000;  // actual ikionekana mara ya kwanza baada ya dakika 30 → muda halisi haujulikani
const OBS_IMPACTS = ['high', 'medium'];
const MAX_IMPORT_ROWS = 5000;

let timer = null;
let busy = false;
let known = null;                      // Set ya eventKey zilizohifadhiwa tayari (inapakiwa mara ya kwanza)
const pendingSeen = new Set();         // eventKey zilizoonekana bila actual
let lastCoverage = { released: 0, withActual: 0, checkedAt: 0, lacksActual: false };

const hasValue = (v) => v !== null && v !== undefined && String(v).trim() !== '';
const lower = (v) => String(v || '').toLowerCase();

function eventKeyOf(country, date, title) {
  const t = typeof date === 'number' ? date : new Date(date).getTime();
  if (!Number.isFinite(t)) return null;
  return `${String(country || '').toUpperCase()}|${new Date(t).toISOString().slice(0, 16)}|${String(title || '').replace(/\|/g, '/').trim()}`;
}

// ── Kufuatilia feed ───────────────────────────────────────────────────────────────────────────
async function loadKnown() {
  known = new Set();
  const r = await db.query('SELECT eventKey FROM fx_calendar_obs WHERE scheduledAt >= ?', [Date.now() - 8 * 86400000]);
  for (const row of r.rows || []) known.add(String(row.eventKey));
}

async function observe() {
  if (busy) return;
  busy = true;
  try {
    await db.initSchema();
    if (!known) await loadKnown();
    let view = await economicCalendar.getWeekView(CURRENCIES);
    if (!view.available) return;

    const now = Date.now();
    const pick = (v) => (v.events || []).filter((e) => OBS_IMPACTS.includes(lower(e.impact)));
    let relevant = pick(view);

    // Tukio lilitoka ndani ya dirisha bila actual → lazimisha feed mpya (si cache ya dakika 15).
    const waiting = relevant.some((e) => {
      const t = new Date(e.date).getTime();
      return Number.isFinite(t) && t <= now && now - t <= OBS_WINDOW_MS && !hasValue(e.actual);
    });
    if (waiting) {
      const fresh = await economicCalendar.getWeekView(CURRENCIES, { maxAgeMs: FRESH_FEED_MS });
      if (fresh.available) { view = fresh; relevant = pick(view); }
    }

    let released = 0;
    let withActual = 0;
    for (const e of relevant) {
      const t = new Date(e.date).getTime();
      if (!Number.isFinite(t) || t > now) continue;
      const key = eventKeyOf(e.country, t, e.title);
      if (!key) continue;
      const has = hasValue(e.actual);
      if (now - t > 5 * 60000) { released += 1; if (has) withActual += 1; } // coverage: matukio yaliyokwisha toka kwa uhakika

      if (!has) {
        if (now - t <= OBS_WINDOW_MS) pendingSeen.add(key);
        continue;
      }
      if (known.has(key)) continue;

      const exact = pendingSeen.has(key);
      const age = now - t;
      const seen = exact || age <= UNKNOWN_AFTER_MS;
      await db.query(
        `INSERT INTO fx_calendar_obs (eventKey, currency, title, impact, scheduledAt, forecast, previous, actual, firstSeenAt, lagSec, exact, source, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed', ?)
         ON CONFLICT(eventKey) DO UPDATE SET
           impact = excluded.impact, forecast = excluded.forecast, previous = excluded.previous, actual = excluded.actual,
           firstSeenAt = COALESCE(fx_calendar_obs.firstSeenAt, excluded.firstSeenAt),
           lagSec = COALESCE(fx_calendar_obs.lagSec, excluded.lagSec),
           exact = COALESCE(fx_calendar_obs.exact, excluded.exact),
           source = 'observed', updatedAt = excluded.updatedAt`,
        [key, e.country, e.title, e.impact, t, e.forecast ?? null, e.previous ?? null, String(e.actual),
          seen ? now : null, seen ? Math.max(0, Math.round(age / 1000)) : null, exact ? 1 : 0, now]
      );
      known.add(key);
      pendingSeen.delete(key);
    }
    lastCoverage = { released, withActual, checkedAt: now, lacksActual: released >= 3 && withActual === 0 };
  } catch (err) {
    console.error('[newsObserver] observe imeshindwa:', err.message);
  } finally {
    busy = false;
  }
}

async function start() {
  if (timer) return;
  timer = setInterval(() => { observe().catch((e) => console.error('[newsObserver]', e.message)); }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log(`[newsObserver] ✅ Imeanza — inarekodi muda wa actual (tick kila sekunde ${Math.round(TICK_MS / 1000)}).`);
  observe().catch(() => {});
}

function stop() { if (timer) clearInterval(timer); timer = null; }
function getCoverage() { return { ...lastCoverage }; }

/** Ongeza `obs` ({seenAt, lagSec, exact}) kwenye matukio ya calendar; actual tupu inajazwa kutoka DB ikiwepo. */
async function attach(events) {
  if (!Array.isArray(events) || !events.length) return events || [];
  const times = events.map((e) => new Date(e.date).getTime()).filter(Number.isFinite);
  if (!times.length) return events;
  try {
    await db.initSchema();
    const r = await db.query(
      'SELECT eventKey, firstSeenAt, lagSec, exact, actual FROM fx_calendar_obs WHERE scheduledAt BETWEEN ? AND ?',
      [Math.min(...times) - 60000, Math.max(...times) + 60000]
    );
    const m = new Map((r.rows || []).map((x) => [String(x.eventKey), x]));
    return events.map((e) => {
      const row = m.get(eventKeyOf(e.country || e.currency, e.date, e.title));
      if (!row) return { ...e, obs: null };
      const filled = !hasValue(e.actual) && hasValue(row.actual) ? { actual: row.actual, actualSource: 'db' } : {};
      return {
        ...e, ...filled,
        obs: { seenAt: row.firstSeenAt == null ? null : Number(row.firstSeenAt), lagSec: row.lagSec == null ? null : Number(row.lagSec), exact: Number(row.exact) === 1 },
      };
    });
  } catch (err) {
    return events.map((e) => ({ ...e, obs: null }));
  }
}

// ── Kuingiza historia (CSV/JSON) ──────────────────────────────────────────────────────────────
function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const COLS = {
  date: ['date', 'datetime', 'timestamp', 'releasetime', 'release', 'date_time', 'scheduledat'],
  time: ['time', 'hour'],
  currency: ['currency', 'country', 'ccy', 'cur'],
  title: ['event', 'title', 'name', 'indicator'],
  impact: ['impact', 'importance', 'volatility'],
  forecast: ['forecast', 'consensus', 'estimate', 'expected'],
  previous: ['previous', 'prev'],
  actual: ['actual', 'result', 'value'],
};

function pick(obj, names) {
  for (const n of names) if (obj[n] !== undefined && String(obj[n]).trim() !== '') return String(obj[n]).trim();
  return '';
}

function normImpact(v) {
  const s = lower(v);
  if (/^(high|3|red|h)$/.test(s) || s.includes('high')) return 'High';
  if (/^(medium|med|2|orange|m)$/.test(s) || s.includes('med')) return 'Medium';
  return 'Low';
}

/** "YYYY-MM-DD[ T]HH:mm[:ss]" bila zone = saa za mahali (utcOffsetMin dakika mbele ya UTC); ISO yenye Z/offset inatumika kama ilivyo. */
function parseWhen(dateStr, timeStr, utcOffsetMin) {
  let d = String(dateStr || '').trim();
  if (!d) return null;
  if (/^\d{13}$/.test(d)) return Number(d);
  if (/^\d{10}$/.test(d)) return Number(d) * 1000;
  if (timeStr && !/\d{1,2}:\d{2}/.test(d)) {
    const m = String(timeStr).trim().toLowerCase().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/);
    if (!m) return null;
    let h = Number(m[1]);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    d = `${d} ${String(h).padStart(2, '0')}:${m[2]}`;
  }
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(d) && /\d{2}:\d{2}/.test(d)) {
    const t = Date.parse(d.replace(' ', 'T'));
    return Number.isFinite(t) ? t : null;
  }
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  return utc - (Number(utcOffsetMin) || 0) * 60000;
}

/** Safu muhimu lazima zipatikane (kwa jina lolote linalojulikana) — vinginevyo ujumbe wazi, si 0 kimya kimya. */
function assertColumns(keys) {
  const have = new Set(keys);
  const missing = [];
  for (const [label, names] of [['date', COLS.date], ['currency', COLS.currency], ['event/title', COLS.title], ['actual', COLS.actual]]) {
    if (!names.some((n) => have.has(n))) missing.push(label);
  }
  if (missing.length) {
    throw new Error(`Safu zinazohitajika hazipo: ${missing.join(', ')}. Vichwa vilivyopatikana: ${[...have].slice(0, 12).join(', ') || '(hakuna)'}.`);
  }
}

/** @returns {{rows: object[], skipped: object}} — rows ziko tayari kuingizwa. */
function parseImportText(text, { utcOffsetMin = 0 } = {}) {
  const src = String(text || '').trim();
  const skipped = { noDate: 0, badCurrency: 0, noTitle: 0, noActual: 0 };
  if (!src) return { rows: [], skipped };
  let objs = [];
  if (src[0] === '[' || src[0] === '{') {
    let j;
    try { j = JSON.parse(src); } catch (e) { throw new Error('JSON si sahihi: ' + e.message); }
    objs = Array.isArray(j) ? j : Array.isArray(j.events) ? j.events : Array.isArray(j.data) ? j.data : [];
    objs = objs.map((o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [lower(k).replace(/[\s-]/g, ''), v == null ? '' : String(v)])));
    if (objs.length) assertColumns(new Set(objs.slice(0, 5).flatMap((o) => Object.keys(o))));
  } else {
    const lines = src.split(/\r?\n/).filter((l) => l.trim() !== '');
    if (lines.length < 2) throw new Error('CSV inahitaji mstari wa vichwa (header) na angalau mstari mmoja wa data.');
    const delim = [',', ';', '\t'].map((d) => [d, lines[0].split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const head = splitCsvLine(lines[0], delim).map((h) => lower(h).replace(/[\s-]/g, ''));
    assertColumns(new Set(head));
    objs = lines.slice(1).map((l) => {
      const cells = splitCsvLine(l, delim);
      return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? '']));
    });
  }
  if (objs.length > MAX_IMPORT_ROWS) throw new Error(`Mistari ni mingi mno (${objs.length}). Kikomo ni ${MAX_IMPORT_ROWS} kwa mara moja — gawa faili.`);

  const rows = [];
  for (const o of objs) {
    const t = parseWhen(pick(o, COLS.date), pick(o, COLS.time), utcOffsetMin);
    if (t == null) { skipped.noDate += 1; continue; }
    const cur = pick(o, COLS.currency).toUpperCase();
    if (!CURRENCY_PAIR[cur]) { skipped.badCurrency += 1; continue; }
    const title = pick(o, COLS.title);
    if (!title) { skipped.noTitle += 1; continue; }
    const actual = pick(o, COLS.actual);
    if (!actual) { skipped.noActual += 1; continue; }
    rows.push({
      key: eventKeyOf(cur, t, title), currency: cur, title, impact: normImpact(pick(o, COLS.impact)), scheduledAt: t,
      forecast: pick(o, COLS.forecast) || null, previous: pick(o, COLS.previous) || null, actual,
    });
  }
  return { rows, skipped };
}

async function importEvents(text, opts = {}) {
  const { rows, skipped } = parseImportText(text, opts);
  if (!rows.length) return { ok: true, parsed: 0, imported: 0, skipped, range: null };
  await db.initSchema();
  const now = Date.now();
  let imported = 0;
  for (let i = 0; i < rows.length; i += 40) {
    const chunk = rows.slice(i, i + 40);
    const params = [];
    const values = chunk.map((r) => {
      params.push(r.key, r.currency, r.title, r.impact, r.scheduledAt, r.forecast, r.previous, r.actual, now);
      return "(?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'import', ?)";
    });
    await db.query(
      `INSERT INTO fx_calendar_obs (eventKey, currency, title, impact, scheduledAt, forecast, previous, actual, firstSeenAt, lagSec, exact, source, updatedAt)
       VALUES ${values.join(', ')}
       ON CONFLICT(eventKey) DO UPDATE SET impact = excluded.impact, forecast = excluded.forecast, previous = excluded.previous,
         actual = excluded.actual, updatedAt = excluded.updatedAt
       WHERE fx_calendar_obs.source = 'import'`,
      params
    );
    imported += chunk.length;
  }
  if (known) for (const r of rows) known.add(r.key);
  const ts = rows.map((r) => r.scheduledAt);
  return { ok: true, parsed: rows.length, imported, skipped, range: { from: Math.min(...ts), to: Math.max(...ts) } };
}

async function getDataStats() {
  await db.initSchema();
  const r = await db.query(
    `SELECT source, COUNT(*) AS n, MIN(scheduledAt) AS a, MAX(scheduledAt) AS b
       FROM fx_calendar_obs WHERE actual IS NOT NULL AND forecast IS NOT NULL GROUP BY source`, []);
  const out = { observed: { n: 0, from: null, to: null }, import: { n: 0, from: null, to: null }, total: 0 };
  for (const row of r.rows || []) {
    const k = row.source === 'import' ? 'import' : 'observed';
    out[k] = { n: Number(row.n) || 0, from: row.a == null ? null : Number(row.a), to: row.b == null ? null : Number(row.b) };
    out.total += out[k].n;
  }
  return out;
}

async function clearImported() {
  await db.initSchema();
  const r = await db.query("DELETE FROM fx_calendar_obs WHERE source = 'import'", []);
  known = null;
  return { ok: true, deleted: Number(r.rowsAffected) || 0 };
}

/** Matukio kwa backtest: yenye forecast+actual, kati ya fromMs..toMs, impact zilizochaguliwa. */
async function getEventsBetween({ fromMs, toMs, impacts = ['High'] }) {
  await db.initSchema();
  const want = new Set(impacts.map((x) => lower(x)));
  const r = await db.query(
    `SELECT eventKey, currency AS country, title, impact, scheduledAt, forecast, previous, actual
       FROM fx_calendar_obs WHERE scheduledAt BETWEEN ? AND ? AND actual IS NOT NULL AND forecast IS NOT NULL
       ORDER BY scheduledAt ASC`, [fromMs, toMs]);
  return (r.rows || [])
    .filter((x) => want.has(lower(x.impact)))
    .map((x) => ({ ...x, scheduledAt: Number(x.scheduledAt) }));
}

module.exports = {
  start, stop, observe, attach, eventKeyOf, getCoverage,
  importEvents, parseImportText, getDataStats, clearImported, getEventsBetween,
  OBS_IMPACTS,
  _reset: () => { known = null; pendingSeen.clear(); lastCoverage = { released: 0, withActual: 0, checkedAt: 0, lacksActual: false }; },
};
