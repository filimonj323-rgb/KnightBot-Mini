/**
 * Forex Command — Ishara (signal) za forex kwa jozi za sarafu.
 *
 * Matumizi mawili:
 *   1) Command maalum kwa kila jozi kuu: .eurusd, .gbpusd, .usdjpy, n.k
 *      (faili nyembamba kwenye commands/utility/ zinazoita runForexCommand
 *      hapa na kupasisha pair moja kwa moja — angalia eurusd.js kwa mfano)
 *   2) Command ya jumla: .forex <JOZI> — mfano: .forex GBPJPY (kwa jozi
 *      isiyo na command yake maalum)
 *
 * Chanzo cha data + vigezo: utils/forexSignal.js (Twelve Data API).
 *
 * ⚠️⚠️ FOREX INA HATARI KUBWA ZAIDI YA HISA ZA DSE (leverage, volatility ya
 * dakika kwa dakika). Hii SI ushauri wa kifedha wala wa uwekezaji.
 */

const { fetchForexSnapshot, computeSignal, DEFAULT_INTERVAL } = require('../../utils/forexSignal');

// ─────────────────────────────────────────────
// Formatting helpers — mtindo uleule wa stock.js/analyze.js
// ─────────────────────────────────────────────
function buildHeader(title) {
  return `⎯⎯⎯ 『 *${title}* 』 ⎯⎯⎯`;
}

function buildFooter() {
  return (
    `┌─────────────────\n` +
    `│ 🛠️ *MR.IT MEDIATOR*\n` +
    `└─────────────────\n` +
    `   _for easy access of data and analysis.._\n` +
    `   _system developer and automation.._`
  );
}

