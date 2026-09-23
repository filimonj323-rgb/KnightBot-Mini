/**
 * AUDUSD Command — Forex signal ya AUD/USD (thin wrapper).
 * Logic yote (fetch + kuhesabu signal + formatting) iko utils/forexSignal.js
 * na commands/utility/forex.js — faili hili linapasisha tu jozi mahususi.
 */

const { runForexCommand } = require("./forex.js");

module.exports = {
  name: "audusd",
  aliases: [],
  category: "utility",
  description: "Forex signal ya AUD/USD (EMA9/EMA21, RSI14, MACD — Twelve Data)",
  usage: ".audusd",
  execute: (sock, msg, args, extra) => runForexCommand(sock, msg, args, extra, "AUD/USD"),
};
