/**
 * marketSessions.js — Arifa za SESSION za soko la forex (Deriv) + soko kufungwa/kufunguliwa (hasa weekend).
 *
 * Inatuma kwa owner (DM) — na hiari kwenye group la Deriv (.fxsession group on):
 *   🟢/🔴 Session ya Sydney / Tokyo / London / New York imefunguliwa / imefungwa, pamoja na PAIRS za kutrade
 *         ndani ya session hiyo (zimepangwa kwa nguvu ya signal ya sasa ya auto-trader, ikiwepo).
 *   ⏳ Saa 1 kabla soko halijafungwa Ijumaa (onyo: trades zilizo wazi zitavuka weekend).
 *   🔒 Soko limefungwa (weekend) + litafunguliwa lini.
 *   🔔 Soko limefunguliwa (Jumapili usiku/Jumatatu) + session zilizo wazi na pairs.
 *
 * Saa za sessions (DST-aware, kwa saa za mji husika — Intl):
 *   Sydney 08:00–17:00 • Tokyo 09:00–18:00 • London 08:00–17:00 • New York 08:00–17:00
 * Soko la forex la wiki: linafungwa Ijumaa 17:00 New York, linafunguliwa Jumapili 17:00 New York
 * (Deriv inaweza kutofautiana kwa dakika chache; sikukuu kama Krismasi/Mwaka Mpya hazihesabiwi).
 * Wakati soko limefungwa, hakuna session "iliyo wazi" (hata kama saa za mji zinaonyesha hivyo).
 *
 * Hali (soko wazi/imefungwa + sessions zilizo wazi) inahifadhiwa (Turso) — redeploy haileti arifa mara mbili,
 * na tukio lililotokea wakati bot ilikuwa imezimwa kwa muda mfupi (< STALE_MS) bado linatumwa.
 *
 * Env (zote hiari):
 *   SESSION_ALERTS_ENABLED   — "false" kuzima kabisa (default true; inaweza kuzimwa pia kwa .fxsession off)
 *   SESSION_ALERT_TZ         — saa za kuonyesha kwenye ujumbe (default Africa/Dar_es_Salaam)
 *   SESSION_ALERT_TZ_LABEL   — jina fupi la saa hizo (default "EAT")
 *   MARKET_CLOSE_NY          — "HH:MM" Ijumaa ya kufunga (default 17:00)
 *   MARKET_OPEN_NY           — "HH:MM" Jumapili ya kufungua (default 17:00)
 *   SESSION_TICK_MS          — muda kati ya ukaguzi (default sekunde 60)
 */

const pocketStore = require('./pocketStore');

const NY_TZ = 'America/New_York';
const ALERT_TZ = process.env.SESSION_ALERT_TZ || 'Africa/Dar_es_Salaam';
const ALERT_TZ_LABEL = process.env.SESSION_ALERT_TZ_LABEL || 'EAT';
const TICK_MS = Math.max(10000, Number(process.env.SESSION_TICK_MS) || 60 * 1000);
const STALE_MS = 3 * 60 * 60 * 1000; // hali iliyohifadhiwa ikiwa ya zamani zaidi ya hapa → sawazisha kimya, usitume arifa za zamani
const PRECLOSE_MIN = 60;
const SETTINGS_KEY = 'marketsessions:settings';
const STATE_KEY = 'marketsessions:state';

const ENV_ENABLED = String(process.env.SESSION_ALERTS_ENABLED ?? 'true').toLowerCase() !== 'false';

