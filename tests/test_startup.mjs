import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise startup without a browser or live order data. These small mocks only
// implement the DOM operations used by the initial screen and retry action.
const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const loading = 'Re:Nrob Lab 正在載入工作空間…';
const mockOrders = [
  ['DEMO-001', '示範甲'], ['DEMO-002', '示範乙'], ['DEMO-003', '示範丙'],
  ['DEMO-004', '示範丁'], ['DEMO-005', '示範戊'], ['DEMO-006', '示範己'],
].map(([orderNo, code], index) => ({
  id: String(index + 1), orderNo, code, styleNo: '', items: [],
  workflowConfirmed: false, sampleRequired: true, sampleStage: 'requirements',
  productionStatus: 'waiting', sampleDue: '', productionDue: '', files: [],
}));

function response(body) {
  return { ok: true, status: 200, json: async () => body };
}

function harness({ pathname = '/', fetchImpl } = {}) {
  const elements = new Map();
  const listeners = new Map();
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  let legacyStatus = 'original window status';
  const statusWrites = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '',
      classList: { add() {}, remove() {} },
    });
    return elements.get(id);
  };
  const app = element('app');
  app.innerHTML = loading;
  const document = {
    querySelector(selector) {
      assert.match(selector, /^#[\w-]+$/, `Unexpected startup selector: ${selector}`);
      const id = selector.slice(1);
      if (['app', 'toast', 'modal'].includes(id) || app.innerHTML.includes(`id="${id}"`)) return element(id);
      return null;
    },
    querySelectorAll() { return []; },
    addEventListener(name, callback) { listeners.set(name, callback); },
  };
  const sandbox = {
    document, location: { pathname }, AbortController, DOMException,
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fetch(path, options) {
      calls.push({ path, options });
      return fetchImpl(path, options);
    },
    scrollTo() {},
  };
  Object.defineProperty(sandbox, 'status', {
    configurable: true, enumerable: true,
    get() { return legacyStatus; },
    set(value) { legacyStatus = String(value); statusWrites.push(legacyStatus); },
  });
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: 'web/app.js', timeout: 1000 });
  return {
    app, calls, timers, context, statusWrites,
    async settle() {
      // Bound the number of turns so a hung startup cannot hang this suite.
      for (let i = 0; i < 30; i++) await Promise.resolve();
    },
    async retry() {
      const click = listeners.get('click');
      assert.equal(typeof click, 'function');
      await click({ target: { closest: () => ({ dataset: { action: 'retry' } }) } });
    },
    fireTimeout() {
      const pending = [...timers.entries()];
      assert.equal(pending.length, 1, 'One bounded request timeout should be pending');
      const [id, timer] = pending[0];
      assert.equal(timer.delay, 10000);
      timers.delete(id);
      timer.callback();
    },
  };
}

test('unauthenticated startup displays the internal login form', { timeout: 1000 }, async () => {
  const h = harness({ fetchImpl: async () => response({ admin: false, local: true }) });
  await h.settle();
  assert.match(h.app.innerHTML, /id="login-form"/);
  assert.match(h.app.innerHTML, /回到你的工作空間/);
  assert.doesNotMatch(h.app.innerHTML, /正在載入工作空間/);
  assert.deepEqual(h.calls.map(call => call.path), ['/api/session']);
  assert.equal(h.timers.size, 0, 'Successful requests must clear their timeouts');
});

test('factory startup renders six public orders without a login', { timeout: 1000 }, async () => {
  const h = harness({ pathname: '/factory', fetchImpl: async path => {
    if (path === '/api/session') return response({ admin: false, local: true });
    assert.equal(path, '/api/public/orders');
    return response({ orders: mockOrders });
  } });
  await h.settle();
  assert.match(h.app.innerHTML, /灣得製作進度/);
  assert.match(h.app.innerHTML, /共 6 筆訂單/);
  assert.equal((h.app.innerHTML.match(/class="order-link"/g) || []).length, 6);
  for (const order of mockOrders) assert.ok(h.app.innerHTML.includes(order.orderNo));
  assert.doesNotMatch(h.app.innerHTML, /id="login-form"|data-page="finance"|data-action="new"/);
  assert.deepEqual(h.calls.map(call => call.path), ['/api/session', '/api/public/orders']);
  assert.equal(h.timers.size, 0);
});

test('network failure displays a retry action that recovers', { timeout: 1000 }, async () => {
  let offline = true;
  const h = harness({ fetchImpl: async () => {
    if (offline) throw new TypeError('Failed to fetch');
    return response({ admin: false, local: true });
  } });
  await h.settle();
  assert.match(h.app.innerHTML, /data-action="retry"/);
  assert.doesNotMatch(h.app.innerHTML, /正在載入工作空間/);
  assert.equal(h.timers.size, 0);
  offline = false;
  await h.retry();
  await h.settle();
  assert.match(h.app.innerHTML, /id="login-form"/);
});

test('a pending fetch is aborted after ten seconds and offers retry', { timeout: 1000 }, async () => {
  let requestSignal;
  const h = harness({ fetchImpl: (_path, options) => {
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => {
      if (requestSignal) requestSignal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    });
  } });
  await h.settle();
  assert.ok(requestSignal, 'Fetch must receive an abort signal');
  assert.equal(requestSignal.aborted, false);
  h.fireTimeout();
  await h.settle();
  assert.equal(requestSignal.aborted, true);
  assert.match(h.app.innerHTML, /data-action="retry"/);
  assert.doesNotMatch(h.app.innerHTML, /正在載入工作空間/);
  assert.equal(h.timers.size, 0);
});

test('startup leaves the legacy string-valued Window.status property intact', { timeout: 1000 }, async () => {
  const h = harness({ fetchImpl: async () => response({ admin: false, local: true }) });
  await h.settle();
  assert.equal(h.context.status, 'original window status');
  assert.deepEqual(h.statusWrites, []);
  assert.match(h.app.innerHTML, /id="login-form"/);
});

test('opening index.html as a local file redirects to the running workspace', { timeout: 1000 }, () => {
  const htmlFile = new URL('../web/index.html', import.meta.url);
  const html = readFileSync(htmlFile, 'utf8');
  const startupPath = html.match(/<script\b[^>]*\bsrc="([^"]+)"/)?.[1];
  assert.ok(startupPath, 'The local HTML must load its startup script');
  const startupFile = new URL(startupPath, htmlFile);
  // A root-relative script would resolve to /startup.js when using file:, and
  // never execute the redirect that this regression test exercises.
  assert.equal(startupFile.pathname, new URL('../web/startup.js', import.meta.url).pathname);
  const startupSource = readFileSync(startupFile, 'utf8');
  const replacements = [];
  const context = vm.createContext({
    window: { location: { protocol: 'file:', replace: url => replacements.push(url) } },
  });
  vm.runInContext(startupSource, context, { filename: 'web/startup.js', timeout: 1000 });
  assert.deepEqual(replacements, ['http://127.0.0.1:8765/']);
});
