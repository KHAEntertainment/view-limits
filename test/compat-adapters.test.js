'use strict';
// Fixture tests for the openai-compat / anthropic-compat wire families and
// recipes (Issue #55). Every request goes through the real resolver
// (getAdapterForRoute → resolveEffectiveConfig → recipe → boundedGet) with
// global.fetch mocked; no network, no vault, no live provider. These are
// fixture results built from the documented header formats — not live proof.
//
//   AC1  auth separation (Bearer vs x-api-key + anthropic-version, never both)
//   AC2  malformed / partial / contradictory / diagnostic-only → unknown
//   AC3  reset encodings (relative + absolute), scope, bounds, sanitized errors
//   AC4  routine fetch is one read-only GET; never an inference endpoint

const assert = require('assert');
const { getAdapter, getAdapterForRoute } = require('../lib/adapters');
const openaiCompat = require('../lib/adapters/openai-compat');
const anthropicCompat = require('../lib/adapters/anthropic-compat');
const { parseDuration, parseReset, parseOpenAIHeaders, parseAnthropicHeaders } = require('../lib/adapters/ratelimit-headers');
const { recoveryBoundedFreshUntil } = require('../lib/cache');

const TOKEN = 'sk-CANARY-route-token-91d2c7';
const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const ctx = { threshold: 0.2, now: () => NOW };

// Every request made in this file, for the AC4 sweep at the end.
const allCalls = [];
let calls = [];
function respond({ status = 200, headers = {}, body = '' } = {}) {
  calls = [];
  global.fetch = async (url, init) => {
    const call = { url: String(url), method: init && init.method, headers: Object.assign({}, init && init.headers), redirect: init && init.redirect };
    calls.push(call);
    allCalls.push(call);
    return new Response(body, { status, headers });
  };
}

function oaRoute(opts = {}, monitor = {}) {
  return { id: 'custom-oa', provider: 'openai-compat', monitor: Object.assign({ endpoint: 'https://oa.example.com', recipe: 'openai-compat', recipeOptions: Object.assign({ path: '/v1/models' }, opts) }, monitor) };
}
function anRoute(opts = {}, monitor = {}) {
  return { id: 'custom-an', provider: 'anthropic-compat', monitor: Object.assign({ endpoint: 'https://an.example.com', recipe: 'anthropic-compat', recipeOptions: Object.assign({ path: '/v1/models' }, opts) }, monitor) };
}
function run(route, token = TOKEN) {
  return getAdapterForRoute(route, {}).fetchStatus(null, token, ctx);
}
function lowerKeys(h) { return Object.keys(h).map((k) => k.toLowerCase()); }

const OA_OK = {
  'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '450', 'x-ratelimit-reset-requests': '6m0s',
  'x-ratelimit-limit-tokens': '100000', 'x-ratelimit-remaining-tokens': '90000', 'x-ratelimit-reset-tokens': '20ms',
};
const AN_OK = {
  'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '49', 'anthropic-ratelimit-requests-reset': '2026-10-18T12:01:00Z',
  'anthropic-ratelimit-tokens-limit': '80000', 'anthropic-ratelimit-tokens-remaining': '70000', 'anthropic-ratelimit-tokens-reset': '2026-10-18T12:00:30Z',
  'anthropic-ratelimit-input-tokens-limit': '40000', 'anthropic-ratelimit-input-tokens-remaining': '35000', 'anthropic-ratelimit-input-tokens-reset': '2026-10-18T12:00:30Z',
  'anthropic-ratelimit-output-tokens-limit': '8000', 'anthropic-ratelimit-output-tokens-remaining': '8000', 'anthropic-ratelimit-output-tokens-reset': '2026-10-18T12:00:30+00:00',
};

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function section(name) { tests.push({ section: name }); }
let failures = 0;

function assertUnknown(st, reason) {
  assert.strictEqual(st.state, 'unknown', `expected unknown (${reason}), got ${st.state}`);
  assert.strictEqual(st.detail.reason, reason);
  assert.deepStrictEqual(st.windows, []);
  assert.strictEqual(st.balance, null);
  assert.ok(!JSON.stringify(st).includes(TOKEN), 'token canary must not appear in status');
}

