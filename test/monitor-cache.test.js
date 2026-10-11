'use strict';
// Tests for the additive configRevision attachment in lib/cache.js. Covers:
//   AC3 — diagnostic JSON compatibility: existing cache shape unchanged when
//         options.routes is omitted; configRevision is added only when caller
//         supplies routes, never replacing or removing existing fields.
//   AC4 — config-revision obsolescence: a route whose monitor changes bumps
//         configRevision so a cached entry from the previous config cannot
//         satisfy a future freshness check.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cachePath, readCache, writeCache, attachRevisions } = require('../lib/cache');
const { configRevision } = require('../lib/monitor-schema');

let failures = 0;
async function runTests() {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failures += 1;
      console.log(`  ✗ ${t.name}\n    ${e && e.message || e}`);
    }
  }
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

console.log('attachRevisions — pure helper');

test('without options.routes → returns input unchanged', () => {
  const entries = { 'kimi-code-plan': { routeId: 'kimi-code-plan', observedAt: '2026-01-01T00:00:00Z', freshUntil: '2026-01-01T00:05:00Z', source: 'kimi', status: { state: 'healthy' } } };
  const out = attachRevisions(entries);
  assert.strictEqual(out, entries, 'should return the same object reference');
});

test('with options.routes matching entry → configRevision attached additively', () => {
  const route = { id: 'kimi-code-plan', provider: 'kimi' };
  const entries = { 'kimi-code-plan': { routeId: 'kimi-code-plan', observedAt: '2026-01-01T00:00:00Z', freshUntil: '2026-01-01T00:05:00Z', source: 'kimi', status: { state: 'healthy' } } };
  const out = attachRevisions(entries, { routes: [route] });
  const entry = out['kimi-code-plan'];
  assert.ok(entry.configRevision, 'configRevision should be attached');
  assert.strictEqual(typeof entry.configRevision, 'string');
  assert.strictEqual(entry.configRevision.length, 40);
  // Every existing key is preserved verbatim.
  assert.strictEqual(entry.routeId, 'kimi-code-plan');
  assert.strictEqual(entry.observedAt, '2026-01-01T00:00:00Z');
  assert.strictEqual(entry.freshUntil, '2026-01-01T00:05:00Z');
  assert.strictEqual(entry.source, 'kimi');
  assert.deepStrictEqual(entry.status, { state: 'healthy' });
  // Revision matches the standalone computation.
  assert.strictEqual(entry.configRevision, configRevision(route));
});

test('non-matching route id → entry untouched', () => {
  const entries = { 'something-else': { routeId: 'something-else', observedAt: 't', freshUntil: 't', source: 'x', status: {} } };
  const out = attachRevisions(entries, { routes: [{ id: 'kimi-code-plan', provider: 'kimi' }] });
  assert.strictEqual(out['something-else'].configRevision, undefined);
});

test('null/array/primitive entries pass through unchanged', () => {
  const entries = { 'good': { routeId: 'good', observedAt: 't', freshUntil: 't', source: 'x', status: {} }, 'null': null, 'arr': [], 'num': 5 };
  const out = attachRevisions(entries, { routes: [{ id: 'good', provider: 'kimi' }] });
  assert.ok(out.good.configRevision, 'good entry should be enriched');
  assert.strictEqual(out['null'], null);
  assert.deepStrictEqual(out['arr'], []);
  assert.strictEqual(out['num'], 5);
});

test('options.routes that is not an array → no enrichment (defensive)', () => {
  const entries = { 'a': { routeId: 'a', observedAt: 't', freshUntil: 't', source: 'x', status: {} } };
  assert.strictEqual(attachRevisions(entries, { routes: 'not-array' }).a.configRevision, undefined);
  assert.strictEqual(attachRevisions(entries, { routes: null }).a.configRevision, undefined);
});

test('route without string id is ignored (no crash, no match)', () => {
  const entries = { 'a': { routeId: 'a', observedAt: 't', freshUntil: 't', source: 'x', status: {} } };
  const out = attachRevisions(entries, { routes: [{ id: 5 }, null, [], { provider: 'kimi' }] });
  assert.strictEqual(out.a.configRevision, undefined);
});

console.log('writeCache — disk round-trip with additive configRevision');

test('writeCache without options.routes writes a pre-#54-shaped cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-mcache-legacy-'));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  delete require.cache[require.resolve('../lib/cache')];
  delete require.cache[require.resolve('../lib/config')];
  const cache = require('../lib/cache');
  const entries = { 'kimi-code-plan': { routeId: 'kimi-code-plan', observedAt: '2026-01-01T00:00:00Z', freshUntil: '2026-01-01T00:05:00Z', source: 'kimi', status: { state: 'healthy' } } };
  cache.writeCache(entries);
  const doc = JSON.parse(fs.readFileSync(cache.cachePath(), 'utf8'));
  assert.strictEqual(doc.routes['kimi-code-plan'].configRevision, undefined,
    'legacy writeCache call must not stamp configRevision');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeCache with options.routes stamps configRevision on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-mcache-routed-'));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  delete require.cache[require.resolve('../lib/cache')];
  delete require.cache[require.resolve('../lib/config')];
  const cache = require('../lib/cache');
  const route = { id: 'kimi-code-plan', provider: 'kimi' };
  const entries = { 'kimi-code-plan': { routeId: 'kimi-code-plan', observedAt: '2026-01-01T00:00:00Z', freshUntil: '2026-01-01T00:05:00Z', source: 'kimi', status: { state: 'healthy' } } };
  cache.writeCache(entries, { routes: [route] });
  const doc = JSON.parse(fs.readFileSync(cache.cachePath(), 'utf8'));
  assert.strictEqual(doc.routes['kimi-code-plan'].configRevision, configRevision(route));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('monitor change bumps configRevision → stale cache entry detectable', () => {
  const base = { id: 'custom-a', provider: 'openai-compat' };
  const r1 = Object.assign({}, base, { monitor: { endpoint: 'https://a.example.com', recipe: 'openai-compat' } });
  const r2 = Object.assign({}, base, { monitor: { endpoint: 'https://b.example.com', recipe: 'openai-compat' } });
  // Same id/provider, different monitor → different revision.
  assert.notStrictEqual(configRevision(r1), configRevision(r2));
});

test('unchanged config → identical revision → cache entry stays valid', () => {
  const r1 = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat' } };
  const r2 = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat' } };
  assert.strictEqual(configRevision(r1), configRevision(r2));
});

runTests().then(() => {
  if (failures) {
    console.error(`\n${failures} monitor-cache test(s) failed`);
    process.exit(1);
  }
  console.log('all monitor-cache tests passed');
});