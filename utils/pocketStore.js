/**
 * pocketStore.js — Hifadhi ya Turso kwa Pocket Option (trades + settings).
 *
 * Jedwali: po_trades, po_settings (angalia pairing/db.js). Kila function ni
 * "best-effort": database ikishindwa, trading/commands HAZIVUNJIKI — error
 * inaandikwa kwenye log tu (muundo uleule na autoTrader.js).
 */

const db = require('../pairing/db');

async function ready() {
  await db.initSchema();
}

// ── Trades ──────────────────────────────────────────────────────────────

async function recordOpenTrade({ orderId, pair, direction, stake, expirySeconds }) {
  try {
    await ready();
    const now = Date.now();
    await db.query(
      `INSERT INTO po_trades (orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(orderId) DO NOTHING`,
      [String(orderId), pair, direction, stake, expirySeconds, now, now + expirySeconds * 1000]
    );
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kuhifadhi trade iliyofunguliwa:', err.message);
  }
}

// Inaandika matokeo mara moja tu (closedAt IS NULL) — salama kuitwa mara mbili.
async function recordClosedTrade(orderId, { win, profit, status, result } = {}) {
  try {
    await ready();
    await db.query(
      `UPDATE po_trades
          SET closedAt = ?, win = ?, profit = ?, status = ?, resultJson = ?
        WHERE orderId = ? AND closedAt IS NULL`,
      [
        Date.now(),
        win === true ? 1 : win === false ? 0 : null,
        profit != null && !Number.isNaN(Number(profit)) ? Number(profit) : null,
        status || (win === true ? 'win' : win === false ? 'loss' : 'unknown'),
        result ? JSON.stringify(result) : null,
        String(orderId),
      ]
    );
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kuhifadhi matokeo ya trade:', err.message);
  }
}

async function getOpenTrades() {
  try {
    await ready();
    const r = await db.query(
      `SELECT orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt
         FROM po_trades WHERE closedAt IS NULL ORDER BY openedAt ASC`
    );
    return r.rows || [];
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma trades zilizo wazi:', err.message);
    return [];
  }
}

// Matokeo yaliyohifadhiwa ya trade iliyokwisha kufungwa (au null).
async function getClosedResult(orderId) {
  try {
    await ready();
    const r = await db.query(
      'SELECT resultJson FROM po_trades WHERE orderId = ? AND closedAt IS NOT NULL AND resultJson IS NOT NULL',
      [String(orderId)]
    );
    const row = (r.rows || [])[0];
    return row ? JSON.parse(row.resultJson) : null;
  } catch (err) {
    return null;
  }
}

// Historia ya trades (zilizofungwa + zilizo wazi), mpya kwanza — kwa dashboard.
async function getTradeHistory(limit = 200) {
  try {
    await ready();
    const n = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));
    const r = await db.query(
      `SELECT orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt,
              closedAt, win, profit, status
         FROM po_trades ORDER BY openedAt DESC LIMIT ?`,
      [n]
    );
    return r.rows || [];
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma historia:', err.message);
    return [];
  }
}

// ── Settings ────────────────────────────────────────────────────────────

async function saveSetting(key, value) {
  try {
    await ready();
    await db.query(
      `INSERT INTO po_settings (settingKey, settingValue, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(settingKey) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = excluded.updatedAt`,
      [key, typeof value === 'string' ? value : JSON.stringify(value), Date.now()]
    );
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kuhifadhi setting (itafanya kazi hadi restart ijayo):', err.message);
  }
}

async function deleteSetting(key) {
  try {
    await ready();
    await db.query('DELETE FROM po_settings WHERE settingKey = ?', [key]);
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kufuta setting:', err.message);
  }
}

// Rudisha [{ key, value }] kwa settings zote zinazoanza na `prefix`.
async function loadSettings(prefix) {
  try {
    await ready();
    const r = await db.query(
      'SELECT settingKey, settingValue FROM po_settings WHERE settingKey LIKE ?',
      [`${prefix}%`]
    );
    return (r.rows || []).map((row) => ({ key: row.settingKey, value: row.settingValue }));
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma settings:', err.message);
    return [];
  }
}

module.exports = {
  recordOpenTrade,
  recordClosedTrade,
  getOpenTrades,
  getTradeHistory,
  getClosedResult,
  saveSetting,
  deleteSetting,
  loadSettings,
};
