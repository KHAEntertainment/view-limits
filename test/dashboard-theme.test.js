'use strict';
// Issue #141 — the dashboard theme switch: system / light / dark, kept per
// browser in localStorage, applied before the first paint by page/theme.js.
// Storage that is missing or throws must never break the page. No provider,
// no credentials, no browser; loopback sockets this file opens itself only.

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const vm = require('vm');

const { createControlServer } = require('../lib/dashboard/server');
const { createLanServer } = require('../lib/dashboard/lan-server');
const { ASSETS } = require('../lib/dashboard/page');
const L = require('../lib/dashboard/page/logic');
const R = require('../lib/dashboard/page/render');

const PAGE_DIR = path.join(__dirname, '..', 'lib', 'dashboard', 'page');

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

function get(port, pathname, host = `127.0.0.1:${port}`) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    req.end();
  });
}

// Storage doubles: a working one, one that throws on every call, and one
// whose very property access throws (blocked site data in some browsers).
function memoryStorage(seed) {
  const store = new Map(seed ? Object.entries(seed) : []);
  return {
    store,
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
}
const throwingStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };

function rootElement() {
  return { attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); } };
}

// ---- logic -------------------------------------------------------------------

console.log('theme logic');

test('normalizeTheme: only system / light / dark; anything else is system', () => {
  assert.deepStrictEqual(L.THEMES, ['system', 'light', 'dark']);
  for (const t of L.THEMES) assert.strictEqual(L.normalizeTheme(t), t);
  for (const bad of [null, undefined, '', 'Dark', 'auto', '<script>', 1, {}]) assert.strictEqual(L.normalizeTheme(bad), 'system');
});

test('readTheme: system with no stored value, the stored choice otherwise, system when storage throws or is absent', () => {
  assert.strictEqual(L.readTheme(memoryStorage()), 'system');
  assert.strictEqual(L.readTheme(memoryStorage({ 'vl-theme': 'dark' })), 'dark');
  assert.strictEqual(L.readTheme(memoryStorage({ 'vl-theme': 'light' })), 'light');
  assert.strictEqual(L.readTheme(memoryStorage({ 'vl-theme': 'neon' })), 'system');
  assert.strictEqual(L.readTheme(throwingStorage), 'system');
  assert.strictEqual(L.readTheme(null), 'system');
});

test('writeTheme: light/dark are stored, system clears the key, a throwing store reports false and does not throw', () => {
  const s = memoryStorage();
  assert.strictEqual(L.writeTheme(s, 'dark'), true);
  assert.strictEqual(s.store.get(L.THEME_KEY), 'dark');
  assert.strictEqual(L.writeTheme(s, 'system'), true);
  assert.strictEqual(s.store.has(L.THEME_KEY), false, 'system is the absence of a choice');
  assert.strictEqual(L.writeTheme(s, 'bogus'), true);
  assert.strictEqual(s.store.has(L.THEME_KEY), false, 'an unknown value is stored as system');
  assert.strictEqual(L.writeTheme(throwingStorage, 'light'), false);
  assert.strictEqual(L.writeTheme(null, 'light'), false);
});

test('applyTheme: sets data-theme on the root to the normalized choice; a missing root is harmless', () => {
  const el = rootElement();
  assert.strictEqual(L.applyTheme(el, 'dark'), 'dark');
  assert.strictEqual(el.attrs['data-theme'], 'dark');
  assert.strictEqual(L.applyTheme(el, 'nonsense'), 'system');
  assert.strictEqual(el.attrs['data-theme'], 'system');
  assert.strictEqual(L.applyTheme(undefined, 'light'), 'light');
});

// ---- the control -------------------------------------------------------------

console.log('theme control');

