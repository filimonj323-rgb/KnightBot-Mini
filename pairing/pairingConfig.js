/**
 * pairing/pairingConfig.js
 *
 * All admin/billing/ClickPesa settings hardcoded here instead of Railway
 * environment variables — EDIT THE VALUES BELOW DIRECTLY.
 *
 * ⚠️ SECURITY WARNING: because these values live in code instead of
 * Railway env vars, they will be visible to anyone who can see this repo
 * (e.g. if it's a public GitHub repo, or anyone you share the zip/code
 * with). Do NOT commit this file to a public repository. If your repo is
 * public, at minimum add "pairing/pairingConfig.js" to .gitignore and only
 * keep it on your local machine / Railway's file system directly.
 */

module.exports = {
  // ── Admin dashboard login ────────────────────────────────────────────
  ADMIN_USERNAME: 'mbowe1',
  ADMIN_PASSWORD: 'Mbowe@1963',   // BADILISHA HII
  ADMIN_SESSION_SECRET: 'LawamaFilimonNtigamagwa',

  // ── Free trial ────────────────────────────────────────────────────────
  TRIAL_DAYS: 3,

  // ── Pricing packages ──────────────────────────────────────────────────
  // Shown on the customer dashboard's "Malipo" tab. Edit freely — each
  // entry is { days, price } in TZS. Order here = display order.
  PLANS: [
    { days: 1, price: 500 },
    { days: 3, price: 1000 },
    { days: 5, price: 2000 },
    { days: 7, price: 4000 },
    { days: 10, price: 5000 },
    { days: 30, price: 7000 },
  ],

  // How often (in hours) a customer whose trial/subscription has expired
  // gets a WhatsApp reminder with the payment link, until they pay.
  REMINDER_INTERVAL_HOURS: 24,

  // ── ClickPesa (Dashboard -> Settings -> Developers -> Create Application) ──
  CLICKPESA_CLIENT_ID: 'WEKA_CLIENT_ID_YAKO_HAPA',
  CLICKPESA_API_KEY: 'WEKA_API_KEY_YAKO_HAPA',
  CLICKPESA_BASE_URL: 'https://api.clickpesa.com',

  // ── Pairing website base URL (used in WhatsApp dashboard-link messages) ──
  PAIRING_BASE_URL: 'https://pairingpage.up.railway.app', // badilisha kama domain yako ni tofauti

  // ── Optional custom pairing code (must be EXACTLY 8 uppercase A-Z0-9) ──
  // NOTE: WhatsApp often rejects custom codes even when correctly
  // formatted — see the earlier conversation. If pairing keeps failing
  // with this set, change it back to null to use Baileys' normal random
  // codes (recommended, and known to work reliably).
  CUSTOM_PAIRING_CODE: 'UMOJASTA',
};
