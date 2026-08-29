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
  // ── Turso (cloud SQLite database) ───────────────────────────────────
  // From turso.tech dashboard/CLI after creating a database. Keeps all
  // users/payments/tokens/settings OUTSIDE Railway entirely.
  TURSO_DATABASE_URL: 'libsql://umoja-umojatech.aws-eu-west-1.turso.io',
  TURSO_AUTH_TOKEN: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc0NjI0OTMsImlkIjoiMDFhMDJkMGYtMjgwMS03YmViLTkxYmUtOWY1MDlkZjBlNzBmIiwia2lkIjoiV2drY1Fkc2hlZzNDR1JXQ01Heks3QWhPZC1GUzk4SEZ6QkMyRHh1MWJkNCIsInJpZCI6ImVjZjc2OTc1LTMyMmEtNGY3NS05M2VlLWMyZTdiNWI4NzI1NyJ9.vHMThKrw7TbImo2EtIL3Q9uFOeYtgR4iKCBPCdm1FHGAXKkLyv45P4KKUj2rmQhQUrtzD8VTD3izRxz6Vv03Cg',

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
    { days: 5, price: 1500 },
    { days: 7, price: 2000 },
    { days: 10, price: 2500 },
    { days: 30, price: 4000 },
  ],

  // How often (in hours) a customer whose trial/subscription has expired
  // gets a WhatsApp reminder with the payment link, until they pay.
  REMINDER_INTERVAL_HOURS: 12,

  // How many hours BEFORE trial/subscription expiry a customer gets a
  // one-time early warning ("muda unakaribia kuisha") with the payment
  // link, so they can pay before the bot actually stops responding.
  TRIAL_WARNING_HOURS: 24,

  // ── ClickPesa (Dashboard -> Settings -> Developers -> Create Application) ──
  CLICKPESA_CLIENT_ID: 'IDJwwKwcQaNUPWx5OTCjFaCPOuaGjeTG',
  CLICKPESA_API_KEY: 'SKUPUAIslmBCgrSpS5A3t5uP8E3vdn00D4nuA6w1FX',
  CLICKPESA_BASE_URL: 'https://api.clickpesa.com',

  // ── Pairing website base URL (used in WhatsApp dashboard-link messages) ──
  PAIRING_BASE_URL: 'https://pairingpage.up.railway.app', // badilisha kama domain yako ni tofauti

  // ── Bot kuu (index.js) — inatumika ili reminders za malipo zitumwe
  // kutoka namba ya OWNER (config.ownerNumber kwenye root config.js), si
  // kutoka bot ndogo ya mteja mwenyewe. Kwa sababu bot kuu na pairing server
  // zinaendesha kwenye Railway projects MBILI tofauti (process tofauti,
  // hakuna memory ya pamoja), mawasiliano ni kwa HTTP: pairing server
  // inapiga endpoint hii kwenye service inayoendesha index.js.
  // MAIN_BOT_API_SECRET LAZIMA ilingane HASA na REMINDER_SECRET (env var)
  // kwenye service ya index.js, la sivyo ombi litakataliwa (403).
  MAIN_BOT_API_URL: 'https://botkuusite.up.railway.app',
  MAIN_BOT_API_SECRET: 'Jafethfilimon321@gmail.com',

  // ── Optional custom pairing code (must be EXACTLY 8 uppercase A-Z0-9) ──
  // NOTE: WhatsApp often rejects custom codes even when correctly
  // formatted, ambayo ndiyo iliyokuwa inasababisha "couldn't connect" na
  // "connection closed" mara kwa mara. Imewekwa null kutumia random codes
  // za Baileys ambazo ni za uhakika zaidi. Usiweke thamani hapa tena
  // isipokuwa lazima kabisa.
  CUSTOM_PAIRING_CODE: 'UMOJASTA',
};
