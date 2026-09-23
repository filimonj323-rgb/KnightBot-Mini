/**
 * GBPUSD Command — Forex signal ya GBP/USD (thin wrapper).
 * Logic yote (fetch + kuhesabu signal + formatting) iko utils/forexSignal.js
 * na commands/utility/forex.js — faili hili linapasisha tu jozi mahususi.
 */

const { runForexCommand } = require("./forex.js");

module.exports = {
  name: "gbpusd",
  aliases: [],
  category: "utility",
  description: "Forex signal ya GBP/USD (EMA9/EMA21, RSI14, MACD — Twelve Data)",
  usage: ".gbpusd",
  execute: (sock, msg, args, extra) => runForexCommand(sock, msg, args, extra, "GBP/USD"),
};
