/**
 * start.js — entry point ya Railway.
 * Inarudisha env vars zilizohifadhiwa kwenye Turso (kama zipo) KABLA ya
 * index.js kupakia modules zinazosoma process.env wakati wa require.
 * Angalia pairing/envSync.js.
 */
const { syncEnv } = require('./pairing/envSync');

syncEnv().then(() => {
  require('./index.js');
});
