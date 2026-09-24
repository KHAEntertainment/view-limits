'use strict';
// Tests for lib/jev-openrouter.js — the OpenRouter wire adapter for the Jev
// classifier path (PR-17 fix-batch findings 4–6). The adapter lives in a
// requireable module precisely so this file can prove the wire contract with
// recording stubs: HTTPS-only construction (no cleartext credential hop),
// redirect:'error' on every fetch, the documented json_schema
// response_format envelope, and a deadline-bounded catalog read INCLUDING
// the response body.
//
// Every fetch is an injected stub — no real network.

const assert = require('assert');

const { makeJevTransport } = require('../lib/jev-openrouter');
const { buildClassifierRequest, verifyModelSupport } = require('../lib/jev-client');

let failures = 0;
const pendingTests = [];
function test(name, fn) {
  let result;
  try { result = fn(); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); return; }
  if (result && typeof result.then === 'function') {
    pendingTests.push(result.then(
      () => { console.log(`  ✓ ${name}`); },
      (e) => { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); },
    ));
  } else {
    console.log(`  ✓ ${name}`);
  }
}

const CFG = {
  jev: {
    model: 'acme/jev-1.13',
    baseUrl: 'https://openrouter.example/api/v1',
    catalogUrl: 'https://openrouter.example/api/v1/models',
    apiKeyEnv: 'VL_TEST_JEV_KEY',
    timeoutMs: 200,
  },
};

function fakeResponse({ status = 200, body = '', json } = {}) {
  return {
    status,
    text: async () => body,
    json: json || (async () => JSON.parse(body)),
  };
}

function recordingFetch(responder) {
  const seen = [];
  const fn = async (url, opts) => {
    seen.push({ url, opts });
    return typeof responder === 'function' ? responder(url, opts) : responder;
  };
  return { fn, seen };
}

console.log('jev-openrouter — construction is fail-closed (F4)');

test('non-https or unconfigured jev yields NO transport; https config yields request+fetchCatalog', () => {
  for (const bad of [
    { jev: { ...CFG.jev, baseUrl: 'http://openrouter.example/api/v1' } },
    { jev: { ...CFG.jev, baseUrl: 'ftp://x' } },
    { jev: { ...CFG.jev, baseUrl: 'not a url' } },
    { jev: { ...CFG.jev, baseUrl: '' } },
    { jev: { model: 'm' } },
    { jev: { baseUrl: 'https://x' } },
    {}, null, 'x', 42, [],
  ]) {
    assert.deepStrictEqual(makeJevTransport(bad), {},
      `transport must be absent for ${JSON.stringify(bad && bad.jev ? bad.jev.baseUrl : bad)}`);
  }
  const t = makeJevTransport(CFG, { fetch: async () => fakeResponse({ body: '{}' }) });
  assert.strictEqual(typeof t.request, 'function');
  assert.strictEqual(typeof t.fetchCatalog, 'function');
});

test('a non-https baseUrl passed at request time cannot produce a cleartext hop', async () => {
  const f = recordingFetch(fakeResponse({
    body: JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
  }));
  const t = makeJevTransport(CFG, { fetch: f.fn });
  const doc = buildClassifierRequest({ task: { text: 'x' }, model: 'acme/jev-1.13' });
  await t.request(doc, { timeoutMs: 100, baseUrl: 'http://evil.invalid' });
  assert.ok(f.seen[0].url.startsWith('https://openrouter.example/'),
    `cleartext hop attempted: ${f.seen[0].url}`);
});

console.log('\njev-openrouter — wire shape is the documented OpenRouter envelope (F5)');

