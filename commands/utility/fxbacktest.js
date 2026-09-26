/**
 * FX Backtest Command — jaribu mkakati wa forexSignal.js/autoTrader.js
 * dhidi ya candles za KIHISTORIA (Twelve Data), kupata win-rate, profit
 * factor, na max drawdown KABLA ya kuamini mkakati na pesa halisi zaidi.
 *
 * Matumizi:
 *   .fxbacktest EURUSD           -> bars 1500 (default, ~saa 62 za candles 1h)
 *   .fxbacktest GBPUSD 3000      -> bars 3000 (zaidi ya historia, polepole zaidi)
 */

const { runBacktest } = require('../../utils/backtest');
const { PAIRS } = require('../../utils/autoTrader');

function resolveSymbol(rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z]/g, '');
  const known = PAIRS.find((p) => p.code === code);
  if (known) return { code: known.code, symbol: known.symbol };
  if (code.length === 6) {
    return { code, symbol: `${code.slice(0, 3)}/${code.slice(3)}` };
  }
  return null;
}

module.exports = {
  name: 'fxbacktest',
  aliases: ['backtest', 'fxbt'],
  category: 'owner',
  description: 'Jaribu mkakati wa auto-trade dhidi ya historia (Twelve Data) kabla ya kuutumia na pesa halisi',
  usage: '.fxbacktest <JOZI, mfano EURUSD> [bars, default 1500]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    if (!args[0]) {
      return extra.reply(
        `📋 *Backtest ya Mkakati wa Forex*\n\n` +
          `Matumizi: *.fxbacktest <JOZI> [bars]*\n` +
          `Mfano: *.fxbacktest EURUSD*  au  *.fxbacktest GBPUSD 3000*\n\n` +
          `Jozi zilizowekwa kwa auto-trade: ${PAIRS.map((p) => p.code).join(', ')}\n` +
          `(unaweza pia kujaribu jozi nyingine yoyote ya herufi 6, mfano AUDNZD)\n\n` +
          `_bars_ = idadi ya candles za saa 1 za kurudi nyuma (default 1500 ≈ siku 62). Zaidi ya bars = historia ndefu zaidi lakini polepole zaidi kuhesabu.`
      );
    }

    const resolved = resolveSymbol(args[0]);
    if (!resolved) {
      return extra.reply(`❌ Jozi "${args[0]}" haieleweki. Tumia mfano: EURUSD, GBPJPY, AUDNZD.`);
    }

    const bars = args[1] ? Number(args[1]) : undefined;
    if (args[1] && (!Number.isFinite(bars) || bars <= 0)) {
      return extra.reply(`❌ "${args[1]}" si namba sahihi ya bars.`);
    }

    await extra.reply(
      `⏳ Inaendesha backtest ya *${resolved.code}* (bars: ${bars || 1500})... hii inaweza kuchukua sekunde kadhaa.`
    );

    let result;
    try {
      result = await runBacktest({ code: resolved.code, symbol: resolved.symbol, bars });
    } catch (err) {
      return extra.reply(`❌ Backtest imeshindwa: ${err.message}`);
    }

    const lines = [];
    lines.push(`⎯⎯⎯ 『 *BACKTEST — ${result.code}* 』 ⎯⎯⎯`);
    lines.push('');
    lines.push(`📅 Kipindi: ${result.from} → ${result.to} (candles ${result.bars})`);
    lines.push(`💵 Stake: $${result.stake}  •  Multiplier: x${result.multiplier}  •  Kikomo cha signal: ≥${result.strengthThreshold}%`);
    lines.push('');
    lines.push(`📊 *Matokeo*`);
    lines.push(`   • Trades zilizofungwa: ${result.totalTrades}`);

    if (result.totalTrades === 0) {
      lines.push('');
      lines.push(`_Hakuna trade hata moja iliyofungwa kwenye kipindi hiki — jaribu bars zaidi au kikomo cha chini cha signal._`);
      return extra.reply(lines.join('\n'));
    }

    lines.push(`   • Ushindi: ${result.wins}  •  Hasara: ${result.losses}`);
    lines.push(`   • 🎯 Win rate: *${result.winRate}%*`);
    lines.push(
      `   • 💰 Faida/Hasara jumla: ${result.totalPnl >= 0 ? '✅ +' : '🔴 '}$${Math.abs(result.totalPnl)}` +
        ` (stake $${result.stake} kwa kila trade)`
    );
    lines.push(
      `   • 📈 Profit Factor: ${result.profitFactor === null ? 'N/A' : result.profitFactor}` +
        `${result.profitFactor >= 1.5 ? ' ✅ (nzuri)' : result.profitFactor >= 1 ? ' ⚠️ (dhaifu)' : ' 🔴 (mbaya)'}`
    );
    lines.push(`   • 📉 Max Drawdown: $${result.maxDrawdown}`);
    lines.push(`   • 🔻 Hasara mfululizo (max): ${result.maxConsecutiveLosses}`);
    if (result.stillOpenAtEnd) {
      lines.push(`   • ℹ️ Trade 1 ilibaki "wazi" mwishoni mwa data (haijahesabiwa hapo juu).`);
    }

    lines.push('');
    lines.push(
      `⚠️ *Mipaka ya backtest hii:* haina economic-calendar (habari za soko), haihesabu spread/slippage, ` +
        `na haizingatii circuit breakers za live (daily loss limit n.k). Utendaji halisi wa live mara nyingi ni ` +
        `mbaya kidogo kuliko backtest — tumia matokeo haya kama "mwongozo", si uhakika wa 100%.`
    );

    return extra.reply(lines.join('\n'));
  },
};
