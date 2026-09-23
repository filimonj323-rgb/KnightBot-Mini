/**
 * NZDUSD Command — Forex signal ya NZD/USD (thin wrapper).
 * Logic yote (fetch + kuhesabu signal + formatting) iko utils/forexSignal.js
 * na commands/utility/forex.js — faili hili linapasisha tu jozi mahususi.
 */

const { runForexCommand } = require("./forex.js");

module.exports = {
  name: "nzdusd",
  aliases: [],
  category: "utility",
  description: "Forex signal ya NZD/USD (EMA9/EMA21, RSI14, MACD — Twelve Data)",
  usage: ".nzdusd",
  execute: (sock, msg, args, extra) => runForexCommand(sock, msg, args, extra, "NZD/USD"),
};
