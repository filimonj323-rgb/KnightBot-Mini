/**
 * utils/srAlerts.js — Mantiki ya arifa za Support/Resistance (S/R) na onyo la trade kukaribia Stop Loss.
 *
 * Kazi safi (hakuna mtandao/DB/WhatsApp) ili ijaribiwe kwa urahisi; autoTrader.js ndiye anayetuma arifa.
 *
 * MATUKIO YA S/R (kwa kila jozi, kila mzunguko wa signal) — createTracker().observe().
 *   autoTrader.js inatuma TU approach/broken, na TU kwa jozi yenye trade wazi (blocked/cleared hazitumwi):
 *   • blocked  — S/R imekuwa karibu mbele ya trade (resistance kwa BUY / support kwa SELL), nafasi < kikomo cha ATR.
 *   • cleared  — S/R iliyokuwa inazuia imeondoka (nafasi imerudi ya kutosha).
 *   • approach — bei imekaribia zone ya S/R (ndani ya APPROACH_ATR × ATR).
 *   • broken   — bei imevuka na kufunga nje ya zone (resistance → breakout juu, support → breakdown chini).
 *   Matukio ya "mpito" (blocked/cleared/broken) hayatumwi kwenye uangalizi wa KWANZA wa jozi (hakuna "kabla" ya kulinganisha).
 *   Kila tukio lina cooldown ili lisijirudie kwa kelele.
 *
 * ONYO LA SL (trade wazi) — slRisk() + slAlertDecision():
 *   Hasara ya sasa ikifika SL_WARN_PCT% (default 70) ya SL → onyo; SL_DANGER_PCT% (default 90) → hatari.
 *   Ujumbe unaonyesha S/R iliyo karibu kati ya bei na SL, ili mmiliki aone kama kuna nafasi ya kusogeza SL.
 *   ⚠️ Kusogeza SL mbali zaidi INAONGEZA hatari — ujumbe unasema hivyo wazi. Hii SI ushauri wa kifedha.
 */

const { toPips, pipSize } = require('./supportResistance');

const num = (n, d) => (Number.isFinite(Number(n)) ? Number(n) : d);
const CFG = {
  approachAtr: num(process.env.SR_ALERT_APPROACH_ATR, 0.5),   // karibu = ndani ya 0.5×ATR kutoka ukingo wa zone
  releaseAtr: num(process.env.SR_ALERT_RELEASE_ATR, 1.0),     // ikiondoka zaidi ya 1×ATR, inaweza kuarifu tena
  breakConfirmAtr: 0.1,                                        // bei lazima iwe nje ya zone kwa angalau 0.1×ATR
  cooldownBlockedMs: 60 * 60 * 1000,
  cooldownApproachMs: 3 * 60 * 60 * 1000,
  cooldownBrokenMs: 2 * 60 * 60 * 1000,
  slWarnPct: num(process.env.SR_ALERT_SL_WARN_PCT, 70),
  slDangerPct: num(process.env.SR_ALERT_SL_DANGER_PCT, 90),
  slRearmPct: num(process.env.SR_ALERT_SL_REARM_PCT, 50),
};

const dp = (code) => (pipSize(code) === 0.01 ? 3 : 5);
const f2 = (n) => Number(n).toFixed(2);

/** Ufunguo thabiti wa zone (bei ya zone inaweza kuyumba kidogo zikiongezeka pivots) — ndoo ya 0.5×ATR. */
function zoneKey(z, atr, code) {
  const bucket = Math.max(pipSize(code) * 5, (atr || 0) * 0.5);
  return `${z.tf || '?'}:${Math.round(z.price / bucket)}`;
}

/** Umbali (bei) kutoka `price` hadi ukingo wa karibu wa zone; 0 ikiwa bei iko NDANI ya zone. */
function distToZone(z, price) {
  if (price < z.low) return z.low - price;
  if (price > z.high) return price - z.high;
  return 0;
}

