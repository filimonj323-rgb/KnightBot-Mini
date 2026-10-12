/**
 * Video Downloader - Download video from YouTube
 */

const yts = require('yt-search');
const axios = require('axios');
const APIs = require('../../utils/api');
const config = require('../../config');

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '6302dd380amsh9115a6be5092cf2p1ca0e9jsn757c120ac58a';

// youtubei.js ni ESM-only → import() yenye cache. Inaiga mteja wa YouTube TV
// (kama mtu anayetazama kupitia TV) ili kupunguza kuzuiwa kwa "bot check".
let _ytiPromise = null;
function getInnertube() {
  if (!_ytiPromise) {
    _ytiPromise = import('youtubei.js')
      .then(({ Innertube }) => Innertube.create({ retrieve_player: true }))
      .catch((e) => { _ytiPromise = null; throw e; });
  }
  return _ytiPromise;
}

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

      const MAX_BYTES_YTI = 45 * 1024 * 1024; // kikomo salama cha RAM

      // Hatua 2: youtubei.js ikijifanya mteja wa TV (bila API ya tatu).
      async function downloadYoutubeiTV(url) {
        const id = (url.match(/(?:youtu\.be\/|v=|shorts\/)([a-zA-Z0-9_-]{11})/) || [])[1];
        if (!id) throw new Error('Video ID haipatikani');
        const yt = await getInnertube();
        const stream = await yt.download(id, {
          type: 'video+audio',
          quality: 'best',
          format: 'mp4',
          client: 'TV',
        });
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; reader.cancel().catch(() => {}); }, 90000);
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > MAX_BYTES_YTI) {
              await reader.cancel().catch(() => {});
              throw new Error('Video ni kubwa mno kwa njia ya moja kwa moja');
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          clearTimeout(timer);
        }
        if (timedOut) throw new Error('youtubei timeout');
        const buf = Buffer.concat(chunks);
        if (buf.length < 10000) throw new Error('Buffer ndogo mno');
        return buf;
      }

      // Hatua ya mwisho: RapidAPI youtube-mp36 — inatoa AUDIO (MP3) tu, si video.
      async function downloadMp36Audio(url) {
        const id = (url.match(/(?:youtu\.be\/|v=|shorts\/)([a-zA-Z0-9_-]{11})/) || [])[1];
        if (!id) throw new Error('Video ID haipatikani');
        const headers = { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com' };
        let link = null;
        for (let i = 0; i < 8 && !link; i++) {
          if (i > 0) await new Promise(r => setTimeout(r, 5000));
          const res = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', { params: { id }, headers, timeout: 30000 });
          link = res.data?.link || null;
          if (!link && res.data?.status !== 'processing') break;
        }
        if (!link) throw new Error('Hakuna link kutoka RapidAPI');
        const r = await axios.get(link, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_BYTES_YTI });
        const buf = Buffer.from(r.data);
        if (buf.length < 1000) throw new Error('Audio ndogo mno');
        return buf;
      }

      // Mfuatano: ytdl → youtubei (TV) → APIs za zamani → audio ya youtube-mp36.
      // Kila hatua inaandika kosa lake kwenye log ili tuone ipi inashindwa.
      let videoBuffer = null;
      let videoData = null;
      let audioBuffer = null;
      const errors = [];

      try { videoBuffer = await downloadDirectYtdl(videoUrl); }
      catch (e) { errors.push('ytdl: ' + (e?.message || e)); console.error('[VIDEO] ytdl failed:', e?.message || e); }

      if (!videoBuffer) {
        try { videoBuffer = await downloadYoutubeiTV(videoUrl); }
        catch (e) { errors.push('youtubei-TV: ' + (e?.message || e)); console.error('[VIDEO] youtubei TV failed:', e?.message || e); }
      }

      if (!videoBuffer) {
        const apiSteps = [
          ['EliteProTech', () => APIs.getEliteProTechVideoByUrl(videoUrl)],
          ['Yupra', () => APIs.getYupraVideoByUrl(videoUrl)],
          ['Okatsu', () => APIs.getOkatsuVideoByUrl(videoUrl)],
        ];
        for (const [name, fn] of apiSteps) {
          try { videoData = await fn(); if (videoData?.download) break; videoData = null; }
          catch (e) { errors.push(name + ': ' + (e?.message || e)); console.error('[VIDEO] ' + name + ' failed:', e?.message || e); }
        }
      }

      if (!videoBuffer && !videoData) {
        try { audioBuffer = await downloadMp36Audio(videoUrl); }
        catch (e) { errors.push('youtube-mp36: ' + (e?.message || e)); console.error('[VIDEO] mp36 failed:', e?.message || e); }
      }

      const finalTitle = ((videoData && videoData.title) || videoTitle || 'video');

      if (audioBuffer) {
        await sock.sendMessage(chatId, {
          text: '⚠️ Video imeshindikana kwa sasa (YouTube imezuia server). Nakutumia *audio* badala yake.'
        }, { quoted: msg });
        return await sock.sendMessage(chatId, {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          fileName: `${finalTitle.replace(/[^\w\s-]/g, '')}.mp3`,
        }, { quoted: msg });
      }

      if (!videoBuffer && !videoData) {
        throw new Error('Njia zote zimeshindwa. ' + errors.join(' | '));
      }

      await sock.sendMessage(chatId, {
        video: videoBuffer || { url: videoData.download },
        mimetype: 'video/mp4',
        fileName: `${finalTitle.replace(/[^\w\s-]/g, '')}.mp4`,
        caption: `*${finalTitle}*\n\n> *_Downloaded by ${instanceConfig.botName}_*`
      }, { quoted: msg });

    } catch (error) {
      console.error('[VIDEO] Command Error:', error?.message || error);
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'Download failed: ' + (error?.message || 'Unknown error')
      }, { quoted: msg });
    }
  }
};
