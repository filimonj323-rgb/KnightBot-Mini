/**
 * Pocket Option — Signal Command.
 *
 *   .posignal EURUSD            -> signal ya EURUSD (timeframe 1m)
 *   .posignal EURUSD 5m         -> signal ya EURUSD kwenye 5m
 *   .posignal scan [mode] [tf]  -> changanua jozi, onyesha zenye nguvu
 *        mode: forex (default, jozi kuu) | otc (zote za OTC) | real (soko halisi zote) | all (zote)
 *   .posignal auto on [tf] [minStrength] [mode]  -> (owner) tuma signals kiotomatiki kwenye chat hii
 *   .posignal auto off | status
 *
 * Wikendi jozi za kawaida hazifanyi kazi — "_otc" inaongezwa kiotomatiki.
 */

const { isBridgeUp } = require('../../utils/pocketOptionTrader');
const {
  DEFAULT_PAIRS,
  SCAN_MODES,
  getUniverse,
  parseTimeframe,
  tfLabel,
  analyzePair,
  scanPairs,
  formatSignal,
  formatScan,
} = require('../../utils/pocketSignal');

// jid -> { timer, tf, minStrength, sent:Set }
const autoJobs = new Map();
const MAX_SENT_CACHE = 200;
const MAX_PER_CYCLE = 5; // signals za juu tu kwa kila mzunguko (kuzuia spam)

// Tenganisha mode na timeframe kutoka args (mpangilio wowote): ["otc","5m"] au ["5m","otc"]
function parseModeTf(args) {
  let mode = 'forex';
  let tfArg;
  for (const a of args) {
    if (SCAN_MODES.includes(String(a).toLowerCase())) mode = String(a).toLowerCase();
    else tfArg = a;
  }
  return { mode, tf: parseTimeframe(tfArg, 60) };
}

function msUntilNextCandle(tfSec) {
  const tfMs = tfSec * 1000;
  // +3s ili candle iwe imefungwa kabisa kwenye server ya Pocket Option
  return tfMs - (Date.now() % tfMs) + 3000;
}

function stopAuto(jid) {
  const job = autoJobs.get(jid);
  if (!job) return false;
  clearTimeout(job.timer);
  autoJobs.delete(jid);
  return true;
}

function scheduleAuto(sock, jid, job) {
  job.timer = setTimeout(async () => {
    if (!autoJobs.has(jid)) return;
    try {
      if (await isBridgeUp()) {
        const pairs = await getUniverse(job.mode);
        const { results } = await scanPairs(pairs, job.tf, { minStrength: job.minStrength });
        let sentNow = 0;
        for (const r of results) {
          if (sentNow >= MAX_PER_CYCLE) break;
          if (r.direction === 'NEUTRAL' || r.strength < job.minStrength) continue;
          const key = `${r.pair}|${r.direction}|${r.candleTime}`;
          if (job.sent.has(key)) continue;
          job.sent.add(key);
          if (job.sent.size > MAX_SENT_CACHE) job.sent.delete(job.sent.values().next().value);
          await sock.sendMessage(jid, { text: formatSignal(r) });
          sentNow++;
        }
      }
    } catch (err) {
      console.error('[posignal auto] error:', err.message);
    } finally {
      if (autoJobs.has(jid)) scheduleAuto(sock, jid, job);
    }
  }, msUntilNextCandle(job.tf));
}

