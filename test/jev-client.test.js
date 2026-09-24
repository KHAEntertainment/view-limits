'use strict';
// Tests for lib/jev-client.js — the present-but-dormant Jev classifier path.
// Every transport is an injected stub: no real network, no clock, no I/O.
// Covers configuration gating, every failure reason code, the response
// schema boundary, the confidence floor, model-support verification, and the
// AC7 byte-identical-prompt contract.

const assert = require('assert');

const {
  buildClassifierRequest, canonicalJson, classify, verifyModelSupport,
  MIN_CONFIDENCE, JEV_REASONS,
} = require('../lib/jev-client');
const { DIMENSION_ORDER } = require('../lib/task-profile');

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

const CONFIG = {
  model: 'acme/jev-1.13',
  baseUrl: 'https://example.invalid/api',
  catalogUrl: 'https://example.invalid/api/v1/models',
  apiKey: 'test-key',
};

const VALID_BODY = {
  profile: {
    taskKind: 'code', exploration: 'scoped', specification: 'precise',
    reasoning: 'moderate', risk: 'low', autonomy: 'standard',
    verification: 'automated', executionStyle: 'batch',
  },
  confidence: 0.9,
};

function stubTransport(result) {
  const calls = [];
  const request = async (req, opts) => {
    calls.push({ req, opts });
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result(req, opts) : result;
  };
  return { request, calls };
}

console.log('jev-client — configuration gating (no fabricated defaults)');

test('missing model → jev-model-unconfigured; missing baseUrl → jev-endpoint-unconfigured; no transport → jev-transport-absent', async () => {
  let r = await classify({ task: { text: 'x' }, config: { ...CONFIG, model: undefined }, io: stubTransport({}) });
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.reason, 'jev-model-unconfigured');
  r = await classify({ task: {}, config: { model: 'm' }, io: stubTransport({}) });
  assert.strictEqual(r.reason, 'jev-endpoint-unconfigured');
  r = await classify({ task: {}, config: CONFIG, io: {} });
  assert.strictEqual(r.reason, 'jev-transport-absent');
  assert.ok(JEV_REASONS.includes(r.reason));
});

test('an unconfigured call never touches the transport', async () => {
  const t = stubTransport({ statusCode: 200, body: JSON.stringify(VALID_BODY) });
  const r = await classify({ task: {}, config: { model: '' }, io: t });
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(t.calls.length, 0, 'transport invoked while unconfigured');
});

console.log('\njev-client — failure paths degrade to reasoned unavailability');

test('transport throw → jev-unreachable; timedOut → jev-timeout', async () => {
  let t = stubTransport(new Error('ECONNREFUSED'));
  let r = await classify({ task: {}, config: CONFIG, io: t });
  assert.strictEqual(r.reason, 'jev-unreachable');
  t = stubTransport(() => { const e = new Error('deadline'); e.timedOut = true; throw e; });
  r = await classify({ task: {}, config: CONFIG, io: t });
  assert.strictEqual(r.reason, 'jev-timeout');
  t = stubTransport({ timedOut: true });
  r = await classify({ task: {}, config: CONFIG, io: t });
  assert.strictEqual(r.reason, 'jev-timeout');
});

test('non-2xx status → jev-http-error; non-JSON body → jev-response-malformed; non-object result → jev-response-malformed', async () => {
  let r = await classify({ task: {}, config: CONFIG, io: stubTransport({ statusCode: 503, body: 'oops' }) });
  assert.strictEqual(r.reason, 'jev-http-error');
  assert.strictEqual(r.detail, 503);
  r = await classify({ task: {}, config: CONFIG, io: stubTransport({ statusCode: 200, body: '{not json' }) });
  assert.strictEqual(r.reason, 'jev-response-malformed');
  r = await classify({ task: {}, config: CONFIG, io: stubTransport('a bare string') });
  assert.strictEqual(r.reason, 'jev-response-malformed');
  r = await classify({ task: {}, config: CONFIG, io: stubTransport({ statusCode: 200, body: '[1,2]' }) });
  assert.strictEqual(r.reason, 'jev-response-malformed');
});

test('schema-invalid response → jev-response-schema-invalid with violations; low confidence → jev-low-confidence', async () => {
  const badProfile = JSON.parse(JSON.stringify(VALID_BODY));
  delete badProfile.profile.risk;
  let r = await classify({ task: {}, config: CONFIG, io: stubTransport({ statusCode: 200, body: JSON.stringify(badProfile) }) });
  assert.strictEqual(r.reason, 'jev-response-schema-invalid');
  assert.deepStrictEqual(r.detail, ['profile.risk-invalid']);
  const low = { ...VALID_BODY, confidence: 0.1 };
  r = await classify({ task: {}, config: CONFIG, io: stubTransport({ statusCode: 200, body: JSON.stringify(low) }) });
  assert.strictEqual(r.reason, 'jev-low-confidence');
  assert.strictEqual(r.detail.minConfidence, MIN_CONFIDENCE);
  const atFloor = { ...VALID_BODY, confidence: MIN_CONFIDENCE };
  r = await classify({ task: {}, config: CONFIG, io: stubTransport({ statusCode: 200, body: JSON.stringify(atFloor) }) });
  assert.strictEqual(r.status, 'ok', 'confidence exactly at the floor must pass');
});

