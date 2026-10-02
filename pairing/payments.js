/**
 * pairing/payments.js
 *
 * Uthibitisho wa malipo + kumpa mteja kifurushi AUTOMATICALLY.
 *
 * Njia TATU zinazoleta matokeo yale yale (zote zinapita kwenye
 * verifyAndActivate, kwa hiyo hakuna njia inayoweza kuruka ukaguzi):
 *   1) Webhook ya ClickPesa            (haraka zaidi)
 *   2) Dashboard ya mteja ina-poll     (/api/dashboard/<token>/pay-status)
 *   3) Reconciler ya nyuma (kila ~20s) (inaokoa malipo ikiwa webhook haikufika)
 *
 * Ulinzi:
 *   - Hatuamini data ya webhook peke yake: tunauliza ClickPesa moja kwa moja
 *     hali halisi ya orderReference (getPaymentStatus).
 *   - Kiasi + sarafu vinakaguliwa dhidi ya order tuliyohifadhi (si dhidi ya
 *     chochote kilichotumwa na webhook).
 *   - Idempotent: order inadaiwa kwa DELETE ya atomic, kwa hiyo webhook
 *     iliyorudiwa / polling + webhook kwa pamoja haziwezi kumpa siku mara mbili.
 */

const db = require('./db');
const clickpesa = require('./clickpesa');
const cfg = require('./pairingConfig');
const mainConfig = require('../config');
const im = require('./instanceManager');

const RECONCILE_EVERY_MS = 20 * 1000;
const FRESH_ORDER_MS = 15 * 60 * 1000;          // order changa: angalia kila mzunguko
const OLD_CHECK_EVERY_MS = 5 * 60 * 1000;       // order za zamani: kila dakika 5
const ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000;   // baada ya saa 24 tunaiacha
const MIN_RECHECK_MS = 3 * 1000;                // kinga ya spam kwa order moja

// Matokeo ya hivi karibuni (kwa UI) — kumbukumbu ya muda mfupi tu. Chanzo cha
// ukweli cha "paid" ni jedwali la payments (tazama getOrderState).
const recentResults = new Map(); // orderReference -> { state, days?, message?, at }
const lastCheckedAt = new Map(); // orderReference -> ms
const inFlight = new Map();      // orderReference -> Promise (zuia ukaguzi sambamba)

function rememberResult(orderReference, result) {
  recentResults.set(orderReference, { ...result, at: Date.now() });
  if (recentResults.size > 500) {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [k, v] of recentResults) if (v.at < cutoff) recentResults.delete(k);
  }
}

// ── Pending orders ───────────────────────────────────────────────────────
async function insertPendingOrder(orderReference, phoneNumber, days, amount) {
  await db.query(
    'INSERT INTO pending_orders (orderReference, phoneNumber, days, amount, createdAt) VALUES (?, ?, ?, ?, ?)',
    [orderReference, phoneNumber, days, amount, Date.now()]
  );
}
async function getPendingOrder(orderReference) {
  const res = await db.query('SELECT * FROM pending_orders WHERE orderReference = ?', [orderReference]);
  return res.rows[0] || null;
}
/** Dai order kwa atomic: true tu kwa mpigaji MMOJA aliyeifuta kweli. */
async function claimPendingOrder(orderReference) {
  const res = await db.query('DELETE FROM pending_orders WHERE orderReference = ?', [orderReference]);
  return Number(res.rowsAffected || 0) === 1;
}
async function getPaymentRow(orderReference) {
  const res = await db.query('SELECT * FROM payments WHERE orderReference = ? ORDER BY at DESC LIMIT 1', [orderReference]);
  return res.rows[0] || null;
}