const NOW = Date.parse('2026-10-25T10:00:00Z');
function ctx(over) {
  return Object.assign({ mode: 'local', narrow: false, now: NOW, threshold: 0.2, fetchFailed: false, expanded: new Set(), refresh: {}, on: { refresh() {}, toggle() {}, theme() {} } }, over);
}
function walk(node, fn) { if (typeof node === 'string') return; fn(node); for (const c of node.children) walk(c, fn); }
function findAll(tree, pred) { const out = []; walk(tree, (n) => { if (pred(n)) out.push(n); }); return out; }
function textOf(node) { return typeof node === 'string' ? node : node.children.map(textOf).join(''); }
const doc = { schemaVersion: 1, status: 'ok', daemon: { intervalSeconds: 30, startedAt: new Date(NOW - 600000).toISOString() }, collection: { state: 'idle' }, view: { schemaVersion: 1, status: 'ok', routes: [], profiles: [] } };

test('the control is a labelled group of three buttons; exactly the current choice is pressed (default system)', () => {
  for (const [theme, pressed] of [[undefined, 'system'], ['light', 'light'], ['dark', 'dark'], ['junk', 'system']]) {
    const tree = R.renderPage(doc, ctx({ theme }));
    const [group] = findAll(tree, (n) => n.attrs.role === 'group');
    assert.strictEqual(group.attrs['aria-label'], 'Theme');
    const buttons = findAll(group, (n) => n.tag === 'button');
    assert.deepStrictEqual(buttons.map((b) => b.attrs['data-key']), ['theme:system', 'theme:light', 'theme:dark']);
    assert.deepStrictEqual(buttons.map((b) => textOf(b)), ['System', 'Light', 'Dark'], 'visible labels on wide layouts');
    assert.deepStrictEqual(buttons.filter((b) => b.attrs['aria-pressed'] === 'true').map((b) => b.attrs['data-key']), [`theme:${pressed}`]);
    for (const b of buttons) assert.strictEqual(b.attrs.type, 'button');
  }
});

test('narrow layouts drop the words but every button keeps an accessible name', () => {
  const tree = R.renderPage(doc, ctx({ narrow: true }));
  const buttons = findAll(tree, (n) => n.tag === 'button' && typeof n.attrs['data-key'] === 'string' && n.attrs['data-key'].startsWith('theme:'));
  assert.deepStrictEqual(buttons.map((b) => b.attrs['aria-label']), ['System theme', 'Light theme', 'Dark theme']);
  for (const b of buttons) assert.strictEqual(textOf(b), '');
});

test('the LAN page has the control too, and clicking it calls only the page-side handler', () => {
  for (const over of [{ mode: 'lan' }, { mode: 'lan', preview: true }, { mode: 'lan', narrow: true }]) {
    const picked = [];
    const tree = R.renderPage(doc, ctx(Object.assign({ on: { refresh() { throw new Error('no refresh on LAN'); }, toggle() {}, theme: (t) => picked.push(t) } }, over)));
    const dark = findAll(tree, (n) => n.attrs['data-key'] === 'theme:dark')[0];
    assert.ok(dark, JSON.stringify(over));
    dark.attrs.on.click();
    assert.deepStrictEqual(picked, ['dark']);
  }
});

// ---- the browser scripts in a sandbox -----------------------------------------

console.log('theme in the page');

function runThemeScript(localStorage) {
  const root = rootElement();
  const sandbox = { document: { documentElement: root } };
  if (localStorage !== undefined) sandbox.localStorage = localStorage;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(PAGE_DIR, 'theme.js'), 'utf8'), sandbox, { filename: 'theme.js' });
  return root.attrs['data-theme'];
}

