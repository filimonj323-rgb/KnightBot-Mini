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

const toEpoch = (dt) => Date.parse(`${String(dt).replace(' ', 'T')}${String(dt).length === 10 ? 'T00:00:00' : ''}Z`);
const fromEpoch = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

/**
 * Tafuta offset ya saa (k) inayofanya candles zilingane: lebo ya Deriv + k saa
 * = lebo ya Twelve. Ikipatikana k != 0 yenye tofauti ndogo sana, tatizo ni
 * WAKATI (timezone/alignment ya Twelve), si bei. Deriv = epoch ya UTC (wazi).
 */
function findBestOffset(twCandles, dvCandles, pip) {
  const twMap = new Map(twCandles.map((c) => [c.datetime, c]));
  const minMatches = Math.max(15, Math.floor(Math.min(twCandles.length, dvCandles.length) * 0.4));
  const rows = [];
  for (let k = -12; k <= 12; k++) {
    const diffs = [];
    for (const d of dvCandles) {
      const t = twMap.get(fromEpoch(toEpoch(d.datetime) + k * 3600e3));
      if (t) diffs.push(Math.abs(Number(t.close) - Number(d.close)) / pip);
    }
    if (diffs.length >= minMatches) rows.push({ k, n: diffs.length, mean: mean(diffs) });
  }
  if (!rows.length) return { best: null, zero: null };
  rows.sort((a, b) => a.mean - b.mean);
  return { best: rows[0], zero: rows.find((r) => r.k === 0) || null };
}

function verdictOf(matched, compared, avgClosePips, maxClosePips, off) {
  const offsetFixes = off && off.best && off.best.k !== 0 && off.best.mean <= 1.5 &&
    (!off.zero || off.best.mean < off.zero.mean * 0.5);
  if (offsetFixes) {
    return { icon: '⚠️', text: `Tatizo ni WAKATI, si bei: candles zinalingana (wastani ${f1(off.best.mean)} pips) zikisogezwa saa ${off.best.k >= 0 ? '+' : ''}${off.best.k}. Twelve Data inaonekana kutumia muda wa UTC${off.best.k >= 0 ? '+' : ''}${off.best.k} (au mpangilio tofauti wa candles kwa timeframe hii), si UTC.` };
  }
  if (matched === 0) return { icon: '❓', text: 'Hakuna candles zinazolingana kwa wakati, na hakuna offset ya saa inayosaidia — haiwezi kulinganishwa moja kwa moja.' };
  const coverage = matched / compared;
  if (coverage >= 0.9 && avgClosePips <= 0.3 && maxClosePips <= 1.5) {
    return { icon: '✅', text: 'Data zinalingana vizuri — Twelve Data inaweza kuaminika kwa signal.' };
  }
  if (coverage >= 0.8 && avgClosePips <= 1) {
    return { icon: '⚠️', text: 'Tofauti ndogo — inakubalika kwa timeframe za 1h+, lakini angalia SL/TP zisiwe ndogo mno.' };
  }
  return {
    icon: '❌',
    text: 'Tofauti halisi ya data (si wakati). Hii peke yake haisemi ipi ni sahihi — lakini Deriv ndiyo bei ya trade yako, kwa hiyo ndiyo kigezo cha kuaminika zaidi kwa signal ya Deriv.',
  };
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

    // Chukua candles 50 za mwisho za Twelve KWANZA, kisha hesabu zinazolingana —
    // ili "x/50" iwe ya kweli (hapo awali ilichuja kwanza na ikaonyesha 50/50 kila mara).
    const tdWindow = td.slice(-MAX_COMPARED);
    const pairs = tdWindow.filter((c) => dvMap.has(c.datetime)).map((c) => ({ t: c, d: dvMap.get(c.datetime) }));
    const compared = tdWindow.length;

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

    // Muda wa data + range ya candle (Deriv ina candles chache/zaidi? range pana zaidi?)
    const rangePips = (arr) => mean(arr.slice(-MAX_COMPARED).map((c) => (Number(c.high) - Number(c.low)) / pip));
    L.push('');
    L.push(`🗓️ *Data:* Twelve ${td[0]?.datetime} → ${td[td.length - 1]?.datetime} (${td.length})`);
    L.push(`            Deriv  ${dv[0]?.datetime} → ${dv[dv.length - 1]?.datetime} (${dv.length})`);
    L.push(`🧹 Candles za soko-limefungwa zilizoondolewa (Twelve): ${tdRes.value.droppedClosed ?? 0}`);
    L.push(`📏 *Range ya candle (wastani):* Twelve ${f1(rangePips(td))}p • Deriv ${f1(rangePips(dv))}p`);

    // Offset ya muda (saa) — haina maana kwa daily (lebo ni tarehe tu)
    let off = null;
    if (!/day|week|month/.test(interval)) {
      off = findBestOffset(td, dv, pip);
      if (off.best) {
        L.push('');
        L.push(`🕐 *Offset ya muda (saa):*`);
        L.push(
          `   • Bora zaidi: ${off.best.k >= 0 ? '+' : ''}${off.best.k}h → wastani ${f1(off.best.mean)} pips (candles ${off.best.n})` +
            (off.zero ? ` • bila kusogeza (0h): ${f1(off.zero.mean)} pips` : ' • bila kusogeza (0h): hakuna candles zinazolingana')
        );
      } else {
        L.push('');
        L.push(`🕐 *Offset ya muda:* hakuna offset ya saa (-12..+12) iliyotoa candles za kutosha zinazolingana.`);
      }
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

    const v = verdictOf(pairs.length, compared, mean(closeDiff), max(closeDiff), off);
    L.push('');
    L.push(`${v.icon} *Hitimisho:* ${v.text}`);
    L.push('');
    L.push(`_Candle ya mwisho (inayoendelea) imeachwa kwenye ulinganisho. Kumbuka: jaribu pia 4h na 1day (.fxcheck ${code} 4h) kwa kuwa alignment inaweza kutofautiana._`);

    return extra.reply(L.join('\n'));
  },
};