// ── Notifications ────────────────────────────────────────────────────────
async function notifyOwner(text) {
  try {
    if (!global.currentSock) return;
    const raw = Array.isArray(mainConfig.ownerNumber) ? mainConfig.ownerNumber[0] : mainConfig.ownerNumber;
    const jid = raw?.includes('@') ? raw : `${raw}@s.whatsapp.net`;
    await global.currentSock.sendMessage(jid, { text });
  } catch (e) {
    console.error('[payments] notifyOwner imeshindwa:', e.message);
  }
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString('sw-TZ', {
    timeZone: 'Africa/Dar_es_Salaam', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function packageLabel(days) {
  return days === 1 ? 'Siku 1' : days === 30 ? 'Mwezi 1 (siku 30)' : `Siku ${days}`;
}

// ── Kiini: thibitisha + toa kifurushi ────────────────────────────────────
/**
 * @param {string} orderReference
 * @param {{trustedWebhook?: object}} [opts] trustedWebhook = data ya webhook
 *   ILIYOTHIBITISHWA checksum yake; inatumika kama mbadala TU pale
 *   ClickPesa status API ikishindwa kufikika (si ikijibu "bado/imeshindwa").
 * @returns {Promise<{state:'paid'|'pending'|'failed'|'underpaid'|'unknown', days?:number, paidUntil?:number, message?:string}>}
 */
function verifyAndActivate(orderReference, opts = {}) {
  if (inFlight.has(orderReference)) return inFlight.get(orderReference);
  const p = _verifyAndActivate(orderReference, opts).finally(() => inFlight.delete(orderReference));
  inFlight.set(orderReference, p);
  return p;
}

async function _verifyAndActivate(orderReference, opts) {
  lastCheckedAt.set(orderReference, Date.now());

  const order = await getPendingOrder(orderReference);
  if (!order) return getOrderState(orderReference);

  // 1) Uliza ClickPesa moja kwa moja.
  let remote = null;
  try {
    remote = await clickpesa.getPaymentStatus(orderReference);
  } catch (e) {
    console.warn(`[payments] status check ya ${orderReference} imeshindwa: ${e.message}`);
    const hook = opts.trustedWebhook;
    if (hook && clickpesa.isSuccessStatus(hook.status)) {
      // Webhook yenye checksum sahihi + API haifikiki → tunakubali webhook.
      remote = {
        found: true,
        status: String(hook.status).toUpperCase(),
        paymentReference: hook.paymentReference || hook.id || null,
        collectedAmount: hook.collectedAmount != null ? Number(hook.collectedAmount) : null,
        collectedCurrency: hook.collectedCurrency || null,
      };
    } else {
      return { state: 'pending' }; // jaribu tena mzunguko ujao
    }
  }

  if (!remote.found) {
    return { state: 'pending' }; // mteja bado hajaweka PIN
  }

  if (clickpesa.isFailedStatus(remote.status)) {
    if (await claimPendingOrder(orderReference)) {
      const result = { state: 'failed', message: 'Malipo hayakukamilika (yamekataliwa au muda umeisha). Jaribu tena.' };
      rememberResult(orderReference, result);
      console.log(`[payments] ${orderReference} imeshindwa: ${remote.status}`);
      return result;
    }
    return getOrderState(orderReference);
  }

  if (!clickpesa.isSuccessStatus(remote.status)) {
    return { state: 'pending' }; // PROCESSING / PENDING
  }

  // 2) Malipo yamefanikiwa — kagua kiasi na sarafu.
  const currencyOk = !remote.collectedCurrency || String(remote.collectedCurrency).toUpperCase() === 'TZS';
  const amountOk = remote.collectedAmount == null || Number(remote.collectedAmount) >= Number(order.amount);
  if (!currencyOk || !amountOk) {
    if (await claimPendingOrder(orderReference)) {
      const result = { state: 'underpaid', message: 'Kiasi kilicholipwa hakilingani na kifurushi. Wasiliana na admin.' };
      rememberResult(orderReference, result);
      console.error(`[payments] KIASI HAKILINGANI ${orderReference}: tulitarajia ${order.amount} TZS, ClickPesa=${remote.collectedAmount} ${remote.collectedCurrency}`);
      await notifyOwner(
        `⚠️ *MALIPO YENYE KIASI TOFAUTI*\n\nAkaunti: ${order.phoneNumber}\nKifurushi: ${packageLabel(order.days)} (${order.amount} TZS)\n` +
        `Kilicholipwa: ${remote.collectedAmount} ${remote.collectedCurrency || ''}\nRef: ${orderReference}\nPaymentRef: ${remote.paymentReference || '-'}\n\n` +
        `Hakijapewa kifurushi. Tumia admin "mark-paid" kama unataka kumpa mwenyewe.`
      );
      return result;
    }
    return getOrderState(orderReference);
  }

  // 3) Dai order kwa atomic, kisha mpe mteja kifurushi.
  if (!(await claimPendingOrder(orderReference))) {
    return getOrderState(orderReference); // mtu mwingine (webhook/poller) ameshaishughulikia
  }
  if (await getPaymentRow(orderReference)) {
    return getOrderState(orderReference); // kinga ya ziada: tayari imerekodiwa
  }

  try {
    const user = await im.adminMarkPaid(order.phoneNumber, Number(order.days), {
      method: 'clickpesa',
      orderReference,
      amount: Number(order.amount),
      paymentReference: remote.paymentReference || null,
    });
    const result = { state: 'paid', days: Number(order.days), paidUntil: user.paidUntil };
    rememberResult(orderReference, result);
    console.log(`[payments] ✅ ${orderReference} imethibitishwa — ${order.phoneNumber} amepewa siku ${order.days}`);

    im.notifyCustomer(
      order.phoneNumber,
      `✅ *Malipo Yamethibitishwa!*\n\nKifurushi: ${packageLabel(Number(order.days))}\nKiasi: ${Number(order.amount).toLocaleString('en-US')} TZS\n` +
      `Bot yako inafanya kazi hadi: *${fmtDate(user.paidUntil)}*\n\nAsante kwa kulipa! 🙏`
    );
    notifyOwner(`💰 Malipo mapya: ${order.phoneNumber} — ${packageLabel(Number(order.days))} (${Number(order.amount).toLocaleString('en-US')} TZS)`);
    return result;
  } catch (e) {
    // Usipoteze malipo: rudisha order ili reconciler ijaribu tena.
    console.error(`[payments] adminMarkPaid imeshindwa kwa ${orderReference}:`, e.message);
    try {
      await insertPendingOrder(orderReference, order.phoneNumber, order.days, order.amount);
    } catch (_) { /* tayari ipo */ }
    notifyOwner(`🚨 Malipo yamethibitishwa lakini kumpa kifurushi kumeshindwa!\nAkaunti: ${order.phoneNumber}\nRef: ${orderReference}\nSababu: ${e.message}`);
    return { state: 'pending' };
  }
}

/** Hali ya order kwa UI — haigusi ClickPesa. */
async function getOrderState(orderReference) {
  const pending = await getPendingOrder(orderReference);
  if (pending) return { state: 'pending' };

  const paid = await getPaymentRow(orderReference);
  if (paid) {
    const user = await require('./userStore').getUser(paid.phoneNumber);
    return { state: 'paid', days: Number(paid.days), paidUntil: user ? user.paidUntil : null };
  }
  const recent = recentResults.get(orderReference);
  if (recent) {
    const { at, ...rest } = recent;
    return rest;
  }
  return { state: 'unknown' };
}

/** Kwa polling ya dashboard: hakikisha order ni ya mteja huyu, kisha thibitisha. */
async function checkOrderForAccount(orderReference, accountPhoneNumber) {
  const pending = await getPendingOrder(orderReference);
  if (pending) {
    if (pending.phoneNumber !== accountPhoneNumber) return { state: 'unknown' };
    const last = lastCheckedAt.get(orderReference) || 0;
    if (Date.now() - last < MIN_RECHECK_MS) return { state: 'pending' };
    return verifyAndActivate(orderReference);
  }
  const paid = await getPaymentRow(orderReference);
  if (paid && paid.phoneNumber !== accountPhoneNumber) return { state: 'unknown' };
  return getOrderState(orderReference);
}

// ── Reconciler ya nyuma ──────────────────────────────────────────────────
async function reconcilePending() {
  const res = await db.query('SELECT * FROM pending_orders ORDER BY createdAt DESC LIMIT 200');
  const now = Date.now();
  for (const order of res.rows) {
    const age = now - Number(order.createdAt);
    const last = lastCheckedAt.get(order.orderReference) || 0;
    const interval = age < FRESH_ORDER_MS ? RECONCILE_EVERY_MS - 1000 : OLD_CHECK_EVERY_MS;
    if (now - last < interval) continue;

    try {
      const r = await verifyAndActivate(order.orderReference);
      if (r.state === 'pending' && age > ORDER_MAX_AGE_MS) {
        if (await claimPendingOrder(order.orderReference)) {
          rememberResult(order.orderReference, { state: 'failed', message: 'Muda wa malipo umeisha.' });
          lastCheckedAt.delete(order.orderReference);
          console.log(`[payments] order ${order.orderReference} imeisha muda (saa 24) bila malipo.`);
        }
      }
    } catch (e) {
      console.error(`[payments] reconcile ${order.orderReference} imeshindwa:`, e.message);
    }
  }
}

let reconcilerTimer = null;
function startPaymentReconciler() {
  if (reconcilerTimer) return;
  let running = false;
  reconcilerTimer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await reconcilePending(); } catch (e) { console.error('[payments] reconciler error:', e.message); }
    running = false;
  }, RECONCILE_EVERY_MS);
  console.log('[payments] reconciler imeanza (inakagua malipo yanayosubiri kila ~20s).');
}

module.exports = {
  insertPendingOrder,
  getPendingOrder,
  verifyAndActivate,
  checkOrderForAccount,
  getOrderState,
  startPaymentReconciler,
};