function padCol(str, width) {
  str = String(str);
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

function buildTable(rows, headers, widths) {
  let out = '```\n';
  out += headers.map((h, i) => padCol(h, widths[i])).join(' ') + '\n';
  out += widths.map((w) => '-'.repeat(w)).join(' ') + '\n';
  rows.forEach((r) => {
    out += r.map((c, i) => padCol(String(c), widths[i])).join(' ') + '\n';
  });
  out += '```';
  return out;
}

function buildBox(lines) {
  const width = Math.max(...lines.map((l) => l.length), 20);
  let out = '```\n';
  out += '┌' + '─'.repeat(width + 2) + '┐\n';
  lines.forEach((l) => {
    out += '│ ' + padCol(l, width) + ' │\n';
  });
  out += '└' + '─'.repeat(width + 2) + '┘\n';
  out += '```';
  return out;
}

const fmtPrice = (n, decimals = 5) => (n == null ? 'N/A' : Number(n).toFixed(decimals));

function directionEmoji(d) {
  switch (d) {
    case 'BUY':  return '🟢';
    case 'SELL': return '🔴';
    default:     return '⚪';
  }
}

function buildForexMessage(pairSymbol, s, sig) {
  const displayPair = pairSymbol.replace('/', '');
  const L = [];

  L.push(buildHeader(`${displayPair} — FOREX SIGNAL`));
  L.push('');
  L.push(`💰 *Bei:* ${fmtPrice(s.price)}`);
  L.push(`⏱️ *Interval:* ${s.interval.toUpperCase()}`);
  L.push('');

  L.push(
    buildBox([
      `DIRECTION: ${sig.direction} ${directionEmoji(sig.direction)}`,
      `STRENGTH:  ${sig.strength}%`,
    ])
  );
  L.push('');

  L.push(`📊 *Vigezo vya Kiufundi*`);
  L.push(
    buildTable(
      [
        ['RSI(14)', s.rsi != null ? s.rsi.toFixed(2) : 'N/A'],
        ['EMA9', fmtPrice(s.ema9)],
        ['EMA21', fmtPrice(s.ema21)],
        ['MACD', s.macd != null ? s.macd.toFixed(5) : 'N/A'],
        ['Signal', s.macdSignal != null ? s.macdSignal.toFixed(5) : 'N/A'],
        [`EMA9 (${(s.htfInterval || '4h').toUpperCase()})`, fmtPrice(s.htfEma9)],
        [`EMA21 (${(s.htfInterval || '4h').toUpperCase()})`, fmtPrice(s.htfEma21)],
      ],
      ['KIGEZO', 'THAMANI'],
      [10, 14]
    )
  );
  L.push('');

  if (sig.notes.length) {
    L.push(`🧠 *Sababu*`);
    sig.notes.forEach((n) => L.push(`   • ${n}`));
    L.push('');
  }

  L.push(
    `⚠️ *Forex ina hatari kubwa (leverage) — bei zinabadilika haraka.* ` +
    `Hii SI ushauri wa kifedha wala wa uwekezaji — fanya utafiti wako ` +
    `mwenyewe (DYOR) na tumia risk management (Stop Loss) kabla ya biashara.`
  );
  L.push('');
  L.push(`_Chanzo: bei + vigezo = Twelve Data (interval ${s.interval.toUpperCase()})._`);
  L.push('');
  L.push(buildFooter());
  return L.join('\n');
}

// ─────────────────────────────────────────────
// Handler kuu — inatumika na command maalum (.eurusd, n.k) na na .forex
// ─────────────────────────────────────────────
async function runForexCommand(sock, msg, args, extra, forcedPair) {
  const jid = msg.key.remoteJid;
  let pairSymbol = forcedPair || null;

  if (!pairSymbol) {
    const raw = (args[0] || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (raw.length !== 6) {
      return sock.sendMessage(
        jid,
        {
          text:
            `❓ Weka jozi ya sarafu (herufi 6, bila mkato).\n\n` +
            `Tumia: .forex <JOZI>\n` +
            `Mfano: .forex GBPJPY\n\n` +
            `Au tumia command maalum: .eurusd, .gbpusd, .usdjpy, .usdchf, .audusd, .usdcad, .nzdusd`,
        },
        { quoted: msg }
      );
    }
    pairSymbol = `${raw.slice(0, 3)}/${raw.slice(3)}`;
  }

  try {
    const snapshot = await fetchForexSnapshot(pairSymbol, DEFAULT_INTERVAL);
    const sig = computeSignal(snapshot);
    return await sock.sendMessage(
      jid,
      { text: buildForexMessage(pairSymbol, snapshot, sig) },
      { quoted: msg }
    );
  } catch (err) {
    const status = err.tdCode || err.status || err.response?.status;
    let reason = 'tatizo la muda';
    if (String(err.message || '').includes('TWELVE_DATA_API_KEY')) {
      reason = 'TWELVE_DATA_API_KEY haijawekwa kwenye env (angalia utils/forexSignal.js)';
    } else if (status === 429) {
      reason = 'kikomo cha maombi kimefikiwa kwa muda (tier bure: 8/dakika) — jaribu tena baada ya dakika chache';
    } else if (status === 400 || status === 404) {
      reason = `jozi "${pairSymbol}" haitambuliwi na Twelve Data — hakikisha umeandika sahihi`;
    }
    console.error('forex error:', pairSymbol, err.message);
    await sock.sendMessage(
      jid,
      { text: `❌ Imeshindwa kupata signal ya ${pairSymbol}: ${reason}.` },
      { quoted: msg }
    );
  }
}

module.exports = {
  name: 'forex',
  aliases: ['fx'],
  category: 'utility',
  description: 'Ishara ya forex (BUY/SELL) kwa jozi yoyote ya sarafu — mfano: .forex EURUSD',
  usage: '.forex <JOZI> — mfano: .forex GBPJPY (au tumia .eurusd, .gbpusd, n.k)',

  execute: (sock, msg, args, extra) => runForexCommand(sock, msg, args, extra, null),

  // Inatolewa nje ili command maalum za kila jozi (eurusd.js, n.k) ziweze
  // kuitumia bila kurudia formatting/logic.
  runForexCommand,
};