test('theme.js (pre-paint) applies the same choice logic.js reads, and survives throwing or missing storage', () => {
  for (const seed of [undefined, { 'vl-theme': 'light' }, { 'vl-theme': 'dark' }, { 'vl-theme': 'system' }, { 'vl-theme': '<b>' }]) {
    const expected = L.readTheme(memoryStorage(seed));
    assert.strictEqual(runThemeScript(memoryStorage(seed)), expected, JSON.stringify(seed));
  }
  assert.strictEqual(runThemeScript(throwingStorage), 'system');
  assert.strictEqual(runThemeScript(undefined), 'system', 'no localStorage at all');
  const src = fs.readFileSync(path.join(PAGE_DIR, 'theme.js'), 'utf8');
  assert.ok(src.includes(`'${L.THEME_KEY}'`), 'theme.js and logic.js share the key');
  for (const banned of ['fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'innerHTML', 'document.write', 'eval(']) {
    assert.ok(!src.includes(banned), `theme.js: ${banned}`);
  }
});

// A DOM double that keeps listeners, so the test can press the real buttons.
function fakeDom() {
  class El {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.style = { setProperty() {} }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...c) { this.children = c; }
    addEventListener(ev, fn) { this.listeners[ev] = fn; }
    focus() {}
    querySelector() { return null; }
    get textContent() { return this.children.map((c) => c.textContent).join(''); }
  }
  const app = new El('div');
  const html = new El('html');
  const metas = { 'vl-mode': 'local', 'vl-threshold': '0.2', 'vl-refresh-token': 't'.repeat(64) };
  const document = {
    documentElement: html,
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ text: String(t), get textContent() { return this.text; } }),
    querySelector: (sel) => { const m = /^meta\[name="([^"]+)"\]$/.exec(sel); if (!m || !(m[1] in metas)) return null; const e = new El('meta'); e.setAttribute('content', metas[m[1]]); return e; },
    querySelectorAll: () => [], getElementById: (id) => (id === 'app' ? app : null), addEventListener() {}, activeElement: null, hidden: false,
  };
  return { app, html, document };
}

function findEl(node, pred) {
  if (!node || !node.tag) return null;
  if (pred(node)) return node;
  for (const c of node.children) { const hit = findEl(c, pred); if (hit) return hit; }
  return null;
}

async function runApp({ storage, storageGetterThrows = false } = {}) {
  const { app, html, document } = fakeDom();
  const requests = [];
  const sandbox = {
    document,
    CSS: { escape: (s) => s },
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, status: 200, json: async () => doc }; },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    URL, URLSearchParams, Intl, Date, Math, Object, Array, String, Number, Set, Map, Error, JSON,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {} });
  if (storageGetterThrows) Object.defineProperty(sandbox, 'localStorage', { get() { throw new Error('SecurityError'); } });
  else if (storage) sandbox.localStorage = storage;
  vm.createContext(sandbox);
  for (const file of ['logic.js', 'render.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(PAGE_DIR, file), 'utf8'), sandbox, { filename: file });
  }
  const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); };
  await settle();
  const press = (theme) => findEl(app, (n) => n.attrs['data-key'] === `theme:${theme}`).listeners.click();
  const pressed = () => findEl(app, (n) => n.attrs['aria-pressed'] === 'true').attrs['data-key'];
  return { app, html, requests, press, pressed, settle };
}

test('the page: system by default; light/dark override it, system follows the OS again; the choice survives a reload', async () => {
  const storage = memoryStorage();
  const p = await runApp({ storage });
  assert.strictEqual(p.html.attrs['data-theme'], 'system');
  assert.strictEqual(p.pressed(), 'theme:system');
  p.press('dark');
  assert.strictEqual(p.html.attrs['data-theme'], 'dark');
  assert.strictEqual(p.pressed(), 'theme:dark');
  assert.strictEqual(storage.store.get('vl-theme'), 'dark');
  const reload = await runApp({ storage });
  assert.strictEqual(reload.html.attrs['data-theme'], 'dark', 'kept across a reload');
  assert.strictEqual(reload.pressed(), 'theme:dark');
  reload.press('light');
  assert.strictEqual(reload.html.attrs['data-theme'], 'light');
  reload.press('system');
  assert.strictEqual(reload.html.attrs['data-theme'], 'system');
  assert.strictEqual(storage.store.has('vl-theme'), false);
});

test('the page: throwing storage (or a throwing localStorage getter) never breaks it; the choice still works for the session', async () => {
  for (const opts of [{ storage: throwingStorage }, { storageGetterThrows: true }, {}]) {
    const p = await runApp(opts);
    assert.ok(p.app.textContent.includes('view-limits'), `rendered: ${JSON.stringify(Object.keys(opts))}`);
    assert.strictEqual(p.html.attrs['data-theme'], 'system');
    p.press('dark');
    assert.strictEqual(p.html.attrs['data-theme'], 'dark');
    assert.strictEqual(p.pressed(), 'theme:dark');
  }
});

