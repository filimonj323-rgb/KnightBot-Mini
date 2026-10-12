/**
 * pairing/adminAuth.js
 *
 * Minimal username/password admin auth for the admin dashboard.
 * Credentials zinatoka Railway env vars (ADMIN_USERNAME, ADMIN_PASSWORD,
 * ADMIN_SESSION_SECRET) kupitia pairing/pairingConfig.js.
 *
 * No database needed: a session token is just
 *   "<username>.<expiresAtMs>.<hmac-signature>"
 * — verify() recomputes the signature and checks expiry. Stolen tokens
 * still expire on their own (12h) and can be invalidated any time by
 * changing ADMIN_SESSION_SECRET in pairingConfig.js (which logs everyone out).
 */

const crypto = require('crypto');
const cfg = require('./pairingConfig');

// Zinasomwa wakati wa matumizi (si wakati wa require), na hazijawekwa => admin imefungwa.
const ADMIN_USERNAME = () => cfg.ADMIN_USERNAME;
const ADMIN_PASSWORD = () => cfg.ADMIN_PASSWORD;
const SECRET = () => cfg.ADMIN_SESSION_SECRET;
const configured = () => !!(ADMIN_USERNAME() && ADMIN_PASSWORD() && SECRET());
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(payload) {
  return crypto.createHmac('sha256', SECRET()).update(payload).digest('hex');
}

function login(username, password) {
  if (!configured()) return null;
  if (username !== ADMIN_USERNAME() || password !== ADMIN_PASSWORD()) return null;
  const expiresAt = Date.now() + SESSION_MS;
  const payload = `${username}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

function verify(token) {
  if (!configured()) return false;
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [username, expiresAt, sig] = parts;
  const payload = `${username}.${expiresAt}`;
  if (sign(payload) !== sig) return false;
  if (Date.now() > Number(expiresAt)) return false;
  return true;
}

module.exports = { login, verify };
