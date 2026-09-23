/**
 * USDCHF Command — Forex signal ya USD/CHF (thin wrapper).
 * Logic yote (fetch + kuhesabu signal + formatting) iko utils/forexSignal.js
 * na commands/utility/forex.js — faili hili linapasisha tu jozi mahususi.
 */

const { runForexCommand } = require("./forex.js");

module.exports = {
  name: "usdchf",
  aliases: [],
  category: "utility",
  description: "Forex signal ya USD/CHF (EMA9/EMA21, RSI14, MACD — Twelve Data)",
  usage: ".usdchf",
  execute: (sock, msg, args, extra) => runForexCommand(sock, msg, args, extra, "USD/CHF"),
};
