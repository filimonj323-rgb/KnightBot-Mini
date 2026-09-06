// lib/logger.js — logger ndogo, tofauti na `logger` ya pino inayopitishwa
// Baileys (ile lazima ibaki pino asilia). Hii ni kwa ujumbe wa ndani wa
// session-db.js pekee (info/warn/error).

const pino = require('pino');

function createLogger(name) {
  const base = pino({ level: process.env.LOG_LEVEL || 'info' });
  return base.child({ module: name });
}

module.exports = { createLogger };
