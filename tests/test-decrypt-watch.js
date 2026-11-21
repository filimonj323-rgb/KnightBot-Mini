// node tests/test-decrypt-watch.js "$(pwd)"
const assert = require('assert');
const { createDecryptWatch, isUndecryptable } = require(process.argv[2] + '/lib/decryptWatch.js');
let n = 0; const ok = (name, f) => { f(); n++; console.log('  ✓', name); };
const MIN = 60000, H = 3600000;
ok('inaponya baada ya kushindwa 8 ndani ya dk 10 bila ujumbe hata mmoja uliosomeka', () => {
  const w = createDecryptWatch(); const t = 1e12;
  for (let i = 0; i < 7; i++) w.fail(t + i * 1000);
  assert.strictEqual(w.shouldHeal(t + 8000), false);
  w.fail(t + 8000);
  assert.strictEqual(w.shouldHeal(t + 9000), true);
});
ok('hapaponywi ikiwa angalau ujumbe mmoja ulisomeka (si tatizo la session nzima)', () => {
  const w = createDecryptWatch(); const t = 1e12;
  w.ok(t); for (let i = 0; i < 20; i++) w.fail(t + 1000 + i);
  assert.strictEqual(w.shouldHeal(t + 5000), false);
});
ok('kushindwa kwa zamani (nje ya dirisha la dk 10) hakuhesabiwi', () => {
  const w = createDecryptWatch(); const t = 1e12;
  for (let i = 0; i < 8; i++) w.fail(t + i);
  assert.strictEqual(w.shouldHeal(t + 11 * MIN), false);
});
ok('cooldown: baada ya kuponya, haiponyi tena kwa saa 6', () => {
  const w = createDecryptWatch(); const t = 1e12;
  for (let i = 0; i < 8; i++) w.fail(t + i); assert.ok(w.shouldHeal(t + 10)); w.healed(t + 10);
  for (let i = 0; i < 8; i++) w.fail(t + 20 + i);
  assert.strictEqual(w.shouldHeal(t + 100), false);
  const later = t + 6 * H + 1000; for (let i = 0; i < 8; i++) w.fail(later + i);
  assert.strictEqual(w.shouldHeal(later + 50), true);
});
ok('isUndecryptable: stub CIPHERTEXT bila message = ndiyo; status/ujumbe wenye message/stub nyingine = hapana', () => {
  assert.strictEqual(isUndecryptable({ key: { remoteJid: 'a@s.whatsapp.net' }, messageStubType: 2 }), true);
  assert.strictEqual(isUndecryptable({ key: { remoteJid: 'a@s.whatsapp.net' }, messageStubType: 'CIPHERTEXT' }), true);
  assert.strictEqual(isUndecryptable({ key: { remoteJid: 'status@broadcast' }, messageStubType: 2 }), false);
  assert.strictEqual(isUndecryptable({ key: {}, message: { conversation: 'x' }, messageStubType: 2 }), false);
  assert.strictEqual(isUndecryptable({ key: {}, messageStubType: 20 }), false);
});
console.log(`\nOK — ${n} majaribio ya decryptWatch yamepita`);
