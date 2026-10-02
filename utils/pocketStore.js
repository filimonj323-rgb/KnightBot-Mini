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

async function recordOpenTrade({ orderId, pair, direction, stake, expirySeconds, source = null }) {
  try {
    await ready();
    const now = Date.now();
    await db.query(
      `INSERT INTO po_trades (orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(orderId) DO NOTHING`,
      [String(orderId), pair, direction, stake, expirySeconds, now, now + expirySeconds * 1000, source]
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

// ── Auto-trade (source = 'auto') ────────────────────────────────────────

// Trades za auto ambazo bado ziko wazi (kwa kurejesha hali baada ya restart).
async function getOpenAutoTrades() {
  try {
    await ready();
    const r = await db.query(
      `SELECT orderId, pair, direction, stake, expirySeconds, openedAt, expiresAt
         FROM po_trades WHERE closedAt IS NULL AND source = 'auto' ORDER BY openedAt ASC`
    );
    return r.rows || [];
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma auto-trades zilizo wazi:', err.message);
    return null; // null = DB imeshindwa (tofauti na [] = hakuna)
  }
}

// Hali ya hatari ya auto-trade tangu `sinceMs` (mwanzo wa siku ya UTC):
//   dailyPnl (hasara = -stake; faida = profit chanya), tradesToday, na hasara mfululizo
//   za mwisho (bila ushindi katikati). Rudisha null DB ikishindwa.
async function getAutoRiskState(sinceMs) {
  try {
    await ready();
    const day = await db.query(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN win = 1 THEN MAX(COALESCE(profit, 0), 0)
                                WHEN win = 0 THEN -stake ELSE 0 END), 0) AS pnl
         FROM po_trades WHERE source = 'auto' AND openedAt >= ?`,
      [sinceMs]
    );
    const row = (day.rows || [])[0] || {};
    const last = await db.query(
      `SELECT win, closedAt FROM po_trades
        WHERE source = 'auto' AND closedAt IS NOT NULL AND win IS NOT NULL
        ORDER BY closedAt DESC LIMIT 20`
    );
    let consecutiveLosses = 0;
    let lastLossAt = null;
    for (const t of last.rows || []) {
      if (Number(t.win) === 1) break;
      consecutiveLosses++;
      if (lastLossAt == null) lastLossAt = Number(t.closedAt);
    }
    return {
      tradesToday: Number(row.n) || 0,
      dailyPnl: Number(row.pnl) || 0,
      consecutiveLosses,
      lastLossAt,
    };
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma hali ya hatari ya auto-trade:', err.message);
    return null;
  }
}

// Takwimu za jumla za auto-trades zilizofungwa (kwa .poauto stats).
async function getAutoStats(limit = 500) {
  try {
    await ready();
    const r = await db.query(
      `SELECT pair, stake, win, profit FROM po_trades
        WHERE source = 'auto' AND closedAt IS NOT NULL AND win IS NOT NULL
        ORDER BY closedAt DESC LIMIT ?`,
      [limit]
    );
    const rows = r.rows || [];
    let wins = 0, losses = 0, pnl = 0;
    for (const t of rows) {
      if (Number(t.win) === 1) { wins++; pnl += Math.max(Number(t.profit) || 0, 0); }
      else { losses++; pnl -= Number(t.stake) || 0; }
    }
    return { trades: rows.length, wins, losses, pnl };
  } catch (err) {
    console.error('[pocketStore] Imeshindwa kusoma takwimu za auto-trade:', err.message);
    return null;
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
  getOpenAutoTrades,
  getAutoRiskState,
  getAutoStats,
  getTradeHistory,
  getClosedResult,
  saveSetting,
  deleteSetting,
  loadSettings,
};
