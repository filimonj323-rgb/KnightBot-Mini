/**
 * Analyze Command — Uchambuzi wa kina wa hisa ya DSE kwa msaada wa Groq AI
 *
 * Mtiririko:
 *   1) Bei ya sasa kutoka dse.js (fetchDSEStocks)
 *   2) Fundamentals kutoka stockana.js (stockanalysis.com)
 *   3) Fallback: fundamentals.json (manual) kama stockana inashindwa
 *   4) Hesabu za haraka (P/E, P/B, DY, Market Cap) + ukaguzi wa data
 *   5) [HIARI: .analyze <symbol> habari] Groq/compound inatafuta habari za
 *      hivi karibuni mtandaoni kuhusu kampuni (matukio, ripoti, gawio, n.k)
 *   6) Tuma kwa Groq (gpt-oss-120b) → JSON yenye verdict, score, maana ya
 *      kila kigezo, nguvu, hatari, na mapendekezo — ikizingatia pia habari
 *      za mtandaoni kama zimeombwa
 *
 * ⚠️ SI USHAURI WA KITAALAMU WA UWEKEZAJI.
 */

const { fetchDSEStocks } = require('./dse.js');
const { fetchStockana } = require('../../utils/stockana.js');
const fundamentals = require('../../utils/data/fundamentals.json');
const Groq = require('groq-sdk');

// ─────────────────────────────────────────────
// Groq client (lazy init)
// ─────────────────────────────────────────────
let groqClient = null;
function getGroq() {
  if (!groqClient) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY haipo kwenye env');
    groqClient = new Groq({ apiKey: key });
  }
  return groqClient;
}
// ⚠️ llama-3.3-70b-versatile ilizimwa na Groq tarehe 16 Agosti 2026.
// openai/gpt-oss-120b ndio mbadala rasmi anaopendekeza Groq kwa uchambuzi
// wa JSON. groq/compound ni "system" tofauti (inatumia gpt-oss-120b + Llama 4
// Scout ndani yake) yenye uwezo wa kutafuta mtandaoni (web search) wenyewe —
// tunaitumia PEKEE ukiomba ".analyze <symbol> habari" kwa sababu ina gharama
// ya ziada (search fee) na ni polepole zaidi kuliko uchambuzi wa kawaida.
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const NEWS_MODEL = process.env.GROQ_NEWS_MODEL || 'groq/compound';
const NEWS_TIMEOUT_MS = 20000; // usisubiri zaidi ya sekunde 20 kwa habari za mtandaoni
const NEWS_CACHE_MS = 6 * 60 * 60 * 1000; // saa 6 — habari hazibadiliki kila dakika

// Maneno ambayo mtumiaji anaweza kuweka baada ya symbol kuomba habari za
// mtandaoni (mfano: ".analyze CRDB habari").
const NEWS_TRIGGER_WORDS = new Set(['habari', 'live', 'news', 'mtandao']);

const newsCache = new Map(); // SYMBOL -> { text, sources, at }

// ─────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────
const fmt  = (n) => (n == null || Number.isNaN(n) ? 'N/A' : Number(n).toLocaleString());
const fmt2 = (n) => (n == null || Number.isNaN(n) ? 'N/A' : Number(n).toFixed(2));

function buildHeader(title) {
  return `⎯⎯⎯ 『 *${title}* 』 ⎯⎯⎯`;
}

function buildFooter() {
  return (
    `┌─────────────────\n` +
    `│ 🛠️ *MR.IT MEDIATOR*\n` +
    `└─────────────────\n` +
    `   _for easy access of data and analysis.._\n` +
    `   _system developer and automation.._\n` +
    `   🔗 *DSE INVESTOR:* https://investor.dse.co.tz/login`
  );
}

