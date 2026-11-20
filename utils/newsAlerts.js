/**
 * newsAlerts.js — Arifa za habari za soko (economic calendar, High impact) kwa owner, BILA kujali News Trading imewashwa au la.
 *
 *   ⏰ KABLA ya habari (default dk 30 na dk 5): tukio gani, forecast/previous, currency na PAIRS zitakazoathirika,
 *      na mwelekeo UNAOTARAJIWA (actual bora kuliko forecast → currency inaimarika → BUY/SELL ipi) + pair kuu ya kutrade.
 *   📣 ACTUAL ikitoka: actual vs forecast, surprise %, hukumu (currency inaimarika/inadhoofika/hakuna mwelekeo),
 *      pairs zilizoathirika na mwelekeo wake, pair ya kutrade, na kama signal ya auto-trader inakubaliana.
 *
 * Mantiki ya mwelekeo ni ileile ya News Trading (utils/newsLogic.js: scoreEvents/pairDirection) — hakuna kanuni mpya.
 * Hali ya "tayari imetumwa" inahifadhiwa (Turso) — redeploy hairudii arifa. Arifa za kabla zinatumwa TU ndani ya dirisha lake
 * (bot ikiwa imezimwa wakati huo, hazitumwi baadaye zikiwa zimechelewa).
 *
 * Env (zote hiari): NEWS_ALERTS_ENABLED ("false" = zima kabisa) • NEWS_ALERT_LEADS ("30,5") • NEWS_ALERT_TICK_MS (30000)
 *                   NEWS_ALERT_MIN_SURPRISE (10, %) • NEWS_ALERT_ACTUAL_SETTLE_SEC (60)
 * Amri: .fxnewsalert (on/off, lead, medium, group, test)
 */

const pocketStore = require('./pocketStore');
const economicCalendar = require('./economicCalendar');
const { CURRENCY_PAIR, pairDirection, scoreEvents } = require('./newsLogic');
const ms = require('./marketSessions');

const CURRENCIES = Object.keys(CURRENCY_PAIR);
const TICK_MS = Math.max(10000, Number(process.env.NEWS_ALERT_TICK_MS) || 30000);
const MIN_SURPRISE = Number(process.env.NEWS_ALERT_MIN_SURPRISE) > 0 ? Number(process.env.NEWS_ALERT_MIN_SURPRISE) : 10;
const SETTLE_MS = (Number(process.env.NEWS_ALERT_ACTUAL_SETTLE_SEC) >= 0 ? Number(process.env.NEWS_ALERT_ACTUAL_SETTLE_SEC) : 60) * 1000;
const ACTUAL_WINDOW_MIN = 20;       // actual inatafutwa hadi dakika 20 baada ya release
const FRESH_FEED_MS = 60 * 1000;
const KEEP_SENT_MS = 3 * 24 * 3600 * 1000;
const SETTINGS_KEY = 'newsalerts:settings';
const STATE_KEY = 'newsalerts:state';
const ENV_ENABLED = String(process.env.NEWS_ALERTS_ENABLED ?? 'true').toLowerCase() !== 'false';

const FLAG = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺', CAD: '🇨🇦', CHF: '🇨🇭', NZD: '🇳🇿' };
const FALLBACK_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD'];
const r1 = (n) => Math.round(Number(n) * 10) / 10;
const hasValue = (v) => v !== null && v !== undefined && v !== '';
const dirTxt = (d) => (d === 'BUY' ? '🟢 BUY' : '🔴 SELL');

function parseLeads(raw) {
  const arr = String(raw ?? '30,5').split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= 240).map(Math.round);
  return [...new Set(arr)].sort((a, b) => b - a).slice(0, 4);
}

let settings = { enabled: ENV_ENABLED, leads: parseLeads(process.env.NEWS_ALERT_LEADS), medium: false, toGroup: false };
let sent = {};               // key -> ts
let notifier = null;
let timer = null;
let ticking = false;
let firstActualSeen = new Map(); // groupKey -> ts ya kwanza bot ilipoona actual

// ── Kazi safi ─────────────────────────────────────────────────────────────────────────────────
/** Kundi = currency moja + dakika moja (kama News Trading). */
function buildGroups(events, impacts = ['high']) {
  const groups = new Map();
  for (const e of events || []) {
    if (!impacts.includes(String(e.impact).toLowerCase())) continue;
    if (!CURRENCY_PAIR[e.country]) continue;
    const t = new Date(e.date).getTime();
    if (!Number.isFinite(t)) continue;
    const key = `${e.country}|${new Date(t).toISOString().slice(0, 16)}`;
    if (!groups.has(key)) groups.set(key, { key, currency: e.country, t, events: [] });
    groups.get(key).events.push(e);
  }
  return [...groups.values()].sort((a, b) => a.t - b.t);
}

