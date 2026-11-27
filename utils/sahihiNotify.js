'use strict';
// Arifa za WhatsApp kutoka mfumo wa Sahihi (PHP, hosting tofauti) → bot.
// Usalama: HMAC-SHA256 ya `${timestamp}.${rawBody}` kwa SAHIHI_NOTIFY_SECRET + dirisha la muda.
const crypto = require('crypto');

const WINDOW_MS = 5 * 60 * 1000;
const PER_PHONE_MS = 20 * 1000;      // arifa 1 kwa namba kila sekunde 20
const GLOBAL_PER_MIN = 60;           // jumla ya arifa kwa dakika
const REF_TTL_MS = 24 * 3600 * 1000; // dedupe ya ref

const seenRefs = new Map();
const lastByPhone = new Map();
let globalHits = [];

function secret() { return process.env.SAHIHI_NOTIFY_SECRET || ''; }

function sign(ts, rawBody, sec = secret()) {
  return crypto.createHmac('sha256', sec).update(`${ts}.${rawBody}`).digest('hex');
}

function verify(rawBody, headers, now = Date.now()) {
  const sec = secret();
  if (!sec || sec.length < 16) return { ok: false, code: 503, error: 'SAHIHI_NOTIFY_SECRET haijawekwa (angalau herufi 16).' };
  const ts = String(headers['x-notify-timestamp'] || '');
  const sig = String(headers['x-notify-signature'] || '');
  if (!/^\d{10,13}$/.test(ts) || !/^[0-9a-f]{64}$/i.test(sig)) return { ok: false, code: 401, error: 'Saini haipo.' };
  const tsMs = ts.length <= 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs(now - tsMs) > WINDOW_MS) return { ok: false, code: 401, error: 'Muda umepita.' };
  const a = Buffer.from(sign(ts, rawBody, sec), 'hex');
  const b = Buffer.from(sig.toLowerCase(), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: 401, error: 'Saini si sahihi.' };
  return { ok: true };
}

// 0712345678 | 712345678 | +255712345678 | 255712345678 → 255712345678
function normalizePhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = '255' + d.slice(1);
  else if (d.length === 9 && /^[67]/.test(d)) d = '255' + d;
  return /^255[67]\d{8}$/.test(d) ? d : null;
}

function clean(s, n = 80) {
  return String(s == null ? '' : s).replace(/[\r\n\t*_~`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

const EVENTS = ['pdf.downloaded', 'topup.success', 'topup.failed', 'bonus.admin'];
const tsh = (n) => 'Tsh ' + Number(n).toLocaleString('en-US');
const hasNum = (v) => v != null && v !== '' && Number.isFinite(Number(v));

function buildText(b) {
  const L = [];
  const bal = () => { if (hasNum(b.balance)) L.push(`💰 Salio lako sasa: *${tsh(b.balance)}*`); };
  switch (b.event) {
    case 'topup.success':
      L.push('🎉 *Malipo yamepokelewa!*', '');
      if (hasNum(b.amount)) L.push(`✅ Umeongeza: *${tsh(b.amount)}*`);
      bal();
      if (hasNum(b.downloads_left)) L.push(`📥 Unaweza kupakua PDF *${b.downloads_left}* bila kikomo cha muda`);
      L.push('', 'Asante kwa kuamini Sahihi 🙏 Pakua sasa bila watermark!');
      break;
    case 'topup.failed':
      L.push('⚠️ *Malipo hayakukamilika*', '');
      if (hasNum(b.amount)) L.push(`Ombi la ${tsh(b.amount)} halikufanikiwa. Hakuna kiasi kilichokatwa kwenye salio lako la Sahihi.`);
      L.push('', 'Jaribu tena:', '• Hakikisha una salio la kutosha kwenye simu', '• Thibitisha kwa PIN ukiombwa', '• Ukikatwa pesa lakini salio halijaongezeka, tuandikie na utapata msaada.');
      break;
    case 'bonus.admin':
      L.push('🎁 *Umepata zawadi!*', '');
      if (hasNum(b.amount)) L.push(`✨ Umeongezewa *${tsh(b.amount)}* kama bonus`);
      bal();
      L.push('', 'Karibu ufurahie huduma za Sahihi 💚');
      break;
    default: { // pdf.downloaded
      L.push('✅ *PDF yako iko tayari!*', '');
      if (b.title) L.push(`📄 ${clean(b.title, 100)}`);
      if (hasNum(b.charged) && Number(b.charged) > 0) L.push(`💳 Imekatwa: ${tsh(b.charged)}`);
      else if (b.free) L.push('🆓 Export ya bure (ina watermark). Ongeza salio upate PDF safi bila watermark.');
      bal();
      L.push('', 'Asante kutumia Sahihi 🙏');
    }
  }
  return L.join('\n');
}

async function handle(rawBody, headers, { sock = global.currentSock, now = Date.now() } = {}) {
  const v = verify(rawBody, headers, now);
  if (!v.ok) return { status: v.code, body: { ok: false, error: v.error } };

  let b;
  try { b = JSON.parse(rawBody); } catch { return { status: 400, body: { ok: false, error: 'Invalid JSON' } }; }
  if (!b || !EVENTS.includes(b.event)) return { status: 200, body: { ok: true, ignored: true } };

  const phone = normalizePhone(b.phone);
  if (!phone) return { status: 422, body: { ok: false, error: 'Namba si sahihi.' } };

  const ref = clean(b.ref, 64);
  for (const [k, t] of seenRefs) if (now - t > REF_TTL_MS) seenRefs.delete(k);
  if (ref && seenRefs.has(ref)) return { status: 200, body: { ok: true, duplicate: true } };

  globalHits = globalHits.filter((t) => now - t < 60000);
  if (globalHits.length >= GLOBAL_PER_MIN) return { status: 429, body: { ok: false, error: 'Kikomo cha jumla.' } };
  if (now - (lastByPhone.get(phone + '|' + b.event) || 0) < PER_PHONE_MS) return { status: 429, body: { ok: false, error: 'Kikomo cha namba.' } };

  if (!sock) return { status: 503, body: { ok: false, error: 'Bot haijaunganishwa na WhatsApp.' } };

  let jid = `${phone}@s.whatsapp.net`;
  try {
    if (typeof sock.onWhatsApp === 'function') {
      const r = await sock.onWhatsApp(jid);
      if (!r || !r[0] || !r[0].exists) return { status: 200, body: { ok: true, sent: false, reason: 'not_on_whatsapp' } };
      jid = r[0].jid || jid;
    }
    await sock.sendMessage(jid, { text: buildText(b) });
  } catch (e) {
    return { status: 502, body: { ok: false, error: 'Kutuma kumeshindwa: ' + (e.message || e) } };
  }
  if (ref) seenRefs.set(ref, now);
  lastByPhone.set(phone + '|' + b.event, now);
  globalHits.push(now);
  return { status: 200, body: { ok: true, sent: true } };
}

module.exports = { EVENTS, handle, verify, sign, normalizePhone, buildText };
