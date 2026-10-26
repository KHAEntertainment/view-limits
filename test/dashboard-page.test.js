'use strict';
// Issue #62 — the dashboard page scaffold: the page and asset routes on the
// loopback control listener, the page's pure logic and renderer, and the
// escaping of hostile provider/config strings. No provider, no credentials, no
// network beyond loopback sockets this file opens itself, no browser.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const { createControlServer } = require('../lib/dashboard/server');
const { refreshTokenFor, ASSETS } = require('../lib/dashboard/page');
const L = require('../lib/dashboard/page/logic');
const R = require('../lib/dashboard/page/render');

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

function raw(port, { method = 'GET', pathname = '/', headers = {}, body, host = `127.0.0.1:${port}` }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: Object.assign({ Host: host }, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const NOW = Date.parse('2026-10-25T10:00:00Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function route(over) {
  return Object.assign({
    id: 'r', label: 'R', provider: 'minimax', recipe: null, accountId: 'acct-1', state: 'healthy',
    observedAt: iso(-40000), windows: [], balance: null, reauth: null, quotaEligibility: 'eligible',
    reasonCodes: [], error: null,
  }, over);
}

function statusDoc(routes, profiles = []) {
  return {
    schemaVersion: 1,
    status: 'ok',
    daemon: { intervalSeconds: 30, instanceId: 'a'.repeat(32), startedAt: iso(-600000) },
    collection: { state: 'idle', lastGoodAt: iso(-12000), lastAttempt: { outcome: 'completed' } },
    view: { schemaVersion: 1, status: 'ok', routes, profiles },
  };
}

// ---- tree helpers ------------------------------------------------------------

function walk(node, fn) {
  if (typeof node === 'string') return;
  fn(node);
  for (const c of node.children) walk(c, fn);
}
function findAll(tree, pred) { const out = []; walk(tree, (n) => { if (pred(n)) out.push(n); }); return out; }
function textOf(node) { return typeof node === 'string' ? node : node.children.map(textOf).join(''); }
const hasClass = (n, cls) => typeof n.attrs.class === 'string' && n.attrs.class.split(' ').includes(cls);

function ctx(over) {
  return Object.assign({ mode: 'local', narrow: false, now: NOW, threshold: 0.2, fetchFailed: false, expanded: new Set(), refresh: {}, on: { refresh() {}, toggle() {} } }, over);
}

// ---- the server routes -----------------------------------------------------

console.log('page routes');

async function withServer(fn, { nonce = 'n'.repeat(64), threshold = 0.15, getStatus } = {}) {
  const calls = { stop: 0, refresh: 0 };
  const instance = { instanceId: 'a'.repeat(32), pid: process.pid, startedAt: new Date().toISOString(), nonce };
  const server = createControlServer({
    identity: instance,
    getStatus: getStatus || (() => statusDoc([route({})])),
    refresh: () => { calls.refresh += 1; return { coalesced: false }; },
    requestStop: () => { calls.stop += 1; },
    threshold,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port, calls, instance); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('GET / serves the HTML page with a strict CSP and the security headers', async () => {
  await withServer(async (port, calls, instance) => {
    const res = await raw(port, { pathname: '/' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
    const csp = res.headers['content-security-policy'];
    for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
      assert.ok(csp.split('; ').includes(part), part);
    }
    assert.ok(!/unsafe-inline|unsafe-eval|https?:|\*/.test(csp), csp);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    // No inline script: every <script> has a same-origin src.
    assert.ok(!/<script(?![^>]*\ssrc="\/assets\/)/.test(res.text), 'inline script');
    assert.ok(res.text.includes('<meta name="vl-mode" content="local">'));
    assert.ok(res.text.includes('<meta name="vl-threshold" content="0.15">'));
    assert.ok(res.text.includes(`<meta name="vl-refresh-token" content="${refreshTokenFor(instance.nonce)}">`));
    assert.ok(!res.text.includes(instance.nonce), 'the nonce itself is never in the page');
  });
});

test('GET /?view=lan is a labelled preview with no refresh token', async () => {
  await withServer(async (port, calls, instance) => {
    const res = await raw(port, { pathname: '/?view=lan' });
    assert.strictEqual(res.status, 200);
    assert.ok(res.text.includes('<meta name="vl-mode" content="lan-preview">'));
    assert.ok(!res.text.includes('vl-refresh-token'));
    assert.ok(!res.text.includes(refreshTokenFor(instance.nonce)));
    assert.ok(!res.text.includes(instance.nonce));
  });
});

test('a malformed threshold falls back to 0.2 in the page', async () => {
  for (const threshold of [null, 0, 1, 7, NaN, '0.3']) {
    await withServer(async (port) => {
      const res = await raw(port, { pathname: '/' });
      assert.ok(res.text.includes('<meta name="vl-threshold" content="0.2">'), String(threshold));
    }, { threshold });
  }
});

test('assets: only the fixed allowlist is served, with the right types', async () => {
  await withServer(async (port) => {
    for (const [name, type] of Object.entries(ASSETS)) {
      const res = await raw(port, { pathname: `/assets/${name}` });
      assert.strictEqual(res.status, 200, name);
      assert.strictEqual(res.headers['content-type'], type, name);
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff', name);
      assert.ok(res.buf.equals(fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard', 'page', name))), name);
    }
    for (const bad of ['/assets/', '/assets/nope.js', '/assets/../server.js', '/assets/%2e%2e/server.js', '/assets/fonts/OFL.txt', '/assets/app.js/', '/assets/constructor', '/index.html']) {
      assert.strictEqual((await raw(port, { pathname: bad })).status, 404, bad);
    }
    assert.strictEqual((await raw(port, { method: 'POST', pathname: '/', body: '' })).status, 405);
    assert.strictEqual((await raw(port, { method: 'POST', pathname: '/assets/app.js', body: '' })).status, 405);
  });
});

test('the loopback exact-Host check still applies to the page and the assets', async () => {
  await withServer(async (port) => {
    for (const pathname of ['/', '/?view=lan', '/assets/app.js']) {
      for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost:${port}.evil.example`]) {
        const res = await raw(port, { pathname, host });
        assert.strictEqual(res.status, 403, `${pathname} ${host}`);
        assert.ok(!res.text.includes('vl-refresh-token'));
      }
    }
  });
});

test('/api/status and /api/identity carry neither the nonce nor the refresh token', async () => {
  await withServer(async (port, calls, instance) => {
    const token = refreshTokenFor(instance.nonce);
    for (const pathname of ['/api/status', '/api/identity']) {
      const res = await raw(port, { pathname });
      assert.strictEqual(res.status, 200);
      assert.ok(!res.text.includes(instance.nonce), pathname);
      assert.ok(!res.text.includes(token), pathname);
    }
  });
});

test('the refresh token authorises /api/refresh only, never /api/stop', async () => {
  await withServer(async (port, calls, instance) => {
    const token = refreshTokenFor(instance.nonce);
    const headers = { 'X-VL-Nonce': token, 'Content-Type': 'application/json' };
    const ok = await raw(port, { method: 'POST', pathname: '/api/refresh', headers, body: '{}' });
    assert.strictEqual(ok.status, 202);
    assert.strictEqual(calls.refresh, 1);
    const stop = await raw(port, { method: 'POST', pathname: '/api/stop', headers, body: '{}' });
    assert.strictEqual(stop.status, 401);
    assert.strictEqual(calls.stop, 0);
    // A cross-origin page cannot use it either: the Origin check still applies.
    const cross = await raw(port, { method: 'POST', pathname: '/api/refresh', headers: Object.assign({ Origin: 'http://evil.example' }, headers), body: '{}' });
    assert.strictEqual(cross.status, 403);
    assert.strictEqual(calls.refresh, 1);
  });
});

test('before the nonce exists, the page has no token and nothing is authorised', async () => {
  await withServer(async (port, calls) => {
    const page = await raw(port, { pathname: '/' });
    assert.ok(!page.text.includes('vl-refresh-token'));
    for (const guess of [refreshTokenFor(null), refreshTokenFor('null'), refreshTokenFor(''), 'null']) {
      const res = await raw(port, { method: 'POST', pathname: '/api/refresh', headers: { 'X-VL-Nonce': guess }, body: '' });
      assert.strictEqual(res.status, 401);
    }
    assert.strictEqual(calls.refresh, 0);
  }, { nonce: null });
});

// ---- pure helpers --------------------------------------------------------------

console.log('page logic');

test('barLevel: 0% exhausted, under the threshold constrained, otherwise healthy', () => {
  assert.strictEqual(L.barLevel(0, 0.2), 'exhausted');
  assert.strictEqual(L.barLevel(-0.1, 0.2), 'exhausted');
  assert.strictEqual(L.barLevel(0.001, 0.2), 'constrained');
  assert.strictEqual(L.barLevel(0.199, 0.2), 'constrained');
  assert.strictEqual(L.barLevel(0.2, 0.2), 'healthy');
  assert.strictEqual(L.barLevel(1, 0.2), 'healthy');
  assert.strictEqual(L.barLevel(0.25, 0.3), 'constrained');
  assert.strictEqual(L.barLevel(0.19, undefined), 'constrained', 'default threshold 0.2');
  for (const none of [null, undefined, NaN, '0.5']) assert.strictEqual(L.barLevel(none, 0.2), null, String(none));
  assert.strictEqual(L.parseThreshold('0.15'), 0.15);
  for (const bad of [null, '', 'x', '1', '1.5', '0', '-0.2', '0.2; x']) assert.strictEqual(L.parseThreshold(bad), 0.2, String(bad));
});

test('dashboardUrlFor: a fixed table for built-in providers; custom and recipe routes get none', () => {
  // The owner-verified table, pinned exactly.
  assert.deepStrictEqual({ ...L.PROVIDER_DASHBOARDS }, {
    xiaomi: 'https://platform.xiaomimimo.com/console/plan-manage',
    minimax: 'https://platform.minimax.io/console/usage',
    kimi: 'https://www.kimi.ai/code/console',
    openrouter: 'https://openrouter.ai/settings/credits',
    deepseek: 'https://platform.deepseek.com/usage',
    glm: 'https://z.ai/manage-apikey/coding-plan/personal/usage',
  });
  assert.strictEqual(L.dashboardUrlFor({ provider: 'xiaomi', recipe: null }), 'https://platform.xiaomimimo.com/console/plan-manage');
  for (const p of ['minimax', 'kimi', 'openrouter', 'deepseek', 'glm']) {
    const url = L.dashboardUrlFor({ provider: p, recipe: null });
    assert.ok(url && L.safeHttpsUrl(url) === url, p);
  }
  // A custom route carries a recipe even when its provider id looks built-in.
  assert.strictEqual(L.dashboardUrlFor({ provider: 'kimi', recipe: 'openai-compatible' }), null);
  assert.strictEqual(L.dashboardUrlFor({ provider: 'alibaba', recipe: 'alibaba-coding-plan' }), null);
  assert.strictEqual(L.dashboardUrlFor({ provider: 'stepfun', recipe: 'stepfun-plan' }), null);
  for (const p of ['my-proxy', 'constructor', '__proto__', 'toString', '', null]) {
    assert.strictEqual(L.dashboardUrlFor({ provider: p, recipe: null }), null, String(p));
  }
  assert.strictEqual(L.isCustomRoute({ recipe: 'openai-compatible' }), true);
  assert.strictEqual(L.isCustomRoute({ recipe: 'stepfun-plan' }), false);
  assert.strictEqual(L.isCustomRoute({ recipe: null, provider: 'kimi' }), false);
});

test('safeHttpsUrl: https only, no userinfo, no query, no control characters', () => {
  assert.strictEqual(L.safeHttpsUrl('https://platform.xiaomimimo.com/'), 'https://platform.xiaomimimo.com/');
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'http://example.com/', '//example.com/',
    'https://u:p@example.com/', 'https://example.com/?token=1', 'https://exa\nmple.com/', 'https://example.com/\u0085x',
    'https://example.com\\@evil.example/', ' ', '', null, 42, {}]) {
    assert.strictEqual(L.safeHttpsUrl(bad), null, JSON.stringify(bad));
  }
});

test('attentionItems: login expired, exhausted and collection failed; one per route', () => {
  const view = { routes: [
    route({ id: 'a', state: 'healthy' }),
    route({ id: 'b', state: 'exhausted', windows: [{ type: 'rolling-5h', remainingRatio: 0, resetAt: iso(3600e3) }, { type: 'weekly', remainingRatio: 0.3, resetAt: iso(1000) }] }),
    route({ id: 'c', state: 'unknown', reauth: { required: true, url: 'https://platform.xiaomimimo.com/' }, reasonCodes: ['reauth-required', 'collection-failed'] }),
    route({ id: 'd', state: 'unknown', reasonCodes: ['collection-failed'] }),
    route({ id: 'e', state: 'constrained' }),
  ] };
  const items = L.attentionItems(view);
  assert.deepStrictEqual(items.map((i) => [i.route.id, i.kind]), [['c', 'reauth'], ['b', 'exhausted'], ['d', 'failed']]);
  // The exhausted reset is the spent window's, not the earliest of all.
  assert.strictEqual(items[1].resetAt, iso(3600e3));
  assert.deepStrictEqual(L.attentionItems({ routes: [route({})] }), []);
  assert.deepStrictEqual(L.attentionItems(null), []);
});

test('reauthCopy: the LAN view says "log in again on your Mac" with no link; local validates the URL', () => {
  const r = route({ reauth: { required: true, url: 'https://platform.xiaomimimo.com/', profile: 'Work' } });
  assert.deepStrictEqual(L.reauthCopy(r, 'lan'), { text: 'Login expired: log in again on your Mac', url: null, profile: null });
  assert.deepStrictEqual(L.reauthCopy(r, 'local'), { text: 'Log in again', url: 'https://platform.xiaomimimo.com/', profile: 'Work' });
  const hostile = route({ reauth: { required: true, url: 'javascript:alert(1)' } });
  assert.strictEqual(L.reauthCopy(hostile, 'local').url, null);
  assert.strictEqual(L.reauthCopy(route({}), 'local'), null);
});

test('honesty: pending and unknown are never healthy; a null balance is absent, never 0.00', () => {
  assert.strictEqual(L.displayState(route({ state: 'unknown', observedAt: null, reasonCodes: ['collection-pending'] })), 'pending');
  assert.strictEqual(L.displayState(route({ state: 'unknown', observedAt: iso(-1), reasonCodes: ['collection-pending'] })), 'unknown');
  assert.strictEqual(L.displayState(route({ state: 'bogus' })), 'unknown');
  assert.strictEqual(L.headerStatus({ status: 'pending' }).tone, 'unknown');
  assert.strictEqual(L.headerStatus({ status: 'stale' }).tone, 'constrained');
  assert.strictEqual(L.headerStatus({ status: 'weird' }).label, 'unavailable');
  assert.strictEqual(L.headerStatus({ status: 'ok' }, true).label, 'disconnected');
  assert.strictEqual(L.formatMoney(null, 'USD'), null);
  assert.strictEqual(L.formatMoney(0, 'USD'), '$0.00');
  assert.strictEqual(L.formatMoney(18.42, 'USD'), '$18.42');
  assert.strictEqual(L.formatMoney(5, '<b>'), '5.00 <b>');
  assert.strictEqual(L.formatDuration(9600e3), '2 h 40 m');
  assert.strictEqual(L.formatAgo(iso(-12000), NOW), '12 s ago');
  assert.strictEqual(L.formatReset(iso(4320e3), NOW), 'in 1 h 12 m');
});

// ---- the renderer ------------------------------------------------------------

console.log('page render');

test('an unknown route gets no bar, its raw counts as text, and a stale "last seen"', () => {
  const r = route({ state: 'unknown', windows: [{ type: 'credit', remaining: 412, limit: 1000, remainingRatio: 0.412 }], reasonCodes: ['stale-observation'] });
  const tree = R.routeCard(r, ctx());
  assert.strictEqual(findAll(tree, (n) => hasClass(n, 'track')).length, 0);
  assert.ok(textOf(tree).includes('412 / 1,000 (last seen 40 s ago)'));
  assert.ok(textOf(tree).includes('stale observation'));
  assert.ok(!/healthy/i.test(textOf(tree)));
});

test('#120: a refused route renders its reason chip and the human fix (local)', () => {
  const r = route({ state: 'unknown', refusal: { reason: 'unknown-region', fix: 'region must be one of: global, china' } });
  const tree = R.routeCard(r, ctx());
  const text = textOf(tree);
  assert.ok(text.includes('unknown region'), 'the reason chip word renders');
  assert.ok(text.includes('region must be one of: global, china'), 'the human fix renders');
  const chips = findAll(tree, (n) => hasClass(n, 'reason'));
  assert.strictEqual(chips.length, 1, 'one reason chip for the refusal');
  assert.strictEqual(chips[0].attrs.class, 'chip reason', 'styled like the other reason chips');
});

test('#120: the LAN view never renders a refusal (C-003); a non-refused route shows none', () => {
  const refused = route({ state: 'unknown', refusal: { reason: 'unknown-region', fix: 'region must be one of: global, china' } });
  const lanText = textOf(R.routeCard(refused, ctx({ mode: 'lan' })));
  assert.ok(!lanText.includes('unknown region'));
  assert.ok(!lanText.includes('region must be one of'));
  const plain = textOf(R.routeCard(route({ state: 'unknown' }), ctx()));
  assert.ok(!plain.includes('unknown region'));
  assert.ok(!plain.includes('region must be one of'));
});

test('each bar is coloured by its own window (M2-A); the route state stays on the chip', () => {
  const r = route({ state: 'exhausted', windows: [{ type: 'rolling-5h', remainingRatio: 0 }, { type: 'weekly', remainingRatio: 0.31 }, { type: 'monthly', remainingRatio: 0.1 }] });
  const fills = findAll(R.routeCard(r, ctx()), (n) => hasClass(n, 'fill'));
  assert.deepStrictEqual(fills.map((n) => n.attrs.class), ['fill tone-bg-exhausted', 'fill tone-bg-healthy', 'fill tone-bg-constrained']);
  assert.deepStrictEqual(fills.map((n) => n.attrs.style.width), ['0%', '31%', '10%']);
  const chipNode = findAll(R.routeCard(r, ctx()), (n) => hasClass(n, 'state'))[0];
  assert.strictEqual(textOf(chipNode), 'exhausted');
});

test('local cards: a Dashboard button for built-in providers only, opened safely', () => {
  const links = (r) => findAll(R.routeCard(r, ctx()), (n) => n.tag === 'a' && hasClass(n, 'dash'));
  const [kimi] = links(route({ provider: 'kimi' }));
  assert.strictEqual(kimi.attrs.href, 'https://www.kimi.ai/code/console');
  assert.strictEqual(kimi.attrs.target, '_blank');
  assert.strictEqual(kimi.attrs.rel, 'noopener noreferrer');
  assert.strictEqual(links(route({ provider: 'my-proxy', recipe: 'openai-compatible' })).length, 0);
  assert.ok(textOf(R.routeCard(route({ provider: 'my-proxy', recipe: 'openai-compatible' }), ctx())).includes('Custom route'));
});

test('LAN preview: no controls, no links, no identifiers, every route in order', () => {
  const doc = statusDoc([
    route({ id: 'x', label: 'Xiaomi MiMo', provider: 'xiaomi', state: 'unknown', reauth: { required: true, url: 'https://platform.xiaomimimo.com/', profile: 'ProfileHintZ' }, reasonCodes: ['reauth-required'] }),
    route({ id: 'k', label: 'Kimi', provider: 'kimi', accountId: 'acct-secret', error: 'raw provider error text' }),
    route({ id: 'c', label: 'my-proxy', provider: 'my-proxy', recipe: 'openai-compatible' }),
  ], [{ identity: { host: 'host-name-q', provider: 'anthropic', profileId: 'profile-id-q' }, harness: 'claude', state: 'healthy', windows: [], reasonCodes: [] }]);
  const tree = R.renderPage(doc, ctx({ mode: 'lan', preview: true }));
  const text = textOf(tree);
  assert.strictEqual(findAll(tree, (n) => n.tag === 'a').length, 0, 'no links on the LAN view');
  assert.strictEqual(findAll(tree, (n) => n.tag === 'button').length, 0, 'no controls on the LAN view');
  assert.strictEqual(findAll(tree, (n) => hasClass(n, 'elig')).length, 0, 'no dispatch chips');
  for (const secret of ['acct-secret', 'ProfileHintZ', 'host-name-q', 'profile-id-q', 'raw provider error text', 'platform.xiaomimimo.com']) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.ok(text.includes('Login expired: log in again on your Mac'));
  assert.ok(text.includes('LAN preview'));
  assert.deepStrictEqual(findAll(tree, (n) => n.tag === 'article').map((n) => n.attrs['data-route']), ['x', 'k', 'c']);
});

test('narrow local pane: one line per route, expanding shows the card content', () => {
  const doc = statusDoc([route({ id: 'a', windows: [{ type: 'rolling-5h', remainingRatio: 0.72 }] }), route({ id: 'b', provider: 'kimi' })]);
  const closed = R.renderPage(doc, ctx({ narrow: true }));
  assert.strictEqual(findAll(closed, (n) => n.tag === 'article').length, 0);
  const lines = findAll(closed, (n) => hasClass(n, 'line'));
  assert.deepStrictEqual(lines.map((n) => n.attrs['aria-expanded']), ['false', 'false']);
  const open = R.renderPage(doc, ctx({ narrow: true, expanded: new Set(['a']) }));
  assert.strictEqual(findAll(open, (n) => hasClass(n, 'det')).length, 1);
  assert.ok(textOf(open).includes('72% left'));
  assert.strictEqual(findAll(open, (n) => hasClass(n, 'dash')).length, 0, 'the pane carries no dashboard buttons');
});

test('Q9: the dashboard button is an icon with a "Dashboard" tooltip and a full accessible name', () => {
  const card = R.routeCard(route({ provider: 'kimi', label: 'Kimi' }), ctx());
  const [btn] = findAll(card, (n) => n.tag === 'a' && hasClass(n, 'icon-btn'));
  assert.ok(btn, 'icon button rendered');
  assert.strictEqual(btn.attrs['aria-label'], 'Open Kimi dashboard');
  assert.strictEqual(btn.attrs.title, undefined, 'no native title tooltip');
  assert.strictEqual(btn.attrs.target, '_blank');
  assert.strictEqual(btn.attrs.rel, 'noopener noreferrer');
  assert.strictEqual(btn.attrs['data-key'], 'dash:r', 'focus survives a poll re-render');
  assert.strictEqual(findAll(btn, (n) => hasClass(n, 'ext-icon')).length, 1);
  const tips = findAll(btn, (n) => hasClass(n, 'tip'));
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(textOf(tips[0]), 'Dashboard');
  assert.strictEqual(textOf(btn), 'Dashboard', 'the only visible text is the tooltip');
  // Far right of the title row: the last child of the card header.
  const head = findAll(card, (n) => hasClass(n, 'ch'))[0];
  assert.strictEqual(head.children[head.children.length - 1], btn);
  // None on the LAN view, none for a custom route.
  assert.strictEqual(findAll(R.routeCard(route({ provider: 'kimi' }), ctx({ mode: 'lan' })), (n) => hasClass(n, 'icon-btn')).length, 0);
  assert.strictEqual(findAll(R.routeCard(route({ provider: 'x', recipe: 'openai-compatible' }), ctx()), (n) => hasClass(n, 'icon-btn')).length, 0);
  // The tooltip shows on hover AND keyboard focus.
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard', 'page', 'app.css'), 'utf8');
  assert.ok(css.includes('.icon-btn:hover .tip, .icon-btn:focus-visible .tip { opacity: 1; }'));
});

test('Q9: the desktop grid is capped at three columns', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard', 'page', 'app.css'), 'utf8');
  const rule = /\.grid \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(max\(320px, calc\(\(100% - 28px\) \/ 3\)\), 1fr\)\);/;
  assert.ok(rule.test(css), 'grid columns are never narrower than a third (gap 14px x 2)');
});

test('Q9: wrapped "A · B" lines carry no stray separator; the pane header keeps the attention count whole', () => {
  const profiles = [
    { identity: {}, harness: 'claude', state: 'healthy', windows: [{ type: 'rolling-5h', remainingRatio: 0.64, resetAt: iso(7900e3) }], reasonCodes: [] },
    { identity: {}, harness: 'codex', state: 'unknown', windows: [], reasonCodes: [] },
  ];
  const doc = statusDoc([route({ state: 'exhausted', windows: [{ type: 'rolling-5h', remainingRatio: 0, resetAt: iso(3600e3) }] })], profiles);
  const strays = (tree) => findAll(tree, (n) => n.children.some((c) => typeof c === 'string' && /(^|\s)·(\s|$)/.test(c)));
  for (const c of [ctx({ mode: 'lan' }), ctx({ narrow: true })]) {
    const tree = R.renderPage(doc, c);
    const list = findAll(tree, (n) => hasClass(n, 'plist'))[0];
    assert.ok(list, 'profile list rendered');
    assert.deepStrictEqual(strays(list), [], 'no literal separator text in the profile list');
    const items = findAll(list, (n) => n.tag === 'li');
    assert.deepStrictEqual(items.map((li) => findAll(li, (n) => hasClass(n, 'seg')).length), [4, 2]);
    assert.ok(textOf(items[0]).includes('64% left (5 hour)') && textOf(items[0]).includes('resets in 2 h 11 m'));
    const fresh = findAll(tree, (n) => hasClass(n, 'fresh'))[0];
    assert.deepStrictEqual(strays(fresh), [], 'no literal separator text in the header freshness line');
  }
  const pane = R.renderPage(doc, ctx({ narrow: true }));
  const sub = findAll(pane, (n) => hasClass(n, 'sub'))[0];
  assert.ok(!textOf(sub).includes('next check'), 'the pane header drops "next check" to fit 360 px');
  const whole = findAll(sub, (n) => hasClass(n, 'nowrap'));
  assert.strictEqual(whole.length, 1);
  assert.strictEqual(textOf(whole[0]), '1 needs attention');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard', 'page', 'app.css'), 'utf8');
  assert.ok(css.includes('.segs { display: block; overflow: hidden; }') && css.includes('.seg.nowrap { white-space: nowrap; }'));
});

// ---- escaping, end to end through the real browser script --------------------

console.log('page escaping');

// A minimal DOM: elements record attributes and children; innerHTML and its
// relatives throw, so any use of them fails the test.
function fakeDom(metas) {
  class El {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.style = { props: {}, setProperty: (k, v) => { this.style.props[k] = v; } }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...c) { this.children = c; }
    addEventListener() {}
    focus() {}
    querySelector() { return null; }
    set innerHTML(v) { throw new Error('innerHTML used'); }
    set outerHTML(v) { throw new Error('outerHTML used'); }
    insertAdjacentHTML() { throw new Error('insertAdjacentHTML used'); }
    get textContent() { return this.children.map((c) => c.textContent).join(''); }
  }
  const root = new El('div');
  const document = {
    createElement: (t) => new El(t),
    createTextNode: (t) => ({ text: String(t), get textContent() { return this.text; } }),
    querySelector: (sel) => {
      const m = /^meta\[name="([^"]+)"\]$/.exec(sel);
      if (!m || !(m[1] in metas)) return null;
      const el = new El('meta'); el.setAttribute('content', metas[m[1]]); return el;
    },
    querySelectorAll: () => [],
    getElementById: (id) => (id === 'app' ? root : null),
    addEventListener() {},
    write() { throw new Error('document.write used'); },
    activeElement: null,
    hidden: false,
  };
  return { root, document };
}

test('hostile labels, reasons and URLs render as text; no markup, no script link', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const doc = statusDoc([
    route({ id: `id-${evil}`, label: `Label ${evil}`, provider: 'constructor', accountId: evil, error: `err ${evil}`,
      reasonCodes: [evil, 'stale-observation'], windows: [{ type: `type ${evil}`, remainingRatio: 0.5, resetAt: iso(60000) }],
      balance: { amount: 5, currency: evil, spent: null } }),
    route({ id: 'x', label: 'Xiaomi', provider: 'xiaomi', state: 'unknown',
      reauth: { required: true, url: 'javascript:alert(1)', profile: evil }, reasonCodes: ['reauth-required'] }),
  ], [{ identity: { host: evil, provider: 'p', profileId: evil }, harness: evil, state: evil, windows: [], reasonCodes: [] }]);

  const { root, document } = fakeDom({ 'vl-mode': 'local', 'vl-threshold': '0.2', 'vl-refresh-token': 't'.repeat(64) });
  const sandbox = {
    document,
    CSS: { escape: (s) => s },
    fetch: async () => ({ ok: true, status: 200, json: async () => doc }),
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    URL, Intl, Date, Math, Object, Array, String, Number, Set, Error, JSON,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.window.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.createContext(sandbox);
  for (const file of ['logic.js', 'render.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard', 'page', file), 'utf8'), sandbox, { filename: file });
  }
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));

  const elements = [];
  (function collect(n) { if (n.tag) { elements.push(n); n.children.forEach(collect); } }(root));
  assert.ok(elements.length > 20, 'the page rendered');
  assert.ok(root.textContent.includes(`Label ${evil}`), 'the hostile label is shown as text');
  assert.ok(root.textContent.includes(`err ${evil}`));
  assert.ok(!elements.some((e) => e.tag === 'img' || e.tag === 'script'), 'no element came from data');
  for (const e of elements) {
    if (e.attrs.href !== undefined) assert.ok(e.attrs.href.startsWith('https://'), e.attrs.href);
    assert.ok(!Object.keys(e.attrs).some((k) => /^on/i.test(k)), 'no event-handler attribute');
  }
  assert.ok(!elements.some((e) => e.tag === 'a' && /xiaomi/i.test(e.attrs['aria-label'] || '') && e.attrs.href === undefined),
    'the rejected reauth URL is not rendered as a link');
  // The hostile provider id resolves to no dashboard; Xiaomi's fixed one does.
  const hrefs = elements.filter((e) => e.tag === 'a').map((e) => e.attrs.href);
  assert.deepStrictEqual(hrefs, ['https://platform.xiaomimimo.com/console/plan-manage']);
  // The unknown reason code is dropped, the known one is shown.
  assert.ok(root.textContent.includes('stale observation'));
});

test('the browser scripts never use HTML-string sinks', () => {
  for (const file of ['logic.js', 'render.js', 'app.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard', 'page', file), 'utf8');
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.ok(!src.includes(sink), `${file}: ${sink}`);
    }
  }
});

(async () => {
  for (const { name, fn } of cases) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
  }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall dashboard-page tests passed');
  process.exit(0);
})();