/** Pairs zote (kati ya zile bot inazofuatilia) zenye currency hii + mwelekeo ikiwa currency inaimarika (strong=true) au inadhoofika. */
function affectedPairs(currency, strong, pairList) {
  const list = (pairList && pairList.length ? pairList : FALLBACK_PAIRS).filter((c) => c.includes(currency));
  const main = pairDirection(currency, strong);
  const out = list.map((code) => {
    const isBase = code.slice(0, 3) === currency;
    return { code, direction: strong === isBase ? 'BUY' : 'SELL', main: !!(main && main.pair === code) };
  });
  if (main && !out.some((x) => x.code === main.pair)) out.unshift({ code: main.pair, direction: main.direction, main: true });
  out.sort((a, b) => Number(b.main) - Number(a.main));
  return out;
}

const pairsLine = (arr) => arr.map((p) => `${p.main ? '⭐ ' : ''}${p.code} ${dirTxt(p.direction)}`).join(' • ');

function eventLine(e) {
  const bits = [];
  if (hasValue(e.forecast)) bits.push(`Forecast ${e.forecast}`);
  if (hasValue(e.previous)) bits.push(`Previous ${e.previous}`);
  const inv = economicCalendar.isInverseIndicator(e.title) ? ' _(chini ni bora)_' : '';
  return `• ${e.title}${inv}${bits.length ? ' — ' + bits.join(' | ') : ''}`;
}

/** Mwelekeo wa jumla wa kundi baada ya actual: {net, maxPct, summary} (sheria ileile ya News Trading). */
function judge(group, minSurprise = MIN_SURPRISE) {
  const usable = group.events.filter((e) => economicCalendar.parseNumeric(e.forecast) != null && economicCalendar.parseNumeric(e.actual) != null);
  if (!usable.length) return null;
  return { usable, ...scoreEvents(usable, minSurprise) };
}

function msgPre(group, lead, ctx = {}) {
  const c = group.currency;
  const now = ctx.now ?? Date.now();
  const mins = Math.max(1, Math.round((group.t - now) / 60000));
  const strongList = affectedPairs(c, true, ctx.pairs);
  const weakList = affectedPairs(c, false, ctx.pairs);
  const allInverse = group.events.every((e) => economicCalendar.isInverseIndicator(e.title));
  const anyInverse = group.events.some((e) => economicCalendar.isInverseIndicator(e.title));
  const better = allInverse ? 'Actual CHINI ya forecast (bora kwa kiashiria hiki)' : 'Actual JUU ya forecast (bora kuliko ilivyotarajiwa)';
  const worse = allInverse ? 'Actual JUU ya forecast (mbaya kwa kiashiria hiki)' : 'Actual CHINI ya forecast (mbaya kuliko ilivyotarajiwa)';
  const main = pairDirection(c, true);
  const open = (ctx.openTrades || []).filter((t) => String(t.code).includes(c)).map((t) => `${t.code} ${t.direction}`);
  const L = [];
  L.push(`${lead <= 5 ? '🚨' : '📰'} *HABARI KUBWA (HIGH IMPACT) — BAADA YA DK ${mins}* ${FLAG[c] || ''}`);
  L.push('');
  L.push(`🕐 ${ms.fmtWhen(group.t)}`);
  L.push(`💱 Currency: *${c}*`);
  L.push(...group.events.map(eventLine));
  L.push('', `🎯 *Pairs zitakazoathirika:* ${strongList.map((p) => p.code).join(', ')}`);
  L.push('', '📐 *Mwelekeo unaotarajiwa*');
  L.push(`• ${better} → *${c} inaimarika* → ${pairsLine(strongList)}`);
  L.push(`• ${worse} → *${c} inadhoofika* → ${pairsLine(weakList)}`);
  if (anyInverse && !allInverse) L.push('_Kuna viashiria vya "chini ni bora" (mfano Unemployment/Jobless Claims) — kwa hivyo hesabu kinyume._');
  if (main) L.push('', `⭐ *Pair kuu ya kutrade:* ${main.pair} (inategemea actual itakavyokuwa).`);
  L.push('', '⚠️ *Tahadhari*', '• Spread na volatility huongezeka sana dakika chache kabla na baada ya habari.', '• Usifungue trade kabla ya actual kutoka; usifukuze mwendo ulioshafanyika.');
  if (open.length) L.push(`• Una trades zilizo wazi kwenye pairs hizi: ${open.join(', ')} — fikiria kuzifunga/kulinda.`);
  if (ctx.newsTradingLine) L.push('', ctx.newsTradingLine);
  L.push('', '_Hii si ushauri wa kifedha._');
  return L.join('\n');
}

