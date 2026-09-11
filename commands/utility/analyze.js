/**
 * Analyze Command — Uchambuzi wa Msingi (Fundamental Analysis) wa Hisa za DSE
 *
 * Inachanganya:
 *  1) Bei ya SASA (live/close) kutoka dse.js (fetchDSEStocks — HTML ya
 *     dse.co.tz, tayari ina cache ya dakika 2).
 *  2) Vigezo vya kihasibu (EPS, BVPS, DPS, ROE) kutoka data/fundamentals.json
 *     — hivi HAVIPATIKANI kwenye dse.co.tz Market Summary, kwa hiyo
 *     vinatunzwa kwa mkono (angalia _readme ndani ya fundamentals.json).
 *
 * Muundo wa uchambuzi (angalia utils/stockAnalysis.js kwa hesabu halisi):
 *   Bei ya Soko -> Vipimo vya Msingi -> Uwiano wa Uwekezaji (P/E, P/B,
 *   Dividend Yield, ROE) -> Tathmini ya kila kigezo -> Hitimisho la jumla.
 *
 * ⚠️ SI USHAURI WA UWEKEZAJI: hii ni zana ya elimu/haraka inayotumia
 * "heuristic scoring" ya wazi (angalia BENCHMARKS kwenye stockAnalysis.js),
 * si uchambuzi wa kitaalamu. Command inaonyesha disclaimer kila wakati.
 */

const path = require('path');
const fundamentals = require('../../data/fundamentals.json');
const { analyzeStock } = require('../../utils/stockAnalysis');
const { fetchDSEStocks } = require('./dse.js');

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

function buildAnalysisMessage(result) {
  const { symbol, name, sector, price, asOf, source, ratios, checks, score, verdict } = result;
  const checkLabel = { pe: 'P/E', pb: 'P/B', roe: 'ROE', divYield: 'Dividend Yield' };

  const checksBlock = checks
    .map((c) => {
      const mark = c.points > 0 ? '✅' : c.points < 0 ? '⚠️' : '➖';
      return `   ${mark} *${checkLabel[c.key]}:* ${c.note}`;
    })
    .join('\n');

  return (
    `${buildHeader(symbol + ' — UCHAMBUZI WA MSINGI')}\n\n` +
    `🏢 *${name}* ${sector ? `(${sector})` : ''}\n\n` +
    `💰 *1) Bei ya Soko (sasa):* TZS ${fmt(price)}\n\n` +
    `📊 *2) Vipimo vya Msingi (${asOf || 'kipindi kisichojulikana'}):*\n` +
    `   • EPS (faida/hisa): TZS ${fmt(result.eps)}\n` +
    `   • BVPS (thamani ya vitabu/hisa): TZS ${fmt(result.bvps)}\n` +
    `   • Dividend/hisa: TZS ${fmt(result.dps || 0)}\n\n` +
    `📐 *3) Uwiano wa Uwekezaji:*\n` +
    `   • P/E: ${ratios.pe ? ratios.pe.toFixed(2) + 'x' : 'N/A'}\n` +
    `   • P/B: ${ratios.pb ? ratios.pb.toFixed(2) + 'x' : 'N/A'}\n` +
    `   • ROE: ${ratios.roe ? ratios.roe.toFixed(1) + '%' : 'N/A'}\n` +
    `   • Dividend Yield: ${ratios.divYield.toFixed(2)}%\n\n` +
    `🔍 *4) Tathmini ya kila kigezo:*\n${checksBlock}\n\n` +
    `🎯 *5) Hitimisho (muda mrefu):* ${verdict}\n` +
    `   _Alama (score): ${score >= 0 ? '+' : ''}${score}_\n\n` +
    `_Chanzo cha fundamentals: ${source || 'haijaainishwa'}. Data hii inatunzwa kwa mkono na inaweza kupitwa na wakati — kagua ripoti ya hivi karibuni kabla ya kuamua._\n` +
    `_⚠️ Hii SI ushauri wa kitaalamu wa uwekezaji — ni zana ya haraka ya elimu. Fanya utafiti wako mwenyewe au muone mshauri wa fedha aliyesajiliwa._\n\n` +
    `${buildFooter()}`
  );
}

module.exports = {
  name: 'analyze',
  aliases: ['chambua', 'uwekezaji', 'fundamentals'],
  category: 'utility',
  description: 'Uchambuzi wa msingi (fundamental analysis) wa hisa ya DSE — EPS, BVPS, P/E, P/B na hitimisho la muda mrefu',
  usage: '.analyze <symbol> — mfano: .analyze CRDB — au .analyze MBP',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const symbol = (args[0] || '').toUpperCase();

    if (!symbol) {
      const available = Object.keys(fundamentals).filter((k) => k !== '_readme');
      return await sock.sendMessage(
        jid,
        {
          text:
            `❓ Tafadhali weka symbol ya hisa.\n\n` +
            `Tumia: .analyze <symbol>\n` +
            `Mfano: .analyze CRDB\n\n` +
            `Hisa zenye data ya fundamentals kwa sasa: ${available.join(', ') || 'hakuna bado'}`,
        },
        { quoted: msg }
      );
    }

    const fx = fundamentals[symbol];
    if (!fx) {
      const available = Object.keys(fundamentals).filter((k) => k !== '_readme');
      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ Hatuna vipimo vya msingi (EPS/BVPS) vya "${symbol}" bado.\n\n` +
            `Hivi vinatunzwa kwa mkono kwenye data/fundamentals.json (dse.co.tz haitoi EPS/BVPS kwenye Market Summary yake).\n` +
            `Zilizopo kwa sasa: ${available.join(', ') || 'hakuna bado'}\n\n` +
            `Kwa bei ya soko pekee tumia: .dse ${symbol}`,
        },
        { quoted: msg }
      );
    }

    try {
      const { stocks } = await fetchDSEStocks();
      const live = stocks.find((s) => s.symbol === symbol);
      if (!live) {
        return await sock.sendMessage(
          jid,
          { text: `❌ Bei ya sasa ya "${symbol}" haikupatikana kwenye dse.co.tz kwa sasa. Jaribu tena baadaye.` },
          { quoted: msg }
        );
      }

      const result = analyzeStock({
        symbol,
        name: fx.name || symbol,
        sector: fx.sector,
        price: live.close,
        eps: fx.eps,
        bvps: fx.bvps,
        dps: fx.dps || 0,
        roe: fx.roe,
        asOf: fx.asOf,
        source: fx.source,
      });

      return await sock.sendMessage(jid, { text: buildAnalysisMessage(result) }, { quoted: msg });
    } catch (err) {
      console.error('Analyze error:', err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kufanya uchambuzi wa "${symbol}": ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
