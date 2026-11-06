/**
 * Spotify Downloader - Search a song on Spotify and send the audio
 */

const axios = require('axios');

module.exports = {
  name: 'spotify',
  aliases: ['sp', 'spotifydl'],
  category: 'media',
  description: 'Search and download a song from Spotify',
  usage: '.spotify <song/artist/keywords>',

  async execute(sock, msg, args, extra) {
    try {
      const query = args.join(' ').trim();

      if (!query) {
        return await extra.reply('Usage: .spotify <song/artist/keywords>\nExample: .spotify con calma');
      }

      await sock.sendMessage(extra.from, { react: { text: '🔄', key: msg.key } });

      const apiUrl = `https://okatsu-rolezapiiz.vercel.app/search/spotify?q=${encodeURIComponent(query)}`;
      const { data } = await axios.get(apiUrl, {
        timeout: 20000,
        headers: { 'user-agent': 'Mozilla/5.0' }
      });

      if (!data?.status || !data?.result) {
        throw new Error('No result from Spotify API');
      }

      const r = data.result;
      const audioUrl = r.audio;
      if (!audioUrl) {
        return await extra.reply('No downloadable audio found for this query.');
      }

      const title = r.title || r.name || 'Unknown Title';
      const caption = `🎵 ${title}\n👤 ${r.artist || ''}\n⏱ ${r.duration || ''}\n🔗 ${r.url || ''}`.trim();

      if (r.thumbnails) {
        await sock.sendMessage(extra.from, { image: { url: r.thumbnails }, caption }, { quoted: msg });
      } else {
        await sock.sendMessage(extra.from, { text: caption }, { quoted: msg });
      }

      await sock.sendMessage(extra.from, {
        audio: { url: audioUrl },
        mimetype: 'audio/mpeg',
        fileName: `${(r.title || r.name || 'track').replace(/[\\/:*?"<>|]/g, '')}.mp3`
      }, { quoted: msg });
    } catch (error) {
      console.error('[SPOTIFY] error:', error?.message || error);
      await extra.reply('❌ Failed to fetch Spotify audio. Try another query later.');
    }
  }
};