function msgActual(group, ctx = {}) {
  const c = group.currency;
  const j = judge(group, ctx.minSurprise ?? MIN_SURPRISE);
  const now = ctx.now ?? Date.now();
  const ageMin = Math.max(0, Math.round((now - group.t) / 60000));
  const L = [`📣 *ACTUAL IMETOKA — ${c}* ${FLAG[c] || ''}`, '', `🕐 Release: ${ms.fmtWhen(group.t)}${ageMin ? ` (dk ${ageMin} zilizopita)` : ''}`, ''];
  for (const e of group.events) {
    const a = economicCalendar.parseNumeric(e.actual), f = economicCalendar.parseNumeric(e.forecast);
    if (!hasValue(e.actual)) { L.push(`• ${e.title}: actual bado haijatoka`); continue; }
    let tail = '';
    if (a != null && f != null) {
      const pct = (Math.abs(a - f) / Math.max(Math.abs(f), 0.1)) * 100;
      const inv = economicCalendar.isInverseIndicator(e.title);
      const better = inv ? a < f : a > f;
      tail = a === f ? ' → sawa na forecast' : ` → ${better ? '⬆️ bora' : '⬇️ mbaya'} kuliko forecast (${r1(pct)}%)`;
    }
    L.push(`• ${e.title}: *${e.actual}*${hasValue(e.forecast) ? ` vs forecast ${e.forecast}` : ''}${hasValue(e.previous) ? ` (previous ${e.previous})` : ''}${tail}`);
  }
  if (!j || j.net === 0) {
    L.push('', `⚪ *Hukumu:* hakuna mwelekeo wazi (surprise ndogo au viashiria vinapingana)${j ? ` — ${j.summary}` : ''}.`);
    L.push('', '🙅 *Usitrade kwa habari hii* — hakuna faida ya wazi. Subiri setup nyingine.');
    return L.join('\n');
  }
  const strong = j.net > 0;
  const pairs = affectedPairs(c, strong, ctx.pairs);
  const main = pairs.find((p) => p.main) || pairs[0];
  L.push('', `🧭 *Hukumu:* ${c} ${strong ? '🟢 INAIMARIKA' : '🔴 INADHOOFIKA'} — nguvu ya surprise ${r1(j.maxPct)}%`);
  L.push('', `🎯 *Pairs zilizoathirika na mwelekeo:*`, pairsLine(pairs));
  L.push('', `✅ *Ya kutrade:* ${dirTxt(main.direction)} *${main.code}*`);
  const sig = (ctx.signals || []).find((s) => s.code === main.code);
  if (sig && (sig.direction === 'BUY' || sig.direction === 'SELL')) {
    const same = sig.direction === main.direction;
    L.push(`${same ? '🤝' : '⚠️'} Signal ya auto-trader (${main.code}): ${dirTxt(sig.direction)} ${sig.strength != null ? Math.round(sig.strength) + '%' : ''} — ${same ? 'inakubaliana na habari' : 'INAPINGANA na habari, kuwa makini'}`);
  }
  L.push('', `⏱️ Bei inaweza kuwa imeshasogea ${ageMin >= 1 ? `(tayari dk ${ageMin})` : ''} — usifukuze mwendo; weka SL/TP kila wakati na ushikilie muda mfupi (mwendo wa habari huisha haraka).`);
  if (ctx.newsTradingLine) L.push('', ctx.newsTradingLine);
  L.push('', '_Hii si ushauri wa kifedha._');
  return L.join('\n');
}

/** Ni kundi gani linahitaji arifa SASA? Kazi safi: inarudisha [{kind:'pre'|'actual', group, lead?, key}]. */
function dueAlerts(groups, now, st) {
  const out = [];
  const leads = st.leads || [];
  for (const g of groups) {
    const remMin = (g.t - now) / 60000;
    for (const lead of leads) {
      if (remMin <= lead && remMin > lead - 4 && remMin > 0) {
        const key = `pre:${g.key}:${lead}`;
        if (!st.sent[key]) out.push({ kind: 'pre', group: g, lead, key });
      }
    }
    const age = -remMin;
    if (age >= 0 && age <= ACTUAL_WINDOW_MIN) {
      const key = `act:${g.key}`;
      if (st.sent[key]) continue;
      const needed = g.events.filter((e) => economicCalendar.parseNumeric(e.forecast) != null);
      if (!needed.length) continue; // hotuba/taarifa bila namba — hakuna actual ya kuhukumu
      const withActual = needed.filter((e) => economicCalendar.parseNumeric(e.actual) != null);
      if (!withActual.length) continue;
      const first = st.firstActual && st.firstActual.get(g.key);
      const allIn = withActual.length === needed.length;
      if (allIn || (first && now - first >= SETTLE_MS)) out.push({ kind: 'actual', group: g, key });
    }
  }
  return out;
}

