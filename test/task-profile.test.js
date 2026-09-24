'use strict';
// Tests for lib/task-profile.js — the typed, model-agnostic task profile.
// Every fixture is pure data: no I/O, no clock, no network. Covers the eight
// dimension vocabulary, layered build precedence, explicit-unknown semantics,
// and the Jev classifier response schema (AC2).

const assert = require('assert');

const {
  DIMENSIONS, DIMENSION_ORDER,
  buildProfile, fallbackProfile, validateClassifierResponse, factIsKnown,
} = require('../lib/task-profile');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

console.log('task-profile — dimension contract (AC2)');

test('exactly eight dimensions in canonical order, each with a non-empty vocabulary', () => {
  assert.deepStrictEqual(DIMENSION_ORDER, [
    'taskKind', 'exploration', 'specification', 'reasoning',
    'risk', 'autonomy', 'verification', 'executionStyle',
  ]);
  for (const name of DIMENSION_ORDER) {
    assert.ok(Array.isArray(DIMENSIONS[name].values) && DIMENSIONS[name].values.length > 1, name);
    assert.ok(DIMENSIONS[name].values.every((v) => typeof v === 'string' && v.length > 0), name);
  }
});

test('buildProfile resolves supplied dimensions as observed facts and reports the rest unresolved', () => {
  const p = buildProfile([
    { values: { taskKind: 'CODE', risk: 'high' }, provenance: 'observed', source: 'task-metadata' },
  ]);
  assert.strictEqual(p.dimensions.taskKind.value, 'code');
  assert.strictEqual(p.dimensions.taskKind.provenance, 'observed');
  assert.strictEqual(p.dimensions.risk.value, 'high');
  assert.deepStrictEqual(p.resolved, ['taskKind', 'risk']);
  assert.strictEqual(p.unresolved.length, DIMENSION_ORDER.length - 2);
  assert.strictEqual(p.complete, false);
  for (const u of p.unresolved) assert.strictEqual(u.reason, 'task-profile-field-absent');
  for (const name of p.unresolved.map((u) => u.dimension)) {
    const f = p.dimensions[name];
    assert.strictEqual(f.value, null);
    assert.strictEqual(f.provenance, 'unknown');
  }
});

test('later layers win per-dimension; an absent or invalid later value never erases a resolved one', () => {
  const p = buildProfile([
    { values: { risk: 'low' }, provenance: 'configured', source: 'default-policy' },
    { values: { risk: 'high', taskKind: 'bogus-value' }, provenance: 'observed', source: 'task-metadata' },
  ]);
  assert.strictEqual(p.dimensions.risk.value, 'high');
  assert.strictEqual(p.dimensions.risk.provenance, 'observed');
  assert.strictEqual(p.dimensions.taskKind.provenance, 'unknown');
  assert.strictEqual(p.dimensions.taskKind.reason, 'task-profile-value-invalid');
});

test('a value outside the vocabulary is never coerced — it becomes an explicit invalid unknown', () => {
  const p = buildProfile([
    { values: { taskKind: 'definitely-code', autonomy: 7, reasoning: '' }, provenance: 'observed', source: 'x' },
  ]);
  for (const name of ['taskKind', 'autonomy', 'reasoning']) {
    assert.strictEqual(p.dimensions[name].provenance, 'unknown', name);
    assert.strictEqual(p.dimensions[name].reason, 'task-profile-value-invalid', name);
  }
});

test('fact-shaped dimension input keeps provenance; unknown-provenance input stays unknown', () => {
  const p = buildProfile([
    {
      values: {
        taskKind: { value: 'review', provenance: 'configured', source: 'policy' },
        risk: { value: 'high', provenance: 'unknown', reason: 'jev-field-absent' },
      },
      provenance: 'observed', source: 'task-metadata',
    },
  ]);
  assert.strictEqual(p.dimensions.taskKind.value, 'review');
  assert.strictEqual(p.dimensions.taskKind.provenance, 'configured');
  assert.strictEqual(p.dimensions.risk.provenance, 'unknown');
  assert.strictEqual(p.dimensions.risk.reason, 'jev-field-absent');
});

