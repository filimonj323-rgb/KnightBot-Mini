/**
 * FX Check Command — linganisha candles za Twelve Data na za Deriv kwa jozi
 * na timeframe ileile, ili ujue kama data ya Twelve ni sahihi (ikilinganishwa
 * na bei ya Deriv unayofanyia trade) na kama Deriv `ticks_history` inafanya
 * kazi kwenye muunganisho wako.
 *
 * Matumizi:
 *   .fxcheck EURUSD        -> timeframe 1h (default)
 *   .fxcheck GBPJPY 4h     -> 4h  (zinazokubalika: 15min, 30min, 1h, 4h, 1day ...)
 *
 * Hii HAIFUNGUI trade wala haibadilishi chochote — ni kusoma tu.
 * Gharama: credit 1 ya Twelve Data + ombi 1 la Deriv.
 */

const { fetchTwelveCandles } = require('../../utils/forexSignal');
const { getCandles } = require('../../utils/derivTrader');
const { computeAllIndicators } = require('../../utils/indicators');
const { PAIRS } = require('../../utils/autoTrader');

const COMPARE_BARS = 100;     // candles za kuomba kutoka kila chanzo
const MAX_COMPARED = 50;      // candles za mwisho zilizofungwa za kulinganisha

function resolveSymbol(rawCode) {
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z]/g, '');
  const known = PAIRS.find((p) => p.code === code);
  if (known) return { code: known.code, symbol: known.symbol };
  if (code.length === 6) return { code, symbol: `${code.slice(0, 3)}/${code.slice(3)}` };
  return null;
}

const pipSizeOf = (code) => (code.endsWith('JPY') ? 0.01 : 0.0001);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const max = (a) => (a.length ? Math.max(...a) : 0);
const f1 = (n) => Number(n).toFixed(1);

function verdictOf(matched, compared, avgClosePips, maxClosePips) {
  if (matched === 0) return { icon: '❓', text: 'Hakuna candles zinazolingana kwa wakati (alignment ya timeframe ni tofauti) — haiwezi kulinganishwa moja kwa moja.' };
  const coverage = matched / compared;
  if (coverage >= 0.9 && avgClosePips <= 0.3 && maxClosePips <= 1.5) {
    return { icon: '✅', text: 'Data zinalingana vizuri — Twelve Data inaweza kuaminika kwa signal.' };
  }
  if (coverage >= 0.8 && avgClosePips <= 1) {
    return { icon: '⚠️', text: 'Tofauti ndogo — inakubalika kwa timeframe za 1h+, lakini angalia SL/TP zisiwe ndogo mno.' };
  }
  return { icon: '❌', text: 'Tofauti kubwa au candles zinakosekana — data ya Twelve haifai kwa signal ya trade ya Deriv. Tumia FOREX_DATA_SOURCE=deriv.' };
}