async function handleAuto(sock, jid, args, extra) {
  if (!extra.isOwner) return extra.reply('⛔ Auto-signal ni ya owner tu.');
  const action = (args[0] || 'status').toLowerCase();

  if (action === 'off') {
    return extra.reply(stopAuto(jid) ? '🛑 Auto-signal imezimwa kwenye chat hii.' : 'ℹ️ Auto-signal haikuwa imewashwa hapa.');
  }

  if (action === 'status') {
    const job = autoJobs.get(jid);
    return extra.reply(
      job
        ? `✅ Auto-signal IMEWASHWA — timeframe ${tfLabel(job.tf)}, nguvu ya chini ${job.minStrength}%, jozi: ${job.mode}`
        : 'ℹ️ Auto-signal imezimwa. Washa: *.posignal auto on 1m 70*'
    );
  }

  if (action === 'on') {
    const tf = parseTimeframe(args[1], 60);
    if (!tf) return extra.reply('❌ Timeframe si sahihi. Mfano: 1m, 5m, 30s.');
    const minStrength = Math.min(100, Math.max(30, parseInt(args[2], 10) || 70));
    const mode = SCAN_MODES.includes(String(args[3] || '').toLowerCase()) ? args[3].toLowerCase() : 'forex';
    stopAuto(jid);
    const job = { tf, minStrength, mode, sent: new Set(), timer: null };
    autoJobs.set(jid, job);
    scheduleAuto(sock, jid, job);
    return extra.reply(
      `✅ *Auto-signal imewashwa*\n` +
        `⏱️ Timeframe: ${tfLabel(tf)}\n` +
        `💪 Nguvu ya chini: ${minStrength}%\n` +
        `💱 Jozi: ${mode === 'forex' ? DEFAULT_PAIRS.join(', ') : `mode "${mode}" (orodha kamili)`}\n` +
        (mode !== 'forex' && tf < 300 ? `⚠️ Orodha kubwa + timeframe fupi: scan inaweza kuchukua zaidi ya ${tfLabel(tf)}, baadhi ya candles zitarukwa. Tumia 5m au zaidi.\n` : '') +
        `_Signals ${MAX_PER_CYCLE} za juu tu kwa kila mzunguko._\n\n` +
        `_Itachanganua kila candle ikifungwa. Zima: .posignal auto off_\n` +
        `_Kumbuka: ikiwa bot itarestart, lazima uiwashe tena._`
    );
  }

  return extra.reply('❓ Tumia: .posignal auto on|off|status');
}

module.exports = {
  name: 'posignal',
  aliases: ['posig', 'posignals'],
  category: 'utility',
  description: 'Signals za Pocket Option (UP/DOWN) kwa kutumia candles za Pocket Option + backtest',
  usage:
    '.posignal <JOZI> [tf]  — mfano: .posignal EURUSD 1m\n' +
    '.posignal scan [forex|otc|real|all] [tf]\n' +
    '.posignal auto on [tf] [nguvu] [mode] | off | status (owner)',

  async execute(sock, msg, args, extra) {
    const jid = msg.key.remoteJid;
    const reply = extra?.reply || ((text) => sock.sendMessage(jid, { text }, { quoted: msg }));
    const ex = { ...extra, reply };

    if (!args[0]) {
      return reply(
        `❓ *Matumizi:*\n` +
          `• .posignal EURUSD — signal ya jozi moja\n` +
          `• .posignal EURUSD 5m — timeframe 5 dakika\n` +
          `• .posignal scan — jozi kuu (forex)\n` +
          `• .posignal scan otc — jozi ZOTE za OTC\n` +
          `• .posignal scan all 5m — jozi ZOTE (forex, OTC, dhahabu, crypto, indices, hisa)\n` +
          `• .posignal auto on 5m 70 otc — (owner) signals kiotomatiki`
      );
    }

    if (args[0].toLowerCase() === 'auto') return handleAuto(sock, jid, args.slice(1), ex);

    if (!(await isBridgeUp())) {
      return reply('❌ Pocket Option bridge haijaunganishwa kwa sasa. Angalia logs za bot / SSID.');
    }

    try {
      if (args[0].toLowerCase() === 'scan') {
        const { mode, tf } = parseModeTf(args.slice(1));
        if (!tf) return reply('❌ Timeframe si sahihi. Mfano: 1m, 5m.');
        const pairs = await getUniverse(mode);
        const slow = pairs.length > 20 ? ' — inaweza kuchukua hadi dakika 1-2 mara ya kwanza' : '';
        await reply(`🔎 Nachanganua jozi ${pairs.length} (${mode}, ${tfLabel(tf)})${slow}...`);
        const scan = await scanPairs(pairs, tf);
        return reply(formatScan(scan, tf));
      }

      const tf = parseTimeframe(args[1], 60);
      if (!tf) return reply('❌ Timeframe si sahihi. Mfano: 1m, 5m, 30s.');
      const result = await analyzePair(args[0], tf);
      return reply(formatSignal(result));
    } catch (err) {
      console.error('posignal error:', err.message);
      return reply(`❌ Imeshindwa kupata signal: ${err.message}`);
    }
  },
};
