/**
 * Pending Group Status Store
 * Inatunza (kwa muda) status (text/image/video) iliyoandaliwa na owner
 * akisubiri kubonyeza button ya kuchagua group - kwa command
 * ".gm groupstatus chagua ...". Data inafutwa baada ya TTL au baada
 * ya kutumika.
 */

const pending = new Map(); // key: sender jid -> { payload, timestamp }
const TTL_MS = 5 * 60 * 1000; // dakika 5

function set(sender, payload) {
  pending.set(sender, { payload, timestamp: Date.now() });
}

function get(sender) {
  const entry = pending.get(sender);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > TTL_MS) {
    pending.delete(sender);
    return null;
  }
  return entry.payload;
}

function clear(sender) {
  pending.delete(sender);
}

module.exports = { set, get, clear };
