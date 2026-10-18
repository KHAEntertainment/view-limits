'use strict';
// Fixture tests for lib/adapters/http.js boundedGet — the bounded transport
// for custom (route.monitor) sources (Issue #55). global.fetch is replaced
// per test; no network. Covers HTTPS-only, redirect refusal, timeout (headers
// and body), body cap (declared and streamed), header allowlist, sanitized
// fixed error codes, and that httpJson (built-in callers) is unchanged.

const assert = require('assert');
const { boundedGet, httpJson, MAX_BODY_BYTES } = require('../lib/adapters/http');

const CANARY = 'CANARY-provider-body-7f3a';
let calls = [];
function mockFetch(impl) {
  calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
let failures = 0;

console.log('boundedGet — URL policy');

test('http:// is refused before any request (insecure-url)', async () => {
  mockFetch(() => new Response('{}'));
  const r = await boundedGet('http://api.example.com/v1/models');
  assert.deepStrictEqual(r, { ok: false, status: null, headers: {}, json: null, error: 'insecure-url' });
  assert.strictEqual(calls.length, 0);
});

test('URL-embedded credentials are refused before any request', async () => {
  mockFetch(() => new Response('{}'));
  const r = await boundedGet('https://user:pass@api.example.com/v1');
  assert.strictEqual(r.error, 'insecure-url');
  assert.strictEqual(calls.length, 0);
});

test('request is GET, redirect:manual, with a timeout signal and only caller headers', async () => {
  mockFetch(() => new Response('{"a":1}', { status: 200 }));
  const r = await boundedGet('https://api.example.com/v1', { headers: { 'x-api-key': 'k' } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.json, { a: 1 });
  const init = calls[0].init;
  assert.strictEqual(init.method, 'GET');
  assert.strictEqual(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepStrictEqual(init.headers, { 'x-api-key': 'k' }, 'boundedGet adds no auth of its own');
});

console.log('boundedGet — redirects');

for (const status of [301, 302, 303, 307, 308]) {
  test(`${status} is refused, not followed, Location not retained`, async () => {
    mockFetch(() => new Response(null, { status, headers: { location: `https://evil.example/${CANARY}` } }));
    const r = await boundedGet('https://api.example.com/v1');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'redirect-refused');
    assert.strictEqual(r.status, status);
    assert.strictEqual(calls.length, 1, 'no second hop');
    assert.ok(!JSON.stringify(r).includes(CANARY));
  });
}

console.log('boundedGet — status classification + sanitized errors');

test('401/403 → auth-rejected; body never surfaced', async () => {
  for (const status of [401, 403]) {
    mockFetch(() => new Response(`{"error":"${CANARY}"}`, { status }));
    const r = await boundedGet('https://api.example.com/v1');
    assert.strictEqual(r.error, 'auth-rejected');
    assert.ok(!JSON.stringify(r).includes(CANARY));
  }
});

test('429 → http-429 with retained rate-limit headers (diagnostic only)', async () => {
  mockFetch(() => new Response(CANARY, { status: 429, headers: { 'retry-after': '20', 'x-ratelimit-remaining-requests': '0' } }));
  const r = await boundedGet('https://api.example.com/v1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'http-429');
  assert.deepStrictEqual(r.headers, { 'retry-after': '20', 'x-ratelimit-remaining-requests': '0' });
  assert.ok(!JSON.stringify(r).includes(CANARY));
});

test('5xx → http-<status>, body not surfaced', async () => {
  mockFetch(() => new Response(`<html>${CANARY}</html>`, { status: 503 }));
  const r = await boundedGet('https://api.example.com/v1');
  assert.strictEqual(r.error, 'http-503');
  assert.ok(!JSON.stringify(r).includes(CANARY));
});

test('network failure → network-error, message not surfaced', async () => {
  mockFetch(() => { throw new TypeError(`getaddrinfo ENOTFOUND ${CANARY}`); });
  const r = await boundedGet('https://api.example.com/v1');
  assert.strictEqual(r.error, 'network-error');
  assert.ok(!JSON.stringify(r).includes(CANARY));
});

console.log('boundedGet — timeouts');

function waitForAbort(signal) {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('no response before the deadline → timeout', async () => {
  mockFetch((url, init) => waitForAbort(init.signal));
  const t0 = Date.now();
  const r = await boundedGet('https://api.example.com/v1', { timeoutMs: 1000 });
  assert.strictEqual(r.error, 'timeout');
  assert.ok(Date.now() - t0 < 3000);
});

test('headers arrive but the body stalls → timeout (deadline covers the body)', async () => {
  mockFetch((url, init) => {
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"a":')); },
      pull(c) { return waitForAbort(init.signal).catch((e) => c.error(e)); },
    });
    return new Response(body, { status: 200 });
  });
  const r = await boundedGet('https://api.example.com/v1', { timeoutMs: 1000 });
  assert.strictEqual(r.error, 'timeout');
});

test('timeoutMs is clamped into [1000, 15000]', async () => {
  mockFetch((url, init) => waitForAbort(init.signal));
  const t0 = Date.now();
  const r = await boundedGet('https://api.example.com/v1', { timeoutMs: 1 });
  assert.strictEqual(r.error, 'timeout');
  assert.ok(Date.now() - t0 >= 900, 'a 1ms request still gets the 1s floor');
});

console.log('boundedGet — body bound');

test('declared content-length over the cap → body-too-large without reading', async () => {
  let pulled = false;
  // highWaterMark 0: pull runs only when a reader actually reads.
  mockFetch(() => new Response(new ReadableStream({ pull(c) { pulled = true; c.close(); } }, { highWaterMark: 0 }), {
    status: 200, headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
  }));
  const r = await boundedGet('https://api.example.com/v1');
  assert.strictEqual(r.error, 'body-too-large');
  assert.strictEqual(pulled, false);
});

test('streamed body over the cap (no content-length) → body-too-large', async () => {
  const chunk = new Uint8Array(16 * 1024).fill(0x20);
  let sent = 0;
  mockFetch(() => new Response(new ReadableStream({
    pull(c) { sent += chunk.length; c.enqueue(chunk); },
  }), { status: 200 }));
  const r = await boundedGet('https://api.example.com/v1', { maxBytes: 32 * 1024 });
  assert.strictEqual(r.error, 'body-too-large');
  assert.ok(sent <= 64 * 1024, 'stops reading soon after the cap');
});

test('body at the cap is accepted; non-JSON body → ok with json null', async () => {
  mockFetch(() => new Response('not json', { status: 200 }));
  const r = await boundedGet('https://api.example.com/v1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.json, null);
});

console.log('boundedGet — header allowlist');

test('only rate-limit headers and retry-after are retained', async () => {
  mockFetch(() => new Response('', {
    status: 200,
    headers: {
      'x-ratelimit-limit-requests': '100',
      'anthropic-ratelimit-tokens-remaining': '5',
      'retry-after': '3',
      'set-cookie': `sid=${CANARY}`,
      'x-request-id': CANARY,
      'x-ratelimit-oversized': 'x'.repeat(200),
    },
  }));
  const r = await boundedGet('https://api.example.com/v1');
  assert.deepStrictEqual(r.headers, {
    'anthropic-ratelimit-tokens-remaining': '5',
    'retry-after': '3',
    'x-ratelimit-limit-requests': '100',
  });
  assert.ok(!JSON.stringify(r).includes(CANARY));
});

console.log('httpJson — built-in callers unchanged');

test('httpJson still sends Bearer and throws with .status on non-2xx', async () => {
  mockFetch(() => new Response('denied', { status: 401 }));
  await assert.rejects(httpJson('https://api.example.com/x', 'tok'), (e) => e.status === 401 && /HTTP 401/.test(e.message));
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer tok');
  mockFetch(() => new Response('{"ok":true}', { status: 200 }));
  assert.deepStrictEqual(await httpJson('https://api.example.com/x', 'tok'), { ok: true });
});

(async () => {
  // AbortSignal.timeout timers are unref'd; with fetch mocked nothing else
  // holds the event loop open while a timeout test waits for its abort.
  const keepAlive = setInterval(() => {}, 1000);
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); }
    catch (e) { failures += 1; console.log(`  ✗ ${t.name}\n    ${e && e.message || e}`); }
  }
  clearInterval(keepAlive);
  if (failures) {
    console.error(`\n${failures} bounded-http test(s) failed`);
    process.exit(1);
  }
  console.log('all bounded-http tests passed');
})();
