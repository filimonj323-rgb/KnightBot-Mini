// Jaribio la routes halisi za pairing/server.js (HTTP) — mteja + admin.
// Moduli nzito za mradi zimewekewa stubs; DB = node:sqlite; Deriv = server bandia; axios = shim.
const path = require('path'), fs = require('fs'), http = require('http'), Module = require('module');
const { DatabaseSync } = require('node:sqlite');
const assert = require('assert');
const ROOT = process.argv[2];
const R = (p) => path.join(ROOT, p);
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

const logs = [];
for (const k of ['log', 'warn', 'error']) console[k] = (...a) => logs.push(a.map(String).join(' '));

// ---- DB ----
const ddl = fs.readFileSync(R('pairing/db.js'), 'utf8');
const getDDL = (n) => /`(CREATE TABLE IF NOT EXISTS NAME \([\s\S]*?\))`/.source && new RegExp('`(CREATE TABLE IF NOT EXISTS ' + n + ' \\([\\s\\S]*?\\))`').exec(ddl)[1];
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(getDDL('deriv_accounts')); sqlite.exec(getDDL('fx_auto_settings'));
const dbMock = { async query(sql, a = []) { const st = sqlite.prepare(sql); if (/^\s*select/i.test(sql)) return { rows: st.all(...a).map((r) => ({ ...r })) }; return { rows: [], rowsAffected: st.run(...a).changes }; } };
const dbPath = R('pairing/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: dbMock };

// ---- axios shim ----
const axiosShim = { get(url, { headers = {}, timeout = 5000 } = {}) { return new Promise((res, rej) => { const rq = http.get(url, { headers, timeout }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { let d = b; try { d = JSON.parse(b); } catch {} res({ status: r.statusCode, data: d }); }); }); rq.on('error', rej); }); } };

// ---- stubs za moduli za mradi ----
const sent = [];
const PHONE = '255711000001';
const instanceStub = {
  async assertActiveForToken(tok) {
    if (/^tok-A/.test(tok)) return PHONE;
    if (tok === 'tok-blocked') throw new Error('🚫 Akaunti yako imezuiwa na msimamizi. Wasiliana naye kwa maelezo zaidi.');
    throw new Error('Dashboard link si sahihi. Tumia link uliyopewa baada ya kuunganisha.');
  },
  async sendToSelfChat(phone, text) { sent.push({ phone, text }); return phone === PHONE; },
};
const mk = () => { const f = function () {}; return new Proxy(f, { get: (t, k) => (k === 'then' || k === Symbol.toPrimitive ? undefined : mk()), apply: () => mk(), construct: () => mk() }); };
const KEEP = new Set(['pairing/server.js', 'pairing/adminAuth.js', 'pairing/pairingConfig.js', 'pairing/db.js', 'utils/derivAccounts.js', 'utils/derivCrypto.js', 'utils/derivPin.js', 'utils/derivValidate.js', 'utils/forexAccess.js']);
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return axiosShim;
  let resolved;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch { return mk(); }
  if (resolved.startsWith(ROOT)) {
    const rel = path.relative(ROOT, resolved);
    if (rel === 'pairing/instanceManager.js') return instanceStub;
    if (!KEEP.has(rel)) return mk();
  }
  return origLoad.apply(this, arguments);
};

const fake = http.createServer((req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  const j = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (auth === 'demo-token-aaaa1111') return j(200, { data: [{ account_id: 'VRTC123456', is_virtual: true, currency: 'USD', balance: 10000 }] });
  if (auth === 'real-token-bbbb1111') return j(200, { data: [{ account_id: 'CR456789', is_virtual: false }] });
  return j(401, {});
});

const results = [];
async function t(name, fn) { try { await fn(); results.push(1); out('  ✓', name); } catch (e) { results.push(0); out('  ✗', name, '\n     ', (e.stack || e).toString().split('\n').slice(0, 3).join('\n      ')); } }