function createTracker(cfg = CFG) {
  const state = new Map(); // code -> { seeded, prevPrice, blocked, blockedDir, approach:Set, sent:Map }

  function observe({ code, price, atr, zones, direction, room, now = Date.now() }) {
    const events = [];
    if (!(price > 0) || !(atr > 0)) return events;
    let st = state.get(code);
    if (!st) { st = { seeded: false, prevPrice: null, blocked: false, blockedDir: null, approach: new Set(), sent: new Map() }; state.set(code, st); }
    const cool = (k, ms) => {
      const t = st.sent.get(k);
      if (t != null && now - t < ms) return false;
      st.sent.set(k, now);
      return true;
    };
    const dirOk = direction === 'BUY' || direction === 'SELL';
    const zs = Array.isArray(zones) ? zones : [];

    // 1) blocked / cleared (mpito)
    if (dirOk && room) {
      const nowBlocked = room.ok === false;
      if (st.seeded) {
        if (nowBlocked && (!st.blocked || st.blockedDir !== direction) && cool(`blk:${direction}`, cfg.cooldownBlockedMs)) {
          events.push({ type: 'blocked', direction, room });
        } else if (!nowBlocked && st.blocked) {
          events.push({ type: 'cleared', direction, room });
        }
      }
      st.blocked = nowBlocked;
      st.blockedDir = nowBlocked ? direction : null;
    }

    // 2) broken (bei imevuka zone tangu uangalizi uliopita) — chagua zone imara zaidi (touches nyingi)
    if (st.seeded && st.prevPrice != null) {
      let best = null;
      for (const z of zs) {
        const up = st.prevPrice < z.price && st.prevPrice <= z.high && price > z.high + cfg.breakConfirmAtr * atr;
        const down = st.prevPrice > z.price && st.prevPrice >= z.low && price < z.low - cfg.breakConfirmAtr * atr;
        if (!up && !down) continue;
        if (!best || z.touches > best.z.touches) best = { z, dir: up ? 'UP' : 'DOWN' };
      }
      if (best && cool(`brk:${zoneKey(best.z, atr, code)}`, cfg.cooldownBrokenMs)) {
        events.push({ type: 'broken', zone: best.z, dir: best.dir });
      }
    }

    // 3) approach (hali, yenye hysteresis) — zone ya karibu zaidi iliyo mpya tu
    let nearest = null;
    for (const z of zs) {
      const key = zoneKey(z, atr, code);
      const d = distToZone(z, price) / atr;
      if (d <= cfg.approachAtr) {
        if (!st.approach.has(key)) {
          st.approach.add(key);
          if (!nearest || d < nearest.d) nearest = { z, d, key };
        }
      } else if (d >= cfg.releaseAtr) {
        st.approach.delete(key);
      }
    }
    if (nearest && cool(`apr:${nearest.key}`, cfg.cooldownApproachMs)) {
      events.push({ type: 'approach', zone: nearest.z, side: nearest.z.price > price ? 'resistance' : 'support', distAtr: nearest.d });
    }

    st.seeded = true;
    st.prevPrice = price;
    return events;
  }

  return { observe, reset: () => state.clear() };
}

/** Maelezo ya zone moja: "1.08500 (touches 3 • 4h)". */
function zoneLabel(code, z) {
  return `${z.price.toFixed(dp(code))} (touches ${z.touches}${z.tf ? ` • ${z.tf}` : ''})`;
}

/**
 * Mstari unaoeleza tukio la S/R kwa mtazamo wa TRADE iliyo wazi (BUY/SELL) ya jozi hiyo.
 * Arifa za S/R zinatumwa tu kwa jozi zenye trade wazi, kwa hiyo hii inaeleza "inamaanisha nini kwa trade yangu".
 */
function tradeContextLine(ev, tradeDir) {
  if (tradeDir !== 'BUY' && tradeDir !== 'SELL') return '';
  const buy = tradeDir === 'BUY';
  const who = `Trade yako ya ${tradeDir}`;
  if (ev.type === 'approach') {
    const wall = ev.side === 'resistance';
    if (buy === wall) return `🎯 ${who} inakaribia ${wall ? 'resistance' : 'support'} mbele yake — bei inaweza kugeuka. Fikiria kufunga faida au kusogeza SL kulinda faida.`;
    return `🛡️ Bei inarudi kwenye ${wall ? 'resistance' : 'support'} nyuma ya ${who} — zone ikishikilia inalinda trade; ikivunjwa, SL iko hatarini.`;
  }
  if (ev.type === 'broken') {
    const favorable = (ev.dir === 'UP') === buy;
    return favorable
      ? `✅ Uvunjaji huu uko KWA FAIDA ya ${who} — njia mbele imefunguka zaidi.`
      : `🚨 Uvunjaji huu uko DHIDI ya ${who} — fikiria kufunga mapema au kuthibitisha SL.`;
  }
  return '';
}

