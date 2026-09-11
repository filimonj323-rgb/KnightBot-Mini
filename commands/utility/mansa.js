/**
 * Mansa Command — Data ya Msingi (Fundamentals) kutoka Mansa API
 *
 * Chanzo: Mansa API (https://mansaapi.com) — JSON API (si HTML scraping).
 *
 * ⚠️ MUHIMU:
 *  - Faili hii inajaribu AUTOMATICALLY auth modes 4 na paths kadhaa, kwa
 *    sababu schema halisi ya Mansa haijathibitishwa bado. Ujumbe wa error
 *    utakuambia nini kifanyike kama zote zimeshindwa.
 *  - Free tier: 100 req/day, 60 req/min. Cache ni dakika 5 kuepuka matumizi
 *    ya haraka. Unaweza kuongeza hadi siku 1-7 baadaye.
 *  - MANSA_API_KEY inatoka process.env. Weka kwenye .env kisha anzisha bot.
 *
 * ⚠️ SI USHAURI WA UWEKEZAJI — hii ni zana ya data tu.
 */

const axios = require('axios');

const CACHE_MS = 5 * 60 * 1000; // dakika 5
const cache = new Map(); // symbol -> { data, at }

const MANSA_BASE = process.env.MANSA_BASE_URL || 'https://api.mansaapi.com/v1';

// Njia za auth za kujaribu kwa mpangilio
const AUTH_MODES = ['bearer', 'xapikey', 'apikeyheader', 'apikeyquery'];

// Templates za paths — {SYM} itabadilishwa na symbol
const PATH_TEMPLATES = [
  '/markets/exchanges/DSE/stocks/{SYM}',
  '/markets/exchanges/DSE/stocks',
  '/fundamentals/DSE/{SYM}',
  '/fundamentals/{SYM}',
  '/markets/stocks?exchange=DSE&symbol={SYM}',
];

function buildAuthConfig(mode, key) {
  const headers = { Accept: 'application/json' };
  let queryExtra = '';

  if (mode === 'bearer')            headers['Authorization'] = 'Bearer ' + key;
  else if (mode === 'xapikey')      headers['X-API-Key'] = key;
  else if (mode === 'apikeyheader') headers['api-key'] = key;
  else if (mode === 'apikeyquery')  queryExtra = 'api_key=' + encodeURIComponent(key);

  return { headers, queryExtra };
}

function buildUrl(template, symbol, queryExtra) {
  const path = template.replace('{SYM}', encodeURIComponent(symbol));
  let url = MANSA_BASE.replace(/\/+$/, '') + path;
  if (queryExtra) {
    const sep = url.includes('?') ? '&' : '?';
    url += sep + queryExtra;
  }
  return url;
}

async function tryFetch(url, headers) {
  const res = await axios.get(url, {
    headers,
    timeout: 15000,
    validateStatus: () => true,
  });
  return res;
}

/**
 * Jaribu mchanganyiko wote wa paths × auth modes hadi mmoja ufanikiwe.
 * Inarudisha { ok, status, url, mode, data, error }.
 */
async function fetchMansaRaw(symbol, key) {
  let lastError = null;
  const attempts = [];

  for (const template of PATH_TEMPLATES) {
    for (const mode of AUTH_MODES) {
      const { headers, queryExtra } = buildAuthConfig(mode, key);
      const url = buildUrl(template, symbol, queryExtra);

      try {
        const res = await tryFetch(url, headers);
        attempts.push({ url, mode, status: res.status });

        if (res.status >= 200 && res.status < 300) {
          return { ok: true, status: res.status, url, mode, data: res.data };
        }

        // Kama ni 401/403 kwa mode hii, jaribu mode inayofuata
        // Kama ni 404, jaribu path inayofuata (mode zote zimejaribiwa)
      } catch (err) {
        attempts.push({ url, mode, status: 0, error: err.message });
        lastError = err;
      }
    }
  }

  return { ok: false, attempts, error: lastError };
}

