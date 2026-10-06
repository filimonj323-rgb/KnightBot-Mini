/**
 * tradeAnalysis.js — Uchambuzi wa Trading History kwa Groq AI
 *
 * Inajibu maswali mawili:
 *   1) Jozi (pair) ipi ni imara?
 *   2) Signal strength ipi (kizingiti) ni bora kutumia?
 *
 * MUHIMU — mgawanyo wa kazi:
 *   • Takwimu ZOTE (win rate, ROI, Wilson interval, vizingiti) zinahesabiwa
 *     HAPA kwenye server kutoka database — AI HAIHESABU wala kubuni namba.
 *   • Groq (JSON mode) inapewa takwimu zilizokwisha hesabiwa na kazi yake ni
 *     kuzieleza kwa Kiswahili na kutoa mapendekezo. Majina ya jozi kwenye
 *     jibu la AI yanahakikiwa dhidi ya data halisi (kinga ya "hallucination").
 *   • Kama GROQ_API_KEY haipo au Groq ikishindwa → unapata takwimu + muhtasari
 *     wa kawaida (bila AI), usio na hitilafu.
 *
 * Platforms:
 *   'fx' → fx_auto_trades (ina signalStrength kwa kila trade → uchambuzi kamili wa strength)
 *   'po' → po_trades (jozi/expiry/mwelekeo) + signalTracker (strength ya signals halisi)
 */

const Groq = require('groq-sdk');
const autoTrader = require('./autoTrader');
const pocketStore = require('./pocketStore');
const signalTracker = require('./signalTracker');

const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const MIN_PAIR_N = 8;       // chini ya hii jozi haipewi cheo (sampuli ndogo mno)
const MIN_THRESH_N = 15;    // chini ya hii kizingiti hakipendekezwi
const RELIABLE_N = 30;      // chini ya hii → "confidence: low"
const CACHE_TTL_MS = 10 * 60 * 1000;
const FX_THRESHOLDS = [60, 67, 70, 75, 80, 85, 90];
const FX_BUCKETS = [
  { label: '86-100%', min: 86 }, { label: '76-85%', min: 76 }, { label: '67-75%', min: 67 }, { label: '<67%', min: 0 },
];

let groqClient = null;
function getGroq() {
  if (!groqClient) {
    const key = process.env.GROQ_API_KEY;
    if (!key) return null;
    groqClient = new Groq({ apiKey: key });
  }
  return groqClient;
}

const r2 = (n) => Math.round(Number(n) * 100) / 100;
const r1 = (n) => Math.round(Number(n) * 10) / 10;

function wilsonLow(w, n, z = 1.96) {
  if (!n) return null;
  const p = w / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (c - m) / d;
}

// ── Takwimu za kikundi cha trades ─────────────────────────────────────────
function groupStats(label, trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const staked = trades.reduce((s, t) => s + t.stake, 0);
  const net = trades.reduce((s, t) => s + t.profit, 0);
  const grossWin = trades.filter((t) => t.win).reduce((s, t) => s + t.profit, 0);
  const grossLoss = Math.abs(trades.filter((t) => !t.win).reduce((s, t) => s + t.profit, 0));
  const wl = wilsonLow(wins, n);
  return {
    label, n, wins, losses: n - wins,
    winRate: n ? r1((wins / n) * 100) : null,
    winRateLow95: wl == null ? null : r1(wl * 100), // kikomo cha chini cha uhakika wa 95%
    net: r2(net),
    avgPerTrade: n ? r2(net / n) : null,
    roiPct: staked ? r1((net / staked) * 100) : null, // Net / jumla ya stake
    profitFactor: grossLoss ? r2(grossWin / grossLoss) : (grossWin ? null : 0),
    confidence: n >= RELIABLE_N ? 'ok' : n >= MIN_PAIR_N ? 'low' : 'too_small',
  };
}

function groupBy(trades, keyFn) {
  const m = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  return m;
}

