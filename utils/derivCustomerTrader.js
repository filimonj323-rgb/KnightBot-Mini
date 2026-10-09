/**
 * derivCustomerTrader.js — SERA ya trading ya mteja: LANGO LA PEKEE la kufungua/kufunga trade kwenye akaunti ya mteja.
 * (commands, dashboard na — hatua (d) — auto-trade zote zinapita hapa; hakuna njia nyingine ya kufikia derivSession.placeMultiplier.)
 *
 * Kufungua trade (openTrade) kunapita hundi hizi KWA MPANGILIO, ndani ya mutex ya mteja huyo (trades mbili za wakati mmoja
 * haziwezi kupita vikomo kwa pamoja). Hundi YOYOTE ikishindwa — pamoja na DB/Deriv — trade HAIFUNGUKI (fail-closed):
 *   1. canTrade(): token + active + DEMO + idhini ya admin + swichi ya mteja + kill switch ya wote
 *   2. vigezo: jozi kwenye orodha, upande, stake ≤ maxStake (inakataa, haipunguzi kimya), SL na TP LAZIMA, multiplier halali
 *   3. portfolio ya Deriv inasomeka (ukweli wa trades wazi) → reconcile ya DB → vikomo:
 *        trades wazi < maxOpen • trades za leo < maxTradesDay • hasara ya leo + SL ya trade hii ≤ maxDailyLoss
 *        • hakuna trade wazi ya jozi hiyo • si marudio ya sekunde 8 zilizopita
 *   4. nafasi inahifadhiwa DB (pending) KABLA ya kununua; hundi ya canTrade() inarudiwa mara ya mwisho kabla ya "buy"
 *
 * Kufunga (closeTrade/closeAll) na kuona (overview) vinatumia gate ndogo (getTokenForManage): vinafanya kazi hata trading
 * ikiwa imezimwa au kill switch ikiwa imewashwa — kufunga ni kupunguza hatari.
 */

const { EventEmitter } = require('events');
const accounts = require('./derivAccounts');
const trades = require('./derivTrades');
const { getSession, ALLOWED_MULTIPLIERS } = require('./derivSession');

const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'AUDUSD', 'NZDUSD', 'EURGBP', 'EURJPY', 'GBPJPY', 'AUDJPY'];
const MIN_STAKE = Number(process.env.DERIV_MIN_STAKE_USD || 1);
const DEFAULT_MULTIPLIER = 100;
const DUP_WINDOW_MS = 8000;

// 'auto-closed' ({phone, contractId, code, direction, stake, profit, sellPrice}): trade ya AUTO ya mteja imegundulika kufungwa (SL/TP/Deriv).
// Injini ya auto-trade inasikiliza ili kutuma arifa. Trade za mkono hazitoi tukio hili.
const events = new EventEmitter();

class TradeError extends Error {
  constructor(userMessage, code, extra) {
    super(userMessage);
    this.userMessage = userMessage;
    this.code = code || 'TRADE';
    Object.assign(this, extra || {});
  }
}

const REASON_TEXT = {
  kill_all: 'Trading imesimamishwa kwa muda na msimamizi.',
  not_connected: 'Hujaunganisha akaunti ya Deriv.',
  inactive: 'Akaunti yako ya Deriv ina tatizo (token). Iunganishe upya kwenye dashboard.',
  real_not_allowed: 'Akaunti ya REAL haijaruhusiwa — DEMO tu kwa sasa.',
  not_approved: 'Msimamizi bado hajakuruhusu kutrade.',
  user_disabled: 'Trading imezimwa kwako. Iwashe kwenye dashboard (Deriv → Swichi).',
  auto_off: 'Auto-trade imezimwa.',
  error: 'Hitilafu ya ndani — trade haikufunguliwa.',
  no_phone: 'Mteja hajulikani.',
};

