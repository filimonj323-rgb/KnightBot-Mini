/**
 * pairing/pairingConfig.js
 *
 * Mipangilio ya admin / malipo / Abliner / Turso sasa inasomwa kutoka
 * RAILWAY ENVIRONMENT VARIABLES — hakuna siri iliyoandikwa kwenye code hii.
 * Weka kwenye Railway → Variables (Raw Editor). Angalia railway-vars.env.
 *
 * Thamani zinasomwa KILA zinapotumika (getters), kwa hiyo zile zinazorudishwa
 * kutoka Turso na pairing/envSync.js wakati wa boot (mfano ABLINER_API_KEY)
 * zinaonekana hapa pia.
 *
 * Zisizo siri (PLANS) zinabaki hapa kwa kuhaririwa moja kwa moja.
 */

const str = (name, def = '') => () => {
  const v = process.env[name];
  return v !== undefined && v !== '' ? v : def;
};
const num = (name, def) => () => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== '' && process.env[name] !== undefined ? n : def;
};

const cfg = {
  // ── Pricing packages (TZS) — { days, price }, mpangilio = mpangilio wa kuonyeshwa ──
  PLANS: [
    { days: 2, price: 500 },
    { days: 3, price: 600 },
    { days: 5, price: 800 },
    { days: 7, price: 1000 },
    { days: 10, price: 1500 },
    { days: 30, price: 3000 },
  ],
};

const getters = {
  // Turso (database) — LAZIMA ziwe Railway env (hazihifadhiwi Turso: zinahitajika kuifikia)
  TURSO_DATABASE_URL: str('TURSO_DATABASE_URL'),
  TURSO_AUTH_TOKEN: str('TURSO_AUTH_TOKEN'),

  // Admin dashboard login
  ADMIN_USERNAME: str('ADMIN_USERNAME'),
  ADMIN_PASSWORD: str('ADMIN_PASSWORD'),
  ADMIN_SESSION_SECRET: str('ADMIN_SESSION_SECRET'),

  // Trial / reminders
  TRIAL_DAYS: num('TRIAL_DAYS', 3),
  REMINDER_INTERVAL_HOURS: num('REMINDER_INTERVAL_HOURS', 78),
  TRIAL_WARNING_HOURS: num('TRIAL_WARNING_HOURS', 48),

  // Abliner (malipo ya USSD-push)
  ABLINER_API_KEY: str('ABLINER_API_KEY'),
  ABLINER_WEBHOOK_SECRET: str('ABLINER_WEBHOOK_SECRET'),
  ABLINER_BASE_URL: str('ABLINER_BASE_URL', 'https://abliner.net/api/v1'),

  // URLs za huduma
  PAIRING_BASE_URL: str('PAIRING_BASE_URL', 'https://botkuusite.up.railway.app'),
  MAIN_BOT_API_URL: str('MAIN_BOT_API_URL', 'https://botkuusite.up.railway.app'),
  // LAZIMA ilingane HASA na REMINDER_SECRET kwenye service ya index.js (la sivyo 403)
  MAIN_BOT_API_SECRET: str('MAIN_BOT_API_SECRET'),

  // Pairing code maalum (herufi 8 hasa A-Z0-9). Default 'UMOJASTA' imeandikwa kwenye code (si siri); Railway env CUSTOM_PAIRING_CODE bado inashinda.
  CUSTOM_PAIRING_CODE: str('CUSTOM_PAIRING_CODE', 'UMOJASTA'),
};
for (const [k, fn] of Object.entries(getters)) {
  Object.defineProperty(cfg, k, { get: fn, enumerable: true });
}

// Onyo la boot (majina tu, kamwe thamani): vinavyokosekana ni vya lazima.
const REQUIRED = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(`[config] Railway env vars zinazokosekana: ${missing.join(', ')} — weka kwenye Railway → Variables (angalia railway-vars.env).`);
}

module.exports = cfg;