function parseHM(raw, fallbackMin) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return fallbackMin;
  const h = Number(m[1]), mi = Number(m[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? h * 60 + mi : fallbackMin;
}
const CLOSE_MIN_NY = parseHM(process.env.MARKET_CLOSE_NY, 17 * 60); // Ijumaa
const OPEN_MIN_NY = parseHM(process.env.MARKET_OPEN_NY, 17 * 60);   // Jumapili

// ── Sessions ──────────────────────────────────────────────────────────────────────────────────
const SESSIONS = {
  SYDNEY:  { label: 'Sydney',    emoji: '🇦🇺', tz: 'Australia/Sydney', from: 8 * 60, to: 17 * 60, ccy: ['AUD', 'NZD'] },
  TOKYO:   { label: 'Tokyo',     emoji: '🇯🇵', tz: 'Asia/Tokyo',       from: 9 * 60, to: 18 * 60, ccy: ['JPY', 'AUD', 'NZD'] },
  LONDON:  { label: 'London',    emoji: '🇬🇧', tz: 'Europe/London',    from: 8 * 60, to: 17 * 60, ccy: ['EUR', 'GBP', 'CHF'] },
  NEWYORK: { label: 'New York',  emoji: '🇺🇸', tz: NY_TZ,              from: 8 * 60, to: 17 * 60, ccy: ['USD', 'CAD'] },
};
const SESSION_KEYS = Object.keys(SESSIONS);

// ── Saa kwa timezone (Intl, DST-aware) ────────────────────────────────────────────────────────
const fmtCache = new Map();
function partsOf(ts, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { dow, min: (Number(o.hour) % 24) * 60 + Number(o.minute), date: `${o.year}-${o.month}-${o.day}` };
}

/** Soko la forex la wiki: wazi isipokuwa Ijumaa ≥ close, Jumamosi yote, Jumapili < open (saa za New York). */
function isMarketOpen(ts) {
  const { dow, min } = partsOf(ts, NY_TZ);
  if (dow === 6) return false;
  if (dow === 5 && min >= CLOSE_MIN_NY) return false;
  if (dow === 0 && min < OPEN_MIN_NY) return false;
  return true;
}

function sessionInHours(key, ts) {
  const s = SESSIONS[key];
  const { dow, min } = partsOf(ts, s.tz);
  if (dow === 0 || dow === 6) return false; // Jumamosi/Jumapili ya mji husika — hakuna session
  return min >= s.from && min < s.to;
}

/** Sessions ZILIZO WAZI kweli (saa za mji + soko wazi). */
function activeSessions(ts = Date.now()) {
  if (!isMarketOpen(ts)) return [];
  return SESSION_KEYS.filter((k) => sessionInHours(k, ts));
}

/** Tukio lijalo la `pred` (inabadilika kutoka hali ya sasa) — hatua ya dk 10 kisha dk 1. Inarudisha ts au null (ndani ya siku 8). */
function nextChange(pred, from = Date.now(), maxDays = 8) {
  const start = Math.floor(from / 60000) * 60000;
  const base = pred(start);
  const coarse = 10 * 60000;
  const limit = start + maxDays * 86400000;
  for (let t = start + coarse; t <= limit; t += coarse) {
    if (pred(t) !== base) {
      for (let u = t - coarse + 60000; u <= t; u += 60000) if (pred(u) !== base) return u;
      return t;
    }
  }
  return null;
}
const nextMarketOpen = (from = Date.now()) => (isMarketOpen(from) ? null : nextChange(isMarketOpen, from));
const nextMarketClose = (from = Date.now()) => (isMarketOpen(from) ? nextChange(isMarketOpen, from) : null);
const nextSessionChange = (key, from = Date.now()) => nextChange((t) => activeSessions(t).includes(key), from);

// ── Muundo wa muda ────────────────────────────────────────────────────────────────────────────
/** Saa ya Kiswahili (saa 12 asubuhi = 06:00): "saa 10 jioni (16:00)". Dakika zikiwepo: "saa 10:30 jioni (16:30)". */
function swahiliClock(min) {
  const h = Math.floor(min / 60), mi = min % 60;
  let sw = (h + 6) % 12; if (sw === 0) sw = 12;
  const period = h < 4 ? 'usiku' : h < 6 ? 'alfajiri' : h < 12 ? 'asubuhi' : h < 15 ? 'mchana' : h < 16 ? 'alasiri' : h < 19 ? 'jioni' : 'usiku';
  return `saa ${sw}${mi ? ':' + String(mi).padStart(2, '0') : ''} ${period} (${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')})`;
}
function fmtTime(ts, tz = ALERT_TZ) {
  return swahiliClock(partsOf(ts, tz).min);
}
const DAYS_SW = ['Jumapili', 'Jumatatu', 'Jumanne', 'Jumatano', 'Alhamisi', 'Ijumaa', 'Jumamosi'];
function fmtWhen(ts, tz = ALERT_TZ) {
  const now = partsOf(Date.now(), tz);
  const p = partsOf(ts, tz);
  if (p.date === now.date) return `leo ${fmtTime(ts, tz)}`;
  // Usiku wa manane (00:00–05:59) kwa Kiswahili bado ni "usiku wa kuamkia" siku hiyo — epuka kuchanganya weekend.
  const day = p.min < 6 * 60 ? `usiku wa kuamkia ${DAYS_SW[p.dow]}` : DAYS_SW[p.dow];
  return `${day} ${fmtTime(ts, tz)}`;
}
function fmtIn(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  const parts = [];
  if (d) parts.push(`siku ${d}`);
  if (h) parts.push(`saa ${h}`);
  if (mm && !d) parts.push(`dk ${mm}`);
  return parts.join(' ') || 'sasa hivi';
}

// ── Mapendekezo ya pairs kwa session ──────────────────────────────────────────────────────────
// Pair inapata alama kwa kila currency yake ambayo "nyumbani kwake" ni session iliyo wazi (0–2).
// USD inauzwa kila session (alama ya nusu nje ya New York). Kisha tunapanga kwa alama, kisha kwa nguvu ya signal.
function pairScore(code, active) {
  const base = code.slice(0, 3), quote = code.slice(3, 6);
  const homes = new Set();
  for (const k of active) for (const c of SESSIONS[k].ccy) homes.add(c);
  let score = 0;
  const why = [];
  for (const c of [base, quote]) {
    if (homes.has(c)) { score += 1; why.push(c); }
    else if (c === 'USD') score += 0.5;
  }
  return { score, why };
}

function getSignals() {
  try {
    const st = require('./autoTrader').getStatus();
    return { signals: st.signals || [], threshold: st.strengthThreshold, pairs: st.pairs || [] };
  } catch (_) {
    return { signals: [], threshold: null, pairs: [] };
  }
}

const FALLBACK_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD'];

/** Pairs zilizopendekezwa kwa sessions zilizo wazi: [{code, score, why, direction, strength, tradable}] (juu kwanza). */
function recommendPairs(active, { limit = 5, sigs } = {}) {
  const s = sigs || getSignals();
  const codes = s.pairs.length ? s.pairs : FALLBACK_PAIRS;
  const bySig = new Map((s.signals || []).map((x) => [x.code, x]));
  const rows = codes.map((code) => {
    const { score, why } = pairScore(code, active);
    const sig = bySig.get(code) || {};
    const strength = Number(sig.strength);
    const dir = sig.direction === 'BUY' || sig.direction === 'SELL' ? sig.direction : null;
    const tradable = !!dir && Number.isFinite(strength) && s.threshold != null && strength >= s.threshold && !sig.correlationBlocked;
    return { code, score, why, direction: dir, strength: Number.isFinite(strength) ? strength : null, tradable };
  });
  rows.sort((a, b) => (b.score - a.score) || (Number(b.tradable) - Number(a.tradable)) || ((b.strength || 0) - (a.strength || 0)));
  return rows.filter((r) => r.score >= 1).slice(0, limit);
}

function pairLine(r, i) {
  let sig = '⚪ hakuna signal kali sasa';
  if (r.direction && r.strength != null) {
    sig = `${r.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'} ${Math.round(r.strength)}%${r.tradable ? ' ✅' : ' (chini ya kizingiti)'}`;
  }
  return `${i + 1}. *${r.code}* — ${sig}${r.why.length ? ` _(${r.why.join('/')} ina session yake sasa)_` : ''}`;
}

function pairsBlock(active, opts) {
  if (!active.length) return '';
  const recs = recommendPairs(active, opts);
  if (!recs.length) return '';
  return `\n📌 *Pairs za kutrade ndani ya session hii*\n${recs.map(pairLine).join('\n')}\n`;
}

const DISCLAIMER = '\n_Hii si ushauri wa kifedha — signal za sasa ni za auto-trader; trade kwa hatari yako._';
const activeNames = (a) => a.map((k) => `${SESSIONS[k].emoji} ${SESSIONS[k].label}`).join(' + ');

// ── Ujumbe ────────────────────────────────────────────────────────────────────────────────────
function overlapNote(active) {
  return active.includes('LONDON') && active.includes('NEWYORK')
    ? '\n🔥 *London + New York zinaingiliana (overlap)* — muda wenye liquidity na volatility kubwa zaidi ya siku.\n'
    : '';
}

function msgSessionOpen(key, active, now, opts) {
  const s = SESSIONS[key];
  const end = nextSessionChange(key, now);
  return (
    `🟢 *SESSION YA ${s.label.toUpperCase()} IMEFUNGULIWA* ${s.emoji}\n\n` +
    `🕐 Sasa: ${fmtTime(now)}\n` +
    (end ? `⏱️ Itafungwa: ${fmtWhen(end)} (baada ya ${fmtIn(end - now)})\n` : '') +
    `🌍 Sessions zilizo wazi: ${activeNames(active)}\n` +
    overlapNote(active) +
    pairsBlock(active, opts) +
    DISCLAIMER
  );
}

function msgSessionClose(key, active, now, opts) {
  const s = SESSIONS[key];
  let text = `🔴 *SESSION YA ${s.label.toUpperCase()} IMEFUNGWA* ${s.emoji}\n\n🕐 Sasa: ${fmtTime(now)}\n`;
  if (active.length) {
    text += `🌍 Zilizobaki wazi: ${activeNames(active)}\n` + pairsBlock(active, opts);
  } else if (isMarketOpen(now)) {
    const nxt = SESSION_KEYS
      .map((k) => ({ k, t: nextSessionChange(k, now) }))
      .filter((x) => x.t)
      .sort((a, b) => a.t - b.t)[0];
    text += `😴 Hakuna session kuu wazi sasa — liquidity ni ndogo, spreads huongezeka.\n` +
      (nxt ? `⏭️ Inayofuata: ${SESSIONS[nxt.k].emoji} ${SESSIONS[nxt.k].label} — ${fmtWhen(nxt.t)}\n` : '');
  }
  return text + DISCLAIMER;
}

function openTradesCount() {
  try { return require('./autoTrader').openAutoTrades.size; } catch (_) { return null; }
}

function msgPreClose(closeTs, now) {
  const n = openTradesCount();
  return (
    `⏳ *SOKO LA FOREX LINAFUNGWA BAADA YA ${fmtIn(closeTs - now).toUpperCase()}*\n\n` +
    `🔒 Linafungwa: ${fmtWhen(closeTs)}\n` +
    (n ? `📂 Una trades ${n} zilizo wazi — zitavuka weekend. Bei inaweza kuruka (gap) soko likifunguliwa, SL isitekelezwe kwa bei yake.\n` : '') +
    `\n💡 Fikiria kufunga trades zenye faida kabla ya soko kufungwa, au punguza hatari ya weekend.` +
    `\n_Deriv haikubali trades mpya soko likiwa limefungwa._`
  );
}

function msgMarketClosed(now) {
  const open = nextMarketOpen(now);
  return (
    `🔒 *SOKO LA FOREX LIMEFUNGWA*\n\n` +
    `📅 Weekend — hakuna trading kwenye jozi za forex hadi litakapofunguliwa tena.\n` +
    (open ? `🔔 Litafunguliwa: ${fmtWhen(open)} (baada ya ${fmtIn(open - now)})\n` : '') +
    `\n_Trades zilizo wazi (kama zipo) zinasubiri soko lifunguliwe; angalia gap ya bei._`
  );
}

function msgMarketOpen(active, now, opts) {
  return (
    `🔔 *SOKO LA FOREX LIMEFUNGULIWA* 🎉\n\n` +
    `🕐 Sasa: ${fmtWhen(now)}\n` +
    (active.length ? `🌍 Sessions zilizo wazi: ${activeNames(active)}\n` : `🌍 Hakuna session kuu bado — soko linaamka polepole.\n`) +
    `⚠️ Mwanzo wa wiki: spreads kubwa na gaps za bei ni kawaida kwa dakika za kwanza — subiri utulivu kabla ya kuingia.\n` +
    overlapNote(active) +
    pairsBlock(active, opts) +
    DISCLAIMER
  );
}

// ── Injini ────────────────────────────────────────────────────────────────────────────────────
let settings = { enabled: ENV_ENABLED, toGroup: false };
let state = null; // { ts, marketOpen, active:[], warnedWeek }
let notifier = null;
let timer = null;
let ticking = false;
let startedAt = null;
let lastEvents = []; // matukio ya mwisho (kwa .fxsession status)

function remember(kind, text) {
  lastEvents.unshift({ at: Date.now(), kind });
  if (lastEvents.length > 8) lastEvents.pop();
  return text;
}

async function loadSettings() {
  try {
    const rows = await pocketStore.loadSettings('marketsessions:');
    for (const { key, value } of rows) {
      const v = JSON.parse(value);
      if (key === SETTINGS_KEY) settings = { enabled: ENV_ENABLED && v.enabled !== false, toGroup: v.toGroup === true };
      else if (key === STATE_KEY) state = v;
    }
  } catch (err) {
    console.error('[marketSessions] imeshindwa kusoma mpangilio/hali:', err.message);
  }
}
const saveSettings = () => pocketStore.saveSetting(SETTINGS_KEY, { enabled: settings.enabled, toGroup: settings.toGroup });
const saveState = () => pocketStore.saveSetting(STATE_KEY, state);

async function deliver(text) {
  let ok = false;
  try { if (notifier) ok = (await notifier(text)) !== false; } catch (err) { console.error('[marketSessions] DM imeshindwa:', err.message); }
  if (!ok) { // jaribio la pili baada ya sekunde 20 (WhatsApp inaweza kuwa inaunganishwa upya)
    setTimeout(() => { Promise.resolve(notifier && notifier(text)).catch(() => {}); }, 20000).unref?.();
  }
  if (settings.toGroup) {
    try { await require('./signalTargets').sendSignal('deriv', text); } catch (_) { /* group si lazima */ }
  }
}

/** Hesabu matukio kati ya hali ya zamani (`prev`) na ya sasa; inarudisha ujumbe kwa mpangilio. Kazi safi (inajaribika). */
function diffEvents(prev, now, opts) {
  const marketOpen = isMarketOpen(now);
  const active = activeSessions(now);
  const msgs = [];
  if (prev.marketOpen && !marketOpen) {
    msgs.push({ kind: 'market_closed', text: msgMarketClosed(now) });
  } else if (!prev.marketOpen && marketOpen) {
    msgs.push({ kind: 'market_open', text: msgMarketOpen(active, now, opts) });
  } else if (marketOpen) {
    const was = new Set(prev.active || []);
    for (const k of SESSION_KEYS) {
      if (active.includes(k) && !was.has(k)) msgs.push({ kind: `open:${k}`, text: msgSessionOpen(k, active, now, opts) });
    }
    for (const k of SESSION_KEYS) {
      if (!active.includes(k) && was.has(k)) msgs.push({ kind: `close:${k}`, text: msgSessionClose(k, active, now, opts) });
    }
    // Onyo la kabla ya kufungwa kwa soko (mara moja kwa wiki)
    if (!isMarketOpen(now + PRECLOSE_MIN * 60000)) {
      const week = partsOf(now, NY_TZ).date;
      if (prev.warnedWeek !== week) {
        const closeTs = nextMarketClose(now);
        if (closeTs) msgs.push({ kind: 'preclose', text: msgPreClose(closeTs, now), warnedWeek: week });
      }
    }
  }
  return { marketOpen, active, msgs };
}

async function tick(now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    const cur = { marketOpen: isMarketOpen(now), active: activeSessions(now) };
    if (!state || !settings.enabled || now - (state.ts || 0) > STALE_MS) {
      // Hakuna msingi wa kulinganisha (au arifa zimezimwa/hali ya zamani mno) — sawazisha kimya.
      state = { ts: now, ...cur, warnedWeek: state && state.warnedWeek };
      await saveState();
      return;
    }
    const { msgs } = diffEvents(state, now);
    const next = { ts: now, ...cur, warnedWeek: state.warnedWeek };
    for (const m of msgs) if (m.warnedWeek) next.warnedWeek = m.warnedWeek;
    state = next;
    await saveState(); // hifadhi KABLA ya kutuma — redeploy katikati isirudie
    for (const m of msgs) {
      remember(m.kind);
      await deliver(m.text);
      await new Promise((r) => setTimeout(r, 2500)); // pengo kati ya ujumbe (anti-flood)
    }
  } catch (err) {
    console.error('[marketSessions] tick:', err.message);
  } finally {
    ticking = false;
  }
}

