// Majaribio ya hatua (a): derivCrypto / derivPin / derivValidate / derivAccounts.
// DB = node:sqlite (DDL halisi kutoka pairing/db.js). Deriv = server bandia ya http ya ndani.
// axios = shim ndogo (registry ya npm inazuia axios hapa) — haijaribu axios halisi.
const path = require('path');
const fs = require('fs');
const http = require('http');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');
const assert = require('assert');

const ROOT = process.argv[2];
const R = (p) => path.join(ROOT, p);

// ---- capture logs (kuhakikisha hakuna siri kwenye logs) ----
const logs = [];
for (const k of ['log', 'warn', 'error']) {
  const o = console[k].bind(console);
  console[k] = (...a) => { logs.push(a.map(String).join(' ')); if (process.env.SHOWLOGS) o(...a); };
}
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

// ---- DB mock ----
const ddl = fs.readFileSync(R('pairing/db.js'), 'utf8');
const getDDL = (name) => {
  const m = new RegExp('`(CREATE TABLE IF NOT EXISTS ' + name + ' \\([\\s\\S]*?\\))`').exec(ddl);
  assert(m, 'DDL ya ' + name + ' haikupatikana');
  return m[1];
};
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(getDDL('deriv_accounts'));
sqlite.exec(getDDL('fx_auto_settings'));
let failDb = false;
const dbMock = {
  async query(sql, args = []) {
    if (failDb) throw new Error('DB chini');
    const st = sqlite.prepare(sql);
    if (/^\s*select/i.test(sql)) return { rows: st.all(...args).map((r) => ({ ...r })) };
    const r = st.run(...args);
    return { rows: [], rowsAffected: r.changes };
  },
};
const dbPath = require.resolve(R('pairing/db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

// ---- axios shim ----
const axiosShim = {
  get(url, { headers = {}, timeout = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { headers, timeout }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => { let d = b; try { d = JSON.parse(b); } catch {} resolve({ status: res.statusCode, data: d }); });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    });
  },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'axios') return '__axios_shim__';
  return origResolve.call(this, request, ...rest);
};
require.cache['__axios_shim__'] = { id: '__axios_shim__', filename: '__axios_shim__', loaded: true, exports: axiosShim };

// ---- Deriv bandia ----
const seenAuth = [];
const fake = http.createServer((req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  seenAuth.push({ auth, app: req.headers['deriv-app-id'], url: req.url });
  const j = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  switch (auth) {
    case 'demo-token-aaaa1111': return j(200, { data: [{ account_id: 'VRTC123456', is_virtual: true, currency: 'usd', balance: 10000 }] });
    case 'demo-token-aaaa2222': return j(200, { data: [{ account_id: 'VRTC999999', is_virtual: true, currency: 'USD', balance: 500 }] });
    case 'real-token-bbbb1111': return j(200, { data: [{ account_id: 'CR456789', is_virtual: false, currency: 'USD', balance: 50 }] });
    case 'mixed-token-cccc1111': return j(200, { data: [{ account_id: 'CR1111', is_virtual: false }, { account_id: 'VRTC7777', is_virtual: true, currency: 'USD' }] });
    case 'conflict-token-dd11': return j(200, { data: [{ account_id: 'CR789', is_virtual: true }] });
    case 'prefixconf-token-ee1': return j(200, { data: [{ account_id: 'VRTC555', is_virtual: false }] });
    case 'noflag-token-ffff1111': return j(200, { data: [{ account_id: 'X123' }] });
    case 'bad-token-gggg1111': return j(401, { error: 'unauthorized' });
    case 'down-token-hhhh1111': return j(500, { error: 'boom' });
    case 'empty-token-iiii1111': return j(200, { data: [] });
    default: return j(401, {});
  }
});

