/**
 * Anti-Delete Message Cache
 *
 * Small in-memory store that remembers recent messages so that when a
 * "delete for everyone" revoke notification arrives, handler.js can look
 * the original content back up and forward it to the bot owner.
 *
 * Scoped by `ownerKey` (sock.pairingOwnerId for a paired customer, or
 * '__main__' for the main bot) — same pattern as database.js's
 * runWithOwnerScope — so one process can safely run the main bot AND many
 * pairing/instanceManager.js customer instances at once without one
 * customer's cached messages leaking into another's, or into the main bot's.
 *
 * Deliberately independent from index.js's own `store` (which only serves
 * the main bot) so this works identically for pairing instances too,
 * without needing changes in index.js / instanceManager.js at all.
 */

const MAX_PER_CHAT = 30; // messages kept per chat, per owner (mirrors index.js's own store cap)

// ownerKey -> Map(chatJid -> Map(messageId -> msg))
const stores = new Map();

function getChatMap(ownerKey, chatJid) {
  let ownerStore = stores.get(ownerKey);
  if (!ownerStore) {
    ownerStore = new Map();
    stores.set(ownerKey, ownerStore);
  }
  let chatMap = ownerStore.get(chatJid);
  if (!chatMap) {
    chatMap = new Map();
    ownerStore.set(chatJid, chatMap);
  }
  return chatMap;
}

/** Cache a message. Ignores protocol/revoke notifications themselves. */
function cacheMessage(ownerKey, msg) {
  try {
    const chatJid = msg?.key?.remoteJid;
    const id = msg?.key?.id;
    if (!chatJid || !id || !msg.message) return;
    if (msg.message.protocolMessage) return; // hakuna haja ya ku-cache revoke notice yenyewe

    const chatMap = getChatMap(ownerKey || '__main__', chatJid);
    chatMap.set(id, msg);

    if (chatMap.size > MAX_PER_CHAT) {
      const oldestKey = chatMap.keys().next().value;
      chatMap.delete(oldestKey);
    }
  } catch (e) {
    // best-effort cache — never throw into the message handler
  }
}

/** Look up a previously cached message. Returns null if not found/expired. */
function getMessage(ownerKey, chatJid, id) {
  return stores.get(ownerKey || '__main__')?.get(chatJid)?.get(id) || null;
}

module.exports = { cacheMessage, getMessage };