console.log('\ntask-profile — deterministic fallback (AC3)');

test('fallbackProfile: task metadata is observed, policy defaults are configured, task wins, rest unresolved', () => {
  const p = fallbackProfile(
    { kind: 'code', profile: { risk: 'high' } },
    { defaults: { taskProfile: { risk: 'low', autonomy: 'supervised' } } },
  );
  assert.strictEqual(p.dimensions.taskKind.value, 'code');
  assert.strictEqual(p.dimensions.taskKind.source, 'task-metadata');
  assert.strictEqual(p.dimensions.risk.value, 'high');
  assert.strictEqual(p.dimensions.risk.provenance, 'observed');
  assert.strictEqual(p.dimensions.autonomy.value, 'supervised');
  assert.strictEqual(p.dimensions.autonomy.provenance, 'configured');
  assert.strictEqual(p.dimensions.autonomy.source, 'default-policy');
  assert.deepStrictEqual(
    p.unresolved.map((u) => u.dimension),
    ['exploration', 'specification', 'reasoning', 'verification', 'executionStyle'],
  );
});

test('fallbackProfile with no metadata and no defaults: every dimension unresolved, none invented', () => {
  const p = fallbackProfile(null, null);
  assert.strictEqual(p.resolved.length, 0);
  assert.strictEqual(p.unresolved.length, DIMENSION_ORDER.length);
  assert.strictEqual(p.complete, false);
});

console.log('\ntask-profile — Jev response schema');

function validResponse(overrides = {}) {
  return {
    profile: {
      taskKind: 'code', exploration: 'scoped', specification: 'precise',
      reasoning: 'moderate', risk: 'low', autonomy: 'standard',
      verification: 'automated', executionStyle: 'interactive',
    },
    confidence: 0.9,
    ...overrides,
  };
}

test('a fully-valid response validates and normalizes dimension values', () => {
  const r = validateClassifierResponse(validResponse({
    profile: {
      taskKind: ' CODE ', exploration: 'scoped', specification: 'precise',
      reasoning: 'moderate', risk: 'low', autonomy: 'standard',
      verification: 'automated', executionStyle: 'interactive',
    },
    suggestedCandidateId: 'route-a',
  }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.profile.taskKind, 'code');
  assert.strictEqual(r.confidence, 0.9);
  assert.strictEqual(r.suggestedCandidateId, 'route-a');
});

test('missing dimension, out-of-vocab value, bad confidence, non-object → schema-invalid with sorted violations', () => {
  for (const [raw, want] of [
    [null, ['response-not-object']],
    ['x', ['response-not-object']],
    [{ confidence: 0.5 }, ['profile-not-object']],
    [validResponse({ confidence: 1.5 }), ['confidence-invalid']],
    [validResponse({ confidence: 'high' }), ['confidence-invalid']],
    [validResponse({ suggestedCandidateId: 42 }), ['suggestedCandidateId-invalid']],
  ]) {
    const r = validateClassifierResponse(raw);
    assert.strictEqual(r.ok, false, JSON.stringify(raw));
    assert.deepStrictEqual(r.violations, want);
  }
  const partial = validResponse();
  delete partial.profile.risk;
  const r = validateClassifierResponse(partial);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.violations, ['profile.risk-invalid']);
  const badVal = validResponse();
  badVal.profile.exploration = 'deep';
  const r2 = validateClassifierResponse(badVal);
  assert.strictEqual(r2.ok, false);
  assert.deepStrictEqual(r2.violations, ['profile.exploration-invalid']);
});

test('factIsKnown: only non-unknown provenance with a non-null value counts', () => {
  assert.strictEqual(factIsKnown({ value: 'x', provenance: 'observed' }), true);
  assert.strictEqual(factIsKnown({ value: 'x', provenance: 'configured' }), true);
  assert.strictEqual(factIsKnown({ value: 'x', provenance: 'unknown' }), false);
  assert.strictEqual(factIsKnown({ value: null, provenance: 'observed' }), false);
  assert.strictEqual(factIsKnown('x'), false);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall task-profile tests passed');
