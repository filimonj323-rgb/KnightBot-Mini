/**
 * Song Downloader - Download audio from YouTube
 * Multiple fallback methods
 */

const yts = require('yt-search');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const ytdl = require('@distube/ytdl-core');
const { toAudio } = require('../../utils/converter');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

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

// Download buffer kutoka URL - jaribu arraybuffer kisha stream
async function fetchBuffer(url, extraHeaders = {}) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    ...extraHeaders
  };

  // Jaribu arraybuffer kwanza
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
    if (buf.length > 0) return buf;
  } catch (e) {
    if (e.response?.status === 451) throw new Error('blocked_451');
    // Jaribu stream mode kama arraybuffer imefail
  }

  // Stream mode fallback
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
  if (buf.length > 0) return buf;
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
          text: 'Usage: .song <song name or YouTube link>'
        }, { quoted: msg });
      }

      let video;
      if (text.includes('youtube.com') || text.includes('youtu.be')) {
        video = { url: text };
      } else {
        const search = await yts(text);
        if (!search?.videos?.length) {
          return await sock.sendMessage(chatId, {
            text: '❌ No results found.'
          }, { quoted: msg });
        }
        video = search.videos[0];
      }

      const videoId = extractVideoId(video.url);
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

      // Inform user
      await sock.sendMessage(chatId, {
        image: { url: video.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` },
        caption: `🎵 Downloading: *${video.title}*\n⏱ Duration: ${video.timestamp || ''}`
      }, { quoted: msg });

      let audioBuffer = null;
      let downloadSuccess = false;

      // ══════════════════════════════════════════════
      // METHOD 1: @distube/ytdl-core (highest quality)
      // ══════════════════════════════════════════════
      async function downloadWithYtdl() {
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
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', reject);
        });
      }

      // ══════════════════════════════════════════════
      // METHOD 2: @distube/ytdl-core (lowest quality fallback)
      // ══════════════════════════════════════════════
      async function downloadWithYtdlLow() {
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
          stream.on('end', () => resolve(Buffer.concat(chunks)));
          stream.on('error', reject);
        });
      }

      // ══════════════════════════════════════════════
      // METHOD 3: youtube-mp36 RapidAPI
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

        // Poll kama bado inachakata
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

        if (!dlUrl) throw new Error('No download link from RapidAPI');

        // Jaribu moja kwa moja kwanza
        try {
          return await fetchBuffer(dlUrl);
        } catch (e) {
          // Jaribu kupitia proxy
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(dlUrl)}`;
          return await fetchBuffer(proxyUrl);
        }
      }

      // ══════════════════════════════════════════════
      // METHOD 4: oceansaver API (Free)
      // ══════════════════════════════════════════════
      async function downloadWithOceanSaver() {
        const api = `https://p.oceansaver.in/ajax/download.php?format=mp3&url=${encodeURIComponent(videoUrl)}&api=dfcb6d76f2f6a9894gjkege8a4ab232222`;
        const resp = await axios.get(api, { timeout: 30000 });
        if (!resp.data?.dlink) throw new Error('No download link from oceansaver');
        return await fetchBuffer(resp.data.dlink);
      }

      // ══════════════════════════════════════════════
      // METHOD 5: cobalt.tools (Free)
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
        if (!dlUrl) throw new Error('No URL from cobalt');
        return await fetchBuffer(dlUrl);
      }

      // ══════════════════════════════════════════════
      // METHOD 6: vevioz API (Free)
      // ══════════════════════════════════════════════
      async function downloadWithVevioz() {
        const res = await axios.get(
          `https://api.vevioz.com/ytdown?url=${encodeURIComponent(videoUrl)}&type=audio`,
          { timeout: 30000 }
        );
        if (!res.data?.download_url) throw new Error('No download URL from vevioz');
        return await fetchBuffer(res.data.download_url);
      }

      // ══════════════════════════════════════════════
      // FALLBACK CHAIN - Jaribu kila method
      // ══════════════════════════════════════════════
      const downloadMethods = [
        { name: 'ytdl-core (high quality)', fn: downloadWithYtdl },
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
          if (audioBuffer?.length > 0) {
            downloadSuccess = true;
            console.log(`✅ Success: ${method.name} (${audioBuffer.length} bytes)`);
            break;
          }
        } catch (err) {
          console.log(`❌ ${method.name} failed:`, err.message);
        }
      }

      // Zote zimefail
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

      let actualMimetype = 'audio/mpeg';
      let fileExtension = 'mp3';
      let detectedFormat = 'unknown';

      if (asciiSignature === 'ftyp' || hexSignature.startsWith('000000')) {
        const ftypBox = audioBuffer.slice(4, 8).toString('ascii');
        if (ftypBox === 'ftyp') {
          detectedFormat = 'M4A/MP4';
          actualMimetype = 'audio/mp4';
          fileExtension = 'm4a';
        }
      } else if (
        audioBuffer.toString('ascii', 0, 3) === 'ID3' ||
        (audioBuffer[0] === 0xFF && (audioBuffer[1] & 0xE0) === 0xE0)
      ) {
        detectedFormat = 'MP3';
        actualMimetype = 'audio/mpeg';
        fileExtension = 'mp3';
      } else if (audioBuffer.toString('ascii', 0, 4) === 'OggS') {
        detectedFormat = 'OGG/Opus';
        actualMimetype = 'audio/ogg; codecs=opus';
        fileExtension = 'ogg';
      } else if (audioBuffer.toString('ascii', 0, 4) === 'RIFF') {
        detectedFormat = 'WAV';
        actualMimetype = 'audio/wav';
        fileExtension = 'wav';
      } else {
        actualMimetype = 'audio/mp4';
        fileExtension = 'm4a';
        detectedFormat = 'Unknown (defaulting to M4A)';
      }

      // ══════════════════════════════════════════════
      // Convert to MP3 kama si MP3 tayari
      // ══════════════════════════════════════════════
      let finalBuffer = audioBuffer;
      let finalMimetype = 'audio/mpeg';
      let finalExtension = 'mp3';

      if (fileExtension !== 'mp3') {
        try {
          finalBuffer = await toAudio(audioBuffer, fileExtension);
          if (!finalBuffer || finalBuffer.length === 0) {
            throw new Error('Conversion returned empty buffer');
          }
          finalMimetype = 'audio/mpeg';
          finalExtension = 'mp3';
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
        errorMessage = '❌ Download blocked. The content may be unavailable in your region or due to legal restrictions.';
      } else if (err.response?.status === 451 || err.status === 451) {
        errorMessage = '❌ Content unavailable (451). This may be due to legal restrictions or regional blocking.';
      } else if (err.message?.includes('All download sources failed')) {
        errorMessage = '❌ All download sources failed. The content may be unavailable or blocked.';
      }

      await sock.sendMessage(msg.key.remoteJid, {
        text: errorMessage
      }, { quoted: msg });
    }
  }
};
