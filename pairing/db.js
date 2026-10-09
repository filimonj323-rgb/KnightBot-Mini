/**
 * pairing/db.js
 *
 * Turso (libSQL) — cloud-hosted SQLite. Lives completely OUTSIDE Railway,
 * so moving the bot to a different Railway account, or a different host
 * entirely, never touches this data — you just point the same
 * TURSO_DATABASE_URL / TURSO_AUTH_TOKEN at the new deployment and every
 * customer, session token, and payment record is already there.
 *
 * SETUP (one-time):
 *   1. Sign up free at https://turso.tech
 *   2. Install the CLI or use the web dashboard to create a database, e.g.
 *      `turso db create knightbot-pairing`
 *   3. Get the URL:   `turso db show knightbot-pairing --url`
 *      (looks like    libsql://knightbot-pairing-yourname.turso.io)
 *   4. Get a token:    `turso db tokens create knightbot-pairing`
 *   5. Paste both into pairing/pairingConfig.js:
 *        TURSO_DATABASE_URL: 'libsql://...',
 *        TURSO_AUTH_TOKEN: '...',
 *
 * NOTE: unlike better-sqlite3, every query here is ASYNC (network call to
 * Turso's edge). All the functions in userStore.js and instanceManager.js
 * that touch the database are therefore `async` and must be awaited.
 */

const { createClient } = require('@libsql/client');
const cfg = require('./pairingConfig');

if (!cfg.TURSO_DATABASE_URL || cfg.TURSO_DATABASE_URL.startsWith('WEKA_')) {
  console.warn(
    '[db] TURSO_DATABASE_URL haijawekwa kwenye pairing/pairingConfig.js — database haitafanya kazi mpaka uiweke.'
  );
}

const client = createClient({
  url: cfg.TURSO_DATABASE_URL,
  authToken: cfg.TURSO_AUTH_TOKEN,
});

let schemaReady = false;

/**
 * Creates all tables if they don't exist yet. Must be awaited once at
 * startup (server.js does this) before any other query runs.
 */
