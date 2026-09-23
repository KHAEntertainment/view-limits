'use strict';
// Tests for lib/capability-registry.js — the declarative capability/family
// registry. No I/O beyond reading nothing at all: the registry is pure data
// plus a deterministic indexer, exercised entirely in-process.

const assert = require('assert');

const {
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_SOURCE,
  DEFAULT_ENTRIES,
  createRegistry,
  defaultRegistry,
  mergeEntries,
} = require('../lib/capability-registry');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

const FACT_KEYS = ['value', 'provenance', 'source', 'observedAt', 'freshUntil', 'reason'];

console.log('capability registry — fact contract');

test('known model lookup returns a configured fact with full fact shape', () => {
  const f = defaultRegistry().lookupModel('kimi-k2');
  assert.deepStrictEqual(Object.keys(f).sort(), FACT_KEYS.slice().sort());
  assert.strictEqual(f.provenance, 'configured');
  assert.strictEqual(f.source, REGISTRY_SOURCE);
  assert.strictEqual(f.reason, null);
  assert.strictEqual(f.value.id, 'kimi-k2');
  assert.strictEqual(f.value.family, 'moonshot');
  assert.ok(f.value.taskCapabilities.includes('code'));
  assert.ok(Array.isArray(f.value.aliases));
});

test('canonical ids and aliases resolve case-insensitively to the same entry', () => {
  const reg = defaultRegistry();
  for (const name of ['kimi-k2', 'KIMI', 'kimi-for-coding', ' kimi-k2-instruct ']) {
    const f = reg.lookupModel(name);
    assert.strictEqual(f.value && f.value.id, 'kimi-k2', `name "${name}" must resolve to kimi-k2`);
  }
  assert.strictEqual(reg.lookupHarness('Claude-Code').value.id, 'claude');
  assert.strictEqual(reg.lookupFamily('GLM').value.id, 'zai');
});

test('absent entries return unknown facts with stable reason codes — never sentinels', () => {
  const reg = defaultRegistry();
  for (const [lookup, reason] of [
    [() => reg.lookupModel('no-such-model'), 'registry-model-absent'],
    [() => reg.lookupHarness('no-such-harness'), 'registry-harness-absent'],
    [() => reg.lookupFamily('no-such-family'), 'registry-family-absent'],
    [() => reg.lookupModel(''), 'registry-name-absent'],
    [() => reg.lookupModel(null), 'registry-name-absent'],
    [() => reg.lookupModel(42), 'registry-name-absent'],
  ]) {
    const f = lookup();
    assert.strictEqual(f.value, null);
    assert.strictEqual(f.provenance, 'unknown');
    assert.strictEqual(f.reason, reason);
    // never false / 0 / '' standing in for unknown
    assert.strictEqual(f.value === false || f.value === 0 || f.value === '', false);
  }
});

console.log('\ncapability registry — construction and extension');

test('createRegistry validates: duplicate ids, ambiguous aliases, missing model family', () => {
  assert.throws(() => createRegistry({
    families: { x: {} },
    models: { 'a': { family: 'x' }, 'A': { family: 'x' } },
  }), /duplicate model id/);
  assert.throws(() => createRegistry({
    families: { x: {} },
    models: { 'a': { family: 'x', aliases: ['shared'] }, 'b': { family: 'x', aliases: ['shared'] } },
  }), /ambiguous model alias/);
  assert.throws(() => createRegistry({
    families: { x: {} },
    models: { 'a': { family: 'x' }, 'b': { family: 'x', aliases: ['a'] } },
  }), /ambiguous model alias|collides with canonical id/);
  assert.throws(() => createRegistry({ models: { 'm': {} } }), /requires a family/);
  // an alias pointing at its own canonical id is redundant, not ambiguous
  assert.doesNotThrow(() => createRegistry({
    families: { x: {} },
    models: { 'm': { family: 'x', aliases: ['m'] } },
  }));
});