function mapMansaResponse(raw, symbol) {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw.data || raw;

  const pick = (...keys) => {
    for (const k of keys) {
      if (d[k] != null && d[k] !== '') return d[k];
    }
    return null;
  };

  const num = (v) => {
    if (v == null) return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  return {
    symbol: String(pick('symbol', 'ticker', 'code') || symbol).toUpperCase(),
    name: pick('name', 'company_name', 'companyName') || symbol,
    sector: pick('sector', 'industry') || null,
    eps: num(pick('eps', 'earnings_per_share', 'eps_ttm')),
    bvps: num(pick('bvps', 'book_value_per_share', 'bookValuePerShare')),
    dps: num(pick('dps', 'dividend_per_share', 'dividendPerShare')) || 0,
    roe: num(pick('roe', 'return_on_equity', 'returnOnEquity')),
    asOf: pick('as_of', 'asOf', 'period', 'fiscal_year', 'year') || null,
    source: 'Mansa API',
  };
}

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

const fmt = (n) => (n == null ? 'N/A' : Number(n).toLocaleString());

function buildMansaMessage(m) {
  return (
    `${buildHeader(m.symbol + ' — MANSA FUNDAMENTALS')}\n\n` +
    `🏢 *${m.name}* ${m.sector ? `(${m.sector})` : ''}\n\n` +
    `📊 *Vipimo vya Msingi (${m.asOf || 'kipindi kisichojulikana'}):*\n` +
    `   • EPS: TZS ${fmt(m.eps)}\n` +
    `   • BVPS: TZS ${fmt(m.bvps)}\n` +
    `   • DPS: TZS ${fmt(m.dps)}\n` +
    `   • ROE: ${m.roe != null ? m.roe.toFixed(1) + '%' : 'N/A'}\n\n` +
    `_Chanzo: ${m.source}. Data inaweza kuwa na ucheleweshaji — kagua ripoti ya hivi karibuni ya kampuni._\n` +
    `_⚠️ Hii SI ushauri wa kitaalamu wa uwekezaji._\n\n` +
    `${buildFooter()}`
  );
}

module.exports = {
  name: 'mansa',
  aliases: ['msingi', 'fundamentals'],
  category: 'utility',
  description: 'Data ya msingi (fundamentals) ya hisa za DSE kutoka Mansa API',
  usage: '.mansa <symbol> — mfano: .mansa CRDB',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const symbol = (args[0] || '').toUpperCase();

    if (!symbol) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `❓ Tafadhali weka symbol ya hisa.\n\n` +
            `Tumia: .mansa <symbol>\n` +
            `Mfano: .mansa CRDB`,
        },
        { quoted: msg }
      );
    }

    const key = process.env.MANSA_API_KEY;
    if (!key) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `⚙️ *MANSA_API_KEY haipo kwenye environment.*\n\n` +
            `Ongeza kwenye .env:\n\`MANSA_API_KEY=mansa_live_sk_...\`\n` +
            `kisha anzisha bot tena.`,
        },
        { quoted: msg }
      );
    }

    // Cache
    const cached = cache.get(symbol);
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return await sock.sendMessage(jid, { text: buildMansaMessage(cached.data) }, { quoted: msg });
    }

    try {
      const r = await fetchMansaRaw(symbol, key);

      if (!r.ok) {
        // Unda ujumbe wa error unaoeleweka
        const statuses = (r.attempts || []).map((a) => `${a.mode}:${a.status}`).join(', ');
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ *Imeshindwa kupata data ya Mansa kwa "${symbol}".*\n\n` +
              `Nilijaribu paths ${PATH_TEMPLATES.length} × auth modes ${AUTH_MODES.length}.\n` +
              `Statuses: ${statuses || 'hakuna'}\n` +
              (r.error ? `Error: ${r.error.message}\n` : '') +
              `\n_Hii inaonyesha schema halisi ya Mansa haijulikani bado. Nitumie screenshot ya documentation ya Mansa (kutoka dashboard yako) ili nirekebishe._`,
          },
          { quoted: msg }
        );
      }

      const mapped = mapMansaResponse(r.data, symbol);
      if (!mapped || (mapped.eps == null && mapped.bvps == null && mapped.roe == null)) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `⚠️ *API ilifanya kazi lakini hakuna fundamentals zilizopatikana.*\n\n` +
              `Path: ${r.url}\nMode: ${r.mode}\nStatus: ${r.status}\n\n` +
              `_Inawezekana schema ni tofauti na nilivyotarajia. Nitumie JSON response ili nirekebishe._`,
          },
          { quoted: msg }
        );
      }

      cache.set(symbol, { data: mapped, at: Date.now() });
      return await sock.sendMessage(jid, { text: buildMansaMessage(mapped) }, { quoted: msg });
    } catch (err) {
      console.error('Mansa error:', err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Error ya Mansa kwa "${symbol}": ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
