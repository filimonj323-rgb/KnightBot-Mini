/**
 * FX Auto-Trade Stats Command — win-rate ya auto-trader IKIGAWANYWA kwa
 * "bucket" ya signal strength (67-75%, 76-85%, 86-100%), kutoka trades
 * zilizofungwa tayari (fx_auto_trades, angalia utils/autoTrader.js ->
 * getWinRateStats()).
 *
 * Lengo: kujua kama STRENGTH_THRESHOLD ya sasa (default 67%) inatofautisha
 * ubora wa signal kweli — kama bucket ya 86-100% haina win-rate ya juu
 * zaidi ya 67-75%, ni ishara mkakati unahitaji marekebisho (mfano
 * confirmation ya ziada) badala ya kutegemea "vote count" pekee.
 */

const { getWinRateStats } = require('../../utils/autoTrader');

function buildHeader(title) {
  return `⎯⎯⎯ 『 *${title}* 』 ⎯⎯⎯`;
}

function buildFooter() {
  return (
    `┌─────────────────\n` +
    `│ 🛠️ *MR.IT MEDIATOR*\n` +
    `└─────────────────\n` +
    `   _for easy access of data and analysis.._\n` +
    `   _system developer and automation.._`
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
    out += r.map((c, i) => padCol(String(c), widths[i])).join(' ') + '\n';
  });
  out += '```';
  return out;
}

module.exports = {
  name: 'autostats',
  aliases: ['fxstats', 'winrate'],
  category: 'owner',
  description: 'Win-rate ya auto-trader ikigawanywa kwa nguvu ya signal (strength bucket)',
  usage: '.autostats',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const stats = await getWinRateStats();

    if (!stats.length) {
      return extra.reply(
        `${buildHeader('AUTO-TRADE WIN RATE')}\n\n` +
          `Hakuna trade zilizofungwa bado zenye rekodi ya signal strength.\n` +
          `Zitaonekana hapa mara auto-trader itakapofunga trade za kwanza.\n\n` +
          buildFooter()
      );
    }

    const rows = stats.map((s) => [
      s.bucket,
      s.total,
      `${s.wins}/${s.losses}`,
      `${s.winRatePct}%`,
      `$${s.totalProfit}`,
    ]);

    const table = buildTable(
      rows,
      ['Bucket', 'Jumla', 'W/L', 'Win%', 'Profit'],
      [10, 5, 6, 6, 8]
    );

    const overall = stats.find((s) => s.bucket === 'OVERALL');
    const summary = overall
      ? `\n📊 Jumla: *${overall.total}* trades, win-rate *${overall.winRatePct}%*, profit jumla *$${overall.totalProfit}*\n`
      : '';

    await extra.reply(
      `${buildHeader('AUTO-TRADE WIN RATE (kwa strength)')}\n\n` +
        table +
        summary +
        `\n_Bucket ya juu (86-100%) INATAKIWA kuwa na win-rate ya juu zaidi ya bucket za chini — kama sivyo, threshold ya sasa ya ${'`STRENGTH_THRESHOLD`'} inahitaji marekebisho._\n\n` +
        buildFooter()
    );
  },
};