const results = [];
async function t(name, fn) {
  try { await fn(); results.push([true, name]); out('  ✓', name); }
  catch (e) { results.push([false, name, e]); out('  ✗', name, '\n     ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e); }
}
async function rejects(fn, code) {
  try { await fn(); } catch (e) { if (code) assert.strictEqual(e.code, code, `code ilitarajiwa ${code}, ikapata ${e.code} (${e.message})`); return e; }
  assert.fail('ilitarajiwa kutupa error' + (code ? ' ' + code : ''));
}

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.DERIV_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.DERIV_APP_ID = 'app12345';
  delete process.env.TOKENVAULT_KEY;

  const vault = require(R('utils/derivCrypto.js'));
  const pins = require(R('utils/derivPin.js'));
  const { validateToken, classify } = require(R('utils/derivValidate.js'));
  const A = require(R('utils/derivAccounts.js'));

  const P = '255700000001';
  const P2 = '255700000002';
  const GOODKEY = 'a'.repeat(64);
  const ALLTOK = ['demo-token-aaaa1111', 'demo-token-aaaa2222', 'real-token-bbbb1111', 'bad-token-gggg1111', 'mixed-token-cccc1111'];

  out('\n[1] Vault / usimbaji');
  await t('bila TOKENVAULT_KEY: encrypt inatupa (fail-closed)', async () => {
    assert.strictEqual(vault.isConfigured(), false);
    assert.throws(() => vault.encrypt('x', P), /TOKENVAULT_KEY/);
  });
  await t('bila ufunguo: setPin na connect zinakataa VAULT_OFF', async () => {
    await rejects(() => A.setPin(P, '4829'), 'VAULT_OFF');
    await rejects(() => A.connect(P, 'demo-token-aaaa1111', '4829'), 'VAULT_OFF');
  });
  await t('ufunguo batili (urefu mbaya) unakataliwa', async () => {
    process.env.TOKENVAULT_KEY = 'abc';
    assert.strictEqual(vault.isConfigured(), false);
    process.env.TOKENVAULT_KEY = 'z'.repeat(64);
    assert.strictEqual(vault.isConfigured(), false);
  });
  process.env.TOKENVAULT_KEY = GOODKEY;
  await t('roundtrip + ciphertext tofauti kila mara + haina plaintext', async () => {
    const a = vault.encrypt('secret-token-123', P), b = vault.encrypt('secret-token-123', P);
    assert.notStrictEqual(a, b);
    assert(!a.includes('secret-token-123'));
    assert.strictEqual(vault.decrypt(a, P), 'secret-token-123');
  });
  await t('AAD: ciphertext ya mteja A haisomeki kwa mteja B', async () => {
    const a = vault.encrypt('secret-token-123', P);
    assert.throws(() => vault.decrypt(a, P2), /Imeshindwa kufungua/);
  });
  await t('ciphertext iliyochezewa (tamper) inakataliwa', async () => {
    const a = vault.encrypt('secret-token-123', P).split('.');
    a[3] = a[3].slice(0, -2) + (a[3].endsWith('AA') ? 'BB' : 'AA');
    assert.throws(() => vault.decrypt(a.join('.'), P));
  });
  await t('ufunguo tofauti hauwezi kufungua', async () => {
    const a = vault.encrypt('secret-token-123', P);
    process.env.TOKENVAULT_KEY = 'b'.repeat(64);
    assert.throws(() => vault.decrypt(a, P));
    process.env.TOKENVAULT_KEY = GOODKEY;
  });
  await t('base64 key (baiti 32) inakubaliwa', async () => {
    const k = Buffer.alloc(32, 7).toString('base64');
    process.env.TOKENVAULT_KEY = k;
    assert.strictEqual(vault.decrypt(vault.encrypt('x1', P), P), 'x1');
    process.env.TOKENVAULT_KEY = GOODKEY;
  });
  await t('hint inaonyesha herufi 4 tu', async () => assert.strictEqual(vault.hint('abcdefgh1234'), '…1234'));

  out('\n[2] PIN');
  await t('PIN dhaifu/batili zinakataliwa', async () => {
    for (const p of ['123', '12345678901', 'abcd', '0000', '1234', '4321', '123456', '7777', '']) assert(pins.formatError(p), 'ilipaswa kukataliwa: ' + p);
    for (const p of ['4829', '730194', '90210']) assert.strictEqual(pins.formatError(p), null);
  });
  await t('hash/verify + salt tofauti + hash haina PIN', async () => {
    const h1 = await pins.hashPin('4829'), h2 = await pins.hashPin('4829');
    assert.notStrictEqual(h1, h2);
    assert(await pins.verifyPinHash('4829', h1));
    assert(!(await pins.verifyPinHash('4828', h1)));
    assert(!(await pins.verifyPinHash('4829', 'garbage')));
    assert(!h1.includes('4829'));
  });
  await t('pepper: hash ya ufunguo mwingine haithibitiki', async () => {
    const h = await pins.hashPin('4829');
    process.env.TOKENVAULT_KEY = 'c'.repeat(64);
    assert(!(await pins.verifyPinHash('4829', h)));
    process.env.TOKENVAULT_KEY = GOODKEY;
  });
  await t('PIN ya muda: tarakimu 6 na si dhaifu (mara 300)', async () => {
    for (let i = 0; i < 300; i++) { const p = pins.generateTempPin(); assert(/^\d{6}$/.test(p) && !pins.formatError(p)); }
  });

  out('\n[3] Mtiririko wa mteja');
  await t('connect bila PIN kuwekwa → NO_PIN', async () => rejects(() => A.connect(P, 'demo-token-aaaa1111', '4829'), 'NO_PIN'));
  await t('setPin ya kwanza inafanya kazi; PIN dhaifu inakataliwa', async () => {
    await rejects(() => A.setPin(P, '1234'), 'PIN_FORMAT');
    const a = await A.setPin(P, '4829');
    assert.strictEqual(a.hasPin, true);
  });
  await t('kubadilisha PIN kunahitaji ya zamani; ileile inakataliwa', async () => {
    await rejects(() => A.setPin(P, '7391', '0000'), 'PIN_WRONG');
    await rejects(() => A.setPin(P, '4829', '4829'), 'PIN_SAME');
    await A.setPin(P, '7391', '4829');
    await A.setPin(P, '4829', '7391');
  });
  await t('connect kwa PIN mbaya → PIN_WRONG, hakuna ombi kwa Deriv', async () => {
    const before = seenAuth.length;
    await rejects(() => A.connect(P, 'demo-token-aaaa1111', '1111'), 'PIN_WRONG');
    assert.strictEqual(seenAuth.length, before);
  });
  await t('connect demo → active, token imesimbwa DB, public haina siri', async () => {
    const r = await A.connect(P, 'demo-token-aaaa1111', '4829');
    assert.strictEqual(r.account.connected, true);
    assert.strictEqual(r.account.isDemo, true);
    assert.strictEqual(r.account.status, 'active');
    assert.strictEqual(r.account.currency, 'USD');
    assert.strictEqual(r.balance, 10000);
    assert.strictEqual(r.account.tokenHint, '…1111');
    assert.notStrictEqual(r.account.accountIdMasked, 'VRTC123456');
    assert.strictEqual(r.account.adminApproved, false);
    assert.strictEqual(r.account.userEnabled, false);
    const raw = sqlite.prepare('SELECT * FROM deriv_accounts WHERE phoneNumber=?').get(P);
    assert(!JSON.stringify(raw).includes('demo-token-aaaa1111'), 'token wazi kwenye DB!');
    assert(raw.encToken.startsWith('v1.'));
    const j = JSON.stringify(r.account);
    assert(!j.includes('encToken') && !j.includes('pinHash') && !j.includes('v1.') && !j.includes('s1$'));
    assert(!j.includes('VRTC123456'));
  });
  await t('Deriv ilipokea Authorization + App-ID sahihi', async () => {
    const last = seenAuth.filter((s) => s.auth === 'demo-token-aaaa1111').pop();
    assert.strictEqual(last.app, 'app12345');
    assert(last.url.includes('/trading/v1/options/accounts'));
  });

  out('\n[4] Uthibitisho wa akaunti (fail-closed)');
  const P3 = '255700000003';
  await A.setPin(P3, '5920');
  const cases = [
    ['real-token-bbbb1111', 'REAL_NOT_ALLOWED', /REAL/],
    ['conflict-token-dd11', 'UNKNOWN_TYPE', /DEMO/],
    ['prefixconf-token-ee1', 'UNKNOWN_TYPE', /DEMO/],
    ['noflag-token-ffff1111', 'UNKNOWN_TYPE', /DEMO/],
    ['bad-token-gggg1111', 'REJECTED', /imekataa/],
    ['down-token-hhhh1111', 'UPSTREAM', /hitilafu/],
    ['empty-token-iiii1111', 'NO_ACCOUNTS', /Hakuna/],
    ['short', 'BAD_SHAPE', /sahihi/],
    ['has space in token 1', 'BAD_SHAPE', /sahihi/],
  ];
  for (const [tok, code, rx] of cases) {
    await t(`token "${tok}" → ${code}`, async () => {
      const e = await rejects(() => A.connect(P3, tok, '5920'), code);
      assert(rx.test(e.userMessage), e.userMessage);
      assert(!e.userMessage.includes(tok) || tok === 'short', 'ujumbe una token!');
      const row = sqlite.prepare('SELECT encToken FROM deriv_accounts WHERE phoneNumber=?').get(P3);
      assert.strictEqual(row.encToken, null, 'hakuna kitu kilichohifadhiwa');
    });
  }
  await t('akaunti mchanganyiko (real+demo) → inachagua DEMO', async () => {
    const info = await validateToken('mixed-token-cccc1111');
    assert.strictEqual(info.accountId, 'VRTC7777');
    assert.strictEqual(info.isDemo, true);
  });
  await t('hakuna DERIV_APP_ID → NO_APP_ID, bila ombi la mtandao', async () => {
    const keep = process.env.DERIV_APP_ID; delete process.env.DERIV_APP_ID;
    const before = seenAuth.length;
    const e = await rejects(() => validateToken('demo-token-aaaa1111'));
    assert.strictEqual(e.code, 'NO_APP_ID'); assert.strictEqual(seenAuth.length, before);
    process.env.DERIV_APP_ID = keep;
  });
  await t('mtandao umekufa → NETWORK, ujumbe hauna token', async () => {
    const keep = process.env.DERIV_API_BASE;
    // server iliyofungwa: tumia port isiyosikiliza
    const dead = http.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r)); const port = dead.address().port; await new Promise((r) => dead.close(r));
    // derivValidate imesoma API_BASE wakati wa load — pakia nakala safi
    const p = require.resolve(R('utils/derivValidate.js'));
    const saved = require.cache[p]; delete require.cache[p];
    process.env.DERIV_API_BASE = `http://127.0.0.1:${port}`;
    const v2 = require(R('utils/derivValidate.js'));
    const e = await rejects(() => v2.validateToken('demo-token-aaaa1111'));
    assert.strictEqual(e.code, 'NETWORK'); assert(!e.userMessage.includes('demo-token'));
    delete require.cache[p]; require.cache[p] = saved; process.env.DERIV_API_BASE = keep;
  });
  await t('classify: bendera nyingi zinazopingana → null', async () => {
    assert.strictEqual(classify({ account_id: 'Z1', is_virtual: true, account_type: 'real' }).demo, null);
    assert.strictEqual(classify({ account_id: 'VRTC1', account_type: 'demo' }).demo, true);
    assert.strictEqual(classify({ account_id: 'CR1', is_virtual: 0 }).demo, false);
  });
  await t('real inaruhusiwa TU admin akitoa realAllowed', async () => {
    await A.adminAction(P3, 'allow_real');
    const r = await A.connect(P3, 'real-token-bbbb1111', '5920');
    assert.strictEqual(r.account.isDemo, false);
    assert.strictEqual((await A.canTrade(P3)).ok, false); // bado haijaidhinishwa
    await A.adminAction(P3, 'deny_real'); // inamfungia kabisa kwa kuwa akaunti ni real
    const row = sqlite.prepare('SELECT * FROM deriv_accounts WHERE phoneNumber=?').get(P3);
    assert.strictEqual(row.realAllowed, 0); assert.strictEqual(row.adminApproved, 0);
    assert.strictEqual((await A.canTrade(P3)).reason, 'real_not_allowed'); // real bila ruhusa inakataliwa kwanza
  });
  await t('canTrade: real_not_allowed hata ikiidhinishwa kwa nguvu kwenye DB', async () => {
    sqlite.prepare('UPDATE deriv_accounts SET adminApproved=1,userEnabled=1 WHERE phoneNumber=?').run(P3);
    assert.strictEqual((await A.canTrade(P3)).reason, 'real_not_allowed');
    await A.disconnect(P3);
  });

  out('\n[5] Swichi + lango la canTrade');
  await t('canTrade: not_approved → (approve) → user_disabled → (washa) → ok', async () => {
    assert.strictEqual((await A.canTrade(P)).reason, 'not_approved');
    await A.adminAction(P, 'approve');
    assert.strictEqual((await A.canTrade(P)).reason, 'user_disabled');
    await rejects(() => A.setSwitches(P, { userEnabled: true, pin: '0000' }), 'PIN_WRONG');
    await rejects(() => A.setSwitches(P, { userEnabled: true }), 'PIN_WRONG');
    await A.setSwitches(P, { userEnabled: true, pin: '4829' });
    const g = await A.canTrade(P);
    assert.strictEqual(g.ok, true); assert.strictEqual(g.isDemo, true);
    assert.deepStrictEqual(g.limits, { maxStake: 5, maxTradesDay: 5, maxDailyLoss: 10, maxOpen: 2 });
  });
  await t('kuwasha bila idhini ya admin → NOT_APPROVED (mteja mwingine)', async () => {
    await A.setPin(P2, '3857'); await A.connect(P2, 'demo-token-aaaa2222', '3857');
    await rejects(() => A.setSwitches(P2, { userEnabled: true, pin: '3857' }), 'NOT_APPROVED');
  });
  await t('auto: inahitaji autoApproved; kisha autoEnabled → canTrade(auto) ok', async () => {
    assert.strictEqual((await A.canTrade(P, { auto: true })).reason, 'auto_off');
    await rejects(() => A.setSwitches(P, { autoEnabled: true, pin: '4829' }), 'AUTO_NOT_APPROVED');
    await rejects(() => A.adminAction(P2, 'approve_auto'), 'NOT_APPROVED');
    await A.adminAction(P, 'approve_auto');
    await A.setSwitches(P, { autoEnabled: true, pin: '4829' });
    assert.strictEqual((await A.canTrade(P, { auto: true })).ok, true);
  });
  await t('mteja anazima auto bila PIN; trading inabaki', async () => {
    await A.setSwitches(P, { autoEnabled: false });
    assert.strictEqual((await A.canTrade(P, { auto: true })).reason, 'auto_off');
    assert.strictEqual((await A.canTrade(P)).ok, true);
  });
  await t('mteja akizima trading bila PIN → auto nayo inazimwa', async () => {
    await A.setSwitches(P, { autoEnabled: true, pin: '4829' });
    await A.setSwitches(P, { userEnabled: false });
    const a = await A.getPublic(P);
    assert.strictEqual(a.userEnabled, false); assert.strictEqual(a.autoEnabled, false);
    await A.setSwitches(P, { userEnabled: true, pin: '4829' });
  });
  await t('kill_all: canTrade inakataa kila mteja; kuwasha kunakataliwa; resume inarudisha', async () => {
    await A.adminAction('', 'kill_all');
    assert.strictEqual((await A.canTrade(P)).reason, 'kill_all');
    await A.setSwitches(P, { userEnabled: false });
    await rejects(() => A.setSwitches(P, { userEnabled: true, pin: '4829' }), 'KILLED');
    await A.adminAction('', 'resume_all');
    await A.setSwitches(P, { userEnabled: true, pin: '4829' });
    assert.strictEqual((await A.canTrade(P)).ok, true);
  });
  await t('revoke ya admin inazima kila kitu cha mteja huyo tu', async () => {
    await A.adminAction(P, 'revoke');
    assert.strictEqual((await A.canTrade(P)).reason, 'not_approved');
    const a = await A.getPublic(P);
    assert(!a.userEnabled && !a.autoApproved && !a.autoEnabled);
    await A.adminAction(P, 'approve'); await A.setSwitches(P, { userEnabled: true, pin: '4829' });
  });
  await t('reconnect akaunti ile ile inabakiza idhini; akaunti tofauti inaifuta', async () => {
    await A.connect(P, 'demo-token-aaaa1111', '4829');
    let a = await A.getPublic(P);
    assert.strictEqual(a.adminApproved, true); assert.strictEqual(a.userEnabled, false); // swichi zinaanza zimezimwa
    await A.setSwitches(P, { userEnabled: true, pin: '4829' });
    await A.connect(P, 'demo-token-aaaa2222', '4829'); // VRTC999999 ≠ VRTC123456
    a = await A.getPublic(P);
    assert.strictEqual(a.adminApproved, false); assert.strictEqual(a.userEnabled, false);
    assert.strictEqual((await A.canTrade(P)).ok, false);
    await A.connect(P, 'demo-token-aaaa1111', '4829'); await A.adminAction(P, 'approve'); await A.setSwitches(P, { userEnabled: true, pin: '4829' });
  });
  await t('markInvalid inazima swichi na canTrade inakataa', async () => {
    await A.markInvalid(P, 'Deriv 401');
    assert.strictEqual((await A.canTrade(P)).reason, 'inactive');
    const a = await A.getPublic(P); assert(!a.userEnabled && a.status === 'invalid');
    await A.connect(P, 'demo-token-aaaa1111', '4829'); await A.setSwitches(P, { userEnabled: true, pin: '4829' });
    assert.strictEqual((await A.canTrade(P)).ok, true);
  });

  out('\n[6] Token kwa trading + vikomo');
  await t('getTokenForTrading: inarudisha token pale tu canTrade ikipita', async () => {
    const r = await A.getTokenForTrading(P);
    assert.strictEqual(r.token, 'demo-token-aaaa1111'); assert.strictEqual(r.accountId, 'VRTC123456');
    await A.setSwitches(P, { userEnabled: false });
    const e = await rejects(() => A.getTokenForTrading(P), 'DENIED'); assert.strictEqual(e.reason, 'user_disabled');
    assert(!JSON.stringify(e).includes('demo-token'));
    await A.setSwitches(P, { userEnabled: true, pin: '4829' });
  });
  await t('ciphertext iliyonakiliwa kwa mteja mwingine haisomeki (AAD)', async () => {
    const enc = sqlite.prepare('SELECT encToken FROM deriv_accounts WHERE phoneNumber=?').get(P).encToken;
    sqlite.prepare('UPDATE deriv_accounts SET encToken=? WHERE phoneNumber=?').run(enc, P2);
    sqlite.prepare('UPDATE deriv_accounts SET adminApproved=1,userEnabled=1 WHERE phoneNumber=?').run(P2);
    const e = await rejects(() => A.getTokenForTrading(P2));
    assert(/Imeshindwa kufungua/.test(e.message), e.message);
    await A.disconnect(P2);
  });
  await t('set_limits: ndani ya kikomo OK; juu ya kikomo/namba mbaya zinakataliwa', async () => {
    await A.adminAction(P, 'set_limits', { limits: { maxStake: 10, maxTradesDay: 8, maxDailyLoss: 25, maxOpen: 3 } });
    assert.deepStrictEqual((await A.canTrade(P)).limits, { maxStake: 10, maxTradesDay: 8, maxDailyLoss: 25, maxOpen: 3 });
    await rejects(() => A.adminAction(P, 'set_limits', { limits: { maxStake: 21 } }), 'BAD_LIMIT');
    await rejects(() => A.adminAction(P, 'set_limits', { limits: { maxOpen: 6 } }), 'BAD_LIMIT');
    await rejects(() => A.adminAction(P, 'set_limits', { limits: { maxStake: -1 } }), 'BAD_LIMIT');
    await rejects(() => A.adminAction(P, 'set_limits', { limits: { maxStake: 'abc' } }), 'BAD_LIMIT');
    assert.strictEqual((await A.canTrade(P)).limits.maxStake, 10); // haijabadilika
  });

  out('\n[7] PIN lockout + admin reset');
  await t('majaribio 5 mabaya → PIN_LOCKED; sahihi pia inakataliwa wakati wa lock', async () => {
    for (let i = 0; i < 4; i++) await rejects(() => A.setSwitches(P, { userEnabled: true, pin: '0001' }), 'PIN_WRONG').catch(() => {});
    // userEnabled tayari true → washa tena kunahitaji PIN; tumia disconnect/enable mzunguko:
    await A.setSwitches(P, { userEnabled: false });
    sqlite.prepare('UPDATE deriv_accounts SET pinFails=0 WHERE phoneNumber=?').run(P);
    for (let i = 0; i < 4; i++) { const e = await rejects(() => A.setSwitches(P, { userEnabled: true, pin: '0001' }), 'PIN_WRONG'); assert(/Umebakiwa/.test(e.userMessage)); }
    await rejects(() => A.setSwitches(P, { userEnabled: true, pin: '0001' }), 'PIN_LOCKED');
    await rejects(() => A.setSwitches(P, { userEnabled: true, pin: '4829' }), 'PIN_LOCKED');
    const a = await A.getPublic(P); assert(a.pinLockedUntil > Date.now());
  });
  await t('lock ikiisha muda, PIN sahihi inafanya kazi na kuhesabu kunarudi 0', async () => {
    sqlite.prepare('UPDATE deriv_accounts SET pinLockedUntil=? WHERE phoneNumber=?').run(Date.now() - 1000, P);
    await A.setSwitches(P, { userEnabled: true, pin: '4829' });
    assert.strictEqual(sqlite.prepare('SELECT pinFails f FROM deriv_accounts WHERE phoneNumber=?').get(P).f, 0);
  });
  await t('admin reset_pin: PIN ya muda ya tarakimu 6, ya zamani haifanyi kazi, swichi zimezimwa', async () => {
    sqlite.prepare('UPDATE deriv_accounts SET pinLockedUntil=?,pinFails=3 WHERE phoneNumber=?').run(Date.now() + 99999, P); // mteja amefungwa
    const r = await A.adminAction(P, 'reset_pin');
    assert(/^\d{6}$/.test(r.tempPin));
    assert.strictEqual(r.account.mustChangePin, true); assert.strictEqual(r.account.pinLockedUntil, null);
    assert(!JSON.stringify(r.account).includes(r.tempPin));
    assert.strictEqual(r.account.userEnabled, false);
    assert.strictEqual((await A.canTrade(P)).reason, 'user_disabled');
    const raw = JSON.stringify(sqlite.prepare('SELECT * FROM deriv_accounts WHERE phoneNumber=?').get(P));
    assert(!raw.includes(r.tempPin), 'PIN ya muda imehifadhiwa wazi!');
    global.TEMP = r.tempPin;
  });
  await t('baada ya reset: PIN ya zamani inakataliwa; connect/toggle vinazuiwa hadi abadilishe', async () => {
    await rejects(() => A.setPin(P, '6283', '4829'), 'PIN_WRONG');
    await rejects(() => A.connect(P, 'demo-token-aaaa1111', global.TEMP), 'MUST_CHANGE_PIN');
    await rejects(() => A.setSwitches(P, { userEnabled: true, pin: global.TEMP }), 'MUST_CHANGE_PIN');
    await rejects(() => A.setPin(P, global.TEMP, global.TEMP), 'PIN_SAME');
  });
  await t('mteja anabadilisha PIN ya muda → mustChange inaondoka, PIN mpya inafanya kazi', async () => {
    const a = await A.setPin(P, '6283', global.TEMP);
    assert.strictEqual(a.mustChangePin, false);
    await A.setSwitches(P, { userEnabled: true, pin: '6283' });
    assert.strictEqual((await A.canTrade(P)).ok, true);
    await rejects(() => A.setPin(P, '7391', global.TEMP), 'PIN_WRONG'); // PIN ya muda haitumiki tena
  });
  await t('reset_pin kwa mteja asiyekuwepo → NOT_FOUND; action mbaya → BAD_ACTION', async () => {
    await rejects(() => A.adminAction('255799999999', 'reset_pin'), 'NOT_FOUND');
    await rejects(() => A.adminAction(P, 'foo'), 'BAD_ACTION');
    await rejects(() => A.adminAction('', 'approve'), 'NO_PHONE');
  });

  out('\n[8] Admin list / disconnect / remove');
  await t('adminList haina siri na inaonyesha kila mteja', async () => {
    const l = await A.adminList();
    assert(l.accounts.length >= 3); assert.strictEqual(typeof l.killAll, 'boolean'); assert.strictEqual(l.vaultReady, true);
    const j = JSON.stringify(l);
    assert(!/v1\.[A-Za-z0-9_-]+\.|s1\$|encToken|pinHash/.test(j));
    for (const tk of ALLTOK) assert(!j.includes(tk));
  });
  await t('disconnect: token inafutwa, swichi/idhini zote zinazimwa, bila PIN', async () => {
    const a = await A.disconnect(P);
    assert(!a.connected && !a.userEnabled && !a.adminApproved && a.status === 'none');
    const raw = sqlite.prepare('SELECT encToken,accountId FROM deriv_accounts WHERE phoneNumber=?').get(P);
    assert.strictEqual(raw.encToken, null); assert.strictEqual(raw.accountId, null);
    assert.strictEqual((await A.canTrade(P)).reason, 'not_connected');
  });
  await t('remove inafuta safu; getPublic ya mteja asiye na safu inarudisha hali tupu', async () => {
    await A.adminAction(P2, 'remove');
    const a = await A.getPublic(P2);
    assert(!a.connected && !a.hasPin && a.status === 'none');
  });

  out('\n[9] Fail-closed + rate limit + logs');
  await t('DB ikiharibika: canTrade inakataa, kill switch inahesabiwa ON', async () => {
    await A.connect(P, 'demo-token-aaaa1111', '6283'); await A.adminAction(P, 'approve'); await A.setSwitches(P, { userEnabled: true, pin: '6283' });
    assert.strictEqual((await A.canTrade(P)).ok, true);
    failDb = true;
    await new Promise((r) => setTimeout(r, 3100)); // cache ya kill switch iishe
    const g = await A.canTrade(P);
    assert.strictEqual(g.ok, false);
    assert.strictEqual(await A.getKillAll(true), true);
    failDb = false;
    assert.strictEqual(await A.getKillAll(true), false);
    assert.strictEqual((await A.canTrade(P)).ok, true);
  });
  await t('rateLimit: ya 13 ndani ya dakika inakataliwa (429)', async () => {
    for (let i = 0; i < 12; i++) A.rateLimit('k1', 12, 60000);
    const e = await rejects(async () => A.rateLimit('k1', 12, 60000), 'RATE_LIMIT');
    assert(/dakika moja/.test(e.userMessage));
    A.rateLimit('k2', 12, 60000); // ufunguo tofauti haujaathirika
  });
  await t('LOGS: hakuna token wala PIN (wala PIN ya muda) kwenye console', async () => {
    const all = logs.join('\n');
    for (const tk of ALLTOK.concat(['conflict-token-dd11', 'noflag-token-ffff1111'])) assert(!all.includes(tk), 'token kwenye log: ' + tk);
    for (const pin of ['4829', '7391', '3857', '5920', '6283', global.TEMP, GOODKEY]) assert(!all.includes(pin), 'siri kwenye log: ' + pin);
  });

  fake.close();
  const fail = results.filter((r) => !r[0]);
  out(`\n${results.length - fail.length}/${results.length} zimepita`);
  process.exit(fail.length ? 1 : 0);
})().catch((e) => { out('FATAL', e.stack); process.exit(2); });
