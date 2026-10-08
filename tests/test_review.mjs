import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, 'preview-dist', name), 'utf8');
const adapter = read('review.js');
const app = read('app.js');
function sandbox(search = '') {
  const handlers = [];
  const modal = {innerHTML: '', open: false, showModal() {this.open = true;}};
  const document = {addEventListener: (...args) => handlers.push(args), querySelector: () => modal};
  const context = vm.createContext({window: {}, document, location: {search}, URLSearchParams, Intl, Date, setTimeout() {}, clearTimeout() {}});
  vm.runInContext(adapter, context);
  return {context, handlers, modal, api: context.window.RENROB_REVIEW.api};
}

test('artifact is an explicit interface-only asset allowlist', () => {
  assert.deepEqual(readdirSync(path.join(root, 'preview-dist')).sort(), ['.nojekyll', 'app.js', 'favicon.svg', 'index.html', 'review.js', 'style.css']);
  assert.doesNotMatch(app + adapter, /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/);
  assert.doesNotMatch(app, /href=["']\/[^/]/);
  assert.match(read('index.html'), /connect-src 'none'/);
  assert.match(read('index.html'), /全部為虛構示範資料/);
  assert.equal(read('style.css'), readFileSync(path.join(root, 'web/style.css'), 'utf8'));
});

test('public view removes all internal fields; reads cannot mutate fixtures', async () => {
  const {api} = sandbox();
  const privateOrders = (await api('/api/orders')).orders;
  assert.deepEqual(Array.from(privateOrders, item => item.orderNo), ['DEMO-001', 'DEMO-002', 'DEMO-003']);
  privateOrders[0].code = 'changed';
  assert.equal((await api('/api/orders')).orders[0].code, '示範訂單 甲');
  const publicOrders = (await api('/api/public/orders')).orders;
  for (const key of ['unitPrice', 'totals', 'deposit', 'invoiceRequired', 'buyer', 'internalNotes', 'folder', 'history']) {
    assert.doesNotMatch(JSON.stringify(publicOrders), new RegExp('"' + key + '"'));
  }
  assert.equal(publicOrders.length, 3);
  for (const order of privateOrders) {
    assert.ok((await api(`/api/orders/${order.id}/files`)).files.length);
    assert.ok((await api(`/api/orders/${order.id}/quote-text`)).quotes.length);
  }
  assert.equal((await api('/api/settings')).templateAvailable, false);
});

test('writes, downloads, password actions and submit are blocked honestly', async () => {
  const {api, handlers, modal} = sandbox();
  for (const url of ['/api/orders', '/api/orders/DEMO-001/pi', '/api/password', '/api/logout']) {
    await assert.rejects(api(url, {}), /不會儲存/);
  }
  await assert.rejects(api('/api/backup'), /不會儲存/);
  await assert.rejects(api('/api/orders/DEMO-001/file/anything.pdf'), /不會儲存/);
  await assert.rejects(api('/api/orders', undefined, 'DELETE'), /不會儲存/);
  const click = handlers.find(([name]) => name === 'click')[1];
  for (const action of ['upload', 'password', 'logout', 'generate-pi', 'download']) {
    let prevented = false, stopped = false;
    click({target: {closest: () => ({dataset: {action}, getAttribute: () => action === 'download' ? '#preview-api/backup' : null})}, preventDefault() {prevented = true;}, stopImmediatePropagation() {stopped = true;}});
    assert.ok(prevented && stopped);
    assert.match(modal.innerHTML, /不會儲存/);
  }
  let submitPrevented = false;
  handlers.find(([name]) => name === 'submit')[1]({preventDefault() {submitPrevented = true;}, stopImmediatePropagation() {}});
  assert.ok(submitPrevented);
});

test('all main screens and order tabs render in admin and factory contexts', async () => {
  const expose = 'window.reviewTest={state,overview,workflow,finance,filesPage,settingsPage,detail};';
  assert.equal(app.split('\nboot();\n').length, 2);
  for (const factory of [false, true]) {
    const {context, api} = sandbox(factory ? '?view=factory' : '');
    vm.runInContext(app.replace('\nboot();\n', '\n' + expose + '\n'), context);
    const view = context.window.reviewTest;
    assert.equal(view.state.public, factory);
    view.state.orders = (await api(factory ? '/api/public/orders' : '/api/orders')).orders;
    for (const name of factory ? ['overview', 'workflow'] : ['overview', 'workflow', 'finance', 'filesPage', 'settingsPage']) {
      const html = view[name]();
      assert.ok(html.length > 100, name);
      assert.doesNotMatch(html, /href=["']\/[^/]/);
    }
    for (const order of view.state.orders) {
      view.state.selected = order.id;
      for (const tab of factory ? ['progress', 'spec', 'files'] : ['progress', 'spec', 'finance', 'files', 'history']) {
        view.state.detailTab = tab;
        const html = view.detail();
        assert.ok(html.length > 100);
        if (factory) assert.doesNotMatch(html, /NT\$|虛構帳務資料|單價（內部）/);
      }
    }
  }
});