// ---------------------------------------------------------------------------
section('AC1 — auth separation');

test('openai-compat sends Authorization: Bearer, no x-api-key', async () => {
  respond({ headers: OA_OK });
  await run(oaRoute({ scope: 'account' }));
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!lowerKeys(calls[0].headers).includes('x-api-key'));
  assert.ok(!lowerKeys(calls[0].headers).includes('anthropic-version'));
});

test('anthropic-compat sends x-api-key + anthropic-version and NO Authorization/Bearer', async () => {
  respond({ headers: AN_OK });
  await run(anRoute({ scope: 'account' }));
  assert.strictEqual(calls.length, 1);
  const h = calls[0].headers;
  assert.strictEqual(h['x-api-key'], TOKEN);
  assert.strictEqual(h['anthropic-version'], '2023-06-01');
  assert.ok(!lowerKeys(h).includes('authorization'), 'no Authorization header in any case');
  for (const [k, v] of Object.entries(h)) {
    assert.ok(!/bearer/i.test(String(v)), `header ${k} carries a Bearer value`);
    if (k !== 'x-api-key') assert.ok(!String(v).includes(TOKEN), `token leaked into ${k}`);
  }
});

test('anthropic-compat via direct adapter call (no resolver) still never sends Bearer', async () => {
  respond({ headers: AN_OK });
  await anthropicCompat.fetchStatus({ baseUrl: 'https://an.example.com', recipeOptions: { path: '/v1/models' } }, TOKEN, ctx);
  assert.ok(!lowerKeys(calls[0].headers).includes('authorization'));
});

test('family mismatch (anthropic route, openai recipe) is refused before any request', async () => {
  respond({ headers: OA_OK });
  const route = { id: 'x', provider: 'anthropic-compat', monitor: { endpoint: 'https://an.example.com', recipe: 'openai-compat', recipeOptions: { path: '/v1/models' } } };
  const a = getAdapterForRoute(route, {});
  assert.strictEqual(a.capability.reason, 'recipe-family-mismatch');
  assertUnknown(await a.fetchStatus(null, TOKEN, ctx), 'recipe-family-mismatch');
  assert.strictEqual(calls.length, 0);
});

test('family mismatch (openai route, anthropic recipe) is refused before any request', async () => {
  respond({ headers: AN_OK });
  const route = { id: 'x', provider: 'openai-compat', monitor: { endpoint: 'https://oa.example.com', recipe: 'anthropic-compat', recipeOptions: { path: '/v1/models' } } };
  assertUnknown(await run(route), 'recipe-family-mismatch');
  assert.strictEqual(calls.length, 0);
});

test('unsupported anthropicVersion fails closed (stable reason), no request', async () => {
  respond({ headers: AN_OK });
  assertUnknown(await run(anRoute({ anthropicVersion: '2099-01-01' })), 'unsupported-anthropic-version');
  assertUnknown(await anthropicCompat.fetchStatus({ baseUrl: 'https://an.example.com', recipeOptions: { path: '/v1/models', anthropicVersion: 'latest' } }, TOKEN, ctx), 'unsupported-anthropic-version');
  assert.strictEqual(calls.length, 0);
});

test('missing / header-unsafe credential → stable unknown, no request', async () => {
  respond({ headers: OA_OK });
  assertUnknown(await run(oaRoute(), null), 'credential-missing');
  assertUnknown(await run(oaRoute(), ''), 'credential-missing');
  assertUnknown(await run(oaRoute(), 'abc\r\nX-Injected: 1'), 'credential-invalid');
  assertUnknown(await run(anRoute(), 'has space'), 'credential-invalid');
  assert.strictEqual(calls.length, 0);
});

// ---------------------------------------------------------------------------
section('AC2 — truthfulness: never fabricated healthy/exhausted');

