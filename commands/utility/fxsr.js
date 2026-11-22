/**
 * .fxsr <JOZI> — Support/Resistance za sasa (zones za 1h + 4h) na umbali kwa pips kutoka bei ya sasa.
 * Pia inaonyesha ATR kwa pips ili uelewe SL/TP ya bot kwa mtazamo wa structure.
 */
const { fetchForexSnapshot } = require('../../utils/forexSignal');
const { PAIRS } = require('../../utils/autoTrader');
const { nearestLevels, toPips, pipSize } = require('../../utils/supportResistance');

function resolveSymbol(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z]/g, '');
  const known = PAIRS.find((p) => p.code === code);
  if (known) return known;
  return code.length === 6 ? { code, symbol: `${code.slice(0, 3)}/${code.slice(3)}` } : null;
}

module.exports = {
  name: 'fxsr',
  aliases: ['sr', 'supportresistance'],
  category: 'owner',
  description: 'Onyesha Support/Resistance za sasa za jozi na umbali kwa pips',
  usage: '.fxsr <JOZI, mfano EURUSD>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const r = resolveSymbol(args[0]);
    if (!r) return extra.reply('📋 Matumizi: *.fxsr EURUSD*');
    let snap;
    try { snap = await fetchForexSnapshot(r.symbol, '1h'); } catch (e) { return extra.reply(`❌ Imeshindwa kupata data: ${e.message}`); }
    const zones = snap.srZones || [];
    const dp = pipSize(r.code) === 0.01 ? 3 : 5;
    const pipsTo = (p) => Math.abs(toPips(r.code, p - snap.price)).toFixed(1);
    const sorted = [...zones].sort((a, b) => a.price - b.price);
    const above = sorted.filter((z) => z.low > snap.price).slice(0, 3);
    const below = sorted.filter((z) => z.high < snap.price).slice(-3).reverse();
    const line = (z) => `   • ${z.price.toFixed(dp)}  (${pipsTo(z.price)} pips) — touches ${z.touches} • ${z.tf}`;
    const out = [`⎯⎯⎯ 『 *S/R — ${r.code}* 』 ⎯⎯⎯`, '', `💲 Bei: ${snap.price.toFixed(dp)}  •  ATR(1h): ${toPips(r.code, snap.atr).toFixed(1)} pips`, ''];
    out.push('🔴 *Resistance (juu)*'); out.push(...(above.length ? above.reverse().map(line) : ['   _hakuna zone iliyo karibu_']));
    out.push('', '🟢 *Support (chini)*'); out.push(...(below.length ? below.map(line) : ['   _hakuna zone iliyo karibu_']));
    const nl = nearestLevels(zones, snap.price);
    if (nl.support && nl.resistance) {
      out.push('', `↔️ Nafasi kati ya zones: ${(toPips(r.code, nl.resistance.low - nl.support.high)).toFixed(1)} pips`);
    }
    out.push('', '_Zones = swing highs/lows zilizothibitishwa; touches = mara bei ilipogeuka hapo. 4h ni imara kuliko 1h._');
    return extra.reply(out.join('\n'));
  },
};