test('valid response → ok with typed profile, confidence, suggestion, and the exact request sent', async () => {
  const t = stubTransport({ statusCode: 200, body: JSON.stringify({ ...VALID_BODY, suggestedCandidateId: 'route-9' }) });
  const r = await classify({ task: { text: 'fix the parser', kind: 'code' }, config: CONFIG, io: t });
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.profile.taskKind, 'code');
  assert.strictEqual(r.confidence, 0.9);
  assert.strictEqual(r.suggestedCandidateId, 'route-9');
  assert.strictEqual(t.calls.length, 1);
  assert.strictEqual(t.calls[0].req.model, CONFIG.model);
  assert.deepStrictEqual(r.request, t.calls[0].req);
});

console.log('\njev-client — AC7 prompt is registry-free and byte-stable');

test('classifier request depends only on task + model; canonicalJson is byte-identical across key order', async () => {
  const a = buildClassifierRequest({ task: { text: 't', kind: 'code', metadata: { b: 1, a: 2 } }, model: 'm' });
  const b = buildClassifierRequest({ task: { metadata: { a: 2, b: 1 }, kind: 'code', text: 't' }, model: 'm' });
  assert.strictEqual(canonicalJson(a), canonicalJson(b));
  // Registry-shaped data is not part of the request: no key anywhere mentions
  // capabilities, aliases, families, candidates, or registry contents.
  const flat = canonicalJson(a);
  for (const forbidden of ['taskCapabilities', 'executionCapabilities', 'aliases', 'registry', 'candidateId']) {
    assert.ok(!flat.includes(forbidden), `prompt leaked ${forbidden}`);
  }
  assert.deepStrictEqual(Object.keys(a.criteria), DIMENSION_ORDER.slice());
});

console.log('\njev-client — model support verification (fail-closed)');

function catalogWith(entry) {
  return { data: [entry] };
}

test('missing config/transport → unverified; catalog throw/malformed → unverified', async () => {
  let r = await verifyModelSupport({ config: {}, io: {} });
  assert.deepStrictEqual(r, { status: 'unverified', reason: 'jev-model-unconfigured' });
  r = await verifyModelSupport({ config: { model: 'm' }, io: {} });
  assert.strictEqual(r.reason, 'jev-endpoint-unconfigured');
  r = await verifyModelSupport({ config: { model: 'm', catalogUrl: 'u' }, io: {} });
  assert.strictEqual(r.reason, 'jev-catalog-transport-absent');
  r = await verifyModelSupport({ config: { model: 'm', catalogUrl: 'u' }, io: { fetchCatalog: async () => { throw new Error('down'); } } });
  assert.strictEqual(r.reason, 'jev-catalog-unreachable');
  r = await verifyModelSupport({ config: { model: 'm', catalogUrl: 'u' }, io: { fetchCatalog: async () => ({ nope: 1 }) } });
  assert.strictEqual(r.reason, 'jev-catalog-malformed');
});

test('model absent from catalog → jev-model-not-in-catalog; present without structured output → jev-structured-output-unverified', async () => {
  let r = await verifyModelSupport({
    config: { model: 'acme/jev-1.13', catalogUrl: 'u' },
    io: { fetchCatalog: async () => catalogWith({ id: 'other/model' }) },
  });
  assert.strictEqual(r.reason, 'jev-model-not-in-catalog');
  r = await verifyModelSupport({
    config: { model: 'acme/jev-1.13', catalogUrl: 'u' },
    io: { fetchCatalog: async () => catalogWith({ id: 'acme/jev-1.13', supported_parameters: ['temperature'] }) },
  });
  assert.strictEqual(r.reason, 'jev-structured-output-unverified');
});

test('model present with structured-output support → verified', async () => {
  for (const entry of [
    { id: 'acme/jev-1.13', supported_parameters: ['response_format'] },
    { id: 'acme/jev-1.13', structured_outputs: true },
    { id: 'acme/jev-1.13', supported_parameters: ['json_schema'] },
  ]) {
    const r = await verifyModelSupport({
      config: { model: 'ACME/Jev-1.13', catalogUrl: 'u' },
      io: { fetchCatalog: async () => catalogWith(entry) },
    });
    assert.strictEqual(r.status, 'verified', JSON.stringify(entry));
    assert.strictEqual(r.model, 'acme/jev-1.13');
  }
});

test('F6: a catalog timeout reports jev-catalog-timeout, distinct from unreachable; TimeoutError classifies as timeout', async () => {
  const timedOut = () => { const e = new Error('deadline'); e.timedOut = true; return e; };
  let r = await verifyModelSupport({
    config: { model: 'm', catalogUrl: 'u' },
    io: { fetchCatalog: async () => { throw timedOut(); } },
  });
  assert.strictEqual(r.status, 'unverified');
  assert.strictEqual(r.reason, 'jev-catalog-timeout');
  assert.ok(JEV_REASONS.includes('jev-catalog-timeout'));
  // AbortSignal.timeout() throws name:'TimeoutError' — same classification.
  const abortErr = new Error('The operation timed out');
  abortErr.name = 'TimeoutError';
  r = await verifyModelSupport({
    config: { model: 'm', catalogUrl: 'u' },
    io: { fetchCatalog: async () => { throw abortErr; } },
  });
  assert.strictEqual(r.reason, 'jev-catalog-timeout');
  // And the classifier request maps a TimeoutError throw to jev-timeout.
  const r2 = await classify({ task: {}, config: CONFIG, io: { request: async () => { throw abortErr; } } });
  assert.strictEqual(r2.reason, 'jev-timeout');
});

Promise.all(pendingTests).then(() => {
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall jev-client tests passed');
});