const hourEAT = (ms) => Number(new Date(ms).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Africa/Dar_es_Salaam' })) % 24;

// ── Kusoma + kusawazisha trades kutoka DB ──────────────────────────────────
async function loadTrades(platform) {
  if (platform === 'fx') {
    const rows = await autoTrader.getTradeHistory(1000);
    return rows.filter((r) => r.closedAt).map((r) => ({
      pair: r.code, direction: r.direction, stake: r.stake || 0, profit: r.profit || 0, win: (r.profit || 0) > 0,
      strength: r.signalStrength, openedAt: r.openedAt, closedAt: r.closedAt, expirySec: null,
    }));
  }
  const rows = await pocketStore.getTradeHistory(1000);
  return rows.filter((r) => r.closedAt && (r.win === 1 || r.win === 0)).map((r) => {
    const win = r.win === 1;
    const stake = Number(r.stake) || 0;
    let profit = r.profit == null ? NaN : Number(r.profit);
    if (Number.isNaN(profit) || (!win && profit === 0)) profit = win ? 0 : -stake; // hasara ya binary = stake
    return {
      pair: r.pair, direction: r.direction, stake, profit, win,
      strength: r.signalStrength == null ? null : Number(r.signalStrength), openedAt: r.openedAt, closedAt: r.closedAt, expirySec: r.expirySeconds,
    };
  });
}

// ── Hesabu takwimu zote (deterministic) ────────────────────────────────────
async function computeStats(platform) {
  const trades = await loadTrades(platform);
  const overall = groupStats('OVERALL', trades);

  const pairs = [...groupBy(trades, (t) => t.pair)].map(([k, v]) => groupStats(k, v));
  const ranked = pairs.filter((p) => p.n >= MIN_PAIR_N);
  const byQuality = (a, b) => (b.roiPct ?? -999) - (a.roiPct ?? -999) || (b.winRateLow95 ?? 0) - (a.winRateLow95 ?? 0);
  ranked.sort(byQuality);
  const strongPairs = ranked.filter((p) => (p.roiPct ?? 0) > 0).slice(0, 3).map((p) => p.label);
  const weakPairs = [...ranked].reverse().filter((p) => (p.roiPct ?? 0) < 0).slice(0, 3).map((p) => p.label);

  const out = {
    platform, generatedAt: Date.now(), sampleSize: trades.length, reliable: trades.length >= RELIABLE_N,
    overall, pairs: pairs.sort(byQuality), strongPairs, weakPairs,
    direction: [...groupBy(trades, (t) => t.direction)].map(([k, v]) => groupStats(k, v)),
    hours: [...groupBy(trades, (t) => (t.openedAt ? hourEAT(t.openedAt) : null))]
      .map(([k, v]) => groupStats(String(k).padStart(2, '0') + ':00', v)).filter((h) => h.n >= MIN_PAIR_N).sort(byQuality),
    strength: null, bestThreshold: null, signalTracker: null,
  };

  // Strength kwa kila trade (FX na Pocket Option). Trades zilizo wazi hazihesabiwi (loadTrades inachukua zilizofungwa tu).
  const withStrength = trades.filter((t) => t.strength != null);
  if (withStrength.length) {
    out.strength = {
      tradesWithSignal: withStrength.length,
      buckets: FX_BUCKETS.map((b, i) => {
        const hi = i === 0 ? Infinity : FX_BUCKETS[i - 1].min;
        return groupStats(b.label, withStrength.filter((t) => t.strength >= b.min && t.strength < hi));
      }).filter((b) => b.n > 0),
      // "Ukitumia strength >= X tu" — hii ndiyo inajibu "strength ipi ni bora kutumia"
      thresholds: FX_THRESHOLDS.map((x) => groupStats(`>= ${x}%`, withStrength.filter((t) => t.strength >= x)))
        .map((g, i) => ({ ...g, threshold: FX_THRESHOLDS[i] })).filter((g) => g.n > 0),
    };
    // Pendelea vizingiti vyenye sampuli ya kutosha (>=30) ili kuepuka kuchagua kizingiti kilichobahatika kwa trades chache.
    let eligible = out.strength.thresholds.filter((g) => g.n >= RELIABLE_N && g.roiPct != null);
    if (!eligible.length) eligible = out.strength.thresholds.filter((g) => g.n >= MIN_THRESH_N && g.roiPct != null);
    if (eligible.length) {
      const best = [...eligible].sort((a, b) => b.roiPct - a.roiPct)[0];
      out.bestThreshold = { threshold: best.threshold, n: best.n, winRate: best.winRate, roiPct: best.roiPct, net: best.net, confidence: best.n >= RELIABLE_N ? 'ok' : 'low' };
    }
  }

  if (platform === 'po') {
    // Signals halisi zilizofuatiliwa (signalTracker, siku 30) — sampuli kubwa kuliko trades zako; msaada wa strength/expiry/regime
    try {
      const d = await signalTracker.getDashboard(30, 0);
      out.signalTracker = {
        days: 30, overall: { n: d.overall.n, winRatePct: d.overall.rate == null ? null : r1(d.overall.rate * 100), breakEvenPct: r1(d.overall.breakEven * 100), verdict: d.overall.verdict },
        strength: d.groups.strength.map((g) => ({ label: g.label, n: g.n, winRatePct: g.rate == null ? null : r1(g.rate * 100) })),
        expiry: d.groups.expiry.map((g) => ({ label: g.label, n: g.n, winRatePct: g.rate == null ? null : r1(g.rate * 100) })),
        regime: d.groups.regime.map((g) => ({ label: g.label, n: g.n, winRatePct: g.rate == null ? null : r1(g.rate * 100) })),
      };
      if (!out.bestThreshold) {
        const ok = out.signalTracker.strength.filter((g) => g.n >= MIN_THRESH_N && g.winRatePct != null);
        if (ok.length) {
          const best = [...ok].sort((a, b) => b.winRatePct - a.winRatePct)[0];
          out.bestThreshold = { bucket: best.label, n: best.n, winRate: best.winRatePct, confidence: best.n >= RELIABLE_N ? 'ok' : 'low' };
        }
      }
    } catch (e) { out.signalTracker = null; }
    out.expiry = [...groupBy(trades, (t) => (t.expirySec ? `${Math.round(t.expirySec / 60)}m` : null))]
      .map(([k, v]) => groupStats(k, v)).filter((g) => g.n >= MIN_PAIR_N).sort(byQuality);
  }
  return out;
}

// ── Muhtasari bila AI (fallback) ───────────────────────────────────────────
function fallbackAnalysis(stats, note) {
  const o = stats.overall;
  const lines = [];
  if (!stats.sampleSize) lines.push('Hakuna trades zilizofungwa za kuchambua bado.');
  else {
    lines.push(`Trades ${o.n}: win rate ${o.winRate}%, Net ${o.net >= 0 ? '+' : ''}$${o.net}, ROI ${o.roiPct ?? '-'}%.`);
    if (stats.strongPairs.length) lines.push(`Jozi zenye matokeo bora: ${stats.strongPairs.join(', ')}.`);
    if (stats.weakPairs.length) lines.push(`Jozi dhaifu: ${stats.weakPairs.join(', ')}.`);
    if (stats.bestThreshold) {
      const b = stats.bestThreshold;
      lines.push(b.threshold != null ? `Kizingiti chenye ROI bora: strength >= ${b.threshold}% (trades ${b.n}).` : `Strength bora (signals): ${b.bucket} (${b.winRate}%, signals ${b.n}).`);
    }
  }
  return {
    source: 'stats-only', note: note || null, summary: lines.join(' '),
    strongPairs: stats.strongPairs.map((p) => ({ pair: p, reason: 'ROI chanya kwenye sampuli iliyopo.' })),
    weakPairs: stats.weakPairs.map((p) => ({ pair: p, reason: 'ROI hasi kwenye sampuli iliyopo.' })),
    bestStrength: stats.bestThreshold ? { recommendation: stats.bestThreshold.threshold != null ? `>= ${stats.bestThreshold.threshold}%` : stats.bestThreshold.bucket, reason: 'Imechaguliwa kwa ROI/win rate bora kati ya zenye sampuli ya kutosha.' } : null,
    recommendations: [], warnings: stats.reliable ? [] : [`Sampuli ndogo (trades ${stats.sampleSize}, chini ya ${RELIABLE_N}) — matokeo haya si ya kuaminika bado.`],
  };
}

// ── Groq ──────────────────────────────────────────────────────────────────
function compactForAi(s) {
  const slim = (g) => ({ label: g.label, n: g.n, winRate: g.winRate, winRateLow95: g.winRateLow95, roiPct: g.roiPct, net: g.net, profitFactor: g.profitFactor, confidence: g.confidence });
  return {
    platform: s.platform === 'fx' ? 'FX (multipliers, SL/TP)' : 'Pocket Option (binary, payout ~85%, break-even ~54% win rate)',
    sampleSize: s.sampleSize, overall: slim(s.overall),
    pairs: s.pairs.map(slim), direction: s.direction.map(slim), bestHours: s.hours.slice(0, 3).map(slim), worstHours: s.hours.slice(-3).map(slim),
    strengthBuckets: s.strength ? s.strength.buckets.map(slim) : null,
    strengthThresholds: s.strength ? s.strength.thresholds.map((g) => ({ ...slim(g), threshold: g.threshold })) : null,
    signalTracker30d: s.signalTracker, expiry: s.expiry ? s.expiry.map(slim) : null,
    serverPick: { strongPairs: s.strongPairs, weakPairs: s.weakPairs, bestThreshold: s.bestThreshold },
  };
}

const SYSTEM = `
Wewe ni mchambuzi wa takwimu za trading anayeandika kwa Kiswahili kwa dashboard ya ndani.
Umepewa takwimu ZILIZOKWISHA HESABIWA na server (win rate, ROI, kikomo cha chini cha 95%,
profit factor) kutoka historia halisi ya trades. USIHESABU upya, USIBUNI namba, na USITUMIE
jina la jozi lisilo kwenye data. Tumia namba kama zilivyotolewa.

Kazi yako:
1) Eleza jozi zipi ni imara na zipi dhaifu, na KWA NINI (tumia n, winRate, roiPct, winRateLow95).
   "serverPick" ni uchaguzi wa server — kubaliana nao isipokuwa una sababu ya wazi kwenye data.
2) Pendekeza signal strength bora (kizingiti) kulingana na strengthThresholds/strengthBuckets
   (Pocket Option: trades zako zina strength pale zinapopatikana; signalTracker30d ni data ya ziada ya signals zote). Taja sampuli (n) ya kizingiti ulichochagua.
   Trades zilizo wazi hazimo kwenye takwimu hizi (zilizofungwa tu).
3) Toa mapendekezo 2-4 ya vitendo (mfano: "weka strength >= 75%", "epuka jozi X hadi upate trades 30 zaidi").
4) KANUNI ZA UAMINIFU (lazima):
   - Kikundi chenye confidence "low" au "too_small" (n ndogo) kitajwe kama "sampuli ndogo, si uthibitisho".
   - Ikiwa sampleSize < 30, sema wazi kwamba hitimisho zote ni za awali.
   - Ikiwa overall.roiPct ni hasi, sema kwamba mfumo kwa jumla haujaonyesha faida.
   - Usiahidi faida. Hii si ushauri wa kifedha. Tumia "inaashiria/inaonekana".
   - Pocket Option: win rate chini ya ~54% inamaanisha hasara; angalia winRateLow95 dhidi ya 54%.
Rudisha JSON PEKEE, muundo:
{"summary":"sentensi 2-4","strongPairs":[{"pair":"EURUSD","reason":"..."}],"weakPairs":[{"pair":"GBPJPY","reason":"..."}],
"bestStrength":{"recommendation":">= 75%","reason":"..."},"recommendations":["..."],"warnings":["..."]}
`.trim();

function sanitizeAi(parsed, stats) {
  const known = new Set(stats.pairs.map((p) => p.label.toUpperCase()));
  const pairList = (arr) => (Array.isArray(arr) ? arr : [])
    .filter((x) => x && known.has(String(x.pair || '').toUpperCase()))
    .slice(0, 4).map((x) => ({ pair: String(x.pair).toUpperCase(), reason: String(x.reason || '').slice(0, 300) }));
  const strList = (arr, max) => (Array.isArray(arr) ? arr : []).slice(0, max).map((x) => String(x).slice(0, 300));
  const bs = parsed.bestStrength && typeof parsed.bestStrength === 'object'
    ? { recommendation: String(parsed.bestStrength.recommendation || '').slice(0, 60), reason: String(parsed.bestStrength.reason || '').slice(0, 400) } : null;
  const warnings = strList(parsed.warnings, 4);
  if (!stats.reliable && !warnings.some((w) => /sampuli|sample/i.test(w))) {
    warnings.unshift(`Sampuli ndogo (trades ${stats.sampleSize}, chini ya ${RELIABLE_N}) — hitimisho ni za awali.`);
  }
  return {
    source: 'ai', summary: String(parsed.summary || '').slice(0, 900),
    strongPairs: pairList(parsed.strongPairs), weakPairs: pairList(parsed.weakPairs), bestStrength: bs,
    recommendations: strList(parsed.recommendations, 4), warnings,
  };
}

const cache = new Map(); // platform -> { key, at, data }

async function analyze(platform, { force = false } = {}) {
  platform = platform === 'po' ? 'po' : 'fx';
  const stats = await computeStats(platform);
  const key = `${stats.sampleSize}:${stats.overall.net}`; // inabadilika trade mpya ikifungwa
  const hit = cache.get(platform);
  if (!force && hit && hit.key === key && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.data, cached: true };

  let ai;
  const groq = getGroq();
  if (!stats.sampleSize) {
    ai = fallbackAnalysis(stats);
  } else if (!groq) {
    ai = fallbackAnalysis(stats, 'GROQ_API_KEY haijawekwa — takwimu tu, bila AI.');
  } else {
    try {
      const resp = await groq.chat.completions.create({
        model: MODEL, temperature: 0.2, max_tokens: 1400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Takwimu (JSON):\n${JSON.stringify(compactForAi(stats))}` },
        ],
      });
      ai = sanitizeAi(JSON.parse(resp.choices?.[0]?.message?.content || '{}'), stats);
      if (!ai.summary) ai = fallbackAnalysis(stats, 'AI haikurudisha muhtasari — takwimu tu.');
    } catch (err) {
      console.error('[tradeAnalysis] Groq error:', err.message);
      ai = fallbackAnalysis(stats, `AI imeshindikana (${err.message}) — takwimu tu.`);
    }
  }

  const data = { ok: true, platform, generatedAt: Date.now(), stats, ai };
  cache.set(platform, { key, at: Date.now(), data });
  return data;
}

module.exports = { analyze, computeStats };
