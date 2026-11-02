/**
 * start.js — entry point ya Railway.
 * Inarudisha env vars zilizohifadhiwa kwenye Turso (kama zipo) KABLA ya
 * index.js kupakia modules zinazosoma process.env wakati wa require.
 * Angalia pairing/envSync.js.
 */
const path = require('path');

// Fallback kwa host zisizo na Variables panel (mf. Bot-Hosting): soma faili la
// .env kama lipo. Haibadilishi env vars zilizopo tayari (Railway inashinda) na
// haifanyi chochote kama faili halipo — kwa hiyo Railway haiathiriki.
try {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_) { /* hakuna .env — sawa */ }

const { syncEnv } = require('./pairing/envSync');

syncEnv().then(() => {
  require('./index.js');
});
