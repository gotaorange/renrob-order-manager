import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'pages-redirect-dist/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const origin = 'https://renrob-lab-orders.kelly360753.chatgpt.site';

function destination(pathname, search = '') {
  let result;
  const link = {};
  vm.runInNewContext(script, {
    URLSearchParams,
    location: {pathname, search, replace: value => { result = value; }},
    document: {getElementById: id => {assert.equal(id, 'continue'); return link;}},
  });
  assert.equal(link.href, result);
  return result;
}

test('main GitHub Pages link opens the production manager', () => {
  assert.equal(destination('/renrob-order-manager/'), origin + '/');
});
test('both legacy factory link shapes open the factory view', () => {
  assert.equal(destination('/renrob-order-manager/', '?view=factory'), origin + '/factory');
  assert.equal(destination('/renrob-order-manager/factory'), origin + '/factory');
  assert.equal(destination('/renrob-order-manager/factory/'), origin + '/factory');
});
test('query strings cannot redirect to an arbitrary origin or forward credentials', () => {
  assert.equal(destination('/renrob-order-manager/', '?url=https://elsewhere.example&token=private'), origin + '/');
  assert.equal(destination('/renrob-order-manager/', '?view=factory&token=private'), origin + '/factory');
});
test('direct factory requests and unknown Pages paths have safe handoff documents', () => {
  const factory = readFileSync(path.join(root, 'pages-redirect-dist/factory/index.html'), 'utf8');
  assert.ok(factory.includes(`href="${origin}/factory"`));
  assert.equal(readFileSync(path.join(root, 'pages-redirect-dist/404.html'), 'utf8'), html);
  assert.ok(!/fetch\(|XMLHttpRequest|localStorage|REVIEW|DEMO/.test(html));
});