/** @param {{notify: (text:string)=>Promise<any>}} opts — notify = tuma DM kwa owner */
async function start({ notify } = {}) {
  if (typeof notify === 'function') notifier = notify;
  if (timer) return true;
  startedAt = Date.now();
  await loadSettings();
  console.log(`[marketSessions] ${settings.enabled ? '✅ IMEWASHWA' : 'imezimwa (.fxsession on)'} — ukaguzi kila sekunde ${Math.round(TICK_MS / 1000)}; ` +
    `soko sasa: ${isMarketOpen(Date.now()) ? 'WAZI' : 'IMEFUNGWA'}, sessions: ${activeSessions().join('/') || 'hakuna'}.`);
  tick().catch(() => {});
  timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  timer.unref?.();
  return true;
}

function stop() { if (timer) clearInterval(timer); timer = null; }

async function setEnabled(on) { settings.enabled = !!on && ENV_ENABLED; if (settings.enabled) state = null; await saveSettings(); return { ...settings, envEnabled: ENV_ENABLED }; }
async function setToGroup(on) { settings.toGroup = !!on; await saveSettings(); return { ...settings }; }

/** Muhtasari wa sasa (kwa .fxsession status na tuma-jaribio). */
function getSnapshot(now = Date.now()) {
  const marketOpen = isMarketOpen(now);
  const active = activeSessions(now);
  return {
    now, marketOpen, active,
    nextOpen: marketOpen ? null : nextMarketOpen(now),
    nextClose: marketOpen ? nextMarketClose(now) : null,
    sessions: SESSION_KEYS.map((k) => ({ key: k, label: SESSIONS[k].label, active: active.includes(k), next: nextSessionChange(k, now) })),
    recommended: recommendPairs(active),
    settings: { ...settings, envEnabled: ENV_ENABLED },
    lastEvents: [...lastEvents],
  };
}

