/**
 * Swali Command — Uliza swali la ufuatiliaji kuhusu uchambuzi wa mwisho wa
 * ".analyze <symbol>"
 *
 * KWA NINI COMMAND YENYE PREFIX (SI UJUMBE WA KAWAIDA): ndani ya group,
 * kama bot ingekuwa "inasikiliza" ujumbe wowote unaofuata wa mtumiaji bila
 * prefix na kuutafsiri kama swali, chat ya kawaida ya mtumiaji na wenzake
 * ingeweza kunaswa kimakosa. Kwa kutumia ".swali <swali>" (au button
 * "❓ Nisaidie Kuuliza" kutoka .analyze inayomkumbusha syntax hii), hakuna
 * mgogoro — bot inajibu TU pale mtumiaji ameomba wazi.
 *
 * Haifanyi fetch/search mpya — inatumia muktadha ule ule uliohifadhiwa na
 * .analyze (dakika 10 za mwisho), hivyo ni haraka na haigharimu tena fee ya
 * "habari" (news search).
 */

const analyzeCmd = require('./analyze.js');
const pendingFollowup = require('../../utils/pendingAnalysisFollowup');

module.exports = {
  name: 'swali',
  aliases: ['uliza', 'swalihisa', 'askanalysis'],
  category: 'utility',
  description: 'Uliza swali la ufuatiliaji kuhusu uchambuzi wa mwisho wa .analyze',
  usage: '.swali <swali lako> — mfano: .swali kwa nini P/E iko juu?',

  async execute(sock, msg, args, extra) {
    const jid = msg.key.remoteJid;
    const sender = extra?.sender || msg.key.participant || msg.key.remoteJid;
    const question = args.join(' ').trim();

    const entry = pendingFollowup.get(sender);
    if (!entry) {
      return await sock.sendMessage(
        jid,
        {
          text:
            '⌛ Hakuna uchambuzi wa hivi karibuni wa kuulizia (umeisha muda wa dakika ' +
            '10, au bado hujafanya .analyze).\n\n' +
            'Tumia kwanza: `.analyze <symbol>` — mfano: `.analyze CRDB`',
        },
        { quoted: msg }
      );
    }

    if (!question) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `❓ Andika swali lako baada ya command.\n\n` +
            `Tumia: \`.swali <swali lako>\`\n` +
            `Mfano: \`.swali kwa nini verdict ni ${entry.context.ai?.verdict || 'hii'}?\`\n\n` +
            `(Swali hili litahusu uchambuzi wa *${entry.context.symbol}* uliopata hivi karibuni)`,
        },
        { quoted: msg }
      );
    }

    try {
      await sock.sendMessage(jid, { react: { text: '💭', key: msg.key } });
    } catch (_) {
      // react si muhimu sana kufanikiwa — endelea
    }

    try {
      const answer = await analyzeCmd.answerFollowupQuestion(entry.context, question);
      pendingFollowup.touch(sender); // ruhusu maswali zaidi mfululizo ndani ya dakika 10
      return await sock.sendMessage(
        jid,
        { text: `⎯⎯⎯ 『 *SWALI — ${entry.context.symbol}* 』 ⎯⎯⎯\n\n${answer}` },
        { quoted: msg }
      );
    } catch (err) {
      console.error('swali.js error:', err.message);
      return await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kujibu swali lako kwa sasa: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
