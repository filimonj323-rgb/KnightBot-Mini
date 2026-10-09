/**
 * derivTrades.js — Rekodi za trades za WATEJA (jedwali fx_auto_trades, safu zenye ownerPhone = namba ya mteja).
 *
 * Trades za owner zina ownerPhone = NULL na zinashughulikiwa na utils/autoTrader.js (query zake zote zinachuja
 * `ownerPhone IS NULL`). Hapa kila query INACHUJA kwa ownerPhone ya mteja — hakuna mteja anayeona/kuathiri wa mwingine.
 *
 * Siku = UTC (sawa na autoTrader.js). Fail-closed: makosa ya DB yanapita juu (derivCustomerTrader inazuia trade).
 */

const crypto = require('crypto');
const db = require('../pairing/db');

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfUtcDay = (ts) => Math.floor(ts / DAY_MS) * DAY_MS;

/** Inahifadhi nafasi ya trade KABLA ya kuinunua (contractId ya muda). Ikishindikana, trade haifunguliwi. */
async function reservePending(phone, { code, symbol, direction, stake, slUsd, tpUsd, signalStrength = null }) {
  const id = `pending:${phone}:${crypto.randomBytes(6).toString('hex')}`;
  await db.query(
    `INSERT INTO fx_auto_trades (contractId, code, symbol, direction, stake, slUsd, tpUsd, openedAt, ownerPhone, signalStrength)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, code, symbol, direction, stake, slUsd, tpUsd, Date.now(), String(phone), Number.isFinite(Number(signalStrength)) && signalStrength !== null ? Number(signalStrength) : null]
  );
  return id;
}

async function attachContract(pendingId, contractId, buyPrice, slUsd, tpUsd) {
  await db.query(
    'UPDATE fx_auto_trades SET contractId = ?, buyPrice = ?, slUsd = ?, tpUsd = ? WHERE contractId = ?',
    [String(contractId), Number.isFinite(Number(buyPrice)) ? Number(buyPrice) : null, slUsd, tpUsd, pendingId]
  );
}

async function dropPending(pendingId) {
  await db.query('DELETE FROM fx_auto_trades WHERE contractId = ? AND contractId LIKE ?', [pendingId, 'pending:%']);
}

async function markClosed(phone, contractId, { closedAt = Date.now(), sellPrice = null, profit = null } = {}) {
  const r = await db.query(
    'UPDATE fx_auto_trades SET closedAt = ?, sellPrice = ?, profit = ? WHERE contractId = ? AND ownerPhone = ? AND closedAt IS NULL',
    [closedAt, sellPrice, profit, String(contractId), String(phone)]
  );
  return Number(r.rowsAffected) || 0;
}

async function openRows(phone) {
  const r = await db.query(
    'SELECT contractId, code, symbol, direction, stake, buyPrice, slUsd, tpUsd, openedAt, signalStrength FROM fx_auto_trades WHERE ownerPhone = ? AND closedAt IS NULL ORDER BY openedAt ASC',
    [String(phone)]
  );
  return r.rows;
}

/**
 * Takwimu za SIKU YA SASA (UTC): opened = trades zote zilizofunguliwa leo (pamoja na pending),
 * lossToday = jumla ya hasara halisi za leo (kwa trades zilizofungwa leo; faida hazipunguzi hasara),
 * pnlToday = faida/hasara halisi ya jumla. Trade iliyofungwa bila profit inayojulikana inahesabiwa hasara mbaya zaidi (SL au stake).
 */
async function todayStats(phone, now = Date.now()) {
  const from = startOfUtcDay(now);
  const r = await db.query(
    'SELECT stake, slUsd, profit, closedAt FROM fx_auto_trades WHERE ownerPhone = ? AND openedAt >= ?',
    [String(phone), from]
  );
  let opened = 0, loss = 0, pnl = 0;
  for (const row of r.rows) {
    opened += 1;
    if (row.closedAt == null) continue;
    const p = row.profit == null ? -Math.abs(Number(row.slUsd) || Number(row.stake) || 0) : Number(row.profit);
    pnl += p;
    if (p < 0) loss += -p;
  }
  return { opened, lossToday: Number(loss.toFixed(2)), pnlToday: Number(pnl.toFixed(2)) };
}

async function history(phone, limit = 20) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 200));
  const r = await db.query(
    `SELECT contractId, code, direction, stake, buyPrice, sellPrice, profit, openedAt, closedAt
     FROM fx_auto_trades WHERE ownerPhone = ? AND closedAt IS NOT NULL ORDER BY closedAt DESC LIMIT ?`,
    [String(phone), n]
  );
  return r.rows;
}

/**
 * Trades za AUTO (signalStrength != NULL — za mkono zina NULL) zilizofungwa hivi karibuni za mteja huyu, mpya kwanza.
 * Zinatumika na injini ya auto-trade kuhesabu hasara mfululizo (cooldown). Mteja mmoja tu — hakuna kuvuja kwa wengine.
 */
async function recentAuto(phone, limit = 3) {
  const n = Math.max(1, Math.min(Number(limit) || 3, 50));
  const r = await db.query(
    `SELECT contractId, code, direction, profit, closedAt FROM fx_auto_trades
     WHERE ownerPhone = ? AND signalStrength IS NOT NULL AND closedAt IS NOT NULL ORDER BY closedAt DESC LIMIT ?`,
    [String(phone), n]
  );
  return r.rows;
}

/** Wateja wenye trade ya AUTO bado wazi (zenye contract halisi) — injini inaangalia kama zimefungwa ili kutuma arifa. */
async function phonesWithOpenAuto() {
  const r = await db.query(
    `SELECT DISTINCT ownerPhone FROM fx_auto_trades
     WHERE ownerPhone IS NOT NULL AND closedAt IS NULL AND signalStrength IS NOT NULL AND contractId NOT LIKE 'pending:%'`,
    []
  );
  return r.rows.map((x) => String(x.ownerPhone));
}

/** Ondoa "pending" za zamani (zaidi ya dakika 5) zilizobaki kwa sababu ya ajali — hazina contract halisi. */
async function sweepStalePending(phone, olderThanMs = 5 * 60 * 1000) {
  await db.query(
    "DELETE FROM fx_auto_trades WHERE ownerPhone = ? AND contractId LIKE 'pending:%' AND openedAt < ?",
    [String(phone), Date.now() - olderThanMs]
  );
}

module.exports = { reservePending, attachContract, dropPending, markClosed, openRows, todayStats, history, recentAuto, phonesWithOpenAuto, sweepStalePending, startOfUtcDay };
