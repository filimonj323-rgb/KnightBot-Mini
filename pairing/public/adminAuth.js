/**
 * pairing/adminAuth.js
 *
 * Minimal username/password admin auth for the admin dashboard.
 * Credentials live in pairing/pairingConfig.js — edit them there.
 *
 * No database needed: a session token is just
 *   "<username>.<expiresAtMs>.<hmac-signature>"
 * — verify() recomputes the signature and checks expiry. Stolen tokens
 * still expire on their own (12h) and can be invalidated any time by
 * changing ADMIN_SESSION_SECRET in pairingConfig.js (which logs everyone out).
 */

const crypto = require('crypto');
const cfg = require('./pairingConfig');

const ADMIN_USERNAME = cfg.ADMIN_USERNAME;
const ADMIN_PASSWORD = cfg.ADMIN_PASSWORD;
const SECRET = cfg.ADMIN_SESSION_SECRET;
const SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
}

function login(username, password) {
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) return null;
  const expiresAt = Date.now() + SESSION_MS;
  const payload = `${username}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

function verify(token) {
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
