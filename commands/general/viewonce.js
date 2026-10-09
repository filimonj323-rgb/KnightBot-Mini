/**
 * ViewOnce Command - Reveal view-once messages
 */

const { downloadContentFromMessage } = global.__baileys;

module.exports = {
  name: 'viewonce',
  aliases: ['readvo', 'read', 'vv', 'readviewonce'],
  category: 'general',
  description: 'Reveal view-once messages (images/videos/audio)',
  usage: '.viewonce (reply to view-once message)',
  
  async execute(sock, msg, args) {
    try {
      const originChat = msg.key.remoteJid;
      // Results go to the bot's own DM (never to the chat where the command was typed)
      const chatId = (sock.user?.id || '').split(':')[0].split('@')[0] + '@s.whatsapp.net';

      // Delete the command message from the chat automatically
      const deleteCommand = async () => {
        try {
          await sock.sendMessage(originChat, { delete: msg.key });
        } catch (e) {
          console.error('Failed to delete viewonce command message:', e.message);
        }
      };

      // Try to get contextInfo from different message types (reply can be from text, image, video, etc.)
      const ctx = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.videoMessage?.contextInfo
        || msg.message?.buttonsResponseMessage?.contextInfo
        || msg.message?.listResponseMessage?.contextInfo;

      if (!ctx?.quotedMessage || !ctx?.stanzaId) {
        return await sock.sendMessage(
          chatId,
          { text: '🗑️ Reply to a *view-once* message to reveal it.' },
          {}
        ).finally(deleteCommand);
      }

      const quotedMsg = ctx.quotedMessage;

      // Check various patterns used for view-once messages
      const hasViewOnce =
        !!quotedMsg.viewOnceMessageV2 ||
        !!quotedMsg.viewOnceMessageV2Extension ||
        !!quotedMsg.viewOnceMessage ||
        !!quotedMsg.viewOnce ||
        !!quotedMsg?.imageMessage?.viewOnce ||
        !!quotedMsg?.videoMessage?.viewOnce ||
        !!quotedMsg?.audioMessage?.viewOnce;

      if (!hasViewOnce) {
        return await sock.sendMessage(
          chatId,
          { text: '❌ This is not a view-once message!' },
          {}
        ).finally(deleteCommand);
      }

      let actualMsg = null;
      let mtype = null;

      // Newer Baileys: viewOnceMessageV2Extension
      if (quotedMsg.viewOnceMessageV2Extension?.message) {
        actualMsg = quotedMsg.viewOnceMessageV2Extension.message;
        mtype = Object.keys(actualMsg)[0];

      // Classic Baileys: viewOnceMessageV2
      } else if (quotedMsg.viewOnceMessageV2?.message) {
        actualMsg = quotedMsg.viewOnceMessageV2.message;
        mtype = Object.keys(actualMsg)[0];

      // Older: viewOnceMessage
      } else if (quotedMsg.viewOnceMessage?.message) {
        actualMsg = quotedMsg.viewOnceMessage.message;
        mtype = Object.keys(actualMsg)[0];

      // Direct message with viewOnce flag on media
      } else if (quotedMsg.imageMessage?.viewOnce) {
        actualMsg = { imageMessage: quotedMsg.imageMessage };
        mtype = 'imageMessage';
      } else if (quotedMsg.videoMessage?.viewOnce) {
        actualMsg = { videoMessage: quotedMsg.videoMessage };
        mtype = 'videoMessage';
      } else if (quotedMsg.audioMessage?.viewOnce) {
        actualMsg = { audioMessage: quotedMsg.audioMessage };
        mtype = 'audioMessage';
      }

      if (!actualMsg || !mtype) {
        return await sock.sendMessage(
          chatId,
          { text: '❌ Unsupported view-once message type.' },
          {}
        ).finally(deleteCommand);
      }

      const downloadType =
        mtype === 'imageMessage'
          ? 'image'
          : mtype === 'videoMessage'
          ? 'video'
          : 'audio';

      const mediaStream = await downloadContentFromMessage(
        actualMsg[mtype],
        downloadType
      );

      let buffer = Buffer.from([]);
      for await (const chunk of mediaStream) {
        buffer = Buffer.concat([buffer, chunk]);
      }

      const caption = actualMsg[mtype]?.caption || '';

      if (/video/.test(mtype)) {
        await sock.sendMessage(
          chatId,
          {
            video: buffer,
            caption,
            mimetype: 'video/mp4'
          },
          {}
        );
      } else if (/image/.test(mtype)) {
        await sock.sendMessage(
          chatId,
          {
            image: buffer,
            caption,
            mimetype: 'image/jpeg'
          },
          {}
        );
      } else if (/audio/.test(mtype)) {
        await sock.sendMessage(
          chatId,
          {
            audio: buffer,
            ptt: true,
            mimetype: 'audio/ogg; codecs=opus'
          },
          {}
        );
      }

      await deleteCommand();
    } catch (error) {
      console.error('Error in viewonce command:', error);
      const dmJid = (sock.user?.id || '').split(':')[0].split('@')[0] + '@s.whatsapp.net';
      await sock.sendMessage(
        dmJid,
        {
          text:
            '❌ Error processing view-once message: ' +
            (error.message || 'Unknown error')
        },
        {}
      ).catch(() => {});
      await sock.sendMessage(msg.key.remoteJid, { delete: msg.key }).catch(() => {});
    }
  }
};
