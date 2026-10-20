// session-check.js — ukaguzi wa kusoma tu (read-only) wa sessions kwenye Turso.
// Flag iko ndani ya code (hakuna env var inayohitajika). Weka CHECK_ENABLED = false ukimaliza.
// (Railway env CHECK_SESSIONS=0 pia inazima.) Haibadilishi chochote.
const CHECK_ENABLED = true;
// Matokeo yanaonekana kwenye Railway logs, mistari inayoanza na [CHECK].
if (CHECK_ENABLED && process.env.CHECK_SESSIONS !== '0') {
  setTimeout(async () => {
    try {
      const { getClient, getAllSessionClients, sessionShardCount } = require('./lib/db');
      const mask = (id) => String(id).replace(/(\d{3})\d+(\d{2})$/, '$1****$2');
      const dump = async (label, client) => {
        try {
          const s = await client.execute(
            "SELECT session_id, length(state) AS creds_len, state LIKE '%\"registered\":true%' AS registered FROM wa_sessions ORDER BY session_id");
          console.log(`[CHECK] ${label}: sessions=${s.rows.length}`);
          for (const r of s.rows) {
            const k = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM wa_session_keys WHERE session_id = ?', args: [r.session_id] });
            console.log(`[CHECK]   ${mask(r.session_id)} | creds=${r.creds_len}B | registered=${r.registered ? 'NDIYO' : 'HAPANA'} | keys=${k.rows[0].n}`);
          }
        } catch (e) { console.log(`[CHECK] ${label}: kosa -> ${e.message}`); }
      };
      console.log(`[CHECK] shards zilizosomwa = ${sessionShardCount()}`);
      await dump('DATABASE KUU', getClient());
      if (sessionShardCount() > 0) {
        const all = getAllSessionClients();
        for (let i = 0; i < all.length; i++) await dump(`SHARD ${i + 1}`, all[i]);
      }
      console.log('[CHECK] imekamilika. Weka CHECK_ENABLED = false kwenye session-check.js.');
    } catch (e) { console.log('[CHECK] imeshindwa:', e.message); }
  }, 15000);
}
