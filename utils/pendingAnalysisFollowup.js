/**
 * Pending Analyze Follow-up Store
 *
 * Inatunza (kwa muda) muktadha (context) wa uchambuzi wa mwisho wa
 * ".analyze <symbol>" aliopewa mtumiaji, ili akibonyeza button
 * "❓ Uliza Swali Zaidi" au akiandika swali moja kwa moja (bila prefix),
 * bot iweze kujibu ikitumia data ile ile ya uchambuzi — bila kuomba tena
 * symbol au ku-fetch upya.
 *
 * Muundo:
 *   key: sender jid
 *   value: {
 *     context: { symbol, name, data, calc, ai, newsContext },
 *     awaitingQuestion: boolean,  // true = "ameshabonyeza button, ninasubiri
 *                                 //         aandike swali sasa"
 *     timestamp: number,
 *   }
 *
 * Data inafutwa baada ya TTL (dakika 10) au baada ya kutumika/kufutwa wazi.
 */

const pending = new Map();
const TTL_MS = 10 * 60 * 1000; // dakika 10

function set(sender, context) {
  pending.set(sender, { context, awaitingQuestion: false, timestamp: Date.now() });
}

function markAwaitingQuestion(sender) {
  const entry = pending.get(sender);
  if (!entry) return false;
  if (Date.now() - entry.timestamp > TTL_MS) {
    pending.delete(sender);
    return false;
  }
  entry.awaitingQuestion = true;
  entry.timestamp = Date.now(); // refresh TTL wakati wa mwingiliano
  return true;
}

function get(sender) {
  const entry = pending.get(sender);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    pending.delete(sender);
    return null;
  }
  return entry;
}

function isAwaitingQuestion(sender) {
  const entry = get(sender);
  return !!(entry && entry.awaitingQuestion);
}

function touch(sender) {
  const entry = pending.get(sender);
  if (entry) entry.timestamp = Date.now();
}

function clear(sender) {
  pending.delete(sender);
}

module.exports = { set, get, markAwaitingQuestion, isAwaitingQuestion, touch, clear };
