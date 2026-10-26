'use strict';
// Issue #62 hardening — the dashboard's LAN view: its configuration, the read
// token, the server-side redaction, the LAN listener, the page's token
// handling, and the real CLI (`dashboard lan enable|disable|rotate|url`,
// `dashboard start` with LAN on). No provider, no credential, no browser.
//
// The real-CLI scenarios bind a real non-loopback address of this machine;
// they are skipped when it has none. Every daemon they start is stopped (or
// killed) in `cleanup`.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const vm = require('vm');
const { spawnSync } = require('child_process');

const lan = require('../lib/dashboard/lan');
const { redactForLan } = require('../lib/dashboard/lan-redact');
const { createLanServer } = require('../lib/dashboard/lan-server');
const { CSP, ASSETS, refreshTokenFor } = require('../lib/dashboard/page');
const daemonLib = require('../lib/dashboard/daemon');
const records = require('../lib/dashboard/record');
const { buildViewSchema } = require('../lib/view-model');
const { scratch, vl, record, dirs, started, note, cleanup, alive, until, sleep } = require('./helpers/dashboard-harness');

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

const tmpDir = () => scratch(null);
const IFACES = { en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  utun4: [{ address: '100.64.0.9', family: 'IPv4', internal: false }], lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };
const cfgWith = (lanSection) => ({ dashboard: { lan: lanSection } });

function get(port, { pathname = '/', host = `127.0.0.1:${port}`, headers = {}, method = 'GET', address = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: address, port, method, path: pathname, headers: Object.assign({ Host: host }, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    req.end();
  });
}

// A status document full of identifying and secret values: none of the
// PLANTED_* strings may reach a LAN response.
const NOW = Date.now();
const iso = (ms) => new Date(NOW + ms).toISOString();
const PLANTED = {
  account: 'PLANTED_ACCOUNT_77', pool: 'PLANTED_POOL_77', routeId: 'planted-route-id-77', provider: 'planted-provider-77',
  reauthUrl: 'https://planted.example/login', profileHint: 'PLANTED_PROFILE_HINT', error: 'PLANTED provider error text',
  stateReason: 'planted-state-reason', source: 'planted-source', periodEnd: 'PLANTED_PERIOD_END', host: 'planted-host.example',
  profileId: 'planted-profile-id', instanceId: 'f'.repeat(32), attemptError: 'PLANTED attempt error', nonce: 'e'.repeat(64),
  customRecipe: 'planted-recipe', newField: 'PLANTED_NEW_FIELD', daemonHost: '10.99.99.99', collectionError: 'PLANTED collection error',
};
function identifyingDoc() {
  return {
    schemaVersion: 1,
    status: 'ok',
    nonce: PLANTED.nonce,
    daemon: { intervalSeconds: 30, instanceId: PLANTED.instanceId, startedAt: iso(-600000), host: PLANTED.daemonHost, port: 61234 },
    collection: { state: 'idle', attempts: 3, lastGoodAt: iso(-12000), observationAgeSeconds: 12, stale: false,
      lastAttempt: { trigger: 'tick', outcome: 'partial', error: PLANTED.attemptError, startedAt: iso(-13000) } },
    view: {
      schemaVersion: 1, generatedAt: iso(-12000), status: 'ok', reasonCodes: [],
      collection: { outcome: 'partial', error: PLANTED.collectionError, routes: [{ id: PLANTED.routeId, outcome: 'failed', error: PLANTED.collectionError }] },
      routes: [
        { id: PLANTED.routeId, label: 'Kimi', provider: PLANTED.provider, recipe: null, accountId: PLANTED.account, poolId: PLANTED.pool,
          state: 'healthy', basis: 'quota-window', freshness: 'fresh', observedAt: iso(-12000), freshUntil: iso(60000), source: PLANTED.source,
          windows: [{ type: 'rolling-5h', unit: null, remaining: null, limit: null, remainingRatio: 0.72, resetAt: iso(3600e3) }],
          balance: { amount: 18.42, currency: 'USD', spent: { daily: 0.81, weekly: 4.1, monthly: null } },
          reauth: { required: true, reason: 'auth-expired', url: PLANTED.reauthUrl, profile: PLANTED.profileHint, reasonCodes: [] },
          quotaEligibility: 'eligible', reasonCodes: ['reauth-required', 'not-a-real-code'], periodEnd: PLANTED.periodEnd,
          error: PLANTED.error, stateReason: PLANTED.stateReason, collection: { outcome: 'failed', error: PLANTED.collectionError },
          secretNewField: PLANTED.newField },
        { id: 'custom-planted', label: 'my-proxy', provider: PLANTED.provider, recipe: PLANTED.customRecipe, state: 'unknown', windows: [], reasonCodes: [] },
      ],
      profiles: [{ identity: { host: PLANTED.host, provider: 'claude', profileId: PLANTED.profileId }, harness: 'claude', authStatus: 'authenticated',
        rateLimitStatus: 'ok', state: 'healthy', freshness: 'fresh', observedAt: iso(-1000), usageAt: iso(-1000),
        windows: [{ type: 'rolling-5h', unit: 'percent', remaining: 64, limit: 100, remainingRatio: 0.64, resetAt: iso(7200e3) }], reasonCodes: [] }],
    },
  };
}

// ---- configuration -------------------------------------------------------------

console.log('LAN configuration');