test('request sends {type:json_schema, json_schema:{name,schema}} exactly once, with redirect:error and Bearer from apiKeyEnv', async () => {
  const f = recordingFetch(fakeResponse({
    body: JSON.stringify({ choices: [{ message: { content: '{"profile":{},"confidence":0.9}' } }] }),
  }));
  const t = makeJevTransport(CFG, { fetch: f.fn, env: { VL_TEST_JEV_KEY: 'k-1' } });
  const doc = buildClassifierRequest({ task: { text: 'fix the parser', kind: 'code' }, model: 'acme/jev-1.13' });
  const res = await t.request(doc, { timeoutMs: 1000 });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body, '{"profile":{},"confidence":0.9}');
  assert.strictEqual(f.seen.length, 1);
  const call = f.seen[0];
  assert.strictEqual(call.url, 'https://openrouter.example/api/v1/chat/completions');
  assert.strictEqual(call.opts.method, 'POST');
  assert.strictEqual(call.opts.redirect, 'error',
    'a redirect must not be followed on a credential/task-bearing hop');
  assert.strictEqual(call.opts.headers.authorization, 'Bearer k-1',
    'apiKeyEnv must resolve from the environment, not config');
  assert.ok(call.opts.signal instanceof AbortSignal);
  const body = JSON.parse(call.opts.body);
  assert.strictEqual(body.model, 'acme/jev-1.13');
  // Documented envelope — schema nested exactly once under json_schema.
  assert.deepStrictEqual(Object.keys(body.response_format).sort(), ['json_schema', 'type']);
  assert.strictEqual(body.response_format.type, 'json_schema');
  assert.strictEqual(body.response_format.json_schema.name, 'task_profile');
  assert.deepStrictEqual(body.response_format.json_schema.schema, doc.responseFormat.schema,
    'the transport-neutral schema must arrive unwrapped and unmodified');
  assert.ok(!('schema' in body.response_format), 'schema must not sit at the envelope top level');
  // The message content carries only the transport-neutral document parts.
  const content = JSON.parse(body.messages[0].content);
  assert.deepStrictEqual(Object.keys(content).sort(), ['criteria', 'instructions', 'state']);
});

test('fetchCatalog uses redirect:error + an abort signal, and returns the parsed body (happy path)', async () => {
  const f = recordingFetch(fakeResponse({
    body: '{"data":[{"id":"acme/jev-1.13","structured_outputs":true}]}',
  }));
  const t = makeJevTransport(CFG, { fetch: f.fn });
  const doc = await t.fetchCatalog(CFG.jev.catalogUrl);
  assert.strictEqual(doc.data[0].id, 'acme/jev-1.13');
  assert.strictEqual(f.seen[0].opts.redirect, 'error');
  assert.ok(f.seen[0].opts.signal instanceof AbortSignal);
});

console.log('\njev-openrouter — catalog read is deadline-bounded including the body (F6)');

test('a stalled body read rejects within the bound instead of hanging', async () => {
  const f = recordingFetch({ status: 200, json: () => new Promise(() => {}) });
  const t = makeJevTransport({ jev: { ...CFG.jev, catalogTimeoutMs: 60 } }, { fetch: f.fn });
  const started = Date.now();
  await assert.rejects(
    () => t.fetchCatalog(CFG.jev.catalogUrl),
    (e) => e && e.timedOut === true,
    'stalled body read must reject with a timedOut error',
  );
  assert.ok(Date.now() - started < 5000, 'the bound was not honored');
});

test('a stalled catalog surfaces as jev-catalog-timeout through verifyModelSupport', async () => {
  const t = makeJevTransport({ jev: { ...CFG.jev, catalogTimeoutMs: 40 } }, {
    fetch: async () => ({ status: 200, json: () => new Promise(() => {}) }),
  });
  const r = await verifyModelSupport({
    config: { model: 'acme/jev-1.13', catalogUrl: CFG.jev.catalogUrl },
    io: t,
  });
  assert.strictEqual(r.status, 'unverified');
  assert.strictEqual(r.reason, 'jev-catalog-timeout');
});

Promise.all(pendingTests).then(() => {
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall jev-openrouter tests passed');
});
