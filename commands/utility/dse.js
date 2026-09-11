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

  // Tarehe ya data — dse.co.tz inaonyesha "Market Summary : <tarehe>" juu
  // ya jedwali. Hii ndiyo tarehe HALISI ya bei zilizopo chini (mara nyingi
  // siku ya mwisho ya biashara iliyofunga, si lazima "leo" — angalia
  // comment ya juu ya faili). Tunaitoa hapa ili isionekane kama "live".
  let summaryDate = null;
  $('*').each((_, el) => {
    if (summaryDate) return;
    const text = $(el).text().trim();
    const match = text.match(/Market Summary\s*:?\s*$/i);
    if (match) {
      // Tarehe kwa kawaida iko kwenye element inayofuata (h1/h2/span) yenye
      // muundo "September 08, 2026".
      const next = $(el).next().text().trim();
      if (/\d{4}/.test(next)) summaryDate = next;
    }
  });
  // Fallback: tafuta moja kwa moja muundo "Mwezi DD, YYYY" popote kwenye page.
  if (!summaryDate) {
    const bodyText = $('body').text();
    const m = bodyText.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}/);
    if (m) summaryDate = m[0];
  }

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
    // Order book ya kiwango cha juu (touchline): Bid = bei bora ya
    // kununua iliyopo sokoni, Offer = bei bora ya kuuza iliyopo sokoni.
    const bid = num(cells[9]);
    const offer = num(cells[10]);
    const volume = num(cells[11]);
    const mcap = cells[12] || cells[cells.length - 1] || 'N/A';

    // Tunahesabu mabadiliko wenyewe kutoka close/prevClose badala ya
    // kuchambua text ya "Change" column (ina alama za mishale/emoji
    // ambazo ni ngumu kutegemea kubaki sawa).
    const change = prevClose ? close - prevClose : 0;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;

    return { symbol, open, prevClose, close, high, low, bid, offer, volume, mcap, change, changePct };
  });

  cache = { data: { stocks, date: summaryDate }, at: Date.now() };
  return cache.data;
}

// Table ya monospace inayoonekana sawa kwenye WhatsApp (ndani ya ```code```).
// KUMBUKA: usiweke emoji ndani ya cells — upana wao si sawa na herufi za
// kawaida kwenye monospace, hivyo vinavuruga alignment ya columns.
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

// Header ya kisasa yenye bracket-style, mfano « 『 TITLE 』 »
function buildHeader(title) {
  return `⎯⎯⎯ 『 *${title}* 』 ⎯⎯⎯`;
}

// Footer ya branding, mtindo wa box border.
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

module.exports = {
  name: 'dse',
  aliases: ['hisatz', 'tzstock', 'dsestock'],
  // Inatolewa (exported) ili command nyingine (mfano analyze.js) itumie bei
  // ya live bila kurudia logic ya kuchakura dse.co.tz.
  fetchDSEStocks,
  category: 'utility',
  description: 'Bei za hisa za Dar es Salaam Stock Exchange (DSE)',
  usage: '.dse [symbol] — mfano: .dse CRDB — au .dse pekee kwa muhtasari wa soko',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    try {
      const { stocks, date } = await fetchDSEStocks();
      const dateLabel = date ? `📅 *${date}*` : '📅 _Tarehe haipatikani (tazama dse.co.tz)_';
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
              `${buildHeader(stock.symbol + ' — DSE')}\n\n` +
              `${emoji} ${dateLabel}\n\n` +
              `💰 *Bei (Close):* TZS ${stock.close.toLocaleString()}\n` +
              `${emoji} *Mabadiliko:* ${stock.change >= 0 ? '+' : ''}${stock.change.toFixed(0)} (${stock.changePct.toFixed(2)}%)\n` +
              `📊 *Open:* ${stock.open.toLocaleString()}   *Prev Close:* ${stock.prevClose.toLocaleString()}\n` +
              `📈 *High:* ${stock.high.toLocaleString()}   📉 *Low:* ${stock.low.toLocaleString()}\n` +
              `📦 *Volume:* ${stock.volume.toLocaleString()}\n` +
              `🏦 *Market Cap:* TZS ${stock.mcap} Bilioni\n\n` +
              `📖 *Order Book (Touchline):*\n` +
              `   🟢 Bid (Nunua): ${stock.bid ? 'TZS ' + stock.bid.toLocaleString() : 'Hakuna bid leo'}\n` +
              `   🔴 Offer (Uza): ${stock.offer ? 'TZS ' + stock.offer.toLocaleString() : 'Hakuna offer leo'}\n\n` +
              `_Hii ni bei ya mwisho kufunga (closing) + touchline ya order book, si "live". Kwa bei za live na order book kamili (depth), ingia kwenye DSE INVESTOR._\n\n` +
              `${buildFooter()}`,
          },
          { quoted: msg }
        );
      }

      // Hakuna symbol — onyesha muhtasari wa soko zima kama table
      const headers = ['SYM', 'PRICE', 'CHG%'];
      const widths = [10, 9, 8];
      const rows = stocks.map((s) => [
        s.symbol,
        s.close.toLocaleString(),
        `${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%`,
      ]);
      const table = buildTable(rows, headers, widths);

      return await sock.sendMessage(
        jid,
        {
          text:
            `${buildHeader('DSE MARKET SUMMARY')}\n${dateLabel}\n\n${table}\n\n` +
            `_Tumia: .dse <symbol> kwa maelezo zaidi (mfano: .dse CRDB)_\n\n` +
            `${buildFooter()}`,
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