function formatStatus(now = Date.now()) {
  const s = getSnapshot(now);
  const L = [`⎯⎯⎯ 『 *SESSIONS ZA SOKO* 』 ⎯⎯⎯`, ''];
  L.push(`${s.marketOpen ? '🟢 Soko la forex: *WAZI*' : '🔒 Soko la forex: *IMEFUNGWA*'}`);
  if (s.marketOpen && s.nextClose) L.push(`⏳ Linafungwa: ${fmtWhen(s.nextClose)} (baada ya ${fmtIn(s.nextClose - now)})`);
  if (!s.marketOpen && s.nextOpen) L.push(`🔔 Litafunguliwa: ${fmtWhen(s.nextOpen)} (baada ya ${fmtIn(s.nextOpen - now)})`);
  L.push('');
  for (const x of s.sessions) {
    L.push(`${x.active ? '🟢' : '⚪'} ${SESSIONS[x.key].emoji} ${x.label}: ${x.active ? 'wazi' : 'imefungwa'}` +
      (x.next ? ` — ${x.active ? 'inafungwa' : 'inafunguliwa'} ${fmtWhen(x.next)}` : ''));
  }
  const ov = overlapNote(s.active).trim();
  if (ov) L.push('', ov);
  const block = pairsBlock(s.active);
  if (block) L.push(block.trim());
  L.push('', `🔔 Arifa: ${s.settings.enabled ? '*ON*' : '*OFF*'} • Group la Deriv: ${s.settings.toGroup ? '*ON*' : '*OFF*'}`);
  if (!s.settings.envEnabled) L.push('_(SESSION_ALERTS_ENABLED=false kwenye env — imezimwa kabisa)_');
  L.push(`_Saa zote ni za Tanzania (${ALERT_TZ_LABEL}) — saa za Kiswahili, 24h kwenye mabano._`);
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = {
  start, stop, tick, setEnabled, setToGroup, getSnapshot, formatStatus,
  // kwa majaribio / matumizi ya nje
  isMarketOpen, activeSessions, nextMarketOpen, nextMarketClose, nextSessionChange,
  recommendPairs, diffEvents, pairScore, SESSIONS, swahiliClock, fmtWhen, fmtTime, fmtIn,
  msgSessionOpen, msgSessionClose, msgMarketOpen, msgMarketClosed, msgPreClose,
};