/** Ujumbe wa WhatsApp kwa tukio la S/R. */
function formatEvent(code, ev, ctx = {}) {
  const { price, atr, filterOn, minRoomAtr } = ctx;
  const pips = (d) => Math.abs(toPips(code, d)).toFixed(1);
  const head = `🧱 *S/R — ${code}*`;
  const px = price ? `\n💲 Bei: ${Number(price).toFixed(dp(code))}` : '';
  switch (ev.type) {
    case 'blocked': {
      const lvl = ev.room.level;
      const side = ev.direction === 'BUY' ? 'Resistance' : 'Support';
      return `${head} — 🚧 *${side} iko karibu*\n` +
        `Mwelekeo wa signal: ${ev.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'}${px}\n` +
        `${side}: ${lvl ? zoneLabel(code, lvl) : '—'}\n` +
        `Nafasi iliyobaki: ${ev.room.roomPrice != null ? pips(ev.room.roomPrice) : '?'} pips (${ev.room.roomAtr != null ? ev.room.roomAtr.toFixed(1) : '?'}×ATR, kikomo ${minRoomAtr}×ATR)\n` +
        (filterOn ? `⛔ Kichujio cha S/R kiko ON — trade mpya ya ${code} ${ev.direction} *haitafunguliwa*.`
                  : `ℹ️ Kichujio cha S/R kiko OFF — trade *haizuiwi*, ni taarifa tu.`);
    }
    case 'cleared':
      return `${head} — ✅ *Njia imefunguka*\nMwelekeo: ${ev.direction}${px}\nS/R iliyokuwa karibu imeondoka (${ev.room.reason}).`;
    case 'approach': {
      const isRes = ev.side === 'resistance';
      return `${head} — ${isRes ? '🔴' : '🟢'} *Bei inakaribia ${isRes ? 'Resistance' : 'Support'}*${px}\n` +
        `Zone: ${zoneLabel(code, ev.zone)}\n` +
        `Umbali: ${ev.distAtr === 0 ? 'bei iko NDANI ya zone' : `${pips(ev.distAtr * atr)} pips`}\n` +
        (tradeContextLine(ev, ctx.tradeDirection) || `💡 Bei mara nyingi hugeuka au kusita hapa.`);
    }
    case 'broken': {
      const up = ev.dir === 'UP';
      return `${head} — 💥 *${up ? 'Resistance imevunjwa (breakout ↑)' : 'Support imevunjwa (breakdown ↓)'}*${px}\n` +
        `Zone: ${zoneLabel(code, ev.zone)}\n` +
        `Zone hii sasa inaweza kubadilisha kazi (${up ? 'resistance → support' : 'support → resistance'}).\n` +
        (tradeContextLine(ev, ctx.tradeDirection) || `Angalia trade yako ya ${code}.`);
    }
    default: return `${head} — ${ev.type}`;
  }
}

// ── ONYO LA SL ────────────────────────────────────────────────────────────

/**
 * Hatari ya trade dhidi ya SL.
 * @param profit   faida/hasara ya sasa ($; hasi = hasara)
 * @param stopPnl  P/L ambapo SL inagusa ($; hasi = hasara ya juu, chanya/0 = faida imefungwa)
 * @returns {{lossBudget:number, loss:number, lossPct:number, remaining:number, level:0|1|2}|null}
 *   null = SL imeshafungwa kwenye faida (hakuna hatari ya hasara) au data si sahihi.
 */
function slRisk({ profit, stopPnl }, cfg = CFG) {
  const p = Number(profit);
  const s = Number(stopPnl);
  if (!Number.isFinite(p) || !Number.isFinite(s)) return null;
  const lossBudget = -s;
  if (!(lossBudget > 0)) return null;
  const loss = Math.max(0, -p);
  const lossPct = (loss / lossBudget) * 100;
  const level = lossPct >= cfg.slDangerPct ? 2 : lossPct >= cfg.slWarnPct ? 1 : 0;
  return { lossBudget, loss, lossPct, remaining: Math.max(0, lossBudget + p), level };
}

/**
 * Uamuzi wa kutuma onyo (escalation + hysteresis).
 * @param prev  { level, stopPnl } | undefined
 * @returns {{notify:'warn'|'danger'|'recovered'|null, next:{level:number, stopPnl:number}|null}}
 */
function slAlertDecision(prev, risk, stopPnl, cfg = CFG) {
  if (!risk) return { notify: null, next: null };
  let p = prev;
  if (p && Math.abs(p.stopPnl - stopPnl) > 0.005) p = null; // SL imebadilika (trailing/mkono) — anza upya
  const prevLevel = p ? p.level : 0;
  let level = prevLevel;
  let notify = null;
  if (risk.level > prevLevel) {
    level = risk.level;
    notify = risk.level === 2 ? 'danger' : 'warn';
  } else if (risk.level < prevLevel && risk.lossPct <= cfg.slRearmPct) {
    level = 0;
    notify = 'recovered';
  }
  return { notify, next: { level, stopPnl } };
}