// ── mutex kwa kila mteja ──────────────────────────────────────────────────────────────
const chains = new Map();
function withLock(phone, fn) {
  const key = String(phone);
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

const recent = new Map(); // `${phone}|${code}|${dir}` -> ts

/** Inabadilisha kosa lolote kuwa TradeError yenye ujumbe salama wa kuonyesha mteja. */
function toTradeError(err, fallback) {
  if (err instanceof TradeError) return err;
  if (err && err.userMessage) return new TradeError(err.userMessage, err.code || 'ERROR', { reason: err.reason }); // DerivAccountError/SessionError
  if (err && err.code && err.message) return new TradeError(`Deriv: ${err.message}`, 'DERIV'); // jibu la kosa la Deriv (hakuna siri ndani yake)
  console.error('[derivCustomerTrader] hitilafu ya ndani:', err && err.message);
  return new TradeError(fallback || 'Hitilafu ya ndani. Jaribu tena.', 'INTERNAL');
}

function validate(params, limits) {
  const code = String(params.pair || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!PAIRS.includes(code)) throw new TradeError(`Jozi "${params.pair}" hairuhusiwi. Zinazoruhusiwa: ${PAIRS.join(', ')}.`, 'BAD_PAIR');
  const direction = params.direction === 'SELL' ? 'SELL' : params.direction === 'BUY' ? 'BUY' : null;
  if (!direction) throw new TradeError('Upande lazima uwe BUY au SELL.', 'BAD_DIRECTION');
  const stake = Number(params.stake);
  if (!Number.isFinite(stake) || stake <= 0) throw new TradeError('Stake lazima iwe namba > 0.', 'BAD_STAKE');
  if (stake < MIN_STAKE) throw new TradeError(`Stake ni ndogo mno (chini ya $${MIN_STAKE}).`, 'BAD_STAKE');
  if (stake > limits.maxStake) throw new TradeError(`Stake $${stake} inazidi kikomo chako cha $${limits.maxStake}. Trade haikufunguliwa.`, 'STAKE_LIMIT');
  const stopLoss = Number(params.stopLoss);
  const takeProfit = Number(params.takeProfit);
  if (!(stopLoss > 0) || !(takeProfit > 0)) throw new TradeError('Stop Loss na Take Profit ni LAZIMA (namba > 0).', 'NEED_SL_TP');
  if (stopLoss > stake) throw new TradeError('Stop Loss haiwezi kuzidi stake (hasara ya juu ya trade ni stake).', 'BAD_SL');
  const multiplier = params.multiplier == null || params.multiplier === '' ? DEFAULT_MULTIPLIER : Number(params.multiplier);
  if (!ALLOWED_MULTIPLIERS.includes(multiplier)) throw new TradeError(`Multiplier si sahihi. Zinazokubalika: ${ALLOWED_MULTIPLIERS.join(', ')}.`, 'BAD_MULTIPLIER');
  return { code, direction, stake, stopLoss, takeProfit, multiplier };
}

/** Linganisha trades zilizo wazi kwenye DB na Deriv: zilizofungwa na Deriv (SL/TP/mkono) zinawekwa closed kwa profit halisi. */
async function reconcile(phone, session, live) {
  await trades.sweepStalePending(phone);
  const liveIds = new Set(live.map((c) => String(c.contract_id)));
  const rows = await trades.openRows(phone);
  for (const row of rows) {
    const id = String(row.contractId);
    if (id.startsWith('pending:') || liveIds.has(id)) continue;
    let profit = null, sellPrice = null;
    try {
      const closed = await session.getClosedFromHistory(id);
      if (closed) {
        const cp = Number(closed.profit);
        profit = Number.isFinite(cp) ? cp : Number(closed.sell_price) - Number(closed.buy_price);
        if (!Number.isFinite(profit)) profit = null;
        const sp = Number(closed.sell_price);
        sellPrice = Number.isFinite(sp) ? sp : null;
      }
    } catch { /* profit inabaki null → inahesabiwa hasara mbaya zaidi kwenye vikomo (salama) */ }
    const changed = await trades.markClosed(phone, id, { sellPrice, profit });
    if (changed > 0 && row.signalStrength != null) {
      try {
        events.emit('auto-closed', { phone: String(phone), contractId: id, code: row.code, direction: row.direction, stake: Number(row.stake), profit, sellPrice });
      } catch (e) { console.error('[derivCustomerTrader] msikilizaji wa auto-closed ameshindwa:', e.message); }
    }
  }
}

// ── kufungua ─────────────────────────────────────────────────────────────────────────
function openTrade(phone, params, opts = {}) {
  const auto = !!(opts && opts.auto); // auto: lango linahitaji pia autoApproved + autoEnabled (canTrade {auto:true})
  return withLock(phone, async () => {
    let pendingId = null;
    let keepPending = false;
    try {
      const gate = await accounts.canTrade(phone, { auto });
      if (!gate.ok) throw new TradeError(REASON_TEXT[gate.reason] || 'Trading haijaruhusiwa.', 'DENIED', { reason: gate.reason });
      const limits = gate.limits;
      const t = validate(params, limits);
      const symbol = `frx${t.code}`;

      const dupKey = `${phone}|${t.code}|${t.direction}`;
      if (Date.now() - (recent.get(dupKey) || 0) < DUP_WINDOW_MS) {
        throw new TradeError('Order inayofanana ilifunguliwa sekunde chache zilizopita — imezuiwa kuzuia marudio.', 'DUPLICATE');
      }

      const session = getSession(phone);
      let live;
      try {
        live = await session.getPortfolio();
      } catch (err) {
        throw toTradeError(err, 'Imeshindwa kuthibitisha trades zako wazi (Deriv). Trade haikufunguliwa.');
      }
      await reconcile(phone, session, live);

      if (live.length >= limits.maxOpen) throw new TradeError(`Una trades wazi ${live.length} — kikomo chako ni ${limits.maxOpen}. Funga moja kwanza.`, 'OPEN_LIMIT');
      if (live.some((c) => c.symbol === symbol)) throw new TradeError(`${t.code} tayari ina trade WAZI — haifunguliwi nyingine hadi ifungwe.`, 'DUPLICATE_OPEN');

      const stats = await trades.todayStats(phone);
      if (stats.opened >= limits.maxTradesDay) throw new TradeError(`Umefikia kikomo cha trades za leo (${limits.maxTradesDay}). Jaribu kesho (siku inabadilika saa 03:00 EAT).`, 'DAY_LIMIT');
      if (stats.lossToday >= limits.maxDailyLoss) throw new TradeError(`Umefikia kikomo cha hasara ya leo ($${limits.maxDailyLoss}). Trading imesimama hadi kesho.`, 'LOSS_LIMIT');
      if (stats.lossToday + t.stopLoss > limits.maxDailyLoss) {
        throw new TradeError(`Hasara ya leo ($${stats.lossToday}) + Stop Loss ya trade hii ($${t.stopLoss}) ingezidi kikomo cha hasara ya siku ($${limits.maxDailyLoss}). Punguza SL/stake.`, 'LOSS_BUDGET');
      }

      pendingId = await trades.reservePending(phone, { code: t.code, symbol, direction: t.direction, stake: t.stake, slUsd: t.stopLoss, tpUsd: t.takeProfit, signalStrength: auto ? opts.signalStrength : null });

      // Hundi ya mwisho kabla ya kununua (kill switch/idhini inaweza kubadilika wakati tunasubiri Deriv).
      const gate2 = await accounts.canTrade(phone, { auto });
      if (!gate2.ok) throw new TradeError(REASON_TEXT[gate2.reason] || 'Trading haijaruhusiwa.', 'DENIED', { reason: gate2.reason });

      recent.set(dupKey, Date.now());
      let result;
      try {
        result = await session.placeMultiplier({ underlyingSymbol: symbol, direction: t.direction, stake: t.stake, stopLoss: t.stopLoss, takeProfit: t.takeProfit, multiplier: t.multiplier });
      } catch (err) {
        if (err && err.stage === 'buy' && (err.code === 'TIMEOUT' || err.code === 'DISCONNECTED' || err.code === 'SEND' || err.code === 'CLOSED')) {
          keepPending = true; // matokeo hayajulikani — usifute rekodi; mteja aangalie .positions
          throw new TradeError('Jibu la Deriv halikufika — trade INAWEZA kuwa imefunguliwa. Angalia positions zako kabla ya kujaribu tena.', 'UNKNOWN_OUTCOME');
        }
        throw err;
      }

      let tracked = true;
      try {
        await trades.attachContract(pendingId, result.contract_id, result.buy_price, result.stop_loss, result.take_profit);
      } catch (err) {
        tracked = false;
        keepPending = true;
        console.error('[derivCustomerTrader] Imeshindwa kuandikisha contract (trade imefunguliwa):', err.message);
      }
      pendingId = null;
      return {
        contractId: String(result.contract_id),
        buyPrice: Number(result.buy_price),
        stopLoss: result.stop_loss,
        takeProfit: result.take_profit,
        longcode: result.longcode || null,
        pair: t.code,
        direction: t.direction,
        stake: t.stake,
        multiplier: t.multiplier,
        tracked,
      };
    } catch (err) {
      if (pendingId && !keepPending) await trades.dropPending(pendingId).catch(() => {});
      throw toTradeError(err, 'Hitilafu ya ndani — trade haikufunguliwa.');
    }
  });
}

// ── kufunga / kuona ───────────────────────────────────────────────────────────────────
function closeTrade(phone, contractId) {
  if (!/^\d{3,}$/.test(String(contractId || ''))) return Promise.reject(new TradeError('Contract id si sahihi (tumia namba kutoka .positions).', 'BAD_ID'));
  return withLock(phone, async () => {
    try {
      const session = getSession(phone);
      const r = await session.closeContractWithPnL(contractId);
      await trades.markClosed(phone, contractId, { sellPrice: Number.isFinite(r.sold_for) ? r.sold_for : null, profit: r.profit }).catch((e) =>
        console.error('[derivCustomerTrader] markClosed imeshindwa:', e.message)
      );
      return { contractId: String(contractId), profit: r.profit, soldFor: Number.isFinite(r.sold_for) ? r.sold_for : null };
    } catch (err) {
      throw toTradeError(err, 'Imeshindwa kufunga trade.');
    }
  });
}

function closeAll(phone) {
  return withLock(phone, async () => {
    try {
      const session = getSession(phone);
      const live = await session.getPortfolio();
      const results = [];
      for (const c of live) {
        try {
          const r = await session.closeContractWithPnL(c.contract_id);
          await trades.markClosed(phone, c.contract_id, { sellPrice: Number.isFinite(r.sold_for) ? r.sold_for : null, profit: r.profit }).catch(() => {});
          results.push({ contractId: String(c.contract_id), ok: true, profit: r.profit });
        } catch (err) {
          results.push({ contractId: String(c.contract_id), ok: false, error: toTradeError(err).userMessage });
        }
      }
      return results;
    } catch (err) {
      throw toTradeError(err, 'Imeshindwa kufunga trades.');
    }
  });
}

/** Angalia (bila kufungua chochote) kama trades za mteja zimefungwa na Deriv; zile za AUTO zinatoa tukio 'auto-closed'. */
function syncClosed(phone) {
  return withLock(phone, async () => {
    try {
      const session = getSession(phone);
      const live = await session.getPortfolio();
      await reconcile(phone, session, live);
      return { open: live.length };
    } catch (err) {
      throw toTradeError(err, 'Imeshindwa kusoma akaunti yako ya Deriv.');
    }
  });
}

/** Historia kamili ya mteja (kutoka DB) + muhtasari. Inajaribu kwanza kusasisha trades zilizofungwa na Deriv; ikishindikana inaonyesha ilichonacho. */
async function historyView(phone, { limit = 20, offset = 0 } = {}) {
  try { await syncClosed(phone); } catch { /* si lazima — DB ina historia tuliyo nayo */ }
  const [rows, summary] = await Promise.all([trades.historyPage(phone, { limit, offset }), trades.summary(phone)]);
  return { rows, summary, hasMore: Number(offset) + rows.length < summary.total };
}

function overview(phone) {
  return withLock(phone, async () => {
    try {
      const session = getSession(phone);
      const [balance, live] = await Promise.all([session.getBalance(), session.getOpenPositionsLive()]);
      await reconcile(phone, session, live);
      const stats = await trades.todayStats(phone);
      const gate = await accounts.canTrade(phone);
      const acct = await accounts.getPublic(phone);
      return {
        balance: balance ? { amount: Number(balance.balance), currency: balance.currency || 'USD' } : null,
        positions: live.map((p) => ({
          contractId: String(p.contract_id),
          symbol: p.symbol || null,
          shortcode: p.shortcode || null,
          buyPrice: Number(p.buy_price),
          bidPrice: p.bid_price != null ? Number(p.bid_price) : null,
          profit: p.profit != null ? Number(p.profit) : null,
        })),
        today: stats,
        limits: acct.limits,
        canTrade: gate.ok,
        canTradeReason: gate.ok ? null : gate.reason,
        recent: await trades.history(phone, 10),
      };
    } catch (err) {
      throw toTradeError(err, 'Imeshindwa kusoma akaunti yako ya Deriv.');
    }
  });
}

module.exports = { TradeError, PAIRS, events, openTrade, closeTrade, closeAll, overview, syncClosed, historyView, _validate: validate };