async function initSchema() {
  if (schemaReady) return;

  await client.batch([
    `CREATE TABLE IF NOT EXISTS users (
      phoneNumber       TEXT PRIMARY KEY,
      pairedAt          INTEGER NOT NULL,
      trialExpiresAt    INTEGER NOT NULL,
      isPaid            INTEGER NOT NULL DEFAULT 0,
      paidUntil         INTEGER,
      blocked           INTEGER NOT NULL DEFAULT 0,
      expiryNotifiedAt  INTEGER,
      lastReminderAt    INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS payments (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      phoneNumber      TEXT NOT NULL,
      at               INTEGER NOT NULL,
      days             INTEGER NOT NULL,
      amount           INTEGER,
      method           TEXT,
      orderReference   TEXT,
      paymentReference TEXT,
      note             TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS tokens (
      token       TEXT PRIMARY KEY,
      phoneNumber TEXT NOT NULL UNIQUE
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      phoneNumber TEXT PRIMARY KEY,
      prefix      TEXT,
      botName     TEXT,
      automation  TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pending_orders (
      orderReference TEXT PRIMARY KEY,
      phoneNumber    TEXT NOT NULL,
      days           INTEGER NOT NULL,
      amount         INTEGER NOT NULL,
      createdAt      INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS usage_daily (
      phoneNumber  TEXT NOT NULL,
      date         TEXT NOT NULL,
      messageCount INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (phoneNumber, date)
    )`,
    `CREATE TABLE IF NOT EXISTS fx_auto_trades (
      contractId  TEXT PRIMARY KEY,
      code        TEXT NOT NULL,
      symbol      TEXT NOT NULL,
      direction   TEXT NOT NULL,
      stake       REAL NOT NULL,
      buyPrice    REAL,
      slUsd       REAL,
      tpUsd       REAL,
      openedAt    INTEGER NOT NULL,
      closedAt    INTEGER,
      sellPrice   REAL,
      profit      REAL,
      signalStrength REAL
    )`,
    // Key/value store ya settings za auto-trader zinazoweza kubadilishwa
    // "live" kupitia amri (mfano .fxautostake) badala ya env var + restart.
    // Row moja tu kwa kila key (settingKey ni PRIMARY KEY) — bot hii ni
    // single-owner (si per-customer kama `settings` table iliyopo juu),
    // kwa hiyo hakuna haja ya phoneNumber hapa.
    `CREATE TABLE IF NOT EXISTS fx_auto_settings (
      settingKey  TEXT PRIMARY KEY,
      settingValue TEXT NOT NULL,
      updatedAt   INTEGER NOT NULL
    )`,
    // Pocket Option (Binary/Turbo): kila order iliyofunguliwa kupitia bot
    // (.pobuy/.posell) inahifadhiwa hapa kutoka kufunguliwa hadi kufungwa,
    // ili restart/redeploy isipoteze kumbukumbu ya trades.
    `CREATE TABLE IF NOT EXISTS po_trades (
      orderId       TEXT PRIMARY KEY,
      pair          TEXT NOT NULL,
      direction     TEXT NOT NULL,
      stake         REAL NOT NULL,
      expirySeconds INTEGER NOT NULL,
      openedAt      INTEGER NOT NULL,
      expiresAt     INTEGER NOT NULL,
      closedAt      INTEGER,
      win           INTEGER,
      profit        REAL,
      status        TEXT,
      resultJson    TEXT,
      source        TEXT,
      signalStrength INTEGER
    )`,
    // Key/value ya settings za Pocket Option (mfano auto-signal kwa kila chat).
    `CREATE TABLE IF NOT EXISTS po_settings (
      settingKey   TEXT PRIMARY KEY,
      settingValue TEXT NOT NULL,
      updatedAt    INTEGER NOT NULL
    )`,
    // Ruhusa ya commands za forex/trading kwa pairing bots. Kila mteja amefungwa (locked) hadi
    // admin amruhusu. phoneNumber='*' = ruhusa kwa wote.
    `CREATE TABLE IF NOT EXISTS forex_access (
      phoneNumber TEXT PRIMARY KEY,
      grantedAt   INTEGER NOT NULL,
      note        TEXT
    )`,
    // Akaunti ya Deriv ya KILA mteja wa pairing bot (utils/derivAccounts.js).
    // encToken = token iliyosimbwa (AES-256-GCM, utils/derivCrypto.js) — kamwe wazi.
    // adminApproved/autoApproved = uamuzi wa admin (default 0 = amefungwa).
    // userEnabled/autoEnabled   = swichi za mteja mwenyewe (default 0 = zimezimwa).
    // realAllowed = admin ameruhusu akaunti ya REAL kwa mteja huyu (default 0 = DEMO tu).
    `CREATE TABLE IF NOT EXISTS deriv_accounts (
      phoneNumber    TEXT PRIMARY KEY,
      encToken       TEXT,
      tokenHint      TEXT,
      accountId      TEXT,
      isDemo         INTEGER NOT NULL DEFAULT 1,
      currency       TEXT,
      status         TEXT NOT NULL DEFAULT 'none',
      adminApproved  INTEGER NOT NULL DEFAULT 0,
      autoApproved   INTEGER NOT NULL DEFAULT 0,
      realAllowed    INTEGER NOT NULL DEFAULT 0,
      userEnabled    INTEGER NOT NULL DEFAULT 0,
      autoEnabled    INTEGER NOT NULL DEFAULT 0,
      maxStake       REAL NOT NULL DEFAULT 5,
      maxTradesDay   INTEGER NOT NULL DEFAULT 5,
      maxDailyLoss   REAL NOT NULL DEFAULT 10,
      maxOpen        INTEGER NOT NULL DEFAULT 2,
      autoStake      REAL,
      autoStakeReq   REAL,
      autoStakeReqAt INTEGER,
      pinHash        TEXT,
      mustChangePin  INTEGER NOT NULL DEFAULT 0,
      pinFails       INTEGER NOT NULL DEFAULT 0,
      pinLockedUntil INTEGER,
      lastError      TEXT,
      connectedAt    INTEGER,
      updatedAt      INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_po_trades_open ON po_trades(closedAt)`,
    `CREATE INDEX IF NOT EXISTS idx_payments_phone ON payments(phoneNumber)`,
    `CREATE INDEX IF NOT EXISTS idx_fx_auto_trades_open ON fx_auto_trades(closedAt)`,
  ], 'write');

  // Migration: po_trades.source ('auto' = trade iliyofunguliwa na pocketAutoTrader,
  // NULL = manual .pobuy/.posell au dashboard). DB zilizopo hazipati column
  // kutoka CREATE TABLE IF NOT EXISTS — swallow "duplicate column" kama zile za juu.
  try {
    await client.execute('ALTER TABLE po_trades ADD COLUMN source TEXT');
  } catch (e) {
    // Column already exists — expected on every run after the first.
  }

  // Migration: po_trades.signalStrength (nguvu ya signal % wakati trade ilipofunguliwa;
  // NULL = trade ya mkono au ya zamani isiyo na rekodi).
  try {
    await client.execute('ALTER TABLE po_trades ADD COLUMN signalStrength INTEGER');
  } catch (e) {
    // Column already exists — expected on every run after the first.
  }

  // Migration for a DB created before the `automation` column existed —
  // CREATE TABLE IF NOT EXISTS above never touches an already-existing
  // `settings` table, so old deployments need this ALTER to gain the
  // column. Swallow the "duplicate column" error on databases that already
  // have it (fresh DBs created from the CREATE TABLE above included).
  try {
    await client.execute('ALTER TABLE settings ADD COLUMN automation TEXT');
  } catch (e) {
    // Column already exists — expected on every run after the first.
  }

  // Migration: welcome-message cooldown + cached short links, added when the
  // WhatsApp "umefanikiwa kuunganisha" message became session-aware. Same
  // swallow-if-exists pattern as the `automation` migration above.
  for (const col of ['welcomeSentAt INTEGER', 'shortDashUrl TEXT', 'shortPayUrl TEXT', 'shortBaseUrl TEXT']) {
    try {
      await client.execute(`ALTER TABLE tokens ADD COLUMN ${col}`);
    } catch (e) {
      // Column already exists — expected on every run after the first.
    }
  }

  // Migration: "trial/muda unakaribia kuisha" — onyo LA MAPEMA (kabla ya
  // kuisha), tofauti na expiryNotifiedAt (baada ya kuisha) na
  // lastReminderAt (kumbusho la mara kwa mara baada ya kuisha).
  try {
    await client.execute('ALTER TABLE users ADD COLUMN trialWarningSentAt INTEGER');
  } catch (e) {
    // Column already exists — expected on every run after the first.
  }

  // Migration: jina la mtumiaji kwenye admin dashboard — waName = jina la
  // WhatsApp (linakamatwa moja kwa moja na bot), displayName = jina
  // alilobadilisha admin mwenyewe (likiwepo, ndilo linaonyeshwa).
  for (const col of ['waName TEXT', 'displayName TEXT']) {
    try {
      await client.execute(`ALTER TABLE users ADD COLUMN ${col}`);
    } catch (e) {
      // Column already exists — expected on every run after the first.
    }
  }

  // Migration: signalStrength — kwa ajili ya win-rate tracking per
  // strength-bucket (.autostats + dashboard). DB zilizoundwa kabla ya
  // hii hazina column hii, kwa hiyo ALTER + swallow-if-exists kama
  // migrations nyingine hapo juu.
  try {
    await client.execute('ALTER TABLE fx_auto_trades ADD COLUMN signalStrength REAL');
  } catch (e) {
    // Column already exists — expected on every run after the first.
  }

  // Migration: fx_auto_trades.ownerPhone — NULL = trades za owner/bot kuu (data zilizopo hazibadiliki);
  // namba ya mteja = trade ya akaunti ya Deriv ya mteja huyo (utils/derivAccounts.js, hatua zinazofuata).
  try {
    await client.execute('ALTER TABLE fx_auto_trades ADD COLUMN ownerPhone TEXT');
  } catch (e) {
    // Column already exists — expected on every run after the first.
  }
  try {
    await client.execute('CREATE INDEX IF NOT EXISTS idx_fx_auto_trades_owner ON fx_auto_trades(ownerPhone, closedAt)');
  } catch (e) {
    console.warn('[db] idx_fx_auto_trades_owner:', e.message);
  }

  // Migration: stake ya auto-trade ya mteja (autoStake = iliyoidhinishwa na admin, NULL = default; autoStakeReq = ombi linalosubiri).
  for (const col of ['autoStake REAL', 'autoStakeReq REAL', 'autoStakeReqAt INTEGER']) {
    try {
      await client.execute(`ALTER TABLE deriv_accounts ADD COLUMN ${col}`);
    } catch (e) {
      // Column already exists — expected on every run after the first.
    }
  }

  schemaReady = true;
  console.log('[db] Turso schema iko tayari.');
}

/** Runs a query, returns { rows }. `args` is a plain array. */
async function query(sql, args = []) {
  return client.execute({ sql, args });
}

module.exports = { client, initSchema, query };
