/**
 * Video Downloader - Download video from YouTube
 */

const yts = require('yt-search');
const APIs = require('../../utils/api');
const config = require('../../config');

module.exports = {
  name: 'ytvideo',
  aliases: ['ytv', 'ytmp4', 'ytvid', 'video'],
  category: 'media',
  description: 'Download video from YouTube',
  usage: '.video <video name or URL>',

  async execute(sock, msg, args) {
    try {
      // Get instance-specific config
      const instanceConfig = config;

      const text = args.join(' ');
      const chatId = msg.key.remoteJid;

      const searchQuery = text.trim();

      if (!searchQuery) {
        return await sock.sendMessage(chatId, {
          text: 'What video do you want to download?'
        }, { quoted: msg });
      }

      // Determine if input is a YouTube link
      let videoUrl = '';
      let videoTitle = '';
      let videoThumbnail = '';

      if (searchQuery.startsWith('http://') || searchQuery.startsWith('https://')) {
        videoUrl = searchQuery;
      } else {
        // Search YouTube for the video
        const { videos } = await yts(searchQuery);
        if (!videos || videos.length === 0) {
          return await sock.sendMessage(chatId, {
            text: 'No videos found!'
          }, { quoted: msg });
        }
        videoUrl = videos[0].url;
        videoTitle = videos[0].title;
        videoThumbnail = videos[0].thumbnail;
      }

      // Send thumbnail immediately
      try {
        const ytId = (videoUrl.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/) || [])[1];
        const thumb = videoThumbnail || (ytId ? `https://i.ytimg.com/vi/${ytId}/sddefault.jpg` : undefined);
        const captionTitle = videoTitle || searchQuery;
        if (thumb) {
          await sock.sendMessage(chatId, {
            image: { url: thumb },
            caption: `*${captionTitle}*\nDownloading...`
          }, { quoted: msg });
        }
      } catch (e) {
        console.error('[VIDEO] thumb error:', e?.message || e);
      }

      // Validate YouTube URL
      let urls = videoUrl.match(/(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|v\/|embed\/|shorts\/|playlist\?list=)?)([a-zA-Z0-9_-]{11})/gi);
      if (!urls) {
        return await sock.sendMessage(chatId, {
          text: 'This is not a valid YouTube link!'
        }, { quoted: msg });
      }

      // Njia ya moja kwa moja (bila API ya tatu) kwa kutumia wasitech/
      // @distube/ytdl-core — maktaba ile ile inayotumika kwenye .song.
      // Kikomo cha MB kinazuia buffer kubwa mno kujaza RAM ya container
      // (tofauti na njia za API ambazo Baileys inasoma URL moja kwa moja
      // bila kuhifadhi faili nzima kwenye kumbukumbu).
      async function downloadDirectYtdl(url) {
        let ytdl;
        try { ytdl = require('wasitech'); } catch (e) {
          try { ytdl = require('@distube/ytdl-core'); } catch (e2) { ytdl = null; }
        }
        if (!ytdl) throw new Error('ytdl haijasakinishwa');

        const MAX_BYTES = 45 * 1024 * 1024; // 45MB — kikomo salama cha RAM
        return new Promise((resolve, reject) => {
          const stream = ytdl(url, {
            quality: 'highest',
            filter: (format) => format.hasVideo && format.hasAudio,
            requestOptions: {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
              }
            }
          });
          const chunks = [];
          let total = 0;
          stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_BYTES) {
              stream.destroy();
              reject(new Error('Video ni kubwa mno kwa njia ya moja kwa moja'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length > 10000) resolve(buf);
            else reject(new Error('Buffer ndogo mno'));
          });
          stream.on('error', reject);
          setTimeout(() => reject(new Error('ytdl timeout')), 60000);
        });
      }

      // Jaribu njia ya moja kwa moja KWANZA (bila API ya tatu, hivyo
      // haiwezi kukwama kwa "402 Payment Required" kutoka Okatsu/Yupra/
      // EliteProTech). Ikishindwa (YouTube wakati mwingine ina-block server
      // IPs), inarudi kwenye mfuatano wa awali wa APIs bila kubadilika.
      let videoBuffer = null;
      let videoData = null;
      try {
        videoBuffer = await downloadDirectYtdl(videoUrl);
      } catch (eDirect) {
        try {
          videoData = await APIs.getEliteProTechVideoByUrl(videoUrl);
        } catch (e1) {
          try {
            videoData = await APIs.getYupraVideoByUrl(videoUrl);
          } catch (e2) {
            videoData = await APIs.getOkatsuVideoByUrl(videoUrl);
          }
        }
      }

      // Send video directly using the download URL
      await sock.sendMessage(chatId, {
        video: videoBuffer || { url: videoData.download },
        mimetype: 'video/mp4',
        fileName: `${((videoData && videoData.title) || videoTitle || 'video').replace(/[^\w\s-]/g, '')}.mp4`,
        caption: `*${(videoData && videoData.title) || videoTitle || 'Video'}*\n\n> *_Downloaded by ${instanceConfig.botName}_*`
      }, { quoted: msg });

    } catch (error) {
      console.error('[VIDEO] Command Error:', error?.message || error);
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'Download failed: ' + (error?.message || 'Unknown error')
      }, { quoted: msg });
    }
  }
};
