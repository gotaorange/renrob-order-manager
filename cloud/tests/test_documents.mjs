import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import ExcelJS from 'exceljs';

// Compile only the document/domain modules into an isolated temporary directory.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(path.join(tmpdir(), 'renrob-documents-'));
symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'));
for (const name of ['documents', 'domain']) {
  writeFileSync(path.join(temp, name + '.js'), ts.transpileModule(readFileSync(path.join(root, 'lib', name + '.ts'), 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText);
}
const require = createRequire(path.join(temp, 'loader.cjs'));
const documents = require('./documents.js');
const {normalize} = require('./domain.js');
process.on('exit', () => rmSync(temp, {recursive: true, force: true}));

function order(items = 2) {
  return normalize({orderNo: 'DEMO-001', code: 'Synthetic', styleNo: 'DEMO-TOTE', buyer: 'Synthetic buyer <safe>',
    items: Array.from({length: items}, (_, index) => ({color: 'Color ' + index, quantity: 10 + index, unitPrice: 12.5})),
    shipping: 20, sampleFee: 30, invoiceRequired: true, taxMode: 'excluded', deposit: 0});
}
function environment() {
  const objects = new Map();
  let puts = 0, failAt = -1;
  return {objects, failOnPut(number) {failAt = number;}, BUCKET: {
    async put(key, body, options) {
      puts += 1;
      const bytes = new Uint8Array(body);
      objects.set(key, {bytes, options});
      if (puts === failAt) throw new Error('Simulated R2 failure after write');
    },
    async get(key) {
      const object = objects.get(key);
      return object ? {size: object.bytes.length, body: new Response(object.bytes).body,
        async arrayBuffer() {return object.bytes.slice().buffer;}} : null;
    },
    async delete(keys) {for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);},
  }};
}
const payload = (name = '示範檔案.pdf', kind = 'internal') => ({name, kind, base64: Buffer.from('synthetic file').toString('base64')});
const settings = {seller: 'Synthetic seller', piTerms: 'First term\n\nSecond term'};

function syntheticPdf() {
  const text = 'BT /F1 12 Tf 20 100 Td (Synthetic quotation only) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;});
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`);
}

async function template() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('PI');
  sheet.mergeCells('A3:D3');
  sheet.mergeCells('B26:F26');
  sheet.getColumn('B').width = 27;
  sheet.getRow(3).height = 44;
  sheet.getCell('F12').numFmt = '#,##0.00';
  sheet.getCell('F12').font = {name: 'Arial', size: 12, bold: true};
  sheet.getCell('F12').border = {bottom: {style: 'thin', color: {argb: 'FF112233'}}};
  sheet.pageSetup = {paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 1, printArea: 'A1:F31'};
  sheet.pageSetup.margins = {left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2};
  sheet.getCell('A3').value = 'Stale buyer';
  sheet.getCell('A30').value = 'Stale terms';
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

test('upload stays private by default, validates inputs, and returns rollback keys', async () => {
  const env = environment();
  const original = order();
  const result = await documents.uploadFile(env, original, payload());
  assert.equal(original.files.length, 0);
  assert.equal(result.order.version, original.version + 1);
  assert.equal(result.order.files[0].kind, 'internal');
  assert.match(result.order.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.createdKeys.length, 1);
  assert.equal((await documents.listFiles(env, result.order)).files.length, 1);
  for (const name of ['../escape.pdf', 'bad\r\nname.pdf', 'file.html', '.hidden.pdf']) {
    await assert.rejects(documents.uploadFile(env, original, payload(name)));
  }
  await assert.rejects(documents.uploadFile(env, original, {...payload(), base64: 'not base64'}));
  await assert.rejects(documents.uploadFile(env, original, {...payload(), base64: Buffer.alloc(documents.MAX_FILE_BYTES + 1).toString('base64')}));
  await documents.rollbackFiles(env, result.createdKeys);
  assert.equal(env.objects.size, 0);
});

test('multi-MB base64 uploads do not overflow the stack, preserve bytes, and reject invalid padding', async () => {
  for (const bytes of [Math.floor(5.2 * 1024 * 1024), documents.MAX_FILE_BYTES]) {
    const env = environment();
    const raw = Buffer.alloc(bytes, 7);
    raw[0] = 1; raw[bytes - 1] = 255;
    const result = await documents.uploadFile(env, order(), {name: 'synthetic-large.pdf', base64: raw.toString('base64')});
    const file = result.order.files[0];
    assert.equal(file.size, bytes);
    assert.equal(Buffer.compare(Buffer.from(env.objects.get(file.objectKey).bytes), raw), 0);
    await documents.rollbackFiles(env, result.createdKeys);
  }
  for (const base64 of ['====', 'A===', '=AAA', 'AA=A', 'A=AA', 'AAAA====', 'AA!A', 'AAA', 'AAAA\nAAA', '']) {
    await assert.rejects(documents.uploadFile(environment(), order(), {name: 'invalid.pdf', base64}), error => error.status === 400);
  }
  for (const raw of [Buffer.from('x'), Buffer.from('xy'), Buffer.from('xyz')]) {
    const result = await documents.uploadFile(environment(), order(), {name: 'valid.txt', base64: raw.toString('base64')});
    assert.equal(result.order.files[0].size, raw.length);
  }
});

test('public downloads require explicit public metadata and opaque id', async () => {
  const env = environment();
  let current = (await documents.uploadFile(env, order(), payload('internal.pdf'))).order;
  const privateFile = current.files[0];
  await assert.rejects(documents.downloadFile(env, current, privateFile.id, true), error => error.status === 404);
  current = (await documents.uploadFile(env, current, payload('公開 設計.pdf', 'design'))).order;
  const publicFile = current.files[1];
  await assert.rejects(documents.downloadFile(env, current, publicFile.stored, true), error => error.status === 404);
  const response = await documents.downloadFile(env, current, publicFile.id, true);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Disposition'), /^attachment;.*filename\*=UTF-8''/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(await response.text(), 'synthetic file');
  assert.equal(await (await documents.downloadFile(env, current, privateFile.stored, false)).text(), 'synthetic file');
  const incomplete = {...current, files: [{...publicFile, objectKey: undefined}]};
  await assert.rejects(documents.downloadFile(env, incomplete, publicFile.id, true), error => error.status === 404);
});

test('migration replaces original metadata, retains unrelated files, and never overwrites old objects', async () => {
  const env = environment();
  const old = (await documents.uploadFile(env, order(), payload())).order;
  const originalKey = old.files[0].objectKey;
  const result = await documents.migrateFile(env, old, {file: old.files[0], base64: Buffer.from('migrated').toString('base64')});
  assert.equal(result.order.files.length, 1);
  assert.notEqual(result.order.files[0].objectKey, originalKey);
  await documents.rollbackFiles(env, result.createdKeys);
  assert.ok(env.objects.has(originalKey));
});

test('quote text extracts real PDF text and degrades safely for a malformed PDF', async () => {
  const env = environment();
  let current = (await documents.uploadFile(env, order(), {name: 'synthetic-quote.pdf', kind: 'quote', base64: syntheticPdf().toString('base64')})).order;
  current = (await documents.uploadFile(env, current, payload('broken-quote.pdf', 'quote'))).order;
  const result = await documents.readQuoteText(env, current);
  assert.equal(result.quotes.length, 2);
  assert.match(result.quotes[0].text, /Synthetic quotation only/);
  assert.match(result.quotes[1].text, /無法擷取文字/);
});

test('PI workbook preserves template layout, updates values and caches formula results', async () => {
  const source = await template();
  const result = await documents.fillPiWorkbook(source, order(), settings, new Date('2026-10-08T18:00:00Z'));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getCell('A3').value, 'Synthetic buyer <safe>');
  assert.equal(sheet.getCell('F5').value.toISOString(), '2026-10-09T00:00:00.000Z');
  assert.equal(sheet.getColumn('B').width, 27);
  assert.equal(sheet.getRow(3).height, 44);
  assert.equal(sheet.getCell('F12').font.bold, true);
  assert.equal(sheet.getCell('F12').border.bottom.color.argb, 'FF112233');
  assert.equal(sheet.getCell('F12').numFmt, '"NTD "#,##0.00');
  assert.equal(sheet.getCell('E17').numFmt, '"NTD "#,##0.00');
  assert.ok(sheet.getRow(21).height >= 16);
  assert.deepEqual(sheet.getCell('F12').value, {formula: 'D12*E12', result: 125});
  assert.deepEqual(sheet.getCell('F23').value, {formula: 'SUM(F20:F22)', result: 328.5});
  assert.equal(sheet.pageSetup.printArea, 'A1:F31');
  assert.equal(sheet.pageSetup.margins.left, 0.4);
  assert.equal(sheet.getCell('B3').master.address, 'A3');
  assert.equal(sheet.getCell('A30').value, 'Second term');
  assert.equal(sheet.getCell('B26').value, settings.seller);
  const html = documents.piHtml(order(7), settings, new Date('2026-10-08T18:00:00Z'));
  assert.ok(html.includes('Color 6'));
  assert.ok(html.includes('Synthetic buyer &lt;safe&gt;'));
  assert.ok(html.includes('2026-10-09'));
});

test('PI and templates are private, append versions, and roll back partially written objects', async () => {
  const env = environment();
  const bytes = await template();
  const uploaded = await documents.putPrivateTemplate(env, {name: 'pi-template.xlsx', base64: Buffer.from(bytes).toString('base64')});
  const configured = {...settings, templateKey: uploaded.templateKey};
  const generated = await documents.generatePi(env, order(), {}, configured);
  assert.equal(generated.order.files.length, 2);
  assert.deepEqual(generated.order.files.map(file => file.kind), ['pi', 'pi']);
  for (const file of generated.order.files) await assert.rejects(documents.downloadFile(env, generated.order, file.id, true));
  const again = await documents.generatePi(env, generated.order, {}, configured);
  assert.equal(again.order.files.length, 4);
  assert.equal(new Set(again.order.files.map(file => file.name)).size, 4);
  const manyColors = await documents.generatePi(env, order(7), {}, configured);
  assert.equal(manyColors.order.files.length, 1);
  assert.ok(manyColors.order.files[0].name.endsWith('.html'));
  const missing = await documents.generatePi(environment(), order(), {}, settings);
  assert.equal(missing.order.files.length, 1);
  const failed = environment();
  failed.objects.set(configured.templateKey, {bytes});
  failed.failOnPut(2);
  await assert.rejects(documents.generatePi(failed, order(), {}, configured), /Simulated R2/);
  assert.deepEqual([...failed.objects.keys()], [configured.templateKey]);
});
