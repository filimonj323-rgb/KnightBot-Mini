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
  usage: '.fxbacktest <JOZI, mfano EURUSD> [bars, default 1500] [nogate|nodaily] [5m|15m|30m|1h] [sr] [h24]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    if (!args[0]) {
      return extra.reply(
        `📋 *Backtest ya Mkakati wa Forex*\n\n` +
          `Matumizi: *.fxbacktest <JOZI> [bars] [nogate|nodaily] [5m|15m|30m|1h] [sr] [h24]*\n` +
          `_nogate_ = zima gate ya 4h+1day, _nodaily_ = zima gate ya 1day tu (kulinganisha kabla/baada)\n` +
          `_15m_ (au 5m/30m) = timeframe ndogo (HTF inakuwa 1h/15m/2h) • _sr_ = zuia entry zilizo karibu na Support/Resistance • _h24_ = candles za kupima bei ilisogea pips ngapi baada ya entry\n` +
          `Mfano: *.fxbacktest EURUSD*  •  *.fxbacktest GBPUSD 3000*  •  *.fxbacktest EURUSD 3000 15m*  •  *.fxbacktest EURUSD 3000 15m sr*\n\n` +
          `Jozi zilizowekwa kwa auto-trade: ${PAIRS.map((p) => p.code).join(', ')}\n` +
          `(unaweza pia kujaribu jozi nyingine yoyote ya herufi 6, mfano AUDNZD)\n\n` +
          `_bars_ = idadi ya candles za saa 1 za kurudi nyuma (default 1500 ≈ siku 62). Zaidi ya bars = historia ndefu zaidi lakini polepole zaidi kuhesabu.`
      );
    }

    const resolved = resolveSymbol(args[0]);
    if (!resolved) {
      return extra.reply(`❌ Jozi "${args[0]}" haieleweki. Tumia mfano: EURUSD, GBPJPY, AUDNZD.`);
    }

    // Flags: gates, timeframe (5m/15m/30m/1h), sr, horizon (h24), na bars (namba).
    const TF_ALIAS = { '5m': '5min', '5min': '5min', '15m': '15min', '15min': '15min', '30m': '30min', '30min': '30min', '1h': '1h', '1hr': '1h' };
    const flags = args.slice(1).map((a) => String(a).toLowerCase());
    const htfGate = flags.includes('nogate') ? false : undefined;
    const dailyGate = flags.includes('nogate') || flags.includes('nodaily') ? false : undefined;
    const interval = flags.map((f) => TF_ALIAS[f]).find(Boolean);
    const sr = flags.includes('sr') ? true : undefined;
    const hArg = flags.find((f) => /^h\d+$/.test(f));
    const horizon = hArg ? Number(hArg.slice(1)) : undefined;
    const known = new Set(['nogate', 'nodaily', 'sr', ...Object.keys(TF_ALIAS)]);
    const barsArg = args.slice(1).find((a) => !known.has(String(a).toLowerCase()) && !/^h\d+$/i.test(String(a)));

    const bars = barsArg ? Number(barsArg) : undefined;
    if (barsArg && (!Number.isFinite(bars) || bars <= 0)) {
      return extra.reply(`❌ \"${barsArg}\" si namba sahihi ya bars.`);
    }

    await extra.reply(
      `⏳ Inaendesha backtest ya *${resolved.code}* (bars: ${bars || 1500}${interval ? `, ${interval}` : ''}${sr ? ', S/R filter' : ''})... hii inaweza kuchukua sekunde kadhaa.`
    );

    let result;
    try {
      result = await runBacktest({ code: resolved.code, symbol: resolved.symbol, bars, htfGate, dailyGate, interval, sr, horizon });
    } catch (err) {
      return extra.reply(`❌ Backtest imeshindwa: ${err.message}`);
    }

    const lines = [];
    lines.push(`⎯⎯⎯ 『 *BACKTEST — ${result.code}* 』 ⎯⎯⎯`);
    lines.push('');
    lines.push(`📅 Kipindi: ${result.from} → ${result.to} (candles ${result.bars})`);
    lines.push(`⏱️ Timeframe: ${result.interval} (HTF: ${result.htfInterval})`);
    lines.push(`🧭 Gates: ${result.htfInterval} ${result.htfGate ? 'ON' : 'OFF'}  •  1day ${result.dailyGate ? 'ON' : 'OFF'}  •  S/R filter ${result.sr.filter ? `ON (≥${result.sr.minRoomAtr}×ATR, zimezuiwa ${result.sr.blocked})` : 'OFF'}`);
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

    // ── Bei ilisogea pips ngapi baada ya entry ──
    const ex = result.excursion;
    if (ex && ex.n > 0) {
      lines.push('');
      lines.push(`📏 *Bei ilisogea kiasi gani baada ya entry* (candles ${result.horizon} za ${result.interval}, entries ${ex.n})`);
      lines.push(`   • SL ya wastani: *${result.avgSlPips} pips*  •  TP ya wastani: *${result.avgTpPips} pips*`);
      lines.push(`   • Kwa faida (MFE): wastani ${ex.mfe.avg}p • median *${ex.mfe.median}p* • robo ya juu ${ex.mfe.p75}p`);
      lines.push(`   • Kinyume (MAE): wastani ${ex.mae.avg}p • median *${ex.mae.median}p* • robo ya juu ${ex.mae.p75}p`);
      lines.push(`   • Bei ilifika +X pips *kabla* ya −X pips:`);
      for (const [t, v] of Object.entries(ex.byThreshold)) {
        lines.push(`      ${String(t).padStart(2)} pips → ${v.winFirstPct}% faida kwanza • ${v.lossFirstPct}% hasara kwanza` + (v.medianBars ? ` • ilifika baada ya ~${v.medianBars} candle` : ''));
      }
      const near = result.excursionNearSr;
      const open = result.excursionOpenRoad;
      if (near && near.n > 0 && open && open.n > 0) {
        lines.push(`   • 🧱 S/R karibu (<${result.sr.minRoomAtr}×ATR): entries ${near.n}, MFE median ${near.mfe.median}p vs MAE ${near.mae.median}p`);
        lines.push(`   • 🛣️ Njia wazi: entries ${open.n}, MFE median ${open.mfe.median}p vs MAE ${open.mae.median}p`);
      }
      lines.push(`   _Ukisoma hivi: linganisha "faida kwanza" na "hasara kwanza" kwa X ndogo — faida kwanza ikiwa kubwa wazi, entry fupi ina nafasi. Kumbuka spread ya Deriv inakula sehemu ya target ndogo (5–10 pips), na backtest haihesabu spread._`);
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