// ── Mazingira (auto-trader + News Trading) ────────────────────────────────────────────────────
function getContext() {
  const ctx = { pairs: [], signals: [], openTrades: [], newsTradingLine: '' };
  try {
    const st = require('./autoTrader').getStatus();
    ctx.pairs = st.pairs || [];
    ctx.signals = st.signals || [];
    ctx.openTrades = st.openTrades || [];
  } catch (_) { /* si lazima */ }
  return ctx;
}

async function newsTradingLine(currencyHasPair = true) {
  try {
    const nt = require('./newsTrader');
    const cfg = await nt.getConfig();
    const mode = require('./derivTrader').getAccountMode();
    if (!cfg.enabled) return '📡 News Trading: *IMEZIMWA* — bot haitafungua trade ya habari hii (unaweza kutrade mwenyewe).';
    if (mode === 'real' && !cfg.allowReal) return '📡 News Trading: IMEWASHWA lakini akaunti ni *REAL* na ruhusa ya REAL imezimwa — haitafanya trade.';
    return `📡 News Trading: *IMEWASHWA* (${String(mode || '?').toUpperCase()}) — bot itaamua yenyewe kulingana na actual (stake $${cfg.stake}).`;
  } catch (_) { return ''; }
}

// ── Hali & utumaji ────────────────────────────────────────────────────────────────────────────
async function loadAll() {
  try {
    const rows = await pocketStore.loadSettings('newsalerts:');
    for (const { key, value } of rows) {
      const v = JSON.parse(value);
      if (key === SETTINGS_KEY) {
        settings = {
          enabled: ENV_ENABLED && v.enabled !== false,
          leads: Array.isArray(v.leads) && v.leads.length ? parseLeads(v.leads.join(',')) : settings.leads,
          medium: v.medium === true,
          toGroup: v.toGroup === true,
        };
      } else if (key === STATE_KEY && v && typeof v === 'object') sent = v;
    }
  } catch (err) { console.error('[newsAlerts] imeshindwa kusoma mpangilio/hali:', err.message); }
}
const saveSettings = () => pocketStore.saveSetting(SETTINGS_KEY, settings);
function pruneSent(now) { for (const k of Object.keys(sent)) if (now - sent[k] > KEEP_SENT_MS) delete sent[k]; }
const saveState = () => pocketStore.saveSetting(STATE_KEY, sent);

async function deliver(text) {
  let ok = false;
  try { if (notifier) ok = (await notifier(text)) !== false; } catch (err) { console.error('[newsAlerts] DM imeshindwa:', err.message); }
  if (!ok) setTimeout(() => { Promise.resolve(notifier && notifier(text)).catch(() => {}); }, 15000).unref?.();
  if (settings.toGroup) { try { await require('./signalTargets').sendSignal('deriv', text); } catch (_) { /* group si lazima */ } }
}

async function tick(now = Date.now()) {
  if (ticking || !settings.enabled) return;
  ticking = true;
  try {
    const impacts = settings.medium ? ['high', 'medium'] : ['high'];
    let view = await economicCalendar.getWeekView(CURRENCIES);
    if (!view.available) return;
    let groups = buildGroups(view.events, impacts).filter((g) => now - g.t < 3600000 && g.t - now < 6 * 3600000);
    if (!groups.length) return;

    // Kuna tukio lililotoka bila actual → lazimisha feed mpya (si cache ya dakika 15) ili actual ipatikane haraka.
    const awaiting = groups.some((g) => now >= g.t && now - g.t <= ACTUAL_WINDOW_MIN * 60000 && !sent[`act:${g.key}`] && g.events.some((e) => !hasValue(e.actual)));
    if (awaiting) {
      const fresh = await economicCalendar.getWeekView(CURRENCIES, { maxAgeMs: FRESH_FEED_MS });
      if (fresh.available) { view = fresh; groups = buildGroups(view.events, impacts).filter((g) => now - g.t < 3600000 && g.t - now < 6 * 3600000); }
    }
    for (const g of groups) if (g.events.some((e) => hasValue(e.actual)) && !firstActualSeen.has(g.key)) firstActualSeen.set(g.key, now);

    const due = dueAlerts(groups, now, { leads: settings.leads, sent, firstActual: firstActualSeen });
    if (!due.length) return;
    const ctx = { ...getContext(), now, newsTradingLine: await newsTradingLine() };
    for (const d of due) {
      sent[d.key] = now;
      pruneSent(now);
      await saveState(); // hifadhi KABLA ya kutuma — redeploy katikati isirudie
      await deliver(d.kind === 'pre' ? msgPre(d.group, d.lead, ctx) : msgActual(d.group, ctx));
      await new Promise((r) => setTimeout(r, 2500));
    }
  } catch (err) {
    console.error('[newsAlerts] tick:', err.message);
  } finally {
    ticking = false;
  }
}