/** Umbali wa bei hadi SL kutoka hasara iliyobaki ($): remaining / (stake×multiplier) × bei. null kama data haitoshi. */
function priceDistanceForUsd(usd, { spot, stake, multiplier }) {
  const notional = Number(stake) * Number(multiplier);
  if (!(notional > 0) || !(spot > 0) || !(usd >= 0)) return null;
  return (usd / notional) * spot;
}

/**
 * Mistari ya ushauri wa S/R kuhusu SL.
 * BUY: support chini ya bei; SELL: resistance juu ya bei. `slPrice` ni makadirio (≈) ya bei ya SL.
 */
function slAdviceLines({ code, direction, price, atr, zones, slPrice, profit, notional }) {
  const out = [];
  if (!Array.isArray(zones) || !zones.length || !(price > 0)) return out;
  const buy = direction === 'BUY';
  const against = zones.filter((z) => (buy ? z.low < price : z.high > price));
  if (!against.length) return ['🧭 Hakuna zone ya S/R inayojulikana upande wa SL.'];
  // zone ya karibu zaidi upande wa SL
  const z = against.reduce((a, b) => (Math.abs((buy ? a.high : a.low) - price) <= Math.abs((buy ? b.high : b.low) - price) ? a : b));
  const label = buy ? 'Support' : 'Resistance';
  const edge = buy ? z.low : z.high; // ukingo wa mbali wa zone (upande wa SL)
  const pips = (d) => Math.abs(toPips(code, d)).toFixed(1);
  const slBeyond = slPrice != null && (buy ? slPrice < edge : slPrice > edge); // SL iko PEMBENI ya zone?
  if (slPrice != null && slBeyond) {
    out.push(`🧭 ${label} ${zoneLabel(code, z)} iko ${pips(price - z.price)} pips kutoka bei — *kabla ya SL*. Ikishikilia, trade inaweza kuokoka; ikivunjika, SL itaguswa.`);
  } else if (slPrice != null) {
    out.push(`🧭 ${label} ${zoneLabel(code, z)} iko ${pips(price - z.price)} pips kutoka bei, lakini *SL iko karibu zaidi* kuliko zone — SL inaweza kuguswa kabla zone haijapimwa.`);
    const level = buy ? z.low - 0.25 * atr : z.high + 0.25 * atr;
    const extra = buy ? price - level : level - price;
    if (extra > 0 && notional > 0) {
      const newLoss = -Number(profit) + (extra / price) * notional;
      out.push(`🔧 Chaguo: SL nyuma ya zone (≈ ${level.toFixed(dp(code))}) ingekuwa hasara ya juu ≈ $${f2(newLoss)}. ⚠️ Hii *inaongeza hatari* — amua kwa makini.`);
    }
  } else {
    out.push(`🧭 ${label} iliyo karibu: ${zoneLabel(code, z)} (${pips(price - z.price)} pips kutoka bei).`);
  }
  return out;
}

/** Ujumbe wa onyo la SL. */
function formatSlAlert(kind, d) {
  const { code, direction, contractId, profit, risk, stopPnl, pipsToSl, adviceLines } = d;
  if (kind === 'recovered') {
    return `✅ *TRADE IMEREJEA — ${code}*\n\nHasara imepungua hadi ${risk.lossPct.toFixed(0)}% ya SL (hasara $${f2(risk.loss)} / SL $${f2(risk.lossBudget)}).\nOnyo litatumwa tena ikikaribia SL.\n🆔 ${contractId}`;
  }
  const danger = kind === 'danger';
  return `${danger ? '🚨 *HATARI — SL KARIBU SANA*' : '⚠️ *TRADE INAKARIBIA SL*'} — ${code} ${direction === 'BUY' ? '🟢 BUY' : '🔴 SELL'}\n\n` +
    `Hasara ya sasa: -$${f2(risk.loss)} (${risk.lossPct.toFixed(0)}% ya SL $${f2(risk.lossBudget)})\n` +
    `Imebaki hadi SL: $${f2(risk.remaining)}${pipsToSl != null ? ` ≈ ${pipsToSl.toFixed(1)} pips` : ''}\n` +
    (adviceLines && adviceLines.length ? `\n${adviceLines.join('\n')}\n` : '') +
    `\n💡 Kusogeza SL: Dashboard → Trades wazi → Edit SL, au funga kwa *.fxclose*.\n🆔 Contract ID: ${contractId}\n_Hii SI ushauri wa kifedha._`;
}

module.exports = {
  CFG, createTracker, zoneKey, distToZone, formatEvent, tradeContextLine,
  slRisk, slAlertDecision, priceDistanceForUsd, slAdviceLines, formatSlAlert,
};
