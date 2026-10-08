// Run: node --experimental-vm-modules --test tests/api-contract.test.mjs
// Actual SQLite executes the production handler's D1 SQL. Document generation is
// stubbed here; complete R2/Worker flows are covered by deployment integration.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ddl = `CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,number TEXT UNIQUE NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,auth_version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY,window_start INTEGER NOT NULL,count INTEGER NOT NULL);`;
class D1 {
  constructor(file = ':memory:') {this.sqlite = new DatabaseSync(file); this.sqlite.exec(ddl);}
  prepare(sql) {
    const db = this.sqlite;
    const query = (...values) => ({
      sql, values, bind: (...next) => query(...next),
      async first() {return db.prepare(sql).get(...values) || null;},
      async all() {return {results: db.prepare(sql).all(...values), success: true};},
      async run() {const result = db.prepare(sql).run(...values); return {success: true, meta: {changes: Number(result.changes)}};},
    });
    return query();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const result = statements.map(statement => {const r = this.sqlite.prepare(statement.sql).run(...statement.values); return {success: true, meta: {changes: Number(r.changes)}};});
      this.sqlite.exec('COMMIT'); return result;
    } catch (error) {this.sqlite.exec('ROLLBACK'); throw error;}
  }
}
async function loadApi() {
  const context = vm.createContext({crypto: webcrypto, Error, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, Request, Response, Headers, URL, Date, JSON, structuredClone, console});
  const modules = new Map();
  const docs = new vm.SyntheticModule(['downloadFile', 'generatePi', 'listFiles', 'migrateFile', 'putPrivateTemplate', 'readQuoteText', 'rollbackFiles', 'uploadFile'], function () {
    this.setExport('downloadFile', async (_env, _order, _key, isPublic) => new Response(isPublic ? 'public-file' : 'private-file'));
    this.setExport('listFiles', async () => ({files: [], folder: 'cloud'}));
    this.setExport('readQuoteText', async () => ({quotes: []}));
    this.setExport('rollbackFiles', async () => {});
    for (const name of ['generatePi', 'migrateFile', 'putPrivateTemplate', 'uploadFile']) this.setExport(name, async () => {throw new Error('Unexpected document mutation in API-only test');});
  }, {context});
  async function source(name) {
    if (modules.has(name)) return modules.get(name);
    const code = ts.transpileModule(readFileSync(path.join(root, 'lib', name + '.ts'), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
    const module = new vm.SourceTextModule(code, {context}); modules.set(name, module);
    await module.link(specifier => specifier === './documents' ? docs : source(specifier.replace('./', '')));
    return module;
  }
  const api = await source('api'); await api.evaluate(); return api.namespace.handleApi;
}
const handle = await loadApi();
const password = 'integration-password-only-123';
function environment(db = new D1()) {return {DB: db, BUCKET: {head: async () => null}, INITIAL_ADMIN_PASSWORD: password, MAC_SYNC_TOKEN: 'a'.repeat(48)};}
async function request(env, route, {method = 'GET', data, cookie, headers = {}} = {}) {
  const response = await handle(new Request('https://orders.example' + route, {method, headers: {...(data ? {'Content-Type': 'application/json', Origin: 'https://orders.example'} : {}), ...(cookie ? {Cookie: cookie} : {}), ...headers}, body: data ? JSON.stringify(data) : undefined}), env);
  const body = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : await response.text();
  return {status: response.status, body, cookie: response.headers.get('Set-Cookie')?.split(';')[0], headers: response.headers};
}
async function login(env, ip = '192.0.2.1') {return request(env, '/api/login', {method: 'POST', data: {password}, headers: {'CF-Connecting-IP': ip}});}
const orderData = {orderNo: 'TEST-001', code: '測試訂單', styleNo: 'TOTE', items: [{color: 'BLACK', quantity: 20, unitPrice: 300}, {color: 'WHITE', quantity: 30, unitPrice: 300}], sampleFee: 1000, deposit: 5000, invoiceRequired: true, taxMode: 'excluded', buyer: '測試買方', internalNotes: 'PRIVATE_SENTINEL'};

test('authentication, public allowlist, secure session and cloud totals', async () => {
  const env = environment();
  assert.equal((await request(env, '/api/orders')).status, 401);
  assert.equal((await request(env, '/api/settings')).status, 401);
  const signed = await login(env); assert.equal(signed.status, 200);
  assert.match(signed.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(signed.headers.get('Set-Cookie'), /Secure/);
  const stored = env.DB.sqlite.prepare('SELECT * FROM sessions').get();
  assert.equal(stored.token_hash.length, 64); assert.ok(!signed.cookie.includes(stored.token_hash));
  const made = await request(env, '/api/orders', {method: 'POST', cookie: signed.cookie, data: orderData});
  assert.equal(made.status, 201); assert.equal(made.body.totals.total, 16800); assert.equal(made.body.totals.balance, 11800);
  const publicOrders = await request(env, '/api/public/orders');
  for (const key of ['unitPrice', 'totals', 'deposit', 'buyer', 'internalNotes', 'PRIVATE_SENTINEL', 'folder']) assert.ok(!JSON.stringify(publicOrders.body).includes(key), key);
  assert.equal((await request(env, '/api/orders', {method: 'POST', cookie: signed.cookie, data: orderData})).status, 409);
  env.DB.sqlite.close();
});

test('concurrent same-version changes produce one winner and one conflict', async () => {
  const env = environment(), signed = await login(env);
  const order = (await request(env, '/api/orders', {method: 'POST', cookie: signed.cookie, data: orderData})).body;
  const changes = await Promise.all(['first', 'second'].map(requirements => request(env, '/api/orders/' + order.id, {method: 'PUT', cookie: signed.cookie, data: {version: order.version, requirements}})));
  assert.deepEqual(changes.map(result => result.status).sort(), [200, 409]);
  const saved = (await request(env, '/api/orders', {cookie: signed.cookie})).body.orders[0];
  assert.equal(saved.version, order.version + 1);
  env.DB.sqlite.close();
});

test('sessions and orders persist after a new handler and DB connection; password revokes all sessions', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'renrob-api-')); const file = path.join(dir, 'state.sqlite');
  try {
    let env = environment(new D1(file)); const first = await login(env), second = await login(env, '192.0.2.2');
    await request(env, '/api/orders', {method: 'POST', cookie: first.cookie, data: orderData}); env.DB.sqlite.close();
    env = environment(new D1(file)); env.INITIAL_ADMIN_PASSWORD = 'different-env-does-not-reset-existing-auth';
    const restarted = await loadApi();
    const restored = await restarted(new Request('https://orders.example/api/orders', {headers: {Cookie: first.cookie}}), env);
    assert.equal(restored.status, 200); assert.equal((await restored.json()).orders.length, 1);
    assert.equal((await request(env, '/api/password', {method: 'POST', cookie: first.cookie, data: {password: 'changed-password-123'}})).status, 200);
    for (const cookie of [first.cookie, second.cookie]) assert.equal((await request(env, '/api/orders', {cookie})).status, 401);
    assert.equal((await login(env)).status, 401);
    assert.equal((await request(env, '/api/login', {method: 'POST', data: {password: 'changed-password-123'}, headers: {'CF-Connecting-IP': '192.0.2.3'}})).status, 200);
    env.DB.sqlite.close();
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('persistent rate limit trusts CF IP, ignores spoofed forwarded IP, and blocks cross-origin JSON', async () => {
  const env = environment();
  for (let i = 0; i < 10; i++) assert.equal((await request(env, '/api/login', {method: 'POST', data: {password: 'wrong'}, headers: {'CF-Connecting-IP': '192.0.2.4', 'X-Forwarded-For': String(i)}})).status, 401);
  assert.equal((await login(env, '192.0.2.4')).status, 429);
  assert.equal((await request(env, '/api/login', {method: 'POST', data: {password}, headers: {Origin: 'https://evil.example'}})).status, 403);
  assert.equal((await request(env, '/api/login', {method: 'POST', data: {password}, headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
  env.DB.sqlite.close();
});

test('migration is empty-database-only and ignores auth/path config; sync token is strictly read-only', async () => {
  const env = environment(), signed = await login(env), id = 'a'.repeat(24);
  const imported = {...orderData, id, version: 3, files: [], workflowConfirmed: false, createdAt: '2026-10-01T09:00:00+08:00'};
  const payload = {orders: [imported], config: {seller: '測試賣方', piTerms: '測試條款', auth: 'EVIL_AUTH', ordersRoot: '/private/path'}};
  assert.equal((await request(env, '/api/migrate/init', {method: 'POST', cookie: signed.cookie, data: payload})).status, 201);
  assert.equal((await request(env, '/api/migrate/init', {method: 'POST', cookie: signed.cookie, data: payload})).status, 409);
  const settings = (await request(env, '/api/settings', {cookie: signed.cookie})).body;
  assert.equal(settings.seller, '測試賣方'); assert.ok(!JSON.stringify(settings).includes('/private/path'));
  const headers = {Authorization: 'Bearer ' + env.MAC_SYNC_TOKEN};
  assert.equal((await request(env, '/api/sync/manifest', {headers})).body.orders[0].version, 3);
  assert.equal((await request(env, '/api/orders/' + id + '/file/test.pdf', {headers})).status, 200);
  for (const route of ['/api/orders', '/api/settings', '/api/backup']) assert.equal((await request(env, route, {headers})).status, 401);
  for (const route of ['/api/orders', '/api/migrate/init', '/api/password']) assert.equal((await request(env, route, {method: 'POST', headers, data: payload})).status, 401);
  env.DB.sqlite.close();
});

test('legacy incomplete orders and exact decimal money survive import and edits', async () => {
  const env = environment(), signed = await login(env);
  const incomplete = {...orderData, id: 'b'.repeat(24), orderNo: 'LEGACY-TEST', styleNo: '', items: [], deposit: 0, sampleFee: 0, dataComplete: false, workflowConfirmed: false};
  assert.equal((await request(env, '/api/migrate/init', {method: 'POST', cookie: signed.cookie, data: {orders: [incomplete]}})).status, 201);
  const order = (await request(env, '/api/orders', {cookie: signed.cookie})).body.orders[0];
  assert.equal(order.dataComplete, false); assert.equal(order.workflowConfirmed, false); assert.equal(order.items.length, 0);
  assert.equal((await request(env, '/api/orders/' + order.id, {method: 'PUT', cookie: signed.cookie, data: {version: order.version, requirements: '待確認'}})).status, 200);
  const made = await request(env, '/api/orders', {method: 'POST', cookie: signed.cookie, data: {...orderData, orderNo: 'ROUNDING-TEST', items: [{color: 'Black', quantity: 1, unitPrice: 10.075}], deposit: 0, sampleFee: 0, invoiceRequired: false}});
  assert.equal(made.status, 201); assert.equal(made.body.totals.total, 10.08);
  env.DB.sqlite.close();
});