// ─────────────────────────────────────────────
// Box/frame ya monospace kwa tables (values) — inatumia ``` ili WhatsApp
// ionyeshe kwa font ya monospace (tofauti na maandishi ya kawaida ya
// kuchati), na box-drawing characters kuzungushia jedwali.
// rows: [ [label, value], ... ]
// ─────────────────────────────────────────────
function buildBox(title, rows) {
  const labelWidth = Math.max(...rows.map((r) => String(r[0]).length));
  const lines = rows.map(
    ([label, value]) => `${String(label).padEnd(labelWidth)} : ${value}`
  );
  const innerWidth = Math.max(title.length, ...lines.map((l) => l.length));

  const top    = `┌${'─'.repeat(innerWidth + 2)}┐`;
  const sep    = `├${'─'.repeat(innerWidth + 2)}┤`;
  const bottom = `└${'─'.repeat(innerWidth + 2)}┘`;
  const titleLine = `│ ${title.padEnd(innerWidth)} │`;
  const body = lines.map((l) => `│ ${l.padEnd(innerWidth)} │`).join('\n');

  return '```\n' + [top, titleLine, sep, body, bottom].join('\n') + '\n```';
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: muda umeisha (>${ms}ms)`)), ms)
    ),
  ]);
}

// ─────────────────────────────────────────────
// 1) Kukusanya data (bei + fundamentals)
// ─────────────────────────────────────────────
async function gatherData(symbol) {
  const data = {
    symbol,
    name: symbol,
    price: null,
    priceChangePct: null,
    fund: null,
    asOf: null,
    srcPrice: 'DSE',
    srcFund: 'haipatikani',
  };

  // Bei kutoka DSE — jedwali la dse.co.tz halina jina la kampuni, symbol pekee.
  try {
    const { stocks } = await fetchDSEStocks();
    const live = stocks.find((s) => s.symbol === symbol);
    if (live) {
      data.price = live.close || live.prevClose || live.open || null;
      data.priceChangePct = live.changePct ?? null;
    }
  } catch (err) {
    console.warn('analyze: DSE fetch error', err.message);
  }

  // Fundamentals kutoka stockana (live, stockanalysis.com) — hii ndiyo yenye jina
  try {
    const fund = await fetchStockana(symbol);
    if (fund) {
      data.fund = fund;
      data.asOf = fund.asOf || null;
      data.srcFund = 'stockanalysis.com';
      if (fund.name) data.name = fund.name;
    }
  } catch (err) {
    console.warn('analyze: stockana fetch error', err.message);
  }

  // Fallback JSON
  if (!data.fund) {
    const fx = fundamentals[symbol];
    if (fx) {
      data.fund = fx;
      data.asOf = fx.asOf || null;
      data.srcFund = 'fundamentals.json (data ya mkono)';
      if (fx.name) data.name = fx.name;
    }
  }

  return data;
}

// ─────────────────────────────────────────────
// 2) Hesabu za haraka + ukaguzi wa data
// ─────────────────────────────────────────────
function enrichAndAudit(data) {
  const { price, fund } = data;
  const calc = {
    pe: null, pb: null, dy: null, marketcap: null,
  };
  const audit = []; // inconsistencies

  if (fund) {
    // P/E
    if (fund.pe != null) calc.pe = fund.pe;
    else if (price && fund.eps > 0) calc.pe = price / fund.eps;

    // P/B
    if (fund.pb != null) calc.pb = fund.pb;
    else if (price && fund.bvps > 0) calc.pb = price / fund.bvps;

    // Dividend Yield
    if (fund.divYield != null) calc.dy = fund.divYield;
    else if (price && fund.dps) calc.dy = (fund.dps / price) * 100;

    // Market Cap
    if (fund.marketcap != null) calc.marketcap = fund.marketcap;
    else if (fund.sharesOutstanding && price) calc.marketcap = fund.sharesOutstanding * price;

    // ── Ukaguzi wa data ──
    if (fund.dps != null && price) {
      const implied = (fund.dps / price) * 100;
      if (fund.divYield != null && Math.abs(implied - fund.divYield) > 0.3) {
        audit.push(
          `Dividend Yield iliyoripotiwa (${fmt2(fund.divYield)}%) haitokani na DPS/bei ` +
          `(${fmt2(implied)}%). DPS=${fmt(fund.dps)}, bei=${fmt(price)}.`
        );
      }
    }
    if (fund.pe != null && calc.pb != null && fund.roe != null) {
      const impliedRoe = (calc.pb / fund.pe) * 100;
      if (Math.abs(impliedRoe - fund.roe) > 3) {
        audit.push(
          `ROE iliyoripotiwa (${fmt2(fund.roe)}%) haitokani na P/B ÷ P/E ` +
          `(${fmt2(impliedRoe)}%). Huenda vipindi (periods) hazifanani.`
        );
      }
    }
    if (!fund.eps) audit.push('EPS haipo — P/E haiwezi kuthibitishwa.');
    if (!fund.bvps) audit.push('BVPS haipo — P/B haiwezi kuthibitishwa.');
  } else {
    audit.push('Fundamentals hazipatikani kabisa kwenye vyanzo vyote.');
  }

  return { calc, audit };
}

// ─────────────────────────────────────────────
// 3) Habari za mtandaoni (HIARI) kupitia groq/compound
// ─────────────────────────────────────────────
async function fetchLiveNewsContext(symbol, name) {
  const key = symbol.toUpperCase();
  const cached = newsCache.get(key);
  if (cached && Date.now() - cached.at < NEWS_CACHE_MS) {
    return cached;
  }

  const groq = getGroq();
  const query =
    `Tafuta habari za hivi karibuni (miezi 3-6 iliyopita) kuhusu hisa ya ` +
    `"${name || symbol}" (symbol: ${symbol}) inayouzwa katika Dar es Salaam ` +
    `Stock Exchange (DSE), Tanzania. Nataka: ripoti za kifedha/faida za hivi ` +
    `karibuni, tangazo lolote la gawio (dividend), mabadiliko ya uongozi, ` +
    `upanuzi/mikataba mipya, au hatari za kiudhibiti. Jibu kwa Kiswahili ` +
    `rahisi, aya MOJA fupi (maneno 60-100). Kama huwezi kupata habari mahususi ` +
    `za kampuni hii, sema hivyo wazi badala ya kubuni.`;

  const resp = await withTimeout(
    groq.chat.completions.create({
      model: NEWS_MODEL,
      temperature: 0.2,
      messages: [{ role: 'user', content: query }],
      search_settings: { country: 'tanzania' },
    }),
    NEWS_TIMEOUT_MS,
    'habari za mtandaoni (groq/compound)'
  );

  const text = resp.choices?.[0]?.message?.content?.trim() || null;
  const rawResults =
    resp.choices?.[0]?.message?.executed_tools?.[0]?.search_results?.results || [];
  const sources = rawResults.slice(0, 3).map((r) => ({ title: r.title, url: r.url }));

  const result = { text, sources, at: Date.now() };
  newsCache.set(key, result);
  return result;
}

// ─────────────────────────────────────────────
// 4) Groq — uchambuzi wa maana
// ─────────────────────────────────────────────
async function analyzeWithGroq(data, calc, audit, newsContext) {
  const { symbol, name, price, priceChangePct, fund, asOf, srcFund } = data;

  const payload = {
    symbol,
    name,
    price: price,
    priceChangePct,
    asOf,
    source_fundamentals: srcFund,
    fundamentals: fund
      ? {
          eps: fund.eps ?? null,
          bvps: fund.bvps ?? null,
          dps: fund.dps ?? null,
          roe: fund.roe ?? null,
          sharesOutstanding: fund.sharesOutstanding ?? null,
          marketcap: fund.marketcap ?? null,
          pe: fund.pe ?? null,
          pb: fund.pb ?? null,
          divYield: fund.divYield ?? null,
        }
      : null,
    calculated: calc,
    data_quality_notes: audit,
    recent_web_context: newsContext?.text || null,
  };

  const system = `
Wewe ni mchambuzi wa hisa za DSE (Dar es Salaam Stock Exchange) unaongea Kiswahili rahisi.
Unapokea data mbichi + uwiano uliohesabiwa (na wakati mwingine "recent_web_context" —
muhtasari wa habari za hivi karibuni zilizotafutwa mtandaoni), kisha unarudisha JSON
KAMILI (bila maandishi ya nje) yenye muundo huu:

{
  "verdict": "BUY" | "HOLD" | "SELL" | "NEUTRAL" | "WATCH",
  "score": <0-100>,
  "confidence": "juu" | "kati" | "chini",
  "summary": "aya 2-3 kwa Kiswahili rahisi ikieleza hisa ipo vipi",
  "metrics_meaning": {
    "pe": "maana ya P/E hapa",
    "pb": "maana ya P/B hapa",
    "dy": "maana ya Dividend Yield hapa",
    "roe": "maana ya ROE hapa",
    "marketcap": "maana ya Market Cap hapa"
  },
  "strengths": ["pointi 2-4"],
  "risks": ["pointi 2-4"],
  "action": "pendekezo fupi la hatua (si ushauri wa kifedha)",
  "watch": ["vitu vya kufuatilia (2-3)"],
  "data_warnings": ["onyo lolote kuhusu ubora wa data"]
}

KANUNI:
- Kama kigezo ni null/N/A, sema "hakipatikani" usibuni namba.
- Kama kuna data_quality_notes, zitaje kwenye data_warnings.
- Kama "recent_web_context" ipo na ina taarifa za maana, izingatie kwenye
  summary/strengths/risks/watch (mfano: gawio jipya lililotangazwa, ripoti ya
  faida ya karibuni, hatari ya kiudhibiti). Kama recent_web_context ni null au
  inasema "hakuna habari", puuza kimya kimya — usitengeneze habari za kubuni.
- Usitoe ushauri wa kifedha wa moja kwa moja; tumia "inaweza", "inaashiria".
- Jibu KISWAHILI pekee.
- JSON pekee, hakuna maelezo ya ziada nje ya JSON.
`.trim();

  const user = `Chambua hisa hii ya DSE:\n\n${JSON.stringify(payload, null, 2)}`;

  const groq = getGroq();
  const resp = await groq.chat.completions.create({
    model: MODEL,
    temperature: 0.3,
    max_tokens: 1400,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const raw = resp.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    // fallback: rudisha kama summary tu
    return {
      verdict: 'NEUTRAL',
      score: 50,
      confidence: 'chini',
      summary: raw.slice(0, 800),
      metrics_meaning: {},
      strengths: [],
      risks: [],
      action: 'Angalia data kwa uangalifu.',
      watch: [],
      data_warnings: ['Groq haikurudisha JSON halali.'],
    };
  }
}

// ─────────────────────────────────────────────
// 5) Kujenga ujumbe wa WhatsApp
// ─────────────────────────────────────────────
function verdictEmoji(v) {
  switch ((v || '').toUpperCase()) {
    case 'BUY':     return '🟢';
    case 'HOLD':    return '🟡';
    case 'SELL':    return '🔴';
    case 'WATCH':   return '👀';
    default:        return '⚪';
  }
}

function buildMessage(data, calc, ai, newsContext) {
  const { symbol, name, price, priceChangePct, fund, asOf, srcPrice, srcFund } = data;
  const L = [];

  L.push(buildHeader(`${symbol} — DSE ANALYZE`));
  L.push('');
  if (name && name !== symbol) L.push(`🏢 *${name}*`);
  L.push('');

  const priceStr =
    `TZS ${fmt(price)}` +
    (priceChangePct != null
      ? ` (${priceChangePct >= 0 ? '+' : ''}${Number(priceChangePct).toFixed(2)}%)`
      : '');

  L.push(
    buildBox('SNAPSHOT', [
      ['Bei', priceStr],
      ['Verdict', `${verdictEmoji(ai.verdict)} ${ai.verdict || 'NEUTRAL'}`],
      ['Score', `${ai.score ?? '—'}/100`],
      ['Confidence', ai.confidence || '—'],
    ])
  );
  L.push('');

  // Muhtasari
  if (ai.summary) {
    L.push(`📝 *Muhtasari*`);
    L.push(ai.summary);
    L.push('');
  }

  // Fundamentals ghafi — kwenye box ya monospace
  if (fund) {
    L.push(`📊 *Fundamentals (${asOf || 'kipindi kisichojulikana'})*`);
    L.push(
      buildBox('FUNDAMENTALS', [
        ['EPS', `TZS ${fmt(fund.eps)}`],
        ['BVPS', `TZS ${fmt(fund.bvps)}`],
        ['DPS', `TZS ${fmt(fund.dps)}`],
        ['ROE', fund.roe != null ? fmt2(fund.roe) + '%' : 'N/A'],
      ])
    );
    L.push('');

    L.push(`📐 *Uwiano*`);
    L.push(
      buildBox('UWIANO', [
        ['P/E', calc.pe != null ? fmt2(calc.pe) + 'x' : 'N/A'],
        ['P/B', calc.pb != null ? fmt2(calc.pb) + 'x' : 'N/A'],
        ['Div. Yield', calc.dy != null ? fmt2(calc.dy) + '%' : 'N/A'],
        ['Market Cap', calc.marketcap != null ? 'TZS ' + fmt(calc.marketcap) : 'N/A'],
      ])
    );
    L.push('');
  } else {
    L.push('⚠️ *Fundamentals hazipatikani* kwa hisa hii.');
    L.push('');
  }

  // Maana ya kila kigezo
  const mm = ai.metrics_meaning || {};
  if (Object.keys(mm).length) {
    L.push(`🧠 *Maana ya viwango*`);
    if (mm.pe) L.push(`   • *P/E:* ${mm.pe}`);
    if (mm.pb) L.push(`   • *P/B:* ${mm.pb}`);
    if (mm.dy) L.push(`   • *DY:* ${mm.dy}`);
    if (mm.roe) L.push(`   • *ROE:* ${mm.roe}`);
    if (mm.marketcap) L.push(`   • *Market Cap:* ${mm.marketcap}`);
    L.push('');
  }

  // Nguvu
  if (Array.isArray(ai.strengths) && ai.strengths.length) {
    L.push(`✅ *Nguvu*`);
    ai.strengths.forEach((s) => L.push(`   • ${s}`));
    L.push('');
  }

  // Hatari
  if (Array.isArray(ai.risks) && ai.risks.length) {
    L.push(`⚠️ *Hatari*`);
    ai.risks.forEach((r) => L.push(`   • ${r}`));
    L.push('');
  }

  // Hatua
  if (ai.action) {
    L.push(`🎬 *Hatua inayoshauriwa*`);
    L.push(`   ${ai.action}`);
    L.push('');
  }

  // Vya kufuatilia
  if (Array.isArray(ai.watch) && ai.watch.length) {
    L.push(`👀 *Fuatilia*`);
    ai.watch.forEach((w) => L.push(`   • ${w}`));
    L.push('');
  }

  // Vyanzo vya habari za mtandaoni (kama ".analyze SYMBOL habari" ilitumika)
  if (newsContext?.sources?.length) {
    L.push(`🌐 *Vyanzo vya habari (mtandaoni)*`);
    newsContext.sources.forEach((s) => L.push(`   • ${s.title || s.url}`));
    L.push('');
  }

  // Onyo la data
  const warnings = [
    ...(Array.isArray(ai.data_warnings) ? ai.data_warnings : []),
  ];
  if (warnings.length) {
    L.push(`🔎 *Ubora wa data*`);
    warnings.forEach((w) => L.push(`   • ${w}`));
    L.push('');
  }

  L.push(`_Chanzo: bei = ${srcPrice}; fundamentals = ${srcFund}; uchambuzi = Groq (${MODEL})` +
    (newsContext ? `; habari = Groq (${NEWS_MODEL})` : '') + `._`);
  L.push(`_⚠️ SI ushauri wa kitaalamu wa uwekezaji._`);
  L.push('');
  L.push(buildFooter());
  return L.join('\n');
}

// ─────────────────────────────────────────────
// 6) Command export
// ─────────────────────────────────────────────
module.exports = {
  name: 'analyze',
  aliases: ['chambua', 'changanua', 'uchambuzi', 'uwekezaji', 'fundamentals'],
  category: 'utility',
  description: 'Uchambuzi wa kina wa hisa ya DSE kwa msaada wa Groq AI (ongeza "habari" kutafuta habari za sasa mtandaoni)',
  usage: '.analyze <symbol> [habari] — mfano: .analyze CRDB au .analyze CRDB habari',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const symbol = (args[0] || '').toUpperCase();
    const wantsLiveNews = NEWS_TRIGGER_WORDS.has((args[1] || '').toLowerCase());

    if (!symbol) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `❓ Weka symbol ya hisa.\n\n` +
            `Tumia: .analyze <symbol> [habari]\n` +
            `Mfano: .analyze CRDB\n` +
            `Mfano (na habari za mtandaoni): .analyze CRDB habari`,
        },
        { quoted: msg }
      );
    }

    try {
      // 1) Kukusanya data
      const data = await gatherData(symbol);

      if (data.price == null && !data.fund) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ Hatuna data kwa "${symbol}" kwa sasa.\n\n` +
              `• Bei haikupatikana kwenye DSE\n` +
              `• Fundamentals hazipatikani kwenye stockanalysis.com wala fundamentals.json\n\n` +
              `Jaribu tena baadaye au tumia \`.stock ${symbol}\` kwa snapshot.`,
          },
          { quoted: msg }
        );
      }

      // 2) Hesabu + ukaguzi
      const { calc, audit } = enrichAndAudit(data);

      // 3) Habari za mtandaoni (HIARI — ".analyze SYMBOL habari")
      let newsContext = null;
      if (wantsLiveNews) {
        try {
          newsContext = await fetchLiveNewsContext(symbol, data.name);
        } catch (err) {
          // Log details kamili (status, body) kwa developer — si kwa mtumiaji,
          // ili tuweze kubaini chanzo halisi cha errors kama 413/429/500.
          console.warn(
            'analyze: live news fetch error',
            err.status || err.response?.status || '',
            err.message,
            err.error || err.response?.data || ''
          );

          const status = err.status || err.response?.status;
          let reason;
          if (status === 413) {
            reason = 'ombi lilikuwa kubwa mno kwa seva ya habari';
          } else if (status === 429) {
            reason = 'kikomo cha maombi kimefikiwa (rate limit), jaribu tena baadaye';
          } else if (/muda umeisha/i.test(err.message)) {
            reason = 'muda wa kusubiri umeisha';
          } else {
            reason = 'tatizo la mtandao/seva';
          }
          audit.push(`Habari za mtandaoni hazikupatikana (${reason}).`);
        }
      }

      // 4) Groq — uchambuzi
      let ai;
      try {
        ai = await analyzeWithGroq(data, calc, audit, newsContext);
      } catch (err) {
        console.warn('analyze: Groq error', err.message);
        ai = {
          verdict: 'NEUTRAL',
          score: 50,
          confidence: 'chini',
          summary: `Uchambuzi wa AI haukupatikana (${err.message}). Hii hapa snapshot ya data:`,
          metrics_meaning: {},
          strengths: [],
          risks: [],
          action: 'Angalia data ghafi hapa chini kwa uangalifu.',
          watch: [],
          data_warnings: ['Groq haikupatikana — onyo la ubora wa data lipo chini.'],
        };
      }

      // 5) Ongeza audit kwenye data_warnings
      if (audit.length) {
        ai.data_warnings = [
          ...(Array.isArray(ai.data_warnings) ? ai.data_warnings : []),
          ...audit,
        ];
      }

      // 6) Tuma
      return await sock.sendMessage(
        jid,
        { text: buildMessage(data, calc, ai, newsContext) },
        { quoted: msg }
      );
    } catch (err) {
      console.error('analyze error:', err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kuchambua "${symbol}": ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
