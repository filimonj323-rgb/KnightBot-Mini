/**
 * Mansa Command — Bei + muhtasari wa soko la DSE kutoka Mansa API
 *
 * Chanzo: Mansa API (https://mansaapi.com) — JSON API moja kwa moja.
 *
 * ⚠️ MUHIMU:
 *  - Endpoint hii inarudisha BEI, volume, change — HAIrudishi EPS/BVPS/ROE.
 *    Kwa fundamentals, angalia analyze.js (manual) au endpoint nyingine ya
 *    Mansa kama ipo.
 *  - Auth: api_key kama QUERY PARAMETER (sio header).
 *  - Free tier: 100 req/day, 60 req/min. Cache ni dakika 5.
 *  - MANSA_API_KEY inatoka process.env.
 *
 * ⚠️ SI USHAURI WA UWEKEZAJI.
 */

const axios = require('axios');

const CACHE_MS = 5 * 60 * 1000; // dakika 5
let cache = { data: null, at: 0 };

const MANSA_BASE = process.env.MANSA_BASE_URL || 'https://mansaapi.com/api/v1';

async function fetchMansaStocks() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const key = process.env.MANSA_API_KEY;
  if (!key) {
    throw new Error(
      'MANSA_API_KEY haipo kwenye environment. Weka kwenye .env kisha anzisha bot tena.'
    );
  }

  const url = `${MANSA_BASE}/markets/exchanges/DSE/stocks?api_key=${encodeURIComponent(key)}`;
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  });

  if (!data || data.success !== true || !Array.isArray(data.data)) {
    throw new Error('Muundo wa response ya Mansa haukutegemewa (schema imebadilika?)');
  }

  const stocks = data.data.map((s) => ({
    symbol: String(s.ticker || '').toUpperCase(),
    name: s.name || s.ticker || '',
    price: Number(s.price) || 0,
    change: Number(s.change) || 0,
    changePct: Number(s.change_pct) || 0,
    volume: s.volume == null ? null : Number(s.volume),
    scrapedAt: s.scraped_at || null,
  }));

  const meta = data.meta || {};
  cache = { data: { stocks, meta }, at: Date.now() };
  return cache.data;
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

function padCol(str, width) {
  str = String(str);
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

function buildTable(rows, headers, widths) {
  let out = '```\n';
  out += headers.map((h, i) => padCol(h, widths[i])).join(' ') + '\n';
  out += widths.map((w) => '-'.repeat(w)).join(' ') + '\n';
  rows.forEach((r) => {
    out += r.map((c, i) => padCol(c, widths[i])).join(' ') + '\n';
  });
  out += '```';
  return out;
}

const fmtVol = (v) => (v == null ? '—' : v.toLocaleString());

module.exports = {
  name: 'mansa',
  aliases: ['msingi', 'manz', 'dse2'],
  category: 'utility',
  description: 'Bei + muhtasari wa soko la DSE kutoka Mansa API',
  usage: '.mansa [symbol] — mfano: .mansa CRDB — au .mansa pekee kwa muhtasari wa soko',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    try {
      const { stocks, meta } = await fetchMansaStocks();
      const symbol = (args[0] || '').toUpperCase();
      const updated = meta.updated_at ? new Date(meta.updated_at).toLocaleString('sw-TZ') : null;
      const dateLabel = updated ? `📅 *${updated}*` : '📅 _Tarehe haipatikani_';

      if (symbol) {
        const stock = stocks.find((s) => s.symbol === symbol);
        if (!stock) {
          return await sock.sendMessage(
            jid,
            {
              text:
                `❌ Hisa "${symbol}" haikupatikana kwenye Mansa.\n\n` +
                `Zilizopo: ${stocks.map((s) => s.symbol).join(', ')}`,
            },
            { quoted: msg }
          );
        }

        const emoji = stock.change > 0 ? '📈' : stock.change < 0 ? '📉' : '➖';
        return await sock.sendMessage(
          jid,
          {
            text:
              `${buildHeader(stock.symbol + ' — MANSA')}\n\n` +
              `${emoji} ${dateLabel}\n\n` +
              `🏢 *${stock.name}*\n\n` +
              `💰 *Bei:* TZS ${stock.price.toLocaleString()}\n` +
              `${emoji} *Mabadiliko:* ${stock.change >= 0 ? '+' : ''}${stock.change.toLocaleString()} (${stock.changePct.toFixed(2)}%)\n` +
              `📦 *Volume:* ${fmtVol(stock.volume)}\n\n` +
              `_Chanzo: Mansa API (data_freshness: ${meta.data_freshness || 'N/A'})._\n` +
              `_⚠️ Hii ni bei ya mwisho iliyorekodiwa, si "live"._\n\n` +
              `${buildFooter()}`,
          },
          { quoted: msg }
        );
      }

      // Muhtasari wa soko — top movers + table kamili
      const sorted = [...stocks].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
      const headers = ['SYM', 'PRICE', 'CHG%'];
      const widths = [10, 9, 8];
      const rows = sorted.map((s) => [
        s.symbol,
        s.price.toLocaleString(),
        `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%`,
      ]);

      return await sock.sendMessage(
        jid,
        {
          text:
            `${buildHeader('MANSA — DSE MARKET')}\n${dateLabel}\n\n` +
            `${buildTable(rows, headers, widths)}\n\n` +
            `_Jumla: ${stocks.length} hisa. Tumia: .mansa <symbol> kwa maelezo zaidi._\n` +
            `_⚠️ Chanzo: Mansa API — bei/volume pekee, HAKUNA EPS/BVPS/ROE._\n\n` +
            `${buildFooter()}`,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('Mansa error:', err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kupata data ya Mansa: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
