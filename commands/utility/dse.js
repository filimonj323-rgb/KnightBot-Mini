/**
 * DSE Command — Bei za hisa za Dar es Salaam Stock Exchange (DSE)
 *
 * Chanzo: dse.co.tz (ukurasa mkuu unaonyesha "Market Summary" ya siku,
 * ikiwa na hisa zote zilizoorodheshwa — bila login, kama HTML ya kawaida).
 *
 * ⚠️ MUHIMU: Terms & Conditions za DSE (dse.co.tz/terms/conditions)
 * zinaruhusu matumizi ya Market Data kwa "personal, non-commercial purposes
 * only" — si kwa kusambaza tena kibiashara. Command hii ni kwa matumizi
 * yako binafsi/ndani ya group zako, si kwa kuuza upatikanaji au kutumika na
 * wateja wengi wa kibiashara (mfano wateja wa pairing wanaolipa). Kwa
 * matumizi ya kibiashara, tumia Data Services Portal rasmi ya DSE
 * (data.dse.co.tz).
 *
 * NOTE YA KIUFUNDI: dse.co.tz haina API rasmi ya bure — hii inasoma jedwali
 * la "Equity/Bonds Watch" moja kwa moja kutoka HTML ya ukurasa mkuu.
 * Ikiwa DSE watabadilisha muundo wa website yao, parsing hii inaweza
 * kuhitaji kurekebishwa (angalia comment za "SELECTOR" chini).
 */

const axios = require('axios');
const cheerio = require('cheerio');

// Muda wa "cache" kuepuka kupiga dse.co.tz kila ujumbe (heshimu server yao).
const CACHE_MS = 2 * 60 * 1000; // dakika 2
let cache = { data: null, at: 0 };

async function fetchDSEStocks() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const { data: html } = await axios.get('https://dse.co.tz/', {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });

  const $ = cheerio.load(html);
  const rows = [];

  // SELECTOR: tunatafuta table yoyote ambayo mstari wake wa kwanza una
  // "Symbol" NA "MCAP" — hii ndiyo jedwali la "Equity Watch" kwenye
  // Market Summary. Tunaepuka kutegemea class/id maalum kwa sababu
  // haikuwepo njia ya kuzithibitisha bila kufikia HTML halisi wakati wa
  // kuandika command hii.
  $('table').each((_, table) => {
    const headerText = $(table).find('tr').first().text();
    if (/Symbol/i.test(headerText) && /MCAP/i.test(headerText)) {
      $(table)
        .find('tr')
        .slice(1)
        .each((__, tr) => {
          const cells = $(tr)
            .find('td')
            .map((___, td) => $(td).text().trim())
            .get();
          if (cells.length >= 6 && cells[0] && /^[A-Z]+(-ETF)?$/i.test(cells[0])) {
            rows.push(cells);
          }
        });
    }
  });

  if (rows.length === 0) {
    throw new Error(
      'Imeshindwa kupata jedwali la DSE — huenda muundo wa dse.co.tz umebadilika (tazama comment "SELECTOR" kwenye dse.js)'
    );
  }

  const num = (s) => parseFloat(String(s || '0').replace(/,/g, '')) || 0;

  const stocks = rows.map((cells) => {
    // Mpangilio kwenye jedwali la DSE: Symbol, Open, Prev Close, Close,
    // High, Low, Change, Turn over, Deals, Bid, Offer, Volume, MCAP
    const symbol = cells[0].toUpperCase();
    const open = num(cells[1]);
    const prevClose = num(cells[2]);
    const close = num(cells[3]);
    const high = num(cells[4]);
    const low = num(cells[5]);
    const volume = num(cells[11]);
    const mcap = cells[12] || cells[cells.length - 1] || 'N/A';

    // Tunahesabu mabadiliko wenyewe kutoka close/prevClose badala ya
    // kuchambua text ya "Change" column (ina alama za mishale/emoji
    // ambazo ni ngumu kutegemea kubaki sawa).
    const change = prevClose ? close - prevClose : 0;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    return { symbol, open, prevClose, close, high, low, volume, mcap, change, changePct };
  });

  cache = { data: stocks, at: Date.now() };
  return stocks;
}

module.exports = {
  name: 'dse',
  aliases: ['hisatz', 'tzstock', 'dsestock'],
  category: 'utility',
  description: 'Bei za hisa za Dar es Salaam Stock Exchange (DSE)',
  usage: '.dse [symbol] — mfano: .dse CRDB — au .dse pekee kwa muhtasari wa soko',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    try {
      const stocks = await fetchDSEStocks();
      const symbol = (args[0] || '').toUpperCase();

      if (symbol) {
        const stock = stocks.find((s) => s.symbol === symbol);
        if (!stock) {
          return await sock.sendMessage(
            jid,
            {
              text:
                `❌ Hisa "${symbol}" haikupatikana kwenye DSE.\n\n` +
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
              `${emoji} *${stock.symbol} — DSE*\n\n` +
              `💰 *Bei (Close):* TZS ${stock.close.toLocaleString()}\n` +
              `${emoji} *Mabadiliko:* ${stock.change >= 0 ? '+' : ''}${stock.change.toFixed(0)} (${stock.changePct.toFixed(2)}%)\n` +
              `📊 *Open:* ${stock.open.toLocaleString()}   *Prev Close:* ${stock.prevClose.toLocaleString()}\n` +
              `📈 *High:* ${stock.high.toLocaleString()}   📉 *Low:* ${stock.low.toLocaleString()}\n` +
              `📦 *Volume:* ${stock.volume.toLocaleString()}\n` +
              `🏦 *Market Cap:* TZS ${stock.mcap} Bilioni\n\n` +
              `_Chanzo: dse.co.tz — kwa matumizi binafsi (si kusambaza kibiashara)_`,
          },
          { quoted: msg }
        );
      }

      // Hakuna symbol — onyesha muhtasari wa soko zima
      const lines = stocks
        .map((s) => {
          const arrow = s.change > 0 ? '▲' : s.change < 0 ? '▼' : '⏺';
          return `${arrow} *${s.symbol}*: ${s.close.toLocaleString()} (${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%)`;
        })
        .join('\n');

      return await sock.sendMessage(
        jid,
        {
          text:
            `📊 *DSE — Muhtasari wa Soko*\n\n${lines}\n\n` +
            `_Tumia: .dse <symbol> kwa maelezo zaidi (mfano: .dse CRDB)_\n` +
            `_Chanzo: dse.co.tz_`,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('DSE fetch error:', err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kupata data ya DSE: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
