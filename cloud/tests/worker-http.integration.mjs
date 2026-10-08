// Synthetic, local-only HTTP integration. Requires the production Worker on 8877.
// Never point this script at a live deployment or a database with real orders.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {createHash, randomBytes} from 'node:crypto';
import {readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const origin = 'http://127.0.0.1:8877';
const password = 'local-integration-only-2026';
const syncToken = 'local-sync-only-2026-abcdefghijklmnopqrstuvwxyz';
const stamp = Date.now().toString();
const id = () => randomBytes(12).toString('hex');
let cookie = '';
async function request(route, {method = 'GET', body, admin = false, bearer = false, headers = {}, raw = false} = {}) {
  const result = await fetch(origin + route, {method, headers: {...(body ? {'Content-Type': 'application/json', Origin: origin} : {}), ...(admin ? {Cookie: cookie} : {}), ...(bearer ? {Authorization: 'Bearer ' + syncToken} : {}), ...headers}, body: body ? JSON.stringify(body) : undefined});
  const bytes = new Uint8Array(await result.arrayBuffer());
  let data = bytes;
  if (!raw && result.headers.get('Content-Type')?.includes('application/json')) data = JSON.parse(new TextDecoder().decode(bytes));
  return {status: result.status, data, headers: result.headers, bytes};
}
function expect(result, status, label) {assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data).slice(0, 300)}`); return result.data;}
const report = (label) => process.stdout.write('PASS ' + label + '\n');
const assets = new Set(['/app.js', '/style.css', '/favicon.svg']);
const builtAssets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/client');
for (const file of readdirSync(builtAssets, {recursive: true})) if (typeof file === 'string' && /\.(?:js|css)$/.test(file)) assets.add('/' + file.replaceAll(path.sep, '/'));
for (const route of ['/', '/factory', '/login']) {
  const page = await request(route, {raw: true}); expect(page, 200, 'HTML ' + route);
  assert.match(page.headers.get('Content-Type'), /text\/html/);
  const html = new TextDecoder().decode(page.bytes);
  assert.ok(html.includes('Re:Nrob Lab') && html.includes('id="app"'), 'workspace markup ' + route);
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) || []) {
    if (tag.startsWith('<link') && !/rel="(?:stylesheet|modulepreload|preload)"/.test(tag)) continue;
    const match = tag.match(/(?:src|href)="([^"]+)"/); if (!match) continue;
    const target = new URL(match[1].replaceAll('&amp;', '&'), origin);
    assert.equal(target.origin, origin, 'unexpected external asset');
    assets.add(target.pathname + target.search);
  }
}
for (const asset of assets) {
  const result = await request(asset, {raw: true}); expect(result, 200, 'asset ' + asset);
  const type = result.headers.get('Content-Type') || '';
  if (/\.css(?:\?|$)/.test(asset)) assert.match(type, /text\/css/);
  else if (/\.(?:js|mjs)(?:\?|$)/.test(asset)) assert.match(type, /(?:javascript|ecmascript)/);
  else if (/\.svg(?:\?|$)/.test(asset)) assert.match(type, /image\/svg\+xml/);
  assert.ok(result.bytes.length > 0);
}
report('HTML routes and all ' + assets.size + ' emitted script/CSS/static assets return 200 with correct types');
if (process.argv.includes('--assets-only')) process.exit(0);
const initial = expect(await request('/api/public/orders'), 200, 'readiness');
assert.ok(initial.orders.every(order => order.orderNo.startsWith('LOCALHTTP-')), 'Refusing to write: non-test orders found in this local database');
expect(await request('/api/orders'), 401, 'unauth internal');
expect(await request('/api/settings'), 401, 'unauth settings');
expect(await request('/api/login', {method: 'POST', body: {password}, headers: {Origin: 'https://wrong.example'}}), 403, 'cross-origin');
const login = await request('/api/login', {method: 'POST', body: {password}}); expect(login, 200, 'login');
cookie = login.headers.get('Set-Cookie').split(';')[0];
assert.match(login.headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict/);
assert.equal(expect(await request('/api/session', {admin: true}), 200, 'session').admin, true);
report('login, cookie, unauthenticated boundaries and same-origin guard');

if (process.argv.includes('--contract-only')) {
  const orders = expect(await request('/api/orders', {admin: true}), 200, 'frontend orders contract').orders;
  for (const order of orders) {
    for (const key of ['id', 'orderNo', 'code', 'styleNo', 'folder']) assert.equal(typeof order[key], 'string');
    for (const key of ['items', 'history', 'files']) assert.ok(Array.isArray(order[key]));
    for (const key of ['total', 'balance', 'tax']) assert.equal(typeof order.totals[key], 'number');
    assert.equal(typeof order.version, 'number');
    const listed = expect(await request(`/api/orders/${order.id}/files`, {admin: true}), 200, 'frontend file contract');
    for (const file of listed.files) {
      assert.equal(typeof file.name, 'string'); assert.equal(typeof file.kind, 'string'); assert.equal(typeof file.size, 'number');
      // app.js builds its private download URL from files[].name, not order.files[].stored.
      expect(await request(`/api/orders/${order.id}/file/${encodeURIComponent(file.name)}`, {admin: true, raw: true}), 200, 'frontend list-built download URL');
    }
  }
  const settings = expect(await request('/api/settings', {admin: true}), 200, 'frontend settings contract');
  for (const key of ['ordersRoot', 'piTemplate']) assert.equal(typeof settings[key], 'string');
  assert.equal(typeof settings.templateAvailable, 'boolean');
  report('frontend app.js order/settings/file response contracts and list-built downloads');
  process.exit(0);
}

let migrated;
if (!initial.orders.length) {
  const migrationId = id(), fileId = id();
  const legacy = {id: migrationId, orderNo: 'LOCALHTTP-MIGRATION', code: 'Synthetic Legacy', styleNo: '', items: [], dataComplete: false, version: 4, files: [{id: fileId, name: 'legacy-design.txt', stored: 'legacy-design.txt', kind: 'design', createdAt: '2026-10-01T09:00:00+08:00'}], history: [], workflowConfirmed: false};
  const payload = {orders: [legacy], config: {seller: 'Synthetic seller', piTerms: 'Synthetic terms', auth: 'MUST_NOT_IMPORT', ordersRoot: '/MUST_NOT_IMPORT'}};
  expect(await request('/api/migrate/init', {method: 'POST', admin: true, body: payload}), 201, 'migration init');
  expect(await request('/api/migrate/init', {method: 'POST', admin: true, body: payload}), 409, 'repeat migration');
  const fileBytes = Buffer.from('SYNTHETIC_LEGACY_DESIGN');
  migrated = expect(await request('/api/migrate/file', {method: 'POST', admin: true, body: {orderId: migrationId, file: legacy.files[0], base64: fileBytes.toString('base64')}}), 200, 'migration file');
  assert.equal(migrated.files.length, 1); assert.equal(migrated.files[0].id, fileId); assert.equal(migrated.version, 5);
  assert.equal(migrated.files[0].sha256, createHash('sha256').update(fileBytes).digest('hex'));
  const downloaded = await request(`/api/public/orders/${migrationId}/file/${fileId}`, {raw: true});
  expect(downloaded, 200, 'migrated public file'); assert.deepEqual(Buffer.from(downloaded.bytes), fileBytes);
  report('one-time private migration, incomplete order and attachment metadata preservation');
} else report('migration already initialized by an earlier synthetic local run');

const template = new ExcelJS.Workbook(), sheet = template.addWorksheet('PI');
sheet.mergeCells('A1:F1'); sheet.getCell('A1').value = 'SYNTHETIC TEMPLATE'; sheet.getCell('A1').font = {bold: true};
sheet.pageSetup = {paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1};
for (let row = 2; row <= 30; row++) for (let col = 1; col <= 6; col++) {sheet.getCell(row, col).value = ''; sheet.getCell(row, col).border = {bottom: {style: 'thin'}};}
const templateBytes = Buffer.from(await template.xlsx.writeBuffer());
expect(await request('/api/migrate/template', {method: 'POST', admin: true, body: {name: 'synthetic-template.xlsx', base64: templateBytes.toString('base64')}}), 200, 'template migration');
const settings = expect(await request('/api/settings', {admin: true}), 200, 'settings');
assert.equal(settings.templateAvailable, true); assert.ok(!JSON.stringify(settings).includes('MUST_NOT_IMPORT'));
assert.ok(!JSON.stringify(settings).includes('settings/pi-template/'));
report('private XLSX template stored in native R2 and settings redact secrets');

let order = expect(await request('/api/orders', {method: 'POST', admin: true, body: {orderNo: 'LOCALHTTP-' + stamp, code: 'Synthetic Order', styleNo: 'TOTE', items: [{color: 'BLACK', quantity: 20, unitPrice: 300}, {color: 'WHITE', quantity: 30, unitPrice: 300}], sampleFee: 1000, deposit: 5000, invoiceRequired: true, taxMode: 'excluded', buyer: 'SYNTHETIC_PRIVATE_BUYER', internalNotes: 'SYNTHETIC_PRIVATE_NOTE'}}), 201, 'create');
assert.equal(order.totals.total, 16800);
const updates = await Promise.all(['first update', 'second update'].map(requirements => request('/api/orders/' + order.id, {method: 'PUT', admin: true, body: {version: order.version, requirements}})));
assert.deepEqual(updates.map(result => result.status).sort(), [200, 409]);
order = updates.find(result => result.status === 200).data;
expect(await request('/api/orders/' + order.id, {method: 'PUT', admin: true, body: {version: order.version, productionStatus: 'producing'}}), 400, 'sample before production');
report('create, financial totals, workflow validation and native D1 atomic concurrent version conflict');

for (const [name, kind, content] of [['internal.txt', 'internal', 'SYNTHETIC_PRIVATE_FILE'], ['design.txt', 'design', 'SYNTHETIC_PUBLIC_FILE']]) {
  order = expect(await request(`/api/orders/${order.id}/upload`, {method: 'POST', admin: true, body: {version: order.version, name, kind, base64: Buffer.from(content).toString('base64')}}), 200, 'upload ' + kind);
  const file = order.files.at(-1);
  assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'));
  const privateRead = await request(`/api/orders/${order.id}/file/${encodeURIComponent(file.stored)}`, {admin: true, raw: true});
  expect(privateRead, 200, 'admin download'); assert.equal(new TextDecoder().decode(privateRead.bytes), content);
  expect(await request(`/api/orders/${order.id}/file/${encodeURIComponent(file.stored)}`), 401, 'anonymous internal route');
  const publicRead = await request(`/api/public/orders/${order.id}/file/${file.id}`, {raw: true});
  expect(publicRead, kind === 'design' ? 200 : 404, 'public visibility');
}
const publicOrders = expect(await request('/api/public/orders'), 200, 'public orders');
for (const secret of ['SYNTHETIC_PRIVATE_BUYER', 'SYNTHETIC_PRIVATE_NOTE', 'internal.txt', 'unitPrice', 'objectKey', 'totals', 'deposit', 'buyer']) assert.ok(!JSON.stringify(publicOrders).includes(secret), 'public leak: ' + secret);
expect(await request(`/api/orders/${order.id}/files`, {admin: true}), 200, 'file listing');
report('native R2 private/public uploads, checksums, downloads and public serializer privacy');

function tinyPdf(message) {
  const stream = `BT /F1 12 Tf 50 700 Td (${message}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => {offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;});
  const xref = Buffer.byteLength(pdf); pdf += 'xref\n0 6\n0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`; return Buffer.from(pdf);
}
order = expect(await request(`/api/orders/${order.id}/upload`, {method: 'POST', admin: true, body: {version: order.version, name: 'synthetic-quote.pdf', kind: 'quote', base64: tinyPdf('SYNTHETIC_QUOTE_123').toString('base64')}}), 200, 'quote upload');
const quotes = expect(await request(`/api/orders/${order.id}/quote-text`, {admin: true}), 200, 'quote extraction');
assert.ok(quotes.quotes[0].text.includes('SYNTHETIC_QUOTE_123'), 'PDF extraction fallback: ' + quotes.quotes[0].text);
report('PDF text extraction works in the native Worker runtime');

