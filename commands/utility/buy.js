/**
 * Buy Command — Fungua trade ya BUY (Deriv Multipliers).
 * Stop Loss na Take Profit ni LAZIMA — haziwezi kuachwa.
 */

const { placeManualTrade } = require('../../utils/autoTrader');
const { placeMultiplier, MAX_STAKE_USD, MAX_MULTIPLIER, MIN_STAKE_USD, ALLOWED_MULTIPLIERS } = require('../../utils/derivTrader');

// SL/TP: namba ya kawaida = dola ($); ukiongeza "p" (mfano 10p) = pips.
const parseLimit = (raw) => {
  const t = String(raw).trim().toLowerCase();
  const isPips = /p(ips?)?$/.test(t);
  return { value: parseFloat(t.replace(/p(ips?)?$/, '')), isPips };
};

module.exports = {
  name: 'fxbuy',
  aliases: ['buyfx'],
  category: 'utility',
  description: 'Fungua trade ya BUY (Deriv Multipliers) — SL/TP ni LAZIMA',
  usage:
    '.fxbuy <JOZI> <STAKE_USD> <SL> <TP> [MULTIPLIER]\n' +
    'SL/TP kwa dola: .fxbuy EURUSD 10 5 10 50\n' +
    'SL/TP kwa pips (ongeza p): .fxbuy EURUSD 10 10p 20p 100',

  async execute(sock, msg, args) {
    // Pairing bot (mteja): akaunti yake mwenyewe ya Deriv (DEMO) kupitia lango la sera — si akaunti ya owner.
    if (sock.pairingOwnerId) return require('../../utils/derivCustomerCommands').buy(sock, msg, args);
    const jid = msg.key.remoteJid;
    const [pairRaw, stakeRaw, slRaw, tpRaw, multRaw] = args;

    if (!pairRaw || !stakeRaw || !slRaw || !tpRaw) {
      return sock.sendMessage(
        jid,
        {
          text:
            `❓ Tumia: .fxbuy <JOZI> <STAKE_USD> <SL> <TP> [MULTIPLIER]\n` +
            `Dola: .fxbuy EURUSD 10 5 10 50\n` +
            `Pips (ongeza p): .fxbuy EURUSD 10 10p 20p 100\n\n` +
            `⚠️ Stop Loss na Take Profit ni LAZIMA — haziwezi kuachwa.\n` +
            `Kikomo: stake $${MIN_STAKE_USD}–$${MAX_STAKE_USD}.\n` +
            `Multiplier zinazokubalika: ${ALLOWED_MULTIPLIERS.join(', ')} (kikomo ${MAX_MULTIPLIER}).`,
        },
        { quoted: msg }
      );
    }

    const pair = pairRaw.toUpperCase().replace(/[^A-Z]/g, '');

    try {
      const sl = parseLimit(slRaw); const tp = parseLimit(tpRaw);
      const result = await placeManualTrade({
        pair,
        direction: 'BUY',
        stake: parseFloat(stakeRaw),
        stopLoss: sl.isPips ? 0 : sl.value,
        takeProfit: tp.isPips ? 0 : tp.value,
        slPips: sl.isPips ? sl.value : undefined,
        tpPips: tp.isPips ? tp.value : undefined,
        multiplier: multRaw ? parseFloat(multRaw) : undefined,
      });

      return sock.sendMessage(
        jid,
        {
          text:
            `✅ *BUY imefunguliwa — ${pair}*\n\n` +
            `🆔 Contract ID: ${result.contract_id}\n` +
            `💵 Bei ya ununuzi: $${result.buy_price}\n` +
            (result.longcode ? `📄 ${result.longcode}\n` : '') +
            (result.estimateText ? `\n${result.estimateText}\n` : '') +
            `\n_Tumia .positions kuona trades wazi, .panic kufunga zote dharura._`,
        },
        { quoted: msg }
      );
    } catch (err) {
      console.error('buy error:', pair, err.message);
      await sock.sendMessage(
        jid,
        { text: `❌ Imeshindwa kufungua BUY ya ${pair}: ${err.message}` },
        { quoted: msg }
      );
    }
  },
};