test('resolveLanConfig: absent or disabled is off; a valid enabled section resolves', () => {
  assert.deepStrictEqual(lan.resolveLanConfig({}, { interfaces: IFACES }), { ok: true, enabled: false });
  assert.deepStrictEqual(lan.resolveLanConfig({ dashboard: {} }, { interfaces: IFACES }), { ok: true, enabled: false });
  assert.deepStrictEqual(lan.resolveLanConfig(cfgWith({ enabled: false, interface: '1.2.3.4', port: 1 }), { interfaces: IFACES }), { ok: true, enabled: false });
  assert.deepStrictEqual(lan.resolveLanConfig(cfgWith({ enabled: true, interface: '192.168.1.20', port: 47615 }), { interfaces: IFACES }),
    { ok: true, enabled: true, address: '192.168.1.20', port: 47615 });
  assert.strictEqual(lan.resolveLanConfig(cfgWith({ enabled: true, interface: '100.64.0.9', port: 1024 }), { interfaces: IFACES }).ok, true, 'a Tailscale address');
});

test('resolveLanConfig: a bad value refuses with the fix, never a default', () => {
  const bad = [
    [{ dashboard: 'x' }, /must be an object/],
    [cfgWith('yes'), /dashboard\.lan" must be an object/],
    [cfgWith({ enabled: 'yes' }), /enabled" must be true or false/],
    [cfgWith({ enabled: true, interface: '127.0.0.1', port: 5000 }), /loopback/],
    [cfgWith({ enabled: true, interface: '::1', port: 5000 }), /loopback/],
    [cfgWith({ enabled: true, interface: '::FFFF:127.0.0.1', port: 5000 }), /loopback/],
    [cfgWith({ enabled: true, interface: '0:0:0:0:0:0:0:1', port: 5000 }), /loopback/],
    [cfgWith({ enabled: true, interface: '0.0.0.0', port: 5000 }), /wildcard/],
    [cfgWith({ enabled: true, interface: '::', port: 5000 }), /wildcard/],
    [cfgWith({ enabled: true, interface: 'fe80::1', port: 5000 }), /link-local/],
    [cfgWith({ enabled: true, interface: 'my-mac.local', port: 5000 }), /not an IP address/],
    [cfgWith({ enabled: true, interface: '192.168.1.20', port: 80 }), /port" must be a whole number from 1024/],
    [cfgWith({ enabled: true, interface: '192.168.1.20', port: '5000' }), /port"/],
    [cfgWith({ enabled: true, interface: '192.168.1.20' }), /port"/],
    [cfgWith({ enabled: true, interface: '203.0.113.7', port: 5000 }), /not an address on this machine/],
  ];
  for (const [cfg, re] of bad) {
    const r = lan.resolveLanConfig(cfg, { interfaces: IFACES });
    assert.strictEqual(r.ok, false, JSON.stringify(cfg));
    assert.match(r.error, re, JSON.stringify(cfg));
    if (cfg.dashboard && typeof cfg.dashboard === 'object') assert.match(r.error, /vl\.js dashboard lan (disable|enable)/, 'names the fix');
  }
  // Validating a document without the machine check (interfaces: null).
  assert.strictEqual(lan.resolveLanConfig(cfgWith({ enabled: true, interface: '203.0.113.7', port: 5000 }), { interfaces: null }).ok, true);
});

test('hostFor / lanUrl: IPv6 hosts are bracketed', () => {
  assert.strictEqual(lan.hostFor('192.168.1.20', 47615), '192.168.1.20:47615');
  assert.strictEqual(lan.hostFor('fd7a:115c:a1e0::9', 47615), '[fd7a:115c:a1e0::9]:47615');
  assert.strictEqual(lan.lanUrl('fd7a::9', 8000, 'a'.repeat(64)), `http://[fd7a::9]:8000/?t=${'a'.repeat(64)}`);
});

test('an uppercase IPv6 interface resolves to the one canonical spelling, and the printed link\'s Host is accepted', async () => {
  const ifaces = { utun4: [{ address: 'fd7a:115c:a1e0::9', family: 'IPv6', internal: false }] };
  const resolved = lan.resolveLanConfig(cfgWith({ enabled: true, interface: 'FD7A:115C:A1E0::9', port: 47615 }), { interfaces: ifaces });
  assert.deepStrictEqual(resolved, { ok: true, enabled: true, address: 'fd7a:115c:a1e0::9', port: 47615 });
  assert.strictEqual(lan.canonicalAddress('FD7A:115C:A1E0:0:0:0:0:9'), 'fd7a:115c:a1e0::9');
  const token = 'a'.repeat(64);
  // What a browser sends as Host for the printed link.
  const browserHost = new URL(lan.lanUrl('FD7A:115C:A1E0::9', 47615, token)).host;
  assert.strictEqual(lan.hostFor('FD7A:115C:A1E0::9', 47615), browserHost);
  // The listener built from the spelling in config accepts that Host. It is
  // bound on loopback here; only the Host header carries the IPv6 address.
  const port = await new Promise((r) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  const server = createLanServer({ address: 'FD7A:115C:A1E0::9', port, getStatus: () => ({}), currentToken: () => token });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try {
    const host = new URL(lan.lanUrl('FD7A:115C:A1E0::9', port, token)).host;
    assert.strictEqual((await get(port, { pathname: '/', host })).status, 200, host);
    assert.strictEqual((await get(port, { pathname: '/api/lan/status', host, headers: { 'X-VL-Read': token } })).status, 200);
    assert.strictEqual((await get(port, { pathname: '/', host: `[FD7A:115C:A1E0::9]:${port}` })).status, 403, 'the Host check stays exact');
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

// ---- token -----------------------------------------------------------------------

console.log('LAN read token');

test('the token file is 0600, 64 hex, re-read on rotate; unsafe or malformed files are refused', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(lan.readToken(dir), { ok: false, reason: 'absent' });
  const w = lan.writeToken(dir);
  assert.ok(w.ok && lan.TOKEN_RE.test(w.token));
  const st = fs.statSync(lan.tokenPath(dir));
  assert.strictEqual(st.mode & 0o777, 0o600);
  assert.strictEqual(lan.readToken(dir).token, w.token);
  const reader = lan.createTokenReader(dir);
  assert.strictEqual(reader(), w.token);
  const w2 = lan.writeToken(dir);
  assert.notStrictEqual(w2.token, w.token);
  assert.strictEqual(reader(), w2.token, 'rotation is picked up at once');
  fs.chmodSync(lan.tokenPath(dir), 0o644);
  assert.deepStrictEqual(lan.readToken(dir), { ok: false, reason: 'unsafe' });
  assert.strictEqual(reader(), null, 'a world-readable token is not trusted');
  fs.chmodSync(lan.tokenPath(dir), 0o600);
  fs.writeFileSync(lan.tokenPath(dir), 'not-a-token\n', { mode: 0o600 });
  assert.deepStrictEqual(lan.readToken(dir), { ok: false, reason: 'malformed' });
  fs.unlinkSync(lan.tokenPath(dir));
  const target = path.join(dir, 'elsewhere');
  fs.writeFileSync(target, `${'a'.repeat(64)}\n`, { mode: 0o600 });
  fs.symlinkSync(target, lan.tokenPath(dir));
  assert.deepStrictEqual(lan.readToken(dir), { ok: false, reason: 'unsafe' }, 'a symlink is refused, not followed');
  for (const reason of ['absent', 'unsafe', 'malformed', 'unreadable']) assert.match(lan.tokenProblem(reason), /vl\.js dashboard lan rotate/);
  assert.strictEqual(lan.tokenMatches('a'.repeat(64), 'a'.repeat(64)), true);
  for (const bad of ['b'.repeat(64), '', undefined, null, 'a'.repeat(63)]) assert.strictEqual(lan.tokenMatches('a'.repeat(64), bad), false);
  assert.strictEqual(lan.tokenMatches(null, null), false);
});

// ---- redaction -------------------------------------------------------------------

console.log('LAN redaction');

test('redactForLan: no identifier, secret, URL or diagnostic survives; the display facts do', () => {
  const out = JSON.stringify(redactForLan(identifyingDoc()));
  for (const [name, value] of Object.entries(PLANTED)) assert.ok(!out.includes(value), `${name} leaked: ${value}`);
  const doc = JSON.parse(out);
  const [kimi, custom] = doc.view.routes;
  assert.strictEqual(kimi.id, 'r1', 'route ids are replaced by an opaque key');
  assert.strictEqual(kimi.label, 'Kimi');
  assert.strictEqual(kimi.windows[0].remainingRatio, 0.72);
  assert.strictEqual(kimi.balance.amount, 18.42);
  assert.deepStrictEqual(kimi.reauth, { required: true, reason: null, url: null, profile: null, reasonCodes: [] });
  assert.deepStrictEqual(kimi.reasonCodes, ['reauth-required'], 'unknown codes are dropped');
  assert.strictEqual(kimi.quotaEligibility, null);
  assert.strictEqual(custom.recipe, 'custom', 'a user recipe becomes a bare "custom" marker');
  assert.deepStrictEqual(Object.keys(doc.daemon), ['intervalSeconds']);
  assert.deepStrictEqual(doc.collection.lastAttempt, { outcome: 'partial' });
  assert.strictEqual(doc.view.profiles[0].identity, null);
  assert.strictEqual(doc.view.profiles[0].harness, 'claude');
  assert.strictEqual(doc.view.collection, undefined, 'the collection block (route ids, errors) is not projected');
  // Never throws on garbage.
  for (const junk of [null, 42, 'x', [], { view: 'x' }, { view: { routes: [null, 1, 'x'] } }]) redactForLan(junk);
});

// Provider text planted in the fields the LAN keeps (currency, window type
// and unit, a parseable but decorated reset time), through the REAL view
// schema builder: none of it may reach the LAN document or its HTTP body.
const PLANTED_TEXT = 'acct-private';
function providerTextDoc() {
  const configured = (value) => ({ value, provenance: 'configured', source: 'config', observedAt: null, freshUntil: null, reason: null });
  const observed = (value) => ({ value, provenance: 'observed', source: 'status.json', observedAt: null, freshUntil: null, reason: null });
  const view = buildViewSchema({
    routes: [{
      id: 'deepseek-direct', configured: true,
      provider: configured('deepseek'), account: configured(PLANTED_TEXT), pool: configured({ provider: 'deepseek', account: PLANTED_TEXT }),
      resource: {
        state: observed('healthy'), basis: observed('quota-window'), freshness: 'fresh', error: null, reauth: null,
        windows: [{ type: PLANTED_TEXT, unit: 'session-77', remaining: 4, limit: 10, resetAt: `2026-10-26 (${PLANTED_TEXT})` },
          { type: 'weekly', unit: 'requests', remaining: 1, limit: 2, resetAt: '2026-10-26T09:00:00+02:00' }],
        balance: { available: 5, currency: PLANTED_TEXT },
        observedAt: observed(iso(-1000)), freshUntil: observed(iso(60000)), resetAt: observed(`2026-10-26 (${PLANTED_TEXT})`),
      },
    }, {
      id: 'openrouter-main', configured: true, provider: configured('openrouter'), account: configured('main'),
      resource: { state: observed('healthy'), freshness: 'fresh', error: null, reauth: null, windows: [],
        balance: { available: 12.5, currency: 'USD' }, observedAt: observed(iso(-1000)), freshUntil: observed(iso(60000)) },
    }],
  }, { now: NOW });
  view.profiles = [{ harness: PLANTED_TEXT, state: 'healthy', freshness: 'fresh', windows: [], reasonCodes: [] }];
  return { schemaVersion: 1, status: 'ok', daemon: { intervalSeconds: 30 }, collection: { state: 'idle' }, view };
}

test('redactForLan: provider text in allowed fields (currency, window type/unit, decorated dates, harness) never survives', async () => {
  const doc = providerTextDoc();
  // The planted text really is in the loopback document's kept fields.
  const [ds] = doc.view.routes;
  assert.strictEqual(ds.balance.currency, PLANTED_TEXT);
  assert.strictEqual(ds.windows[0].type, PLANTED_TEXT);
  assert.strictEqual(ds.windows[0].unit, 'session-77');
  assert.ok(ds.windows[0].resetAt.includes(PLANTED_TEXT));
  const out = redactForLan(doc);
  const text = JSON.stringify(out);
  for (const value of [PLANTED_TEXT, 'session-77']) assert.ok(!text.includes(value), `leaked: ${value}`);
  const [lanDs, lanOr] = out.view.routes;
  assert.strictEqual(lanDs.balance.currency, null, 'not an ISO 4217 code');
  assert.strictEqual(lanDs.balance.amount, 5);
  assert.deepStrictEqual([lanDs.windows[0].type, lanDs.windows[0].unit], [null, null]);
  assert.strictEqual(lanDs.windows[0].resetAt, new Date(Date.parse(`2026-10-26 (${PLANTED_TEXT})`)).toISOString(), 're-emitted, not copied');
  assert.deepStrictEqual([lanDs.windows[1].type, lanDs.windows[1].unit, lanDs.windows[1].resetAt], ['weekly', 'requests', '2026-10-26T07:00:00.000Z']);
  assert.strictEqual(lanOr.balance.currency, 'USD');
  assert.strictEqual(out.view.profiles[0].harness, null);
  assert.ok(lanDs.observedAt, 'an observation time is kept');
  for (const t of [out.view.generatedAt, lanDs.observedAt].filter(Boolean)) assert.strictEqual(t, new Date(t).toISOString(), 'canonical timestamps');
  // And over HTTP.
  await withLanServer(async (port, dir) => {
    const res = await get(port, { pathname: '/api/lan/status', headers: { 'X-VL-Read': lan.readToken(dir).token } });
    assert.strictEqual(res.status, 200);
    for (const value of [PLANTED_TEXT, 'session-77']) assert.ok(!res.text.includes(value), `HTTP body leaked: ${value}`);
  }, { status: doc });
});

test('redactForLan: a refused route leaves the LAN projection byte-identical (C-003)', () => {
  // A refused route as the view model emits it: state unknown + an additive
  // `refusal` block (and the refusal codes deliberately NOT in reasonCodes).
  // Against an otherwise-identical route that is merely unknown, the LAN
  // projection must be byte-for-byte the same.
  const plain = identifyingDoc();
  const refused = identifyingDoc();
  plain.view.routes[0].state = 'unknown';
  refused.view.routes[0].state = 'unknown';
  refused.view.routes[0].refusal = { reason: 'unknown-region', fix: 'region must be one of: global, china' };
  assert.deepStrictEqual(
    JSON.stringify(redactForLan(plain)),
    JSON.stringify(redactForLan(refused)),
    'the LAN projection must not change when a route is refused',
  );
  const lan = redactForLan(refused).view.routes[0];
  assert.ok(!('refusal' in lan), 'the refusal block never reaches the LAN view');
  assert.ok(!JSON.stringify(lan).includes('unknown-region'));
  assert.ok(!JSON.stringify(lan).includes('region must be one of'));
});

test('redactForLan: refusal codes are not part of the LAN vocabulary (C-003)', () => {
  const doc = identifyingDoc();
  doc.view.routes[0].reasonCodes = ['unknown-region', 'built-in-endpoint-refused'];
  const lan = redactForLan(doc).view.routes[0];
  assert.deepStrictEqual(lan.reasonCodes, [], 'the LAN redaction drops the refusal codes');
});

// ---- the LAN listener --------------------------------------------------------------

console.log('LAN listener');

async function withLanServer(fn, { status = identifyingDoc() } = {}) {
  const dir = tmpDir();
  lan.writeToken(dir);
  const port = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const server = createLanServer({ address: '127.0.0.1', port, getStatus: () => status, currentToken: lan.createTokenReader(dir), threshold: 0.2 });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  try { await fn(port, dir); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('GET / and /assets/* carry no data, no route names, nothing from config, no token, no CORS', async () => {
  await withLanServer(async (port, dir) => {
    const token = lan.readToken(dir).token;
    for (const pathname of ['/', '/assets/app.js', '/assets/render.js', '/assets/logic.js', '/assets/app.css']) {
      const res = await get(port, { pathname });
      assert.strictEqual(res.status, 200, pathname);
      for (const value of [...Object.values(PLANTED), 'Kimi', 'my-proxy', token]) assert.ok(!res.text.includes(value), `${pathname}: ${value}`);
      assert.strictEqual(res.headers['content-security-policy'], CSP);
      assert.strictEqual(res.headers['cache-control'], 'no-store');
      assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
      assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
      assert.ok(!Object.keys(res.headers).some((h) => h.startsWith('access-control-')), 'no CORS headers');
    }
    const page = await get(port, { pathname: '/' });
    assert.ok(page.text.includes('<meta name="vl-mode" content="lan">'));
    assert.ok(!page.text.includes('vl-refresh-token'));
    assert.ok(!/<script(?![^>]*\ssrc="\/assets\/)/.test(page.text), 'no inline script');
  });
});

test('/api/lan/status needs the read token in X-VL-Read; rotation revokes the old one at once', async () => {
  await withLanServer(async (port, dir) => {
    const old = lan.readToken(dir).token;
    for (const headers of [{}, { 'X-VL-Read': 'b'.repeat(64) }, { 'X-VL-Read': '' }, { 'X-VL-Nonce': old }]) {
      const res = await get(port, { pathname: '/api/lan/status', headers });
      assert.strictEqual(res.status, 401, JSON.stringify(headers));
      assert.deepStrictEqual(res.json, { error: 'unauthorized' });
    }
    const ok = await get(port, { pathname: '/api/lan/status', headers: { 'X-VL-Read': old } });
    assert.strictEqual(ok.status, 200);
    for (const [name, value] of Object.entries(PLANTED)) assert.ok(!ok.text.includes(value), `${name} leaked`);
    assert.ok(!ok.text.includes(old), 'the token is never echoed');
    assert.strictEqual(ok.json.view.routes[0].label, 'Kimi');
    // The token in the query string is not accepted by the API.
    assert.strictEqual((await get(port, { pathname: `/api/lan/status?t=${old}` })).status, 401);
    const fresh = lan.writeToken(dir).token;
    assert.strictEqual((await get(port, { pathname: '/api/lan/status', headers: { 'X-VL-Read': old } })).status, 401, 'rotated: old refused');
    assert.strictEqual((await get(port, { pathname: '/api/lan/status', headers: { 'X-VL-Read': fresh } })).status, 200);
    fs.unlinkSync(lan.tokenPath(dir));
    assert.strictEqual((await get(port, { pathname: '/api/lan/status', headers: { 'X-VL-Read': fresh } })).status, 401, 'no token file: refused');
  });
});

test('read-only, exact Host, fixed routes', async () => {
  await withLanServer(async (port, dir) => {
    const token = lan.readToken(dir).token;
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const pathname of ['/', '/api/lan/status', '/assets/app.js']) {
        assert.strictEqual((await get(port, { method, pathname, headers: { 'X-VL-Read': token } })).status, 405, `${method} ${pathname}`);
      }
    }
    for (const pathname of ['/api/status', '/api/refresh', '/api/stop', '/api/identity', '/assets/nope.js', '/assets/../page.js', '/index.html']) {
      assert.strictEqual((await get(port, { pathname, headers: { 'X-VL-Read': token } })).status, 404, pathname);
    }
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost:${port}`, '127.0.0.1']) {
      assert.strictEqual((await get(port, { pathname: '/api/lan/status', host, headers: { 'X-VL-Read': token } })).status, 403, host);
    }
  });
});

test('the refresh token (C-002 amendment) is on the loopback page only: never on the LAN page, its assets or /api/lan/status', async () => {
  // The real daemon, both listeners from ONE identity. The LAN listener is
  // bound on loopback here (no real LAN address); only its Host differs.
  const dir = tmpDir();
  lan.writeToken(dir);
  const lanPort = await new Promise((r) => { const sv = net.createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
  const collect = async () => ({ ok: true, envelope: { schemaVersion: 1, generatedAt: new Date().toISOString(), status: 'ok', routes: [],
    collection: { outcome: 'completed', published: true, reason: null, error: null, routes: [], native: null } } });
  const h = await daemonLib.runDaemon({ dir, host: '127.0.0.1', port: 0, intervalSeconds: 30, collect,
    lan: { address: '127.0.0.1', port: lanPort, currentToken: lan.createTokenReader(dir) } });
  assert.ok(h.ok, JSON.stringify(h));
  try {
    const { nonce } = records.readRecord(dir).record;
    const refresh = refreshTokenFor(nonce);
    // Not vacuous: the loopback page does carry it.
    const local = await get(h.port, { pathname: '/' });
    assert.strictEqual(local.status, 200);
    assert.ok(local.text.includes(refresh), 'the loopback page carries the refresh token');
    const read = lan.readToken(dir).token;
    const lanGets = [
      ['/', {}], ...Object.keys(ASSETS).map((name) => [`/assets/${name}`, {}]),
      ['/api/lan/status', { 'X-VL-Read': read }], ['/api/lan/status', {}], ['/api/lan/status', { 'X-VL-Read': 'b'.repeat(64) }],
    ];
    const seen = new Set();
    for (const [pathname, headers] of lanGets) {
      const res = await get(lanPort, { pathname, headers });
      seen.add(res.status);
      for (const [name, value] of [['refresh token', refresh], ['nonce', nonce]]) assert.ok(!res.text.includes(value), `${pathname} ${JSON.stringify(headers)}: ${name}`);
      if (pathname === '/') assert.ok(!res.text.includes('vl-refresh-token'), 'no refresh meta on the LAN page');
    }
    assert.deepStrictEqual([...seen].sort(), [200, 401], 'both the 200 and the 401 bodies were checked');
  } finally { await h.shutdown('test'); }
});

// ---- the page's token handling (the real browser script in a sandbox) ----------------

console.log('LAN page');

function runLanPage({ search = '', storage = 'ok', statusCode = 200, body = redactForLan(identifyingDoc()), seed = null } = {}) {
  const store = new Map(seed ? [['vl-lan-read-token', seed]] : []);
  const calls = { fetch: [], replaceState: [] };
  class El {
    constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.style = { setProperty() {} }; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...c) { this.children = c; }
    addEventListener() {}
    focus() {}
    querySelector() { return null; }
    get textContent() { return this.children.map((c) => c.textContent).join(''); }
  }
  const root = new El('div');
  const metas = { 'vl-mode': 'lan', 'vl-threshold': '0.2' };
  const localStorage = storage === 'ok'
    ? { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
    : storage === 'write-fails'
      ? { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem() { throw new Error('quota'); }, removeItem: (k) => store.delete(k) }
      : { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const sandbox = {
    document: {
      createElement: (t) => new El(t),
      createTextNode: (t) => ({ text: String(t), get textContent() { return this.text; } }),
      querySelector: (sel) => { const m = /^meta\[name="([^"]+)"\]$/.exec(sel); if (!m || !(m[1] in metas)) return null; const e = new El('meta'); e.setAttribute('content', metas[m[1]]); return e; },
      querySelectorAll: () => [], getElementById: (id) => (id === 'app' ? root : null), addEventListener() {}, activeElement: null, hidden: false,
    },
    location: { search, pathname: '/' },
    history: { replaceState: (s, t, url) => calls.replaceState.push(url) },
    localStorage,
    CSS: { escape: (s) => s },
    fetch: async (url, opts) => { calls.fetch.push({ url, headers: Object.assign({}, opts && opts.headers) }); return { ok: statusCode === 200, status: statusCode, json: async () => body }; },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    URL, URLSearchParams, Intl, Date, Math, Object, Array, String, Number, Set, Map, Error, JSON,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {} });
  vm.createContext(sandbox);
  for (const file of ['logic.js', 'render.js', 'app.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard', 'page', file), 'utf8'), sandbox, { filename: file });
  }
  return { root, store, calls, settle: async () => { for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); } };
}

test('the page takes ?t= once, strips it from the address bar, stores it for this origin and sends it as X-VL-Read', async () => {
  const t = 'c'.repeat(64);
  const p = runLanPage({ search: `?t=${t}` });
  await p.settle();
  assert.deepStrictEqual(p.calls.replaceState, ['/']);
  assert.strictEqual(p.store.get('vl-lan-read-token'), t);
  assert.deepStrictEqual(p.calls.fetch.map((f) => [f.url, f.headers['X-VL-Read']]), [['/api/lan/status', t]]);
  assert.ok(p.root.textContent.includes('Kimi'));
  assert.ok(p.root.textContent.includes('LAN · read-only'));
  assert.ok(!p.root.textContent.includes('preview'), 'the real LAN view is not labelled a preview');
});

test('a bookmark of "/" uses the stored token; without storage the token lives in memory for the session', async () => {
  const t = 'd'.repeat(64);
  const bookmark = runLanPage({ search: '', seed: t });
  await bookmark.settle();
  assert.deepStrictEqual(bookmark.calls.replaceState, [], 'nothing to strip');
  assert.deepStrictEqual(bookmark.calls.fetch.map((f) => f.headers['X-VL-Read']), [t]);
  const p = runLanPage({ search: `?t=${t}`, storage: 'denied' });
  await p.settle();
  assert.deepStrictEqual(p.calls.replaceState, ['/']);
  assert.deepStrictEqual(p.calls.fetch.map((f) => f.headers['X-VL-Read']), [t], 'private mode: the in-memory token is used');
});

test('a fresh ?t= wins for the session when storage reads work but the write fails (quota): never the stale stored token', async () => {
  const stale = 'a'.repeat(64);
  const fresh = 'b'.repeat(64);
  const p = runLanPage({ search: `?t=${fresh}`, storage: 'write-fails', seed: stale });
  await p.settle();
  assert.strictEqual(p.store.get('vl-lan-read-token'), stale, 'the write really failed');
  assert.deepStrictEqual(p.calls.fetch.map((f) => f.headers['X-VL-Read']), [fresh]);
  assert.ok(p.root.textContent.includes('Kimi'));
});

test('no token: no request, and the page says where to get the link; 401: the stored token is cleared and the page says it was replaced', async () => {
  const none = runLanPage({ search: '' });
  await none.settle();
  assert.strictEqual(none.calls.fetch.length, 0);
  assert.ok(none.root.textContent.includes('Open the dashboard link from your Mac'));
  assert.ok(none.root.textContent.includes('vl.js dashboard lan url'));
  const bad = runLanPage({ search: '?t=<script>' });
  await bad.settle();
  assert.deepStrictEqual(bad.calls.replaceState, ['/'], 'a malformed token is stripped too');
  assert.strictEqual(bad.calls.fetch.length, 0, 'and never sent');
  const rotated = runLanPage({ search: `?t=${'e'.repeat(64)}`, statusCode: 401 });
  await rotated.settle();
  assert.strictEqual(rotated.store.has('vl-lan-read-token'), false, 'cleared on 401');
  assert.ok(rotated.root.textContent.includes('This link was replaced.'));
});

// ---- the real CLI ---------------------------------------------------------------------

console.log('LAN CLI');

const LAN_ADDR = lan.localAddresses().find((a) => net.isIPv4(a)) || null;
const ROUTE = { id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 300 };
const baseConfig = (extra = {}) => Object.assign({ routes: [ROUTE], gate: { mode: 'deny', injectContext: false } }, extra);
const readCfg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const freePort = (address) => new Promise((r) => { const s = net.createServer(); s.listen(0, address, () => { const p = s.address().port; s.close(() => r(p)); }); });

test('lan enable refuses bad input with the right exit code and the fix', async () => {
  const dir = scratch(baseConfig());
  const cases2 = [
    [['dashboard', 'lan', 'enable'], 2, /needs --interface/],
    [['dashboard', 'lan', 'enable', '--interface', '127.0.0.1'], 1, /loopback/],
    [['dashboard', 'lan', 'enable', '--interface', '0.0.0.0'], 1, /wildcard/],
    [['dashboard', 'lan', 'enable', '--interface', 'my-mac.local'], 1, /not an IP address/],
    [['dashboard', 'lan', 'enable', '--interface', '203.0.113.7'], 1, /not an address on this machine/],
    [['dashboard', 'lan', 'enable', '--interface', '203.0.113.7', '--port', 'abc'], 2, /--port must be a whole number/],
    [['dashboard', 'lan', 'bogus'], 2, /unknown lan command/],
    [['dashboard', 'lan', 'url'], 1, /LAN view is off/],
  ];
  for (const [args, code, re] of cases2) {
    const r = await vl(dir, args);
    assert.strictEqual(r.status, code, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re, args.join(' '));
  }
  assert.strictEqual(readCfg(dir).dashboard, undefined, 'nothing was written');
  assert.ok(!fs.existsSync(lan.tokenPath(dir)));
});

test('a corrupt config.json refuses lan enable and lan url (exit 10), writing nothing', async () => {
  const dir = scratch(baseConfig());
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  for (const args of [['dashboard', 'lan', 'enable', '--interface', LAN_ADDR || '192.0.2.1'], ['dashboard', 'lan', 'url'], ['dashboard', 'lan', 'disable']]) {
    const r = await vl(dir, args);
    assert.strictEqual(r.status, 10, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{ not json');
});

test('lan disable refuses a present but invalid dashboard.lan (exit 1) and leaves it as it is; an absent section is a no-op', async () => {
  const cfgPath = (dir) => path.join(dir, 'config.json');
  const invalid = ['on', null, [], 42, { enabled: 'yes' }, { enabled: true, interface: 'my-mac.local', port: 5000 }];
  for (const value of invalid) {
    const dir = scratch(baseConfig({ dashboard: { lan: value } }));
    const before = fs.readFileSync(cfgPath(dir), 'utf8');
    const r = await vl(dir, ['dashboard', 'lan', 'disable']);
    assert.strictEqual(r.status, 1, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /dashboard\.lan/, JSON.stringify(value));
    assert.ok(r.stderr.includes(lan.LAN_FIX), `${JSON.stringify(value)}: recovery text: ${r.stderr}`);
    assert.ok(!r.stdout.includes('already off'), JSON.stringify(value));
    assert.strictEqual(fs.readFileSync(cfgPath(dir), 'utf8'), before, `${JSON.stringify(value)}: config untouched`);
    // resolveLanConfig gives the same recovery text for the same value.
    const resolved = lan.resolveLanConfig({ dashboard: { lan: value } }, { interfaces: null });
    assert.strictEqual(resolved.ok, false, JSON.stringify(value));
    assert.ok(resolved.error.includes(lan.LAN_FIX), JSON.stringify(value));
  }
  // Absent: the no-op, config untouched.
  const dir = scratch(baseConfig());
  const before = fs.readFileSync(cfgPath(dir), 'utf8');
  const r = await vl(dir, ['dashboard', 'lan', 'disable']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /already off/);
  assert.strictEqual(fs.readFileSync(cfgPath(dir), 'utf8'), before);
  // A valid section whose interface is not on this machine can still be disabled.
  const gone = scratch(baseConfig({ dashboard: { lan: { enabled: true, interface: '203.0.113.7', port: 47615 } } }));
  const off = await vl(gone, ['dashboard', 'lan', 'disable']);
  assert.strictEqual(off.status, 0, off.stderr);
  assert.deepStrictEqual(readCfg(gone).dashboard.lan, { enabled: false, interface: '203.0.113.7', port: 47615 });
});

if (!LAN_ADDR) {
  console.log('    (skipped: the real-interface LAN scenarios need a non-loopback IPv4 address on this machine)');
} else {
  test('enable → url → start serves the redacted LAN view; rotate revokes at once; the token appears ONLY in `lan url`', async () => {
    const dir = scratch(baseConfig());
    const outputs = [];
    const run = async (args) => { const r = await vl(dir, args); outputs.push(`${r.stdout}\n${r.stderr}`); return r; };

    const en = await run(['dashboard', 'lan', 'enable', '--interface', LAN_ADDR]);
    assert.strictEqual(en.status, 0, en.stderr);
    assert.match(en.stdout, /it starts with the daemon/);
    const section = readCfg(dir).dashboard.lan;
    assert.strictEqual(section.enabled, true);
    assert.strictEqual(section.interface, LAN_ADDR);
    assert.ok(Number.isInteger(section.port) && section.port >= 1024);
    assert.strictEqual(fs.statSync(lan.tokenPath(dir)).mode & 0o777, 0o600);
    // The port is chosen once and kept.
    assert.strictEqual((await run(['dashboard', 'lan', 'enable', '--interface', LAN_ADDR])).status, 0);
    assert.strictEqual(readCfg(dir).dashboard.lan.port, section.port);
    assert.ok(!JSON.stringify(readCfg(dir)).includes(lan.readToken(dir).token), 'the token is never in config.json');

    const start = await run(['dashboard', 'start']);
    assert.strictEqual(start.status, 0, start.stderr);
    note(dir);
    assert.match(start.stdout, new RegExp(`LAN view \\(read-only\\) on http://${LAN_ADDR.replace(/\./g, '\\.')}:${section.port}/`));
    const token = lan.readToken(dir).token;

    const url = await vl(dir, ['dashboard', 'lan', 'url']);
    assert.strictEqual(url.status, 0, url.stderr);
    assert.strictEqual(url.stdout, `http://${LAN_ADDR}:${section.port}/?t=${token}\n`);
    assert.ok(!url.stderr.includes(token));

    const host = `${LAN_ADDR}:${section.port}`;
    const st = await until(async () => {
      const r = await get(section.port, { address: LAN_ADDR, host, pathname: '/api/lan/status', headers: { 'X-VL-Read': token } });
      return r.status === 200 && r.json && r.json.view ? r : null;
    }, 'a redacted LAN view');
    assert.strictEqual(st.json.view.routes[0].id, 'r1');
    assert.ok(!st.text.includes('kimi-code-plan'), 'no route id on the LAN');
    assert.ok(!st.text.includes(record(dir).nonce), 'no nonce on the LAN');
    // The loopback listener is unchanged and the LAN listener serves no control route.
    assert.strictEqual((await get(section.port, { address: LAN_ADDR, host, pathname: '/api/status' })).status, 404);

    const rot = await run(['dashboard', 'lan', 'rotate']);
    assert.strictEqual(rot.status, 0, rot.stderr);
    assert.strictEqual((await get(section.port, { address: LAN_ADDR, host, pathname: '/api/lan/status', headers: { 'X-VL-Read': token } })).status, 401, 'rotated: refused at once');
    const fresh = lan.readToken(dir).token;
    assert.strictEqual((await get(section.port, { address: LAN_ADDR, host, pathname: '/api/lan/status', headers: { 'X-VL-Read': fresh } })).status, 200);

    const dis = await run(['dashboard', 'lan', 'disable']);
    assert.strictEqual(dis.status, 0, dis.stderr);
    assert.match(dis.stdout, /takes effect at the next start/);
    assert.strictEqual(readCfg(dir).dashboard.lan.enabled, false);
    assert.strictEqual(readCfg(dir).dashboard.lan.port, section.port, 'the port is kept for re-enable');
    outputs.push(JSON.stringify((await vl(dir, ['dashboard', 'status', '--json']))));
    outputs.push(JSON.stringify((await vl(dir, ['dashboard', 'status']))));

    // Nowhere but `lan url`: not in any other command's output, not in the
    // log, not in the daemon's argv.
    const pid = record(dir).pid;
    const ps = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
    const log = fs.readFileSync(path.join(dir, 'dashboard.log'), 'utf8');
    for (const t of [token, fresh]) {
      for (const o of outputs) assert.ok(!o.includes(t), `token in CLI output: ${o.slice(0, 200)}`);
      assert.ok(!log.includes(t), 'token in dashboard.log');
      assert.ok(!ps.includes(t), 'token in the daemon argv');
    }
    assert.ok(ps.includes('--lan-address'), 'premise: the argv check looked at the daemon');
    assert.strictEqual((await vl(dir, ['dashboard', 'stop'])).status, 0);
  });

  test('start refuses an unsafe token (exit 10) and a bad LAN value (exit 1); a LAN bind failure publishes nothing', async () => {
    const dir = scratch(baseConfig());
    assert.strictEqual((await vl(dir, ['dashboard', 'lan', 'enable', '--interface', LAN_ADDR])).status, 0);
    fs.chmodSync(lan.tokenPath(dir), 0o644);
    for (const args of [['dashboard', 'start'], ['dashboard', 'lan', 'url'], ['dashboard', 'lan', 'enable', '--interface', LAN_ADDR]]) {
      const r = await vl(dir, args);
      assert.strictEqual(r.status, 10, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /vl\.js dashboard lan rotate/);
    }
    assert.ok(!fs.existsSync(path.join(dir, 'dashboard.json')), 'nothing published');
    assert.strictEqual((await vl(dir, ['dashboard', 'lan', 'rotate'])).status, 0);

    const cfg = readCfg(dir);
    cfg.dashboard.lan.enabled = 'yes';
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
    const badValue = await vl(dir, ['dashboard', 'start']);
    assert.strictEqual(badValue.status, 1, badValue.stderr);
    assert.match(badValue.stderr, /enabled" must be true or false.*vl\.js dashboard lan/);

    // Occupy the LAN port: start fails, names the fix, publishes nothing.
    const port = await freePort(LAN_ADDR);
    cfg.dashboard.lan = { enabled: true, interface: LAN_ADDR, port };
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
    const squatter = net.createServer();
    await new Promise((r) => squatter.listen(port, LAN_ADDR, r));
    try {
      const r = await vl(dir, ['dashboard', 'start']);
      assert.strictEqual(r.status, 1, r.stderr);
      assert.match(r.stderr, /could not listen on the LAN interface .*nothing was published.*lan disable/);
      assert.ok(!fs.existsSync(path.join(dir, 'dashboard.json')), 'nothing published');
    } finally { squatter.close(); }
  });
}

(async () => {
  try {
    for (const { name, fn } of cases) {
      try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
    }
  } finally {
    await cleanup();
  }
  for (const pid of started) {
    if (alive(pid)) { failures += 1; console.log(`  ✗ daemon ${pid} survived cleanup`); }
  }
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall dashboard-lan tests passed');
  process.exit(0);
})();