(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.DERIV_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.DERIV_APP_ID = 'app12345';
  process.env.TOKENVAULT_KEY = 'd'.repeat(64);

  const srv = require(R('pairing/server.js'));
  const adminAuth = require(R('pairing/adminAuth.js'));
  const cfg = require(R('pairing/pairingConfig.js'));
  const web = http.createServer((q, s) => srv.handlePairingRequest(q, s));
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${web.address().port}`;
  const ADMIN = adminAuth.login(cfg.ADMIN_USERNAME, cfg.ADMIN_PASSWORD);
  assert(ADMIN, 'admin login imeshindwa');

  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; const text = await r.text(); try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text };
  };
  let TOK = 'tok-A';
  const cust = (sub, method = 'GET', body, tok = TOK) => call(method, `/api/dashboard/${tok}/deriv${sub ? '/' + sub : ''}`, body);
  const adm = (method, body) => call(method, '/api/admin/deriv', body, { authorization: 'Bearer ' + ADMIN });
  const noSecrets = (txt, extra = []) => { assert(!/encToken|pinHash|"v1\.|s1\$/.test(txt), 'siri kwenye jibu: ' + txt.slice(0, 200)); for (const x of extra) assert(!txt.includes(x), 'ina ' + x); };

  out('\n[A] Routes za mteja');
  await t('GET /deriv (mteja mpya) → hali tupu, vaultReady, bila siri', async () => {
    const r = await cust('');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.connected, false); assert.strictEqual(r.data.account.vaultReady, true);
    noSecrets(r.text);
  });
  await t('token ya dashboard batili → 400 + ujumbe', async () => {
    const r = await cust('', 'GET', undefined, 'bad'); assert.strictEqual(r.status, 400); assert(/Dashboard link/.test(r.data.error));
  });
  await t('mteja aliyezuiwa/muda umeisha → 400 + ujumbe (si 500)', async () => {
    const r = await cust('', 'GET', undefined, 'tok-blocked'); assert.strictEqual(r.status, 400); assert(/imezuiwa/.test(r.data.error));
    const p = await cust('connect', 'POST', { token: 'demo-token-aaaa1111', pin: '4829' }, 'tok-blocked'); assert.strictEqual(p.status, 400);
  });
  await t('connect kabla ya PIN → 400 NO_PIN', async () => {
    const r = await cust('connect', 'POST', { token: 'demo-token-aaaa1111', pin: '4829' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'NO_PIN');
  });
  await t('POST /pin: dhaifu inakataliwa; sahihi inafanya kazi', async () => {
    let r = await cust('pin', 'POST', { newPin: '1234' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'PIN_FORMAT');
    r = await cust('pin', 'POST', { newPin: '4829' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.hasPin, true); noSecrets(r.text, ['4829']);
  });
  await t('POST /connect (demo) → 200, jibu halina token wala accountId kamili', async () => {
    const r = await cust('connect', 'POST', { token: 'demo-token-aaaa1111', pin: '4829' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.isDemo, true); assert.strictEqual(r.data.balance, 10000);
    noSecrets(r.text, ['demo-token-aaaa1111', 'VRTC123456', '4829']);
  });
  await t('POST /connect (real) → 400 REAL_NOT_ALLOWED', async () => {
    const r = await cust('connect', 'POST', { token: 'real-token-bbbb1111', pin: '4829' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'REAL_NOT_ALLOWED');
    assert.strictEqual((await cust('')).data.account.isDemo, true); // akaunti ya demo bado ipo
  });
  await t('POST /toggle bila idhini ya admin → 400 NOT_APPROVED', async () => {
    const r = await cust('toggle', 'POST', { userEnabled: true, pin: '4829' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'NOT_APPROVED');
  });
  await t('GET kwenye route ya POST / sub-route isiyojulikana haidondoki vibaya', async () => {
    const r = await call('GET', `/api/dashboard/tok-A/deriv/connect`); assert(r.status !== 500, 'status ' + r.status);
    const r2 = await call('POST', `/api/dashboard/tok-A/deriv/foo`, {}); assert(r2.status !== 500);
  });

  out('\n[B] Routes za admin');
  TOK = 'tok-A-B';
  await t('bila Authorization → 401 (GET na POST)', async () => {
    assert.strictEqual((await call('GET', '/api/admin/deriv')).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/deriv', { action: 'kill_all' })).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/deriv', { action: 'reset_pin', phone: PHONE }, { authorization: 'Bearer feki.1.zz' })).status, 401);
  });
  await t('GET orodha: ina mteja, haina siri', async () => {
    const r = await adm('GET'); assert.strictEqual(r.status, 200); assert(r.data.accounts.some((a) => a.phoneNumber === PHONE)); assert.strictEqual(r.data.killAll, false);
    noSecrets(r.text, ['demo-token-aaaa1111', 'VRTC123456']);
  });
  await t('approve → mteja anaweza kuwasha trading kwa PIN', async () => {
    let r = await adm('POST', { action: 'approve', phone: PHONE }); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.adminApproved, true);
    r = await cust('toggle', 'POST', { userEnabled: true, pin: '4829' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.userEnabled, true);
    r = await cust('toggle', 'POST', { userEnabled: true, pin: '0000' }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'PIN_WRONG');
  });
  await t('auto: bila idhini → AUTO_NOT_APPROVED; baada ya approve_auto → inawashwa; kuzima bila PIN', async () => {
    let r = await cust('toggle', 'POST', { autoEnabled: true, pin: '4829' }); assert.strictEqual(r.data.code, 'AUTO_NOT_APPROVED');
    assert.strictEqual((await adm('POST', { action: 'approve_auto', phone: PHONE })).status, 200);
    r = await cust('toggle', 'POST', { autoEnabled: true, pin: '4829' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.autoEnabled, true);
    r = await cust('toggle', 'POST', { autoEnabled: false }); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.autoEnabled, false);
  });
  await t('set_limits kupitia HTTP + kikomo kigumu → 400', async () => {
    let r = await adm('POST', { action: 'set_limits', phone: PHONE, limits: { maxStake: 7, maxTradesDay: 4, maxDailyLoss: 12, maxOpen: 1 } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.limits.maxStake, 7);
    r = await adm('POST', { action: 'set_limits', phone: PHONE, limits: { maxStake: 9999 } }); assert.strictEqual(r.status, 400); assert.strictEqual(r.data.code, 'BAD_LIMIT');
  });
  await t('reset_pin (bila DM): admin anapata tempPin; mteja anazuiwa hadi abadilishe', async () => {
    sent.length = 0;
    const r = await adm('POST', { action: 'reset_pin', phone: PHONE });
    assert.strictEqual(r.status, 200); assert(/^\d{6}$/.test(r.data.tempPin)); assert.strictEqual(r.data.dmSent, false); assert.strictEqual(sent.length, 0);
    assert.strictEqual(r.data.account.userEnabled, false);
    global.T1 = r.data.tempPin;
    let c = await cust('toggle', 'POST', { userEnabled: true, pin: global.T1 }); assert.strictEqual(c.data.code, 'MUST_CHANGE_PIN');
    c = await cust('pin', 'POST', { newPin: '6283', oldPin: '4829' }); assert.strictEqual(c.data.code, 'PIN_WRONG'); // ya zamani imekufa
    c = await cust('pin', 'POST', { newPin: '6283', oldPin: global.T1 }); assert.strictEqual(c.status, 200); assert.strictEqual(c.data.account.mustChangePin, false);
    c = await cust('toggle', 'POST', { userEnabled: true, pin: '6283' }); assert.strictEqual(c.status, 200);
  });
  await t('reset_pin + dm: ujumbe unatumwa kwa namba sahihi ukiwa na PIN; dmSent=true', async () => {
    sent.length = 0;
    const r = await adm('POST', { action: 'reset_pin', phone: PHONE, dm: true });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.dmSent, true);
    assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].phone, PHONE); assert(sent[0].text.includes(r.data.tempPin));
    assert(/badilishe/i.test(sent[0].text));
    const c = await cust('pin', 'POST', { newPin: '7391', oldPin: r.data.tempPin }); assert.strictEqual(c.status, 200);
  });
  await t('reset_pin + dm kwa bot isiyounganishwa → dmSent=false (admin bado ana PIN)', async () => {
    sqlite.prepare("INSERT INTO deriv_accounts (phoneNumber, updatedAt) VALUES ('255799000000', 1)").run();
    const r = await adm('POST', { action: 'reset_pin', phone: '255799000000', dm: true });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.data.dmSent, false); assert(/^\d{6}$/.test(r.data.tempPin));
  });
  await t('namba yenye alama (+255 7xx) inasafishwa; mteja asiyekuwepo → 400 NOT_FOUND', async () => {
    const r = await adm('POST', { action: 'revoke', phone: '+255 711-000-001' }); assert.strictEqual(r.status, 200); assert.strictEqual(r.data.account.adminApproved, false);
    const n = await adm('POST', { action: 'reset_pin', phone: '255700123123' }); assert.strictEqual(n.status, 400); assert.strictEqual(n.data.code, 'NOT_FOUND');
  });
  await t('kill_all kupitia HTTP: mteja hawezi kuwasha; resume inarudisha; GET inaonyesha hali', async () => {
    await adm('POST', { action: 'approve', phone: PHONE });
    assert.strictEqual((await adm('POST', { action: 'kill_all' })).data.killAll, true);
    assert.strictEqual((await adm('GET')).data.killAll, true);
    assert.strictEqual((await cust('')).data.account.killAll, true);
    const c = await cust('toggle', 'POST', { userEnabled: true, pin: '7391' }); assert.strictEqual(c.data.code, 'KILLED');
    assert.strictEqual((await adm('POST', { action: 'resume_all' })).data.killAll, false);
    assert.strictEqual((await cust('toggle', 'POST', { userEnabled: true, pin: '7391' })).status, 200);
  });
  await t('mteja anaondoa akaunti (bila PIN) → swichi/idhini zote zinazimwa', async () => {
    const r = await cust('disconnect', 'POST', {}); assert.strictEqual(r.status, 200);
    assert(!r.data.account.connected && !r.data.account.userEnabled && !r.data.account.adminApproved);
  });
  await t('action isiyojulikana → 400; JSON mbovu → si 500 ya stack', async () => {
    assert.strictEqual((await adm('POST', { action: 'foo', phone: PHONE })).status, 400);
    const r = await fetch(base + '/api/admin/deriv', { method: 'POST', headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' }, body: '{bad' });
    assert(r.status >= 400 && r.status < 600);
  });
  await t('rate limit: hatua za PIN → 429, LAKINI kuzima trading/auto na kuondoa akaunti hazizuiwi kamwe', async () => {
    TOK = 'tok-A-C';
    let got429 = false;
    for (let i = 0; i < 20; i++) { const r = await cust('pin', 'POST', { newPin: '1111' }); if (r.status === 429) { got429 = true; break; } }
    assert(got429, 'ilipaswa kufika 429');
    assert.strictEqual((await cust('connect', 'POST', { token: 'demo-token-aaaa1111', pin: '7391' })).status, 429);
    assert.strictEqual((await cust('toggle', 'POST', { userEnabled: true, pin: '7391' })).status, 429);
    // zimezuiwa kwa PIN, lakini kusimamisha kunaruhusiwa:
    assert.strictEqual((await cust('toggle', 'POST', { userEnabled: false })).status, 200);
    assert.strictEqual((await cust('toggle', 'POST', { autoEnabled: false })).status, 200);
    assert.strictEqual((await cust('disconnect', 'POST', {})).status, 200);
    assert.strictEqual((await cust('')).status, 200); // GET haizuiwi
  });
  await t('OPTIONS preflight bado 204 (routes za zamani hazijaathirika)', async () => {
    const r = await fetch(base + '/api/dashboard/tok-A/deriv', { method: 'OPTIONS' }); assert.strictEqual(r.status, 204);
  });
  await t('LOGS za server: hakuna token/PIN/ufunguo', async () => {
    const all = logs.join('\n');
    for (const x of ['demo-token-aaaa1111', 'real-token-bbbb1111', '4829', '6283', '7391', global.T1, 'd'.repeat(64)]) assert(!all.includes(x), 'siri kwenye log: ' + x);
  });

  fake.close(); web.close();
  const bad = results.filter((x) => !x).length;
  out(`\n${results.length - bad}/${results.length} zimepita`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { out('FATAL', e.stack); process.exit(2); });