order = expect(await request(`/api/orders/${order.id}/pi`, {method: 'POST', admin: true, body: {version: order.version}}), 200, 'PI generation');
const piFiles = order.files.filter(file => file.kind === 'pi'); assert.equal(piFiles.length, 2);
const xlsx = piFiles.find(file => file.name.endsWith('.xlsx'));
const result = await request(`/api/orders/${order.id}/file/${encodeURIComponent(xlsx.stored)}`, {admin: true, raw: true}); expect(result, 200, 'PI download');
const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(Buffer.from(result.bytes));
const resultSheet = workbook.worksheets[0];
assert.equal(resultSheet.getCell('F6').value, order.orderNo); assert.equal(resultSheet.getCell('F23').value.result, 16800); assert.equal(resultSheet.getCell('A1').font.bold, true);
const html = piFiles.find(file => file.name.endsWith('.html'));
const htmlRead = await request(`/api/orders/${order.id}/file/${encodeURIComponent(html.stored)}`, {admin: true, raw: true}); expect(htmlRead, 200, 'HTML PI'); assert.ok(new TextDecoder().decode(htmlRead.bytes).includes('16,800.00'));
expect(await request(`/api/public/orders/${order.id}/file/${xlsx.id}`), 404, 'PI not public');
report('PI XLSX + HTML generation, template formatting, cached totals and private download');

const manifest = expect(await request('/api/sync/manifest', {bearer: true}), 200, 'sync manifest');
assert.ok(manifest.orders.some(item => item.id === order.id));
assert.ok(!JSON.stringify(manifest).includes('objectKey'));
expect(await request(`/api/orders/${order.id}/file/${encodeURIComponent(xlsx.stored)}`, {bearer: true, raw: true}), 200, 'sync private download');
for (const route of ['/api/orders', '/api/settings', '/api/backup']) expect(await request(route, {bearer: true}), 401, 'sync cannot read admin route');
expect(await request(`/api/orders/${order.id}`, {method: 'PUT', bearer: true, body: {version: order.version, requirements: 'not allowed'}}), 401, 'sync cannot write');
expect(await request('/api/backup', {admin: true}), 200, 'admin backup');
expect(await request('/api/logout', {method: 'POST', admin: true, body: {}}), 200, 'logout');
expect(await request('/api/orders', {admin: true}), 401, 'logout revocation');
report('read-only Mac sync scope, admin backup, and persistent logout revocation');
process.stdout.write('ALL LOCAL WORKER HTTP CHECKS PASSED\n');
