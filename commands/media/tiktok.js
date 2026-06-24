/**
 * TikTok Downloader - Download TikTok videos
 * Multiple APIs fallback
 */

const axios = require('axios');
const config = require('../../config');

// Prevent duplicate processing
const processedMessages = new Set();

// Extract TikTok URL from text
function extractTikTokUrl(text) {
  // Pattern inayogundua TikTok URLs zote (vm, vt, www, n.k)
  const pattern = /https?:\/\/(?:[a-z0-9]+\.)?tiktok\.com\/[^\s]*/i;
  const m = text.match(pattern);
  if (m) return m[0].replace(/[.,!?]+$/, ''); // Ondoa punctuation mwishoni
  return null;
}

// Download buffer kutoka URL
async function fetchBuffer(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'video/mp4,video/*,*/*;q=0.9',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.tiktok.com/'
  };

  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90000,
      maxContentLength: 150 * 1024 * 1024,
      headers
    });
    const buf = Buffer.from(r.data);
    if (buf.length > 1000) return buf;
  } catch (e) {}

  // Stream fallback
  const r2 = await axios.get(url, {
    responseType: 'stream',
    timeout: 90000,
    maxContentLength: 150 * 1024 * 1024,
    headers
  });
  const chunks = [];
  await new Promise((resolve, reject) => {
    r2.data.on('data', c => chunks.push(c));
    r2.data.on('end', resolve);
    r2.data.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (buf.length > 1000) return buf;
  return null;
}

module.exports = {
  name: 'tiktok',
  aliases: ['tt', 'ttdl', 'tiktokdl'],
  category: 'media',
  description: 'Download TikTok videos',
  usage: '.tiktok <TikTok URL>',

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;

    try {
      // Prevent duplicates
      if (processedMessages.has(msg.key.id)) return;
      processedMessages.add(msg.key.id);
      setTimeout(() => processedMessages.delete(msg.key.id), 5 * 60 * 1000);

      // Pata URL - soma message yote (command + link)
      const fullText = 
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        args.join(' ') || '';

      console.log('TikTok full text:', fullText);
      const url = extractTikTokUrl(fullText);
      console.log('TikTok extracted URL:', url);

      if (!url) {
        return await sock.sendMessage(chatId, {
          text: '❌ Tuma link ya TikTok!\n\nMfano: .tiktok https://vm.tiktok.com/xxxxx'
        }, { quoted: msg });
      }

      // React - inaonyesha inaprocess
      await sock.sendMessage(chatId, {
        react: { text: '⏳', key: msg.key }
      });

      const botName = config.botName?.toUpperCase() || 'MR. MEDIATOR';
      let videoUrl = null;
      let title = null;
      let success = false;

      // ══════════════════════════════════════
      // API 1: tikwm.com (Reliable sana - no watermark)
      // ══════════════════════════════════════
      if (!success) {
        try {
          console.log('TikTok API 1: tikwm...');
          const params = new URLSearchParams();
          params.append('url', url);
          params.append('count', '12');
          params.append('cursor', '0');
          params.append('web', '1');
          params.append('hd', '1');
          const res = await axios.post(
            'https://www.tikwm.com/api/',
            params.toString(),
            {
              headers: { 
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              timeout: 30000
            }
          );
          const data = res.data?.data;
          if (data?.play || data?.hdplay) {
            videoUrl = data.hdplay || data.play;
            title = data.title || '';
            console.log('API 1 got URL:', videoUrl?.slice(0, 60));

            const buf = await fetchBuffer(videoUrl);
            if (buf && buf.length > 1000) {
              await sock.sendMessage(chatId, {
                video: buf,
                mimetype: 'video/mp4',
                caption: `*DOWNLOADED BY ${botName}*${title ? `\n\n📝 ${title}` : ''}`
              }, { quoted: msg });
              success = true;
              console.log('✅ API 1 success!');
            }
          }
        } catch (e) {
          console.log('❌ API 1 failed:', e.message);
        }
      }

      // ══════════════════════════════════════
      // API 2: tiktokio.com (No watermark)
      // ══════════════════════════════════════
      if (!success) {
        try {
          console.log('TikTok API 2: tiktokio...');
          const res = await axios.post(
            'https://tiktokio.com/api/v1/tk-htmx',
            new URLSearchParams({ prefix: 'https://www.tiktok.com/', url }).toString(),
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://tiktokio.com',
                'Referer': 'https://tiktokio.com/',
                'HX-Request': 'true',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              timeout: 20000
            }
          );
          // Parse HTML response kupata download links
          const html = res.data || '';
          const dlMatch = html.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/);
          const dlUrl = dlMatch?.[1];
          if (dlUrl) {
            const buf = await fetchBuffer(dlUrl);
            if (buf && buf.length > 1000) {
              await sock.sendMessage(chatId, {
                video: buf,
                mimetype: 'video/mp4',
                caption: `*DOWNLOADED BY ${botName}*`
              }, { quoted: msg });
              success = true;
              console.log('✅ API 2 (tiktokio) success!');
            }
          }
        } catch (e) {
          console.log('❌ API 2 (tiktokio) failed:', e.message);
        }
      }


      // ══════════════════════════════════════
      // API 3: musicaldown.com (Free - no watermark)
      // ══════════════════════════════════════
      if (!success) {
        try {
          console.log('TikTok API 3: musicaldown...');
          const res1 = await axios.post(
            'https://musicaldown.com/api/request',
            { link: url },
            {
              headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://musicaldown.com',
                'Referer': 'https://musicaldown.com/'
              },
              timeout: 20000
            }
          );
          const dlUrl = res1.data?.links?.[0]?.url || res1.data?.url;
          if (dlUrl) {
            const buf = await fetchBuffer(dlUrl);
            if (buf && buf.length > 1000) {
              await sock.sendMessage(chatId, {
                video: buf,
                mimetype: 'video/mp4',
                caption: `*DOWNLOADED BY ${botName}*`
              }, { quoted: msg });
              success = true;
              console.log('✅ API 7 success!');
            }
          }
        } catch (e) {
          console.log('❌ API 7 failed:', e.message);
        }
      }

      // ══════════════════════════════════════
      // API 4: gifted-dls (kutoka package)
      // ══════════════════════════════════════
      if (!success) {
        try {
          console.log('TikTok API 4: gifted-dls...');
          const { tiktok } = require('gifted-dls');
          const result = await tiktok(url);
          const dlUrl = result?.video || result?.url || result?.nowm;
          if (dlUrl) {
            const buf = await fetchBuffer(dlUrl);
            if (buf && buf.length > 1000) {
              await sock.sendMessage(chatId, {
                video: buf,
                mimetype: 'video/mp4',
                caption: `*DOWNLOADED BY ${botName}*${result?.title ? `\n\n📝 ${result.title}` : ''}`
              }, { quoted: msg });
              success = true;
              console.log('✅ API 7 success!');
            }
          }
        } catch (e) {
          console.log('❌ API 7 failed:', e.message);
        }
      }

      // ══════════════════════════════════════
      // API 5: api-dylux
      // ══════════════════════════════════════
      if (!success) {
        try {
          console.log('TikTok API 5: api-dylux...');
          const apiDylux = require('api-dylux');
          const result = await apiDylux.tiktok?.(url) || await apiDylux.ttdl?.(url);
          const dlUrl = result?.video || result?.url || result?.nowm || result?.download;
          if (dlUrl) {
            const buf = await fetchBuffer(dlUrl);
            if (buf && buf.length > 1000) {
              await sock.sendMessage(chatId, {
                video: buf,
                mimetype: 'video/mp4',
                caption: `*DOWNLOADED BY ${botName}*`
              }, { quoted: msg });
              success = true;
              console.log('✅ API 7 success!');
            }
          }
        } catch (e) {
          console.log('❌ API 7 failed:', e.message);
        }
      }

      // ══════════════════════════════════════
      // API 6: snaptik.app (Free)
      // ══════════════════════════════════════
      if (!success) {
        try {
          console.log('TikTok API 6: snaptik...');
          const res = await axios.post(
            'https://snaptik.app/abc2.php',
            `url=${encodeURIComponent(url)}`,
            {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Origin': 'https://snaptik.app',
                'Referer': 'https://snaptik.app/'
              },
              timeout: 20000
            }
          );
          const dlUrl = res.data?.data?.['no-watermark'] || res.data?.data?.normal;
          if (dlUrl) {
            const buf = await fetchBuffer(dlUrl);
            if (buf && buf.length > 1000) {
              await sock.sendMessage(chatId, {
                video: buf,
                mimetype: 'video/mp4',
                caption: `*DOWNLOADED BY ${botName}*`
              }, { quoted: msg });
              success = true;
              console.log('✅ API 7 success!');
            }
          }
        } catch (e) {
          console.log('❌ API 7 failed:', e.message);
        }
      }

      // ══════════════════════════════════════
      // API 7: cobalt.tools (Free)
      // ══════════════════════════════════════
      if (!success) {
        try {
          console.log('TikTok API 7: cobalt.tools...');
          const https = require('https');
          const agent = new https.Agent({ rejectUnauthorized: false });
          const res = await axios.post(
            'https://cobalt.api.timelessnesses.me/api/json',
            { url, vCodec: 'h264', vQuality: '720', isAudioOnly: false },
            {
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              timeout: 30000,
              httpsAgent: agent
            }
          );
          const dlUrl = res.data?.url;
          if (dlUrl) {
            const buf = await fetchBuffer(dlUrl);
            if (buf && buf.length > 1000) {
              await sock.sendMessage(chatId, {
                video: buf,
                mimetype: 'video/mp4',
                caption: `*DOWNLOADED BY ${botName}*`
              }, { quoted: msg });
              success = true;
              console.log('✅ API 7 success!');
            }
          }
        } catch (e) {
          console.log('❌ API 7 failed:', e.message);
        }
      }

      // ══════════════════════════════════════
      // Zote zimefail
      // ══════════════════════════════════════
      if (!success) {
        await sock.sendMessage(chatId, {
          react: { text: '❌', key: msg.key }
        });
        return await sock.sendMessage(chatId, {
          text: '❌ Imeshindwa kudownload video hii.\n\nJaribu:\n• Link nyingine\n• Baadaye kidogo'
        }, { quoted: msg });
      }

      // React success
      await sock.sendMessage(chatId, {
        react: { text: '✅', key: msg.key }
      });

    } catch (err) {
      console.error('TikTok command error:', err);
      await sock.sendMessage(chatId, {
        text: '❌ Hitilafu imetokea. Jaribu tena baadaye.'
      }, { quoted: msg });
    }
  }
};
