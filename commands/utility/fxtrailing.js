/**
 * FX Trailing Stop Command — washa/zima trailing stop (breakeven-lock +
 * profit-lock, angalia utils/autoTrader.js -> checkTrailingStops()) "live"
 * bila ku-restart bot. Vigezo vya trigger (R-multiples) ni FASTA ndani ya
 * code (si env vars) — hii command inadhibiti TU on/off. Mabadiliko
 * yanahifadhiwa kwenye database (Turso), hivyo yanabaki hata baada ya
 * bot ku-restart/redeploy — muundo uleule na .fxautostake.
 *
 * Matumizi:
 *   .fxtrailing          -> onyesha hali ya sasa (ON/OFF)
 *   .fxtrailing on        -> washa
 *   .fxtrailing off        -> zima
 */

const { getStatus, setTrailingEnabled } = require('../../utils/autoTrader');

module.exports = {
  name: 'fxtrailing',
  aliases: ['trailing', 'fxtrail'],
  category: 'owner',
  description: 'Washa/zima trailing stop (breakeven-lock + profit-lock) ya auto-trader',
  usage: '.fxtrailing [on|off]',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const s = getStatus();

    if (!args[0]) {
      return extra.reply(
        `🪤 Trailing stop kwa sasa: *${s.trailingEnabled ? 'ON ✅' : 'OFF ⛔'}*\n\n` +
          `   • Breakeven ikifika R${s.trailBreakevenTriggerR} (profit >= hatari ya awali)\n` +
          `   • Profit-lock (${s.trailProfitlockR * 100}% ya hatari ya awali) ikifika R${s.trailProfitlockTriggerR}\n\n` +
          `Kubadilisha: *.fxtrailing on* au *.fxtrailing off*`
      );
    }

    const arg = String(args[0]).toLowerCase();
    if (!['on', 'off'].includes(arg)) {
      return extra.reply(`❌ Weka *on* au *off* pekee — mfano: *.fxtrailing off*`);
    }

    const result = await setTrailingEnabled(arg === 'on');
    return extra.reply(
      `✅ Trailing stop sasa iko: *${result.trailingEnabled ? 'ON ✅' : 'OFF ⛔'}*\n\n` +
        `_Trades zilizo wazi tayari zinaendelea na SL ya sasa; mabadiliko haya yanahusu ukaguzi ujao (kila ${'`AUTO_TRADE_POLL_MS`'}) tu._\n` +
        `_Thamani hii imehifadhiwa kwenye database — haitapotea hata bot ikizima/deploy upya._`
    );
  },
};
