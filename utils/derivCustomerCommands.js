/**
 * derivCustomerCommands.js — Commands za Deriv kwa PAIRING BOTS (akaunti ya mteja mwenyewe, DEMO).
 *
 * Zinaitwa kutoka commands/utility/{buy,sell,positions,panic,fxclose}.js PEKEE pale `sock.pairingOwnerId` ipo.
 * Handler (handler.js) tayari imehakikisha mtumaji ni MTEJA MWENYEWE (si global owner wala mtu mwingine) — angalia
 * forexAccess.decide(). Hapa hakuna ukaguzi wa idhini: kila kitu (idhini ya admin, swichi, vikomo, kill switch) kiko
 * ndani ya derivCustomerTrader.
 */

const trader = require('./derivCustomerTrader');

const reply = (sock, msg, text) => sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
const money = (n) => (n == null || !Number.isFinite(Number(n)) ? 'N/A' : `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(2)}`);

async function trade(sock, msg, args, direction) {
  const cmd = direction === 'BUY' ? '.fxbuy' : '.fxsell';
  const [pair, stake, sl, tp, mult] = args;
  if (!pair || !stake || !sl || !tp) {
    return reply(sock, msg,
      `❓ Tumia: ${cmd} <JOZI> <STAKE_USD> <SL_USD> <TP_USD> [MULTIPLIER]\nMfano: ${cmd} EURUSD 2 1 2 100\n\n` +
      `⚠️ Stop Loss na Take Profit ni LAZIMA. Akaunti yako ya DEMO tu, na vikomo vyako vinatumika.\n` +
      `Jozi: ${trader.PAIRS.join(', ')}`);
  }
  try {
    const r = await trader.openTrade(sock.pairingOwnerId, {
      pair, direction, stake: parseFloat(stake), stopLoss: parseFloat(sl), takeProfit: parseFloat(tp),
      multiplier: mult ? parseFloat(mult) : undefined,
    });
    return reply(sock, msg,
      `✅ *${direction} imefunguliwa — ${r.pair}* (DEMO)\n\n🆔 Contract: ${r.contractId}\n💵 Stake: $${r.stake} • x${r.multiplier}\n` +
      `🛑 SL: $${r.stopLoss} • 🎯 TP: $${r.takeProfit}\n` + (r.tracked ? '' : '\n⚠️ Trade imefunguliwa lakini haikuandikishwa vizuri — iangalie kwa .positions.\n') +
      `\n_.positions kuona • .fxclose <id> kufunga • .panic kufunga zote_`);
  } catch (err) {
    return reply(sock, msg, `❌ ${err.userMessage || 'Imeshindwa kufungua trade.'}`);
  }
}

async function positions(sock, msg) {
  try {
    const o = await trader.overview(sock.pairingOwnerId);
    const lines = ['📊 *Akaunti Yangu ya Deriv (DEMO)*', ''];
    if (!o.positions.length) lines.push('📭 Hakuna trade iliyo wazi.');
    else o.positions.forEach((p) => lines.push(`🆔 ${p.contractId} — ${p.shortcode || p.symbol || ''}\n   Buy: $${p.buyPrice} • Sasa: $${p.bidPrice ?? 'N/A'} • P/L: ${money(p.profit)}`));
    lines.push('');
    if (o.balance) lines.push(`💰 Balance: ${o.balance.currency} ${o.balance.amount}`);
    lines.push(`📅 Leo: trades ${o.today.opened}/${o.limits.maxTradesDay} • hasara $${o.today.lossToday}/${o.limits.maxDailyLoss} • P/L ${money(o.today.pnlToday)}`);
    if (!o.canTrade) lines.push('', '🔒 Kufungua trade mpya hakuruhusiwi kwa sasa (angalia dashboard).');
    return reply(sock, msg, lines.join('\n'));
  } catch (err) {
    return reply(sock, msg, `❌ ${err.userMessage || 'Imeshindwa kusoma akaunti yako.'}`);
  }
}

async function panic(sock, msg) {
  try {
    const results = await trader.closeAll(sock.pairingOwnerId);
    if (!results.length) return reply(sock, msg, '📭 Hakuna trade iliyokuwa wazi.');
    const lines = ['🛑 *Kufunga Trades Zote*', ''];
    results.forEach((r) => lines.push(r.ok ? `✅ ${r.contractId} — imefungwa (${money(r.profit)})` : `❌ ${r.contractId} — ${r.error}`));
    return reply(sock, msg, lines.join('\n'));
  } catch (err) {
    return reply(sock, msg, `❌ ${err.userMessage || 'Imeshindwa kufunga trades.'}`);
  }
}

async function close(sock, msg, args) {
  const id = String(args[0] || '').replace(/\D/g, '');
  if (!id) return reply(sock, msg, '❓ Tumia: .fxclose <contract_id>\n(Pata id kwa .positions)');
  try {
    const r = await trader.closeTrade(sock.pairingOwnerId, id);
    return reply(sock, msg, `✅ Trade ${r.contractId} imefungwa. P/L: ${money(r.profit)}`);
  } catch (err) {
    return reply(sock, msg, `❌ ${err.userMessage || 'Imeshindwa kufunga trade.'}`);
  }
}

module.exports = { buy: (s, m, a) => trade(s, m, a, 'BUY'), sell: (s, m, a) => trade(s, m, a, 'SELL'), positions, panic, close };
