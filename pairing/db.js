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
    `CREATE INDEX IF NOT EXISTS idx_payments_phone ON payments(phoneNumber)`,
  ], 'write');

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
  for (const col of ['welcomeSentAt INTEGER', 'shortDashUrl TEXT', 'shortPayUrl TEXT']) {
    try {
      await client.execute(`ALTER TABLE tokens ADD COLUMN ${col}`);
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