const MALFORMED = [
  ['no rate-limit headers at all', {}, 'no-ratelimit-signal'],
  ['remaining without limit', { 'x-ratelimit-remaining-requests': '5' }, 'partial-ratelimit:requests'],
  ['reset alone', { 'x-ratelimit-reset-tokens': '1s' }, 'partial-ratelimit:tokens'],
  ['non-integer limit', { 'x-ratelimit-limit-requests': '10.5', 'x-ratelimit-remaining-requests': '1' }, 'malformed-ratelimit-header:x-ratelimit-limit-requests'],
  ['negative remaining', { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '-1' }, 'malformed-ratelimit-header:x-ratelimit-remaining-requests'],
  ['words', { 'x-ratelimit-limit-requests': 'lots', 'x-ratelimit-remaining-requests': '1' }, 'malformed-ratelimit-header:x-ratelimit-limit-requests'],
  ['remaining > limit', { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '11' }, 'contradictory-ratelimit:requests'],
  ['zero limit', { 'x-ratelimit-limit-requests': '0', 'x-ratelimit-remaining-requests': '0' }, 'contradictory-ratelimit:requests'],
  ['garbage duration reset', { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': 'soon' }, 'malformed-ratelimit-header:x-ratelimit-reset-requests'],
  ['rfc3339 reset under declared duration encoding', { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2026-10-18T12:01:00Z' }, 'malformed-ratelimit-header:x-ratelimit-reset-requests'],
  ['one good kind + one malformed kind → whole observation unknown', Object.assign({}, OA_OK, { 'x-ratelimit-remaining-tokens': 'NaN' }), 'malformed-ratelimit-header:x-ratelimit-remaining-tokens'],
];
for (const [name, headers, reason] of MALFORMED) {
  test(`openai: ${name} → unknown ${reason}`, async () => {
    respond({ headers });
    assertUnknown(await run(oaRoute({ scope: 'account' })), reason);
  });
}

test('anthropic: non-RFC3339 reset → unknown', async () => {
  respond({ headers: Object.assign({}, AN_OK, { 'anthropic-ratelimit-requests-reset': '1729252860' }) });
  assertUnknown(await run(anRoute({ scope: 'account' })), 'malformed-ratelimit-header:anthropic-ratelimit-requests-reset');
});

test('anthropic: contradictory tokens → unknown', async () => {
  respond({ headers: Object.assign({}, AN_OK, { 'anthropic-ratelimit-tokens-remaining': '90000' }) });
  assertUnknown(await run(anRoute({ scope: 'account' })), 'contradictory-ratelimit:tokens');
});

test('default scope is diagnostic: valid headers stay unknown, numbers only in detail.throughput', async () => {
  respond({ headers: OA_OK });
  const st = await run(oaRoute());
  assertUnknown(st, 'diagnostic-only-throughput');
  assert.strictEqual(st.detail.scope, 'diagnostic');
  assert.strictEqual(st.detail.signal, 'throughput');
  assert.strictEqual(st.detail.throughput.length, 2);
  assert.ok(st.detail.throughput.every((w) => w.signal === 'throughput'));
});

test('diagnostic scope with remaining 0 is still unknown (never exhausted)', async () => {
  respond({ headers: { 'anthropic-ratelimit-requests-limit': '5', 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': '2026-10-18T12:01:00Z' } });
  assertUnknown(await run(anRoute()), 'diagnostic-only-throughput');
});

test('429 (even with remaining 0 headers) → unknown http-429, never exhausted', async () => {
  respond({ status: 429, headers: { 'retry-after': '30', 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30s' }, body: 'Too Many Requests' });
  const st = await run(oaRoute({ scope: 'account' }));
  assertUnknown(st, 'http-429');
  assert.strictEqual(st.detail.httpStatus, 429);
  assert.match(st.detail.note, /not evidence of plan exhaustion/);
});

test('401/403 → unknown auth-rejected (provider body not surfaced)', async () => {
  respond({ status: 401, body: `{"error":"invalid key ${TOKEN}"}` });
  const st = await run(anRoute({ scope: 'account' }));
  assertUnknown(st, 'auth-rejected');
});

test('declared scope, remaining 0, no reset header → unknown exhaustion-without-recovery', async () => {
  respond({ headers: { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '0' } });
  const st = await run(oaRoute({ scope: 'account' }));
  assert.strictEqual(st.state, 'unknown');
  assert.strictEqual(st.detail.reason, 'exhaustion-without-recovery');
});

test('declared scope, remaining 0, reset already passed → unknown (not exhausted)', async () => {
  respond({ headers: { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': String(NOW / 1000 - 60) } });
  const st = await run(oaRoute({ scope: 'account', resetEncoding: 'epoch-seconds' }));
  assert.strictEqual(st.state, 'unknown');
  assert.strictEqual(st.detail.reason, 'exhaustion-without-recovery');
});

test('balance is always null — throughput is never treated as plan credit', async () => {
  respond({ headers: OA_OK });
  const st = await run(oaRoute({ scope: 'account' }));
  assert.strictEqual(st.balance, null);
});

test('provider-keyed lookup without route.monitor → endpoint-required, no guessed source', async () => {
  respond({ headers: OA_OK });
  assertUnknown(await getAdapter('openai-compat').fetchStatus({}, TOKEN, ctx), 'endpoint-required');
  assertUnknown(await getAdapter('anthropic-compat').fetchStatus(undefined, TOKEN, ctx), 'endpoint-required');
  const bare = getAdapterForRoute({ id: 'c', provider: 'openai-compat' }, { providers: {} });
  assertUnknown(await bare.fetchStatus(null, TOKEN, ctx), 'endpoint-required');
  assert.strictEqual(calls.length, 0);
});

test('missing recipeOptions.path → unknown, no request (no default /models)', async () => {
  respond({ headers: OA_OK });
  const route = { id: 'c', provider: 'openai-compat', monitor: { endpoint: 'https://oa.example.com', recipe: 'openai-compat' } };
  const st = await run(route);
  assert.strictEqual(st.state, 'unknown');
  assert.match(st.detail.reason, /^invalid-monitor:.*path is required/);
  assert.strictEqual(calls.length, 0);
});

// ---------------------------------------------------------------------------
section('AC2/AC3 — declared pool scope derives state from remaining');

test('openai account scope: healthy, typed throughput windows, relative resets', async () => {
  respond({ headers: OA_OK });
  const st = await run(oaRoute({ scope: 'account' }));
  assert.strictEqual(st.state, 'healthy');
  assert.deepStrictEqual(st.windows, [
    { type: 'requests', remaining: 450, limit: 500, resetAt: new Date(NOW + 6 * 60000).toISOString(), signal: 'throughput' },
    { type: 'tokens', remaining: 90000, limit: 100000, resetAt: new Date(NOW + 20).toISOString(), signal: 'throughput' },
  ]);
  assert.strictEqual(st.detail.scope, 'account');
  assert.strictEqual(st.detail.monitorable, true);
});

test('anthropic model scope: four kinds, absolute RFC 3339 resets incl. offset', async () => {
  respond({ headers: AN_OK });
  const st = await run(anRoute({ scope: 'model' }));
  assert.strictEqual(st.state, 'healthy');
  assert.deepStrictEqual(st.windows.map((w) => w.type), ['requests', 'tokens', 'input-tokens', 'output-tokens']);
  assert.strictEqual(st.windows[3].resetAt, '2026-10-18T12:00:30.000Z');
  assert.strictEqual(st.resetAt, '2026-10-18T12:00:30.000Z');
});

test('below threshold → constrained', async () => {
  respond({ headers: Object.assign({}, OA_OK, { 'x-ratelimit-remaining-requests': '50' }) });
  assert.strictEqual((await run(oaRoute({ scope: 'organization' }))).state, 'constrained');
});

test('remaining 0 with known future reset → exhausted, resetAt = latest drained recovery', async () => {
  respond({ headers: {
    'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30s',
    'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '2m',
  } });
  const st = await run(oaRoute({ scope: 'account' }));
  assert.strictEqual(st.state, 'exhausted');
  const recovery = new Date(NOW + 120000).toISOString();
  assert.strictEqual(st.resetAt, recovery);
  assert.strictEqual(st.detail.recoveryAt, recovery);
  assert.strictEqual(st.balance, null);
});

test('epoch-seconds and rfc3339 encodings are honoured when declared', async () => {
  const epoch = String(NOW / 1000 + 90);
  respond({ headers: { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '9', 'x-ratelimit-reset-requests': epoch } });
  let st = await run(oaRoute({ scope: 'account', resetEncoding: 'epoch-seconds' }));
  assert.strictEqual(st.windows[0].resetAt, new Date(NOW + 90000).toISOString());
  respond({ headers: { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '9', 'x-ratelimit-reset-requests': '2026-10-18T13:00:00+01:00' } });
  st = await run(oaRoute({ scope: 'account', resetEncoding: 'rfc3339' }));
  assert.strictEqual(st.windows[0].resetAt, '2026-10-18T12:00:00.000Z');
});

// ---------------------------------------------------------------------------
section('AC3 — reset encoding parsers (pure)');

test('parseDuration: OpenAI forms', () => {
  assert.strictEqual(parseDuration('1s'), 1000);
  assert.strictEqual(parseDuration('6m0s'), 360000);
  assert.strictEqual(parseDuration('20ms'), 20);
  assert.strictEqual(parseDuration('1h2m3.5s'), 3723500);
  assert.strictEqual(parseDuration('0s'), 0);
  assert.strictEqual(parseDuration('2m'), 120000);
  for (const bad of ['', 's', '1', '1d', '-1s', '1s2m', ' 1s', '1.5ms', '9999h']) {
    assert.ok(Number.isNaN(parseDuration(bad)), bad);
  }
});

test('parseReset: relative vs absolute, out-of-range rejected', () => {
  assert.strictEqual(parseReset('10s', 'duration', NOW), new Date(NOW + 10000).toISOString());
  assert.strictEqual(parseReset(String(NOW / 1000), 'epoch-seconds', NOW), new Date(NOW).toISOString());
  assert.strictEqual(parseReset('2026-10-18T12:00:00.5Z', 'rfc3339', NOW), '2026-10-18T12:00:00.500Z');
  assert.strictEqual(parseReset(String(NOW), 'epoch-seconds', NOW), null, 'epoch millis is not epoch seconds');
  assert.strictEqual(parseReset('2030-01-01T00:00:00Z', 'rfc3339', NOW), null, '> 31 days out');
  assert.strictEqual(parseReset('2026-10-18 12:00:00', 'rfc3339', NOW), null);
  assert.strictEqual(parseReset('10s', 'unknown-encoding', NOW), null);
});

test('header parsers are total over junk input', () => {
  assert.strictEqual(parseOpenAIHeaders(null, 'duration', NOW).error, 'no-ratelimit-signal');
  assert.strictEqual(parseAnthropicHeaders(undefined, NOW).error, 'no-ratelimit-signal');
});

// ---------------------------------------------------------------------------
section('AC3 — transport bounds + sanitized errors via the recipe');

test('redirect from the quota source is refused → unknown redirect-refused', async () => {
  respond({ status: 302, headers: { location: 'https://elsewhere.example/steal' } });
  const st = await run(oaRoute({ scope: 'account' }));
  assertUnknown(st, 'redirect-refused');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].redirect, 'manual');
});

test('5xx with a body echoing the token → unknown http-500, token absent', async () => {
  respond({ status: 500, body: `upstream error for key ${TOKEN}` });
  assertUnknown(await run(anRoute({ scope: 'account' })), 'http-500');
});

test('URL is endpoint + path with host fixed (base path kept, trailing slash folded)', async () => {
  respond({ headers: OA_OK });
  await run(oaRoute({}, { endpoint: 'https://gw.example.com/api/' }));
  assert.strictEqual(calls[0].url, 'https://gw.example.com/api/v1/models');
});

test('endpoint with a query string is refused (no smuggled parameters)', async () => {
  respond({ headers: OA_OK });
  assertUnknown(await openaiCompat.fetchStatus({ baseUrl: 'https://oa.example.com/?key=1', recipeOptions: { path: '/v1/models' } }, TOKEN, ctx), 'insecure-endpoint');
  assertUnknown(await openaiCompat.fetchStatus({ baseUrl: 'http://oa.example.com', recipeOptions: { path: '/v1/models' } }, TOKEN, ctx), 'insecure-endpoint');
  assert.strictEqual(calls.length, 0);
});

test('credential-shaped recipeOptions → invalid-monitor unknown, no request (M-R1)', async () => {
  respond({ headers: OA_OK });
  const st = await run(oaRoute({ apiKey: 'x' }));
  assert.strictEqual(st.state, 'unknown');
  assert.match(st.detail.reason, /^invalid-monitor:.*credential-shaped/);
  assert.strictEqual(calls.length, 0);
});

// ---------------------------------------------------------------------------
section('D2 — exhausted custom-route freshness is bounded by recovery');

test('recoveryBoundedFreshUntil: custom exhausted → min(ttl, resetAt)', () => {
  const custom = oaRoute();
  const ttlEnd = NOW + 180000;
  assert.strictEqual(recoveryBoundedFreshUntil(custom, { state: 'exhausted', resetAt: new Date(NOW + 30000).toISOString() }, ttlEnd), NOW + 30000);
  assert.strictEqual(recoveryBoundedFreshUntil(custom, { state: 'exhausted', resetAt: new Date(NOW + 999999).toISOString() }, ttlEnd), ttlEnd);
  assert.strictEqual(recoveryBoundedFreshUntil(custom, { state: 'exhausted', resetAt: null }, ttlEnd), ttlEnd);
  assert.strictEqual(recoveryBoundedFreshUntil(custom, { state: 'healthy', resetAt: new Date(NOW + 1).toISOString() }, ttlEnd), ttlEnd);
});

test('recoveryBoundedFreshUntil: built-in routes keep TTL-only freshness', () => {
  const builtIn = { id: 'kimi-code-plan', provider: 'kimi' };
  const ttlEnd = NOW + 180000;
  assert.strictEqual(recoveryBoundedFreshUntil(builtIn, { state: 'exhausted', resetAt: new Date(NOW + 1000).toISOString() }, ttlEnd), ttlEnd);
  const explicitBuiltIn = { id: 'kimi-code-plan', provider: 'kimi', monitor: { recipe: 'built-in' } };
  assert.strictEqual(recoveryBoundedFreshUntil(explicitBuiltIn, { state: 'exhausted', resetAt: new Date(NOW + 1000).toISOString() }, ttlEnd), ttlEnd);
});

// ---------------------------------------------------------------------------
section('AC4 — routine fetch never performs inference');

test('every request made in this file was a single read-only GET to the configured path', () => {
  assert.ok(allCalls.length >= 20, `sweep saw ${allCalls.length} requests`);
  for (const c of allCalls) {
    assert.strictEqual(c.method, 'GET', `${c.method} ${c.url}`);
    assert.doesNotMatch(c.url, /\/(chat\/)?completions|\/messages|\/responses|\/embeddings|\/generate/i, c.url);
  }
});

(async () => {
  const keepAlive = setInterval(() => {}, 1000);
  for (const t of tests) {
    if (t.section) { console.log(t.section); continue; }
    try { await t.fn(); console.log(`  ✓ ${t.name}`); }
    catch (e) { failures += 1; console.log(`  ✗ ${t.name}\n    ${e && e.message || e}`); }
  }
  clearInterval(keepAlive);
  if (failures) {
    console.error(`\n${failures} compat-adapters test(s) failed`);
    process.exit(1);
  }
  console.log('all compat-adapters tests passed');
})();