test('the page: choosing a theme sends nothing to the daemon', async () => {
  const p = await runApp({ storage: memoryStorage() });
  const before = p.requests.length;
  p.press('dark');
  p.press('light');
  await p.settle();
  assert.strictEqual(p.requests.length, before, 'no request on a theme change');
  for (const r of p.requests) assert.ok(!/theme/i.test(`${r.url} ${JSON.stringify(r.opts || {})}`), r.url);
});

// ---- the served shell: loopback and LAN ------------------------------------------

console.log('theme served');

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
}

function checkShell(res, label) {
  assert.strictEqual(res.status, 200, label);
  const theme = res.text.indexOf('<script src="/assets/theme.js"></script>');
  const css = res.text.indexOf('<link rel="stylesheet" href="/assets/app.css">');
  assert.ok(theme > 0 && css > 0, `${label}: both tags present`);
  assert.ok(theme < css, `${label}: theme.js runs before the stylesheet`);
  assert.ok(!/<script[^>]*theme\.js[^>]*\b(defer|async)\b/.test(res.text), `${label}: theme.js is synchronous`);
  assert.ok(!/unsafe-inline/.test(res.headers['content-security-policy']), `${label}: CSP unchanged`);
}

test('the loopback and LAN shells load /assets/theme.js before the stylesheet, and both serve it', async () => {
  assert.strictEqual(ASSETS['theme.js'], 'text/javascript; charset=utf-8');
  const body = fs.readFileSync(path.join(PAGE_DIR, 'theme.js'), 'utf8');

  const control = createControlServer({
    identity: { instanceId: 'a'.repeat(32), pid: process.pid, startedAt: new Date().toISOString(), nonce: 'n'.repeat(64) },
    getStatus: () => doc, refresh: () => ({ coalesced: false }), requestStop() {}, threshold: 0.2,
  });
  await new Promise((r) => control.listen(0, '127.0.0.1', r));
  const lanPort = await freePort();
  const lanServer = createLanServer({ address: '127.0.0.1', port: lanPort, getStatus: () => doc, currentToken: () => 'f'.repeat(64) });
  await new Promise((r) => lanServer.listen(lanPort, '127.0.0.1', r));
  try {
    const port = control.address().port;
    checkShell(await get(port, '/'), 'loopback');
    checkShell(await get(port, '/?view=lan'), 'LAN preview');
    checkShell(await get(lanPort, '/'), 'LAN');
    for (const [p, label] of [[port, 'loopback'], [lanPort, 'LAN']]) {
      const res = await get(p, '/assets/theme.js');
      assert.strictEqual(res.status, 200, label);
      assert.strictEqual(res.headers['content-type'], 'text/javascript; charset=utf-8', label);
      assert.strictEqual(res.text, body, label);
    }
  } finally {
    control.closeAllConnections(); lanServer.closeAllConnections();
    await new Promise((r) => control.close(r));
    await new Promise((r) => lanServer.close(r));
  }
});

test('the stylesheet: an explicit choice beats the OS, and system still follows prefers-color-scheme', () => {
  const css = fs.readFileSync(path.join(PAGE_DIR, 'app.css'), 'utf8');
  assert.ok(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{[^}]*--canvas: #0F0F11/.test(css), 'system on a dark OS');
  assert.ok(/:root\[data-theme="dark"\] \{[^}]*color-scheme: dark;[^}]*--canvas: #0F0F11/.test(css), 'explicit dark');
  assert.ok(/:root\[data-theme="light"\] \{ color-scheme: light; \}/.test(css), 'explicit light');
  assert.ok(/\.theme-opt\[aria-pressed="true"\]/.test(css), 'the pressed state is styled from aria-pressed');
});

(async () => {
  for (const { name, fn } of cases) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
  }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall dashboard-theme tests passed');
  process.exit(0);
})();