test('model.family must reference a declared family id or alias, stored canonical', () => {
  // undeclared family → build-time error, never a runtime unknown
  assert.throws(() => createRegistry({
    families: { x: {} },
    models: { 'm': { family: 'ghost' } },
  }), /undeclared family "ghost"/);
  // family declared via its alias → entry stores the canonical id
  const reg = createRegistry({
    families: { anthropic: { aliases: ['claude'] } },
    models: { 'm': { family: 'Claude', taskCapabilities: ['code'] } },
  });
  assert.strictEqual(reg.lookupModel('m').value.family, 'anthropic');
});

test('mergeEntries adds a new entry without touching built-in data (AC1 support)', () => {
  const merged = mergeEntries(DEFAULT_ENTRIES, {
    families: { acme: {} },
    models: { 'acme-ultra': { family: 'acme', taskCapabilities: ['code', 'vision'], aliases: ['acme'] } },
  });
  const reg = createRegistry(merged);
  const f = reg.lookupModel('ACME');
  assert.strictEqual(f.value.id, 'acme-ultra');
  assert.strictEqual(f.value.family, 'acme');
  // built-ins untouched
  assert.ok(!('acme-ultra' in DEFAULT_ENTRIES.models));
  assert.strictEqual(defaultRegistry().lookupModel('acme-ultra').provenance, 'unknown');
});

test('mergeEntries merges field-wise per id and entry fields override', () => {
  const merged = mergeEntries(DEFAULT_ENTRIES, {
    models: { 'kimi-k2': { taskCapabilities: ['code'] } },
  });
  const reg = createRegistry(merged);
  const f = reg.lookupModel('kimi-k2');
  assert.deepStrictEqual(f.value.taskCapabilities, ['code']);
  assert.strictEqual(f.value.family, 'moonshot'); // untouched field survives
});

test('registry is immutable and deterministic across construction', () => {
  const reg = createRegistry(DEFAULT_ENTRIES);
  assert.throws(() => { reg.lookupModel = () => null; }, TypeError);
  const entry = reg.lookupModel('kimi-k2').value;
  assert.throws(() => { entry.taskCapabilities.push('bogus'); }, TypeError);
  const a = createRegistry(DEFAULT_ENTRIES);
  const b = createRegistry(DEFAULT_ENTRIES);
  assert.deepStrictEqual(a.entries, b.entries);
  assert.strictEqual(REGISTRY_SCHEMA_VERSION, 1);
});

test('entries snapshot is data-only and normalized (sorted ids, sorted lists)', () => {
  const entries = defaultRegistry().entries;
  for (const [id, m] of Object.entries(entries.models)) {
    assert.strictEqual(id, id.toLowerCase());
    assert.strictEqual(m.id, id);
    assert.ok(typeof m.family === 'string' && m.family.length > 0);
    const sorted = m.taskCapabilities.slice().sort();
    assert.deepStrictEqual(m.taskCapabilities, sorted);
  }
  for (const [id, h] of Object.entries(entries.harnesses)) {
    assert.ok(Array.isArray(h.executionCapabilities) && Array.isArray(h.skills));
  }
});

console.log('\ncapability registry — family aliases live here, not in runtime discovery');

test('family aliases resolve to canonical family ids', () => {
  const reg = defaultRegistry();
  assert.strictEqual(reg.canonicalFamilyId('claude'), 'anthropic');
  assert.strictEqual(reg.canonicalFamilyId('Anthropic'), 'anthropic');
  assert.strictEqual(reg.canonicalFamilyId('kimi'), 'moonshot');
  assert.strictEqual(reg.canonicalFamilyId('unregistered-family'), null);
  assert.strictEqual(reg.canonicalModelId('opus'), 'claude-opus-4');
  assert.strictEqual(reg.canonicalHarnessId('codex-cli'), 'codex');
  assert.strictEqual(reg.canonicalModelId('nope'), null);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall capability-registry tests passed');