module.exports = {
  name: 'fxcheck',
  aliases: ['datacheck', 'fxdata'],
  category: 'owner',
  description: 'Linganisha candles za Twelve Data na Deriv (usahihi wa data ya signal)',
  usage: '.fxcheck <JOZI, mfano EURUSD> [timeframe: 1h, 4h, 1day...]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const resolved = resolveSymbol(args[0] || 'EURUSD');
    if (!resolved) {
      return extra.reply(`❌ Jozi "${args[0]}" haieleweki. Tumia mfano: EURUSD, GBPJPY.`);
    }
    const interval = String(args[1] || '1h').toLowerCase();
    const { code, symbol } = resolved;

    await extra.reply(`⏳ Naangalia *${code}* (${interval}) — Twelve Data dhidi ya Deriv...`);

    const [tdRes, dvRes] = await Promise.allSettled([
      fetchTwelveCandles(symbol, interval, COMPARE_BARS),
      getCandles(symbol, interval, COMPARE_BARS),
    ]);

    const L = [];
    L.push(`⎯⎯⎯ 『 *FXCHECK — ${code} ${interval}* 』 ⎯⎯⎯`);
    L.push('');
    L.push(`📡 Twelve Data: ${tdRes.status === 'fulfilled' ? `✅ candles ${tdRes.value.length}` : `❌ ${tdRes.reason?.message || tdRes.reason}`}`);
    L.push(`📡 Deriv (ticks_history): ${dvRes.status === 'fulfilled' ? `✅ candles ${dvRes.value.length}` : `❌ ${dvRes.reason?.message || dvRes.reason}`}`);

    if (dvRes.status !== 'fulfilled') {
      L.push('');
      L.push(
        `ℹ️ Deriv haikurudisha candles. Sababu zinazowezekana: ticks_history haiungwi mkono kwenye muunganisho/akaunti hii, ` +
        `jina la jozi (frx${code}) halitambuliki, au muunganisho wa Deriv haupo (angalia DERIV_API_TOKEN/DERIV_APP_ID). ` +
        `Tuma ujumbe huo wa kosa hapo juu na tutaurekebisha — endelea kutumia Twelve Data kwa sasa.`
      );
      return extra.reply(L.join('\n'));
    }
    if (tdRes.status !== 'fulfilled') {
      L.push('');
      L.push('ℹ️ Deriv inafanya kazi lakini Twelve Data imeshindwa — hakuna cha kulinganisha. Deriv inaweza kuwa chanzo kikuu.');
      return extra.reply(L.join('\n'));
    }

    // Ondoa candle ya mwisho kwa kila chanzo (inaendelea, haijafungwa — itatofautiana)
    const td = tdRes.value.slice(0, -1);
    const dv = dvRes.value.slice(0, -1);
    const dvMap = new Map(dv.map((c) => [c.datetime, c]));
    const pip = pipSizeOf(code);

    const pairs = td.filter((c) => dvMap.has(c.datetime)).slice(-MAX_COMPARED).map((c) => ({ t: c, d: dvMap.get(c.datetime) }));
    const compared = Math.min(td.length, MAX_COMPARED);

    const closeDiff = pairs.map((p) => Math.abs(Number(p.t.close) - Number(p.d.close)) / pip);
    const highDiff = pairs.map((p) => Math.abs(Number(p.t.high) - Number(p.d.high)) / pip);
    const lowDiff = pairs.map((p) => Math.abs(Number(p.t.low) - Number(p.d.low)) / pip);

    L.push('');
    L.push(`📊 *Ulinganisho (candles ${pairs.length}/${compared} zimelingana kwa wakati)*`);
    if (pairs.length) {
      L.push(`   • Close: wastani ${f1(mean(closeDiff))} pips • juu zaidi ${f1(max(closeDiff))}`);
      L.push(`   • High:  wastani ${f1(mean(highDiff))} pips • juu zaidi ${f1(max(highDiff))}`);
      L.push(`   • Low:   wastani ${f1(mean(lowDiff))} pips • juu zaidi ${f1(max(lowDiff))}`);

      const last = pairs.slice(-5);
      L.push('');
      L.push('```');
      L.push('WAKATI (UTC)         TWELVE     DERIV      TOFAUTI');
      for (const p of last) {
        const d = (Number(p.t.close) - Number(p.d.close)) / pip;
        L.push(
          `${p.t.datetime.padEnd(19)}  ${Number(p.t.close).toFixed(5)}  ${Number(p.d.close).toFixed(5)}  ${(d >= 0 ? '+' : '') + f1(d)}p`
        );
      }
      L.push('```');
    }

    // Athari kwenye signal — vigezo vilivyohesabiwa kutoka kila chanzo
    try {
      const iT = computeAllIndicators(tdRes.value);
      const iD = computeAllIndicators(dvRes.value);
      const trend = (i) => (i.ema9 != null && i.ema21 != null ? (i.ema9 > i.ema21 ? 'BUY' : 'SELL') : 'N/A');
      L.push('');
      L.push(`🧠 *Athari kwenye signal (kutoka candles zote)*`);
      L.push(`   • Trend EMA9/21: Twelve ${trend(iT)} • Deriv ${trend(iD)} ${trend(iT) === trend(iD) ? '✅' : '⚠️ ZINAPINGANA'}`);
      if (iT.rsi != null && iD.rsi != null) L.push(`   • RSI: Twelve ${f1(iT.rsi)} • Deriv ${f1(iD.rsi)} (tofauti ${f1(Math.abs(iT.rsi - iD.rsi))})`);
      if (iT.atr != null && iD.atr != null) L.push(`   • ATR: Twelve ${(iT.atr / pip).toFixed(1)}p • Deriv ${(iD.atr / pip).toFixed(1)}p`);
    } catch (_) {
      // indicators zikishindwa, ulinganisho wa candles hapo juu bado unatosha
    }

    const v = verdictOf(pairs.length, compared, mean(closeDiff), max(closeDiff));
    L.push('');
    L.push(`${v.icon} *Hitimisho:* ${v.text}`);
    L.push('');
    L.push(`_Candle ya mwisho (inayoendelea) imeachwa kwenye ulinganisho. Kumbuka: jaribu pia 4h na 1day (.fxcheck ${code} 4h) kwa kuwa alignment inaweza kutofautiana._`);

    return extra.reply(L.join('\n'));
  },
};