async function start({ notify } = {}) {
  if (typeof notify === 'function') notifier = notify;
  if (timer) return true;
  await loadAll();
  console.log(`[newsAlerts] ${settings.enabled ? '✅ IMEWASHWA' : 'imezimwa (.fxnewsalert on)'} — arifa kabla ya habari: dk ${settings.leads.join('/')}, + actual ikitoka; ukaguzi kila sekunde ${Math.round(TICK_MS / 1000)}.`);
  tick().catch(() => {});
  timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  timer.unref?.();
  return true;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

async function update(patch) {
  if (patch.enabled !== undefined) settings.enabled = !!patch.enabled && ENV_ENABLED;
  if (patch.medium !== undefined) settings.medium = !!patch.medium;
  if (patch.toGroup !== undefined) settings.toGroup = !!patch.toGroup;
  if (patch.leads !== undefined) {
    const l = parseLeads(Array.isArray(patch.leads) ? patch.leads.join(',') : patch.leads);
    if (!l.length) throw new Error('Weka dakika kati ya 1 na 240, mfano: 30,5');
    settings.leads = l;
  }
  await saveSettings();
  return { ...settings, envEnabled: ENV_ENABLED };
}

/** Habari zijazo (masaa 24) kwa .fxnewsalert status. */
async function formatStatus(now = Date.now()) {
  const L = ['⎯⎯⎯ 『 *ARIFA ZA HABARI* 』 ⎯⎯⎯', ''];
  L.push(`🔔 Arifa: ${settings.enabled ? '*ON*' : '*OFF*'} • Kabla ya habari: dk ${settings.leads.join(' na ')} • Medium impact: ${settings.medium ? 'ON' : 'OFF'} • Group la Deriv: ${settings.toGroup ? 'ON' : 'OFF'}`);
  if (!ENV_ENABLED) L.push('_(NEWS_ALERTS_ENABLED=false kwenye env — imezimwa kabisa)_');
  try {
    const view = await economicCalendar.getWeekView(CURRENCIES);
    if (!view.available) L.push('', 'Calendar haipatikani kwa sasa.');
    else {
      const next = buildGroups(view.events, settings.medium ? ['high', 'medium'] : ['high']).filter((g) => g.t >= now && g.t - now <= 24 * 3600000).slice(0, 8);
      L.push('', next.length ? '📅 *Habari kubwa zijazo (masaa 24)*' : '📅 Hakuna habari kubwa (High impact) masaa 24 yajayo kwa currencies zinazofuatiliwa.');
      for (const g of next) L.push(`• ${FLAG[g.currency] || ''} ${g.currency} — ${g.events.map((e) => e.title).join(', ')}\n   ${ms.fmtWhen(g.t)} (baada ya ${ms.fmtIn(g.t - now)})`);
    }
  } catch (_) { /* si lazima */ }
  L.push('', '_Saa ni za Tanzania (saa za Kiswahili, 24h kwenye mabano)._');
  return L.join('\n');
}

/** Mfano wa arifa (kwa .fxnewsalert test) — tukio la kubuni, halihifadhiwi. */
async function sampleMessages(now = Date.now()) {
  const ctx = { ...getContext(), now, newsTradingLine: await newsTradingLine() };
  const g = { key: 'TEST', currency: 'USD', t: now + 30 * 60000, events: [{ title: 'Non-Farm Employment Change', country: 'USD', impact: 'High', forecast: '180K', previous: '150K', actual: null }] };
  const g2 = { ...g, t: now - 60000, events: [{ ...g.events[0], actual: '220K' }] };
  return { pre: msgPre(g, 30, ctx), actual: msgActual(g2, { ...ctx, now }) };
}

module.exports = {
  start, stop, tick, update, formatStatus, sampleMessages, getSettings: () => ({ ...settings, envEnabled: ENV_ENABLED }),
  // kazi safi (majaribio)
  buildGroups, affectedPairs, judge, msgPre, msgActual, dueAlerts, parseLeads,
};
