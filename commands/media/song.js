/**
 * Song Downloader - Download audio from YouTube
 * Uses: gifted-dls, api-dylux, wasitech (ytdl-core), axios fallbacks
 */

const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { toAudio } = require('../../utils/converter');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Packages kutoka Demon-Slayer
let giftedDls, apiDylux, ytdl;
try { giftedDls = require('gifted-dls'); } catch (e) { giftedDls = null; }
try { apiDylux = require('api-dylux'); } catch (e) { apiDylux = null; }
try { ytdl = require('wasitech'); } catch (e) {
  try { ytdl = require('@distube/ytdl-core'); } catch (e2) { ytdl = null; }
}

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '6302dd380amsh9115a6be5092cf2p1ca0e9jsn757c120ac58a';

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([^&\s]{11})/,
    /(?:youtu\.be\/)([^?\s]{11})/,
    /(?:youtube\.com\/shorts\/)([^?\s]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

// Fetch buffer kutoka URL - arraybuffer kisha stream
async function fetchBuffer(url, extraHeaders = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    ...extraHeaders
  };

  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 90000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      validateStatus: s => s >= 200 && s < 400,
      headers
    });
    const buf = Buffer.from(r.data);
    if (buf.length > 1000) return buf;
  } catch (e) {
    if (e.response?.status === 451) throw new Error('blocked_451');
  }

  // Stream fallback
  const r2 = await axios.get(url, {
    responseType: 'stream',
    timeout: 90000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    validateStatus: s => s >= 200 && s < 400,
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
  name: 'song',
  aliases: ['play', 'music', 'yta'],
  category: 'media',
  description: 'Download audio from YouTube',
  usage: '.song <song name or YouTube link>',

  async execute(sock, msg, args) {
    try {
      const text = args.join(' ');
      const chatId = msg.key.remoteJid;

      if (!text) {
        return await sock.sendMessage(chatId, {
          text: '🎵 Tumia: .song <jina la wimbo au YouTube link>\n\nMfano: .song Marioo Pombe'
        }, { quoted: msg });
      }

      let video;
      if (text.includes('youtube.com') || text.includes('youtu.be')) {
        video = { url: text, title: text, timestamp: '' };
      } else {
        const search = await yts(text);
        if (!search?.videos?.length) {
          return await sock.sendMessage(chatId, {
            text: '❌ Wimbo haukupatikana. Jaribu jina tofauti.'
          }, { quoted: msg });
        }
        video = search.videos[0];
      }

      const videoId = extractVideoId(video.url);
      if (!videoId) {
        return await sock.sendMessage(chatId, {
          text: '❌ YouTube URL si sahihi.'
        }, { quoted: msg });
      }

      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

      await sock.sendMessage(chatId, {
        image: { url: video.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` },
        caption: `🎵 Downloading: *${video.title}*\n⏱ Duration: ${video.timestamp || ''}`
      }, { quoted: msg });

      let audioBuffer = null;
      let downloadSuccess = false;

      // ══════════════════════════════════════════════
      // METHOD 1: gifted-dls (kutoka Demon-Slayer)
      // Inasupport YouTube, TikTok, Instagram na zaidi
      // ══════════════════════════════════════════════
      async function downloadWithGiftedDls() {
        if (!giftedDls) throw new Error('gifted-dls not installed');
        const result = await giftedDls.youtube.mp3(videoUrl);
        const dlUrl = result?.url || result?.download || result?.audio;
        if (!dlUrl) throw new Error('No URL from gifted-dls');
        return await fetchBuffer(dlUrl);
      }

      // ══════════════════════════════════════════════
      // METHOD 2: api-dylux (kutoka Demon-Slayer)
      // ══════════════════════════════════════════════
      async function downloadWithApiDylux() {
        if (!apiDylux) throw new Error('api-dylux not installed');
        const result = await apiDylux.ytmp3(videoUrl);
        const dlUrl = result?.url || result?.download || result?.link;
        if (!dlUrl) throw new Error('No URL from api-dylux');
        return await fetchBuffer(dlUrl);
      }

      // ══════════════════════════════════════════════
      // METHOD 3: wasitech/@distube/ytdl-core (high quality)
      // Moja kwa moja kutoka YouTube
      // ══════════════════════════════════════════════
      async function downloadWithYtdlHigh() {
        if (!ytdl) throw new Error('ytdl not installed');
        return new Promise((resolve, reject) => {
          const stream = ytdl(videoUrl, {
            quality: 'highestaudio',
            filter: 'audioonly',
            requestOptions: {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
              }
            }
          });
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length > 1000) resolve(buf);
            else reject(new Error('Buffer too small'));
          });
          stream.on('error', reject);
          setTimeout(() => reject(new Error('ytdl timeout')), 60000);
        });
      }

      // ══════════════════════════════════════════════
      // METHOD 4: wasitech/@distube/ytdl-core (low quality)
      // ══════════════════════════════════════════════
      async function downloadWithYtdlLow() {
        if (!ytdl) throw new Error('ytdl not installed');
        return new Promise((resolve, reject) => {
          const stream = ytdl(videoUrl, {
            quality: 'lowestaudio',
            filter: 'audioonly',
            requestOptions: {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              }
            }
          });
          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (buf.length > 1000) resolve(buf);
            else reject(new Error('Buffer too small'));
          });
          stream.on('error', reject);
          setTimeout(() => reject(new Error('ytdl timeout')), 60000);
        });
      }

      // ══════════════════════════════════════════════
      // METHOD 5: RapidAPI youtube-mp36
      // ══════════════════════════════════════════════
      async function downloadWithRapidAPI() {
        const res = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
          params: { id: videoId },
          headers: {
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com'
          },
          timeout: 30000
        });

        let dlUrl = res.data?.link;

        if (!dlUrl && res.data?.status === 'processing') {
          for (let i = 0; i < 8; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const poll = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
              params: { id: videoId },
              headers: {
                'x-rapidapi-key': RAPIDAPI_KEY,
                'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com'
              },
              timeout: 30000
            });
            if (poll.data?.link) { dlUrl = poll.data.link; break; }
          }
        }

        if (!dlUrl) throw new Error('No link from RapidAPI');
        const buf = await fetchBuffer(dlUrl);
        if (!buf || buf.length < 1000) throw new Error(`Too small: ${buf?.length} bytes`);
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 6: OceanSaver (Free)
      // ══════════════════════════════════════════════
      async function downloadWithOceanSaver() {
        const res = await axios.get(
          `https://p.oceansaver.in/ajax/download.php?format=mp3&url=${encodeURIComponent(videoUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`,
          { timeout: 30000 }
        );
        if (!res.data?.dlink) throw new Error('No link from OceanSaver');
        const buf = await fetchBuffer(res.data.dlink);
        if (!buf || buf.length < 1000) throw new Error('Too small from OceanSaver');
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 7: Cobalt.tools (Free)
      // ══════════════════════════════════════════════
      async function downloadWithCobalt() {
        const res = await axios.post(
          'https://cobalt.api.timelessnesses.me/api/json',
          { url: videoUrl, aFormat: 'mp3', isAudioOnly: true },
          {
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            timeout: 30000
          }
        );
        const dlUrl = res.data?.url;
        if (!dlUrl) throw new Error('No URL from Cobalt');
        const buf = await fetchBuffer(dlUrl);
        if (!buf || buf.length < 1000) throw new Error('Too small from Cobalt');
        return buf;
      }

      // ══════════════════════════════════════════════
      // METHOD 8: Vevioz (Free)
      // ══════════════════════════════════════════════
      async function downloadWithVevioz() {
        const res = await axios.get(
          `https://api.vevioz.com/ytdown?url=${encodeURIComponent(videoUrl)}&type=audio`,
          { timeout: 30000 }
        );
        if (!res.data?.download_url) throw new Error('No URL from Vevioz');
        const buf = await fetchBuffer(res.data.download_url);
        if (!buf || buf.length < 1000) throw new Error('Too small from Vevioz');
        return buf;
      }

      // ══════════════════════════════════════════════
      // FALLBACK CHAIN - Jaribu kila method
      // ══════════════════════════════════════════════
      const downloadMethods = [
        { name: 'gifted-dls', fn: downloadWithGiftedDls },
        { name: 'api-dylux', fn: downloadWithApiDylux },
        { name: 'ytdl-core (high quality)', fn: downloadWithYtdlHigh },
        { name: 'ytdl-core (low quality)', fn: downloadWithYtdlLow },
        { name: 'RapidAPI youtube-mp36', fn: downloadWithRapidAPI },
        { name: 'OceanSaver API', fn: downloadWithOceanSaver },
        { name: 'Cobalt.tools', fn: downloadWithCobalt },
        { name: 'Vevioz API', fn: downloadWithVevioz },
      ];

      for (const method of downloadMethods) {
        try {
          console.log(`Trying: ${method.name}`);
          audioBuffer = await method.fn();
          if (audioBuffer?.length > 1000) {
            downloadSuccess = true;
            console.log(`✅ Success: ${method.name} (${audioBuffer.length} bytes)`);
            break;
          }
        } catch (err) {
          console.log(`❌ ${method.name} failed:`, err.message);
        }
      }

      if (!downloadSuccess || !audioBuffer) {
        throw new Error('All download sources failed. The content may be unavailable or blocked in your region.');
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('Downloaded audio buffer is empty');
      }

      // ══════════════════════════════════════════════
      // Detect format kutoka file signature
      // ══════════════════════════════════════════════
      const firstBytes = audioBuffer.slice(0, 12);
      const hexSignature = firstBytes.toString('hex');
      const asciiSignature = firstBytes.toString('ascii', 4, 8);

      let fileExtension = 'mp3';
      let finalMimetype = 'audio/mpeg';
      let detectedFormat = 'MP3';

      if (asciiSignature === 'ftyp' || hexSignature.startsWith('000000')) {
        const ftypBox = audioBuffer.slice(4, 8).toString('ascii');
        if (ftypBox === 'ftyp') {
          detectedFormat = 'M4A/MP4';
          finalMimetype = 'audio/mp4';
          fileExtension = 'm4a';
        }
      } else if (
        audioBuffer.toString('ascii', 0, 3) === 'ID3' ||
        (audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0)
      ) {
        detectedFormat = 'MP3';
        finalMimetype = 'audio/mpeg';
        fileExtension = 'mp3';
      } else if (audioBuffer.toString('ascii', 0, 4) === 'OggS') {
        detectedFormat = 'OGG';
        finalMimetype = 'audio/ogg; codecs=opus';
        fileExtension = 'ogg';
      } else if (audioBuffer.toString('ascii', 0, 4) === 'RIFF') {
        detectedFormat = 'WAV';
        finalMimetype = 'audio/wav';
        fileExtension = 'wav';
      } else {
        detectedFormat = 'M4A';
        finalMimetype = 'audio/mp4';
        fileExtension = 'm4a';
      }

      console.log(`Detected: ${detectedFormat} (${audioBuffer.length} bytes)`);

      // ══════════════════════════════════════════════
      // Convert to MP3 kama si MP3 tayari
      // ══════════════════════════════════════════════
      let finalBuffer = audioBuffer;
      let finalExtension = 'mp3';

      if (fileExtension !== 'mp3') {
        try {
          finalBuffer = await toAudio(audioBuffer, fileExtension);
          if (!finalBuffer || finalBuffer.length === 0) {
            throw new Error('Conversion returned empty buffer');
          }
          finalMimetype = 'audio/mpeg';
          finalExtension = 'mp3';
          console.log(`Converted ${detectedFormat} → MP3 (${finalBuffer.length} bytes)`);
        } catch (convErr) {
          throw new Error(`Failed to convert ${detectedFormat} to MP3: ${convErr.message}`);
        }
      }

      // ══════════════════════════════════════════════
      // Tuma audio
      // ══════════════════════════════════════════════
      await sock.sendMessage(chatId, {
        audio: finalBuffer,
        mimetype: finalMimetype,
        fileName: `${(video.title || 'song').replace(/[^\w\s-]/g, '')}.${finalExtension}`,
        ptt: false
      }, { quoted: msg });

      // ══════════════════════════════════════════════
      // Cleanup temp files
      // ══════════════════════════════════════════════
      try {
        const tempDir = path.join(__dirname, '../../temp');
        if (fs.existsSync(tempDir)) {
          const files = fs.readdirSync(tempDir);
          const now = Date.now();
          files.forEach(file => {
            const filePath = path.join(tempDir, file);
            try {
              const stats = fs.statSync(filePath);
              if (now - stats.mtimeMs > 10000) {
                if (file.endsWith('.mp3') || file.endsWith('.m4a') || /^\d+\.(mp3|m4a)$/.test(file)) {
                  fs.unlinkSync(filePath);
                }
              }
            } catch (e) {}
          });
        }
      } catch (cleanupErr) {}

    } catch (err) {
      console.error('Song command error:', err);
      let errorMessage = '❌ Failed to download song.';
      if (err.message?.includes('blocked')) {
        errorMessage = '❌ Download blocked. The content may be unavailable in your region.';
      } else if (err.response?.status === 451 || err.status === 451) {
        errorMessage = '❌ Content unavailable (451). Regional restrictions apply.';
      } else if (err.message?.includes('All download sources failed')) {
        errorMessage = '❌ All download sources failed. Jaribu wimbo mwingine.';
      }
      await sock.sendMessage(msg.key.remoteJid, { text: errorMessage }, { quoted: msg });
    }
  }
};
