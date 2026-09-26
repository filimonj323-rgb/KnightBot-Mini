/**
 * FX Auto-Trade Stake Command — badilisha kiasi (stake) cha kila auto-trade
 * "live" (bila ku-restart bot) badala ya kuhariri AUTO_TRADE_STAKE_USD
 * kwenye env na kusubiri redeploy. Mabadiliko yanahifadhiwa kwenye database
 * (Turso) kupitia autoTrader.setStakeUsd(), hivyo yanabaki hata baada ya
 * bot ku-restart/redeploy.
 *
 * Matumizi:
 *   .fxautostake            -> onyesha stake ya sasa
 *   .fxautostake 1           -> badilisha stake kuwa $1 kwa kila auto-trade
 */

const { getStatus, setStakeUsd } = require('../../utils/autoTrader');

module.exports = {
  name: 'fxautostake',
  aliases: ['autostake', 'fxstake'],
  category: 'owner',
  description: 'Ona au badilisha kiasi (stake) cha kila auto-trade ya forex, bila kuhitaji restart',
  usage: '.fxautostake <kiasi kwa dola, mfano 1>',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const current = getStatus().stake;

    if (!args[0]) {
      return extra.reply(
        `💵 Stake ya sasa kwa kila auto-trade: *$${current}*\n\n` +
          `Kubadilisha: *.fxautostake <kiasi>*\n` +
          `Mfano: *.fxautostake 1* — kila auto-trade itafungua kwa $1.`
      );
    }

    const result = await setStakeUsd(args[0]);

    if (!result.ok) {
      return extra.reply(`❌ ${result.error}`);
    }

    return extra.reply(
      `✅ Stake ya auto-trade imebadilishwa: $${result.previous} → *$${result.stake}*\n\n` +
        `_Mabadiliko haya yanahusu trade MPYA zitakazofunguliwa kuanzia sasa. Trade zilizo wazi tayari hazibadiliki._\n` +
        `_Thamani hii imehifadhiwa kwenye database — haitapotea hata bot ikizima/deploy upya._`
    );
  },
};
