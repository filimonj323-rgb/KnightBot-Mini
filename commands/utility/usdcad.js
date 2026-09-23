/**
 * USDCAD Command — Forex signal ya USD/CAD (thin wrapper).
 * Logic yote (fetch + kuhesabu signal + formatting) iko utils/forexSignal.js
 * na commands/utility/forex.js — faili hili linapasisha tu jozi mahususi.
 */

const { runForexCommand } = require("./forex.js");

module.exports = {
  name: "usdcad",
  aliases: [],
  category: "utility",
  description: "Forex signal ya USD/CAD (EMA9/EMA21, RSI14, MACD — Twelve Data)",
  usage: ".usdcad",
  execute: (sock, msg, args, extra) => runForexCommand(sock, msg, args, extra, "USD/CAD"),
};
