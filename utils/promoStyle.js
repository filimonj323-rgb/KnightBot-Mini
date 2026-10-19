/**
 * promoStyle.js — mpangilio wa kisasa wa jumbe za Antipromo.
 * `fancy()` hubadilisha herufi/namba kuwa Unicode "Sans Bold" (𝗔𝗻𝘁𝗶𝗽𝗿𝗼𝗺𝗼) —
 * inaonekana tofauti na jumbe za kawaida za WhatsApp kwenye simu zote.
 * Tumia kwa vichwa na maneno muhimu tu (si kwa @mention).
 */
function fancy(text) {
  return Array.from(String(text)).map((ch) => {
    const c = ch.codePointAt(0);
    if (c >= 65 && c <= 90) return String.fromCodePoint(0x1D5D4 + (c - 65));   // A-Z
    if (c >= 97 && c <= 122) return String.fromCodePoint(0x1D5EE + (c - 97));  // a-z
    if (c >= 48 && c <= 57) return String.fromCodePoint(0x1D7EC + (c - 48));   // 0-9
    return ch;
  }).join('');
}

const LINE = '━━━━━━━━━━━━━━━━━━';

function kickMessage(tag, reason, max) {
  return [
    `🚫 ${fancy('ANTIPROMO')}`,
    LINE,
    `${tag} anatolewa kwenye group kwa kutuma matangazo (*${reason}*) mara *${max}*. Bila ruhusa ya admin.`,
    '',
    `⏳ ${fancy('Atatolewa kwa saa 24')}, kisha mfumo wetu utamrudisha kwenye group kiotomatiki.`,
    LINE,
    '_Heshimu sheria za group._',
  ].join('\n');
}

function warnMessage(tag, reason, count, max) {
  return [
    `⚠️ ${fancy('ANTIPROMO ONYO')}`,
    LINE,
    `${tag} — ujumbe wako umefutwa (*${reason}*).`,
    `📊 ${fancy('Onyo')}: *${count}/${max}*`,
    '',
    'Ukivuka kiwango, utatolewa kwenye group kwa *saa 24*.',
    LINE,
  ].join('\n');
}

function rejoinMessage(tag) {
  return [
    `✅ ${fancy('AMERUDISHWA')}`,
    LINE,
    `${tag} karibu tena! Muda wako wa saa 24 umeisha na mfumo wetu umekurudisha kwenye group.`,
    '',
    '📌 Tafadhali usitume matangazo bila ruhusa ya admin.',
    LINE,
  ].join('\n');
}

function inviteMessage(link) {
  return [
    `✅ ${fancy('MUDA UMEISHA')}`,
    LINE,
    'Muda wako wa saa 24 umeisha. Unaweza kurudi kwenye group kupitia link hii:',
    '',
    `🔗 ${link}`,
    LINE,
    '_Tafadhali usitume matangazo bila ruhusa ya admin._',
  ].join('\n');
}

module.exports = { fancy, kickMessage, warnMessage, rejoinMessage, inviteMessage };
