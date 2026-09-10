/**
 * Gainers Command — Wapandaji na Washukaji wa Dar es Salaam Stock Exchange (DSE)
 *
 * Chanzo: dse.co.tz/get/gainers/losers — endpoint rasmi ya JSON inayotumiwa
 * na frontend ya dse.co.tz wenyewe (Alpine.js "gainers_and_losers_function").
 * Tofauti na dse.js (inayochakura HTML ya "Equity Watch"), hii ni endpoint
 * ya JSON moja kwa moja — hakuna parsing ya HTML inayohitajika, na haina
 * kila column (bid/offer/mcap hazipo hapa, price+volume+change tu).
 *
 * ⚠️ MUHIMU: Matumizi sawa na dse.js — Terms & Conditions za DSE zinaruhusu
 * "personal, non-commercial purposes only". Command hii ni kwa matumizi
 * binafsi/ndani ya group zako, si kwa kuuza upatikanaji.
 */

const axios = require('axios');

const CACHE_MS = 2 * 60 * 1000; // dakika 2 — sawa na dse.js
let cache = { data: null, at: 0 };

async function fetchGainersLosers() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const { data } = await axios.get('https://dse.co.tz/get/gainers/losers', {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });

  if (!data || data.success !== true || !Array.isArray(data.gainers_and_losers)) {
    throw new Error('Muundo wa response kutoka DSE haukutegemewa (endpoint imebadilika?)');
  }

  const num = (s) => parseFloat(String(s ?? '0').replace(/,/g, '')) || 0;

  const list = data.gainers_and_losers.map((item) => ({
    symbol: String(item.company || '').toUpperCase(),
    change: num(item.change),
    price: num(item.price),
    volume: num(item.volume),
  }));

  cache = { data: list, at: Date.now() };
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
  name: 'gainers',
  aliases: ['losers', 'topmovers', 'gainerslosers'],
  category: 'utility',
  description: 'Wapandaji (gainers) na washukaji (losers) wa DSE kwa siku husika',
  usage: '.gainers — muhtasari wa wapandaji/washukaji — au .gainers 10 kuonyesha top 10 kila upande',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    try {
      const list = await fetchGainersLosers();

      // Idadi ya kuonyesha kila upande (default 5, max 15 kuepuka ujumbe mrefu sana)
      let topN = parseInt(args[0], 10);
      if (!Number.isFinite(topN) || topN <= 0) topN = 5;
      if (topN > 15) topN = 15;

      const gainers = list
        .filter((s) => s.change > 0)
        .sort((a, b) => b.change - a.change)
        .slice(0, topN);

      const losers = list
        .filter((s) => s.change < 0)
        .sort((a, b) => a.change - b.change)
        .slice(0, topN);

      const flat = list.filter((s) => s.change === 0);

      const headers = ['SYM', 'PRICE', 'CHG%'];
      const widths = [10, 9, 8];
      const toRow = (s) => [s.symbol, s.price.toLocaleString(), `${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}%`];

      const gainersBlock = gainers.length
        ? buildTable(gainers.map(toRow), headers, widths)
        : '_Hakuna wapandaji leo_';

      const losersBlock = losers.length
        ? buildTable(losers.map(toRow), headers, widths)
        : '_Hakuna washukaji leo_';

      const text =
        `${buildHeader(`DSE TOP ${topN} MOVERS`)}\n\n` +
        `🟢 *Wapandaji (Gainers)*\n${gainersBlock}\n\n` +
        `🔴 *Washukaji (Losers)*\n${losersBlock}\n\n` +
        (flat.length ? `⏺ *Bila mabadiliko:* ${flat.map((s) => s.symbol).join(', ')}\n\n` : '') +
        `_Tumia: .gainers <namba> kuonyesha zaidi/pungufu (mfano: .gainers 10)_\n\n` +
        `${buildFooter()}`;

      return await sock.sendMessage(jid, { text }, { quoted: msg });
    } catch (err) {
      console.error('Gainers/Losers fetch error:', err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kupata data ya wapandaji/washukaji: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
