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
      botName     TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS pending_orders (
      orderReference TEXT PRIMARY KEY,
      phoneNumber    TEXT NOT NULL,
      days           INTEGER NOT NULL,
      amount         INTEGER NOT NULL,
      createdAt      INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_payments_phone ON payments(phoneNumber)`,
  ], 'write');

  schemaReady = true;
  console.log('[db] Turso schema iko tayari.');
}

/** Runs a query, returns { rows }. `args` is a plain array. */
async function query(sql, args = []) {
  return client.execute({ sql, args });
}

module.exports = { client, initSchema, query };
