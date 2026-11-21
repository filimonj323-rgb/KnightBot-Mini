'use strict';
// Marekebisho ya Auto Status (view/react) yanayotokana na mabadiliko ya WhatsApp:
//  1) WhatsApp sasa hutuma status kama stanza ya juu <status> (si <message>). Baileys
//     haiiakki -> seva hufunga stream ~dakika 50 baadaye, na bot inabaki "open" lakini
//     haipokei kitu (Baileys #2858/#2866). Tunai-ack wenyewe hapa.
//  2) readMessages() hubadilisha receipt kuwa 'read-self' pale privacy ya read receipts
//     si "everyone" -> mwenye status haoni kuwa umeiona. Tunatuma receipt ya 'read'
//     moja kwa moja kwa mwenye status (RedxBaileys PR #22).

function installStatusAck(sock, tag = 'bot') {
  if (!sock?.ws?.on || sock.__statusAckInstalled) return;
  sock.__statusAckInstalled = true;
  let n = 0;
  sock.ws.on('CB:status', (node) => {
    try {
      const a = node?.attrs || {};
      if (!a.id || !a.from) return;
      const attrs = { id: a.id, to: a.from, class: 'status' };
      if (a.type) attrs.type = a.type;
      if (a.participant) attrs.participant = a.participant;
      Promise.resolve(sock.sendNode({ tag: 'ack', attrs })).then(() => {
        if (n++ < 5) console.log(`[${tag}] ✅ <status> stanza imetumiwa ack (id=${a.id})`);
      }).catch((e) => console.error(`[${tag}] ❌ ack ya <status> imeshindwa:`, e.message));
    } catch (e) { console.error(`[${tag}] ack <status> error:`, e.message); }
  });
}

// Onyesha mwenye status kuwa umeiona. Jaribu receipt ya moja kwa moja kwanza,
// kisha readMessages() kama akiba.
async function viewStatus(sock, key) {
  const author = key.participant || key.participantAlt;
  if (author && typeof sock.sendReceipt === 'function') {
    try {
      await sock.sendReceipt('status@broadcast', author, [key.id], 'read');
      return 'receipt';
    } catch (e) {
      console.warn('⚠️ sendReceipt(read) ya status imeshindwa, najaribu readMessages:', e.message);
    }
  }
  await sock.readMessages([key]);
  return 'readMessages';
}

module.exports = { installStatusAck, viewStatus };
