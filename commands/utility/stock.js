/**
 * Stock Command — Snapshot ya hisa ya DSE
 *
 * Inachanganya:
 *   1) Bei ya sasa kutoka dse.js (fetchDSEStocks — DSE HTML, cache 2 min).
 *   2) Fundamentals kutoka stockana.js (stockanalysis.com/quote/dar/.../statistics/,
 *      cache siku 7).
 *   3) Fallback: fundamentals.json (manual) kama stockana.js inashindwa
 *      (symbol haipo kwenye stockanalysis.com, au tovuti haipatikani).
 *
 * Tofauti na .analyze:
 *   - .stock inaonyesha fundamentals ghafi + uwiano wa haraka (snapshot).
 *   - .analyze inatoa uchambuzi kamili (score, verdict, tathmini ya kila kigezo).
 *
 * ⚠️ SI USHAURI WA UWEKEZAJI.
 */

const { fetchDSEStocks } = require('./dse.js');
const { fetchStockana } = require('../../utils/stockana.js');
const fundamentals = require('../../utils/data/fundamentals.json');

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
const fmt2 = (n) => (n == null ? 'N/A' : Number(n).toFixed(2));

function buildMessage({ symbol, name, price, priceChangePct, fund, asOf, srcPrice, srcFund }) {
  const lines = [];
  lines.push(buildHeader(`${symbol} — DSE SNAPSHOT`));
  lines.push('');

  if (name && name !== symbol) lines.push(`🏢 *${name}*`);
  lines.push(
    `💰 *Bei:* TZS ${fmt(price)}` +
      (priceChangePct != null
        ? ` (${priceChangePct >= 0 ? '+' : ''}${priceChangePct.toFixed(2)}%)`
        : '')
  );
  lines.push('');

  if (fund) {
    lines.push(`📊 *Fundamentals (${asOf || 'kipindi kisichojulikana'})*`);
    lines.push(`   • EPS: TZS ${fmt(fund.eps)}`);
    lines.push(`   • BVPS: TZS ${fmt(fund.bvps)}`);
    lines.push(`   • DPS: TZS ${fmt(fund.dps)}`);
    lines.push(`   • ROE: ${fund.roe != null ? fund.roe.toFixed(1) + '%' : 'N/A'}`);
    lines.push('');

    lines.push(`📐 *Uwiano*`);

    // P/E — tumia iliyopatikana (stockana.js), au hesabu kutoka bei/eps
    if (fund.pe != null) {
      lines.push(`   • P/E: ${fmt2(fund.pe)}x`);
    } else if (price != null && fund.eps > 0) {
      lines.push(`   • P/E: ${fmt2(price / fund.eps)}x _(imehesabiwa)_`);
    } else {
      lines.push(`   • P/E: N/A`);
    }

    // P/B — tumia iliyopatikana, au hesabu kutoka bei/bvps
    if (fund.pb != null) {
      lines.push(`   • P/B: ${fmt2(fund.pb)}x`);
    } else if (price != null && fund.bvps > 0) {
      lines.push(`   • P/B: ${fmt2(price / fund.bvps)}x _(imehesabiwa)_`);
    } else {
      lines.push(`   • P/B: N/A`);
    }

    // Dividend Yield — tumia iliyopatikana, au hesabu kutoka dps/bei
    if (fund.divYield != null) {
      lines.push(`   • Dividend Yield: ${fmt2(fund.divYield)}%`);
    } else if (price != null && fund.dps) {
      lines.push(`   • Dividend Yield: ${fmt2((fund.dps / price) * 100)}% _(imehesabiwa)_`);
    } else {
      lines.push(`   • Dividend Yield: 0.00%`);
    }

    // Market Cap — tumia iliyopatikana, au hesabu kutoka shares * bei
    if (fund.marketcap != null) {
      lines.push(`   • Market Cap: TZS ${fmt(fund.marketcap)}`);
    } else if (fund.sharesOutstanding != null && price != null) {
      lines.push(`   • Market Cap: TZS ${fmt(fund.sharesOutstanding * price)} _(imehesabiwa)_`);
    }

    lines.push('');
  } else {
    lines.push('⚠️ *Fundamentals hazipatikani* kwa hisa hii.');
    lines.push('');
  }

  lines.push(`_Chanzo: bei = ${srcPrice}; fundamentals = ${srcFund}._`);
  lines.push(`_⚠️ SI ushauri wa kitaalamu wa uwekezaji._`);
  lines.push('');
  lines.push(buildFooter());
  return lines.join('\n');
}

module.exports = {
  name: 'stock',
  aliases: ['hisa', 'snapshot'],
  category: 'utility',
  description: 'Snapshot ya hisa ya DSE — bei + fundamentals + uwiano wa haraka',
  usage: '.stock <symbol> — mfano: .stock CRDB',

  async execute(sock, msg, args) {
    const jid = msg.key.remoteJid;
    const symbol = (args[0] || '').toUpperCase();

    if (!symbol) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `❓ Weka symbol ya hisa.\n\n` +
            `Tumia: .stock <symbol>\n` +
            `Mfano: .stock CRDB`,
        },
        { quoted: msg }
      );
    }

    try {
      // 1) Bei kutoka DSE (fetchDSEStocks — kama ilivyo kwenye analyze.js)
      let price = null;
      let name = symbol;
      let priceChangePct = null;
      let srcPrice = 'DSE';

      try {
        const { stocks } = await fetchDSEStocks();
        const live = stocks.find((s) => s.symbol === symbol);
        if (live) {
          price = live.close || live.prevClose || live.open || null;
          priceChangePct = live.changePct ?? null;
        }
      } catch (err) {
        console.warn('stock: DSE fetch error', err.message);
      }

      // 2) Fundamentals kutoka stockana.js (live, stockanalysis.com)
      let fund = null;
      let srcFund = 'haipatikani';

      try {
        fund = await fetchStockana(symbol);
        if (fund) srcFund = 'stockanalysis.com';
      } catch (err) {
        console.warn('stock: stockana fetch error', err.message);
      }

      // 3) Fallback: fundamentals.json (manual) kama stockana.js imeshindwa
      if (!fund) {
        const fx = fundamentals[symbol];
        if (fx) {
          fund = fx;
          srcFund = 'fundamentals.json (data ya mkono)';
        }
      }

      // 4) Kama hatuna kitu kabisa
      if (price == null && !fund) {
        return await sock.sendMessage(
          jid,
          {
            text:
              `❌ Hatuna data kwa "${symbol}" kwa sasa.\n\n` +
              `• Bei haikupatikana kwenye DSE\n` +
              `• Fundamentals hazipatikani kwenye stockanalysis.com wala fundamentals.json\n\n` +
              `Jaribu tena baadaye au tumia \`.dse ${symbol}\` kwa bei pekee.`,
          },
          { quoted: msg }
        );
      }

      // 5) Tumia jina kutoka fundamentals kama DSE halina jina
      if (fund?.name && (!name || name === symbol)) name = fund.name;

      return await sock.sendMessage(
        jid,
        {
          text: buildMessage({
            symbol,
            name,
            price,
            priceChangePct,
            fund,
            asOf: fund?.asOf,
            srcPrice,
            srcFund,
          }),
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('stock error:', err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kuchambua "${symbol}": ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
