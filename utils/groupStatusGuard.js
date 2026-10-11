/**
 * Group Status Guard
 * Huzuia group status kujirudia (kujipost tena) wakati ujumbe wa amri
 * ule ule ukirudishwa na WhatsApp (reconnect / history sync / retry baada
 * ya masaa mengi). Amri ya groupstatus inaruhusiwa MARA MOJA tu kwa kila
 * message id, na tu kama ujumbe ni mpya.
 */

const MAX_AGE_MS = 2 * 60 * 1000;          // ujumbe wa amri lazima uwe wa dakika 2 zilizopita
const KEEP_MS = 48 * 60 * 60 * 1000;       // kumbuka ids kwa masaa 48 (> 24h ya status)

const used = new Map(); // msgId -> timestamp

function cleanup() {
  const now = Date.now();
  for (const [id, t] of used) if (now - t > KEEP_MS) used.delete(id);
}
setInterval(cleanup, 60 * 60 * 1000).unref?.();

/**
 * @returns {boolean} true = endelea kupost, false = ni rudio/ya zamani, ruka.
 */
function claim(msg) {
  const id = msg?.key?.id;
  if (!id) return true;

  const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp) || 0;
  if (ts && Date.now() - ts * 1000 > MAX_AGE_MS) {
    console.log(`[groupstatus-guard] ruka: ujumbe ${id} ni wa zamani`);
    return false;
  }
  if (used.has(id)) {
    console.log(`[groupstatus-guard] ruka: ujumbe ${id} umeshatumika`);
    return false;
  }
  used.set(id, Date.now());
  return true;
}

module.exports = { claim };
