'use strict';
// Reason-code summary completeness test — Issue #13.
//
// [#8] Verifies that every declared reason code in the coupled registries
// (ALL_DECLARED_REASONS from score-candidates.js, JEV_REASONS from
// jev-client.js, profile.*-invalid dimensions from task-profile.js) has a
// human-readable summary in REASON_SUMMARIES.  Frozen-module codes
// (traycer-adapter.js, runtime-snapshot.js) are hand-included in
// ALL_DECLARED_REASONS since those modules do not export registries.
//
// VERDICTS (eligible/ineligible/unresolved from eligibility.js) are verdict
// VALUES, not reason codes — they are explicitly excluded from this check.

const assert = require('assert');

const { ALL_DECLARED_REASONS, REASON_SUMMARIES } = require('../lib/score-candidates');
const { JEV_REASONS } = require('../lib/jev-client');
const { DIMENSION_ORDER } = require('../lib/task-profile');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

console.log('reason-summaries — completeness');

test('every declared reason code has a non-empty summary', () => {
  const missing = [];
  for (const code of ALL_DECLARED_REASONS) {
    const summary = REASON_SUMMARIES[code];
    if (!summary || typeof summary !== 'string' || summary.length === 0) {
      missing.push(code);
    }
  }
  assert.deepStrictEqual(missing, [], `reason codes missing summaries: ${missing.join(', ')}`);
});

test('every JEV_REASONS code is covered', () => {
  const missing = [];
  for (const code of JEV_REASONS) {
    if (!REASON_SUMMARIES[code]) missing.push(code);
  }
  assert.deepStrictEqual(missing, [], `JEV reason codes missing summaries: ${missing.join(', ')}`);
});

test('every profile.*-invalid dimension code is covered', () => {
  const missing = [];
  for (const dim of DIMENSION_ORDER) {
    const code = `profile.${dim}-invalid`;
    if (!REASON_SUMMARIES[code]) missing.push(code);
  }
  assert.deepStrictEqual(missing, [], `profile dimension codes missing summaries: ${missing.join(', ')}`);
});

test('every summary value is a non-empty string', () => {
  const bad = [];
  for (const [code, summary] of Object.entries(REASON_SUMMARIES)) {
    if (typeof summary !== 'string' || summary.length === 0) bad.push(code);
  }
  assert.deepStrictEqual(bad, [], `codes with bad summaries: ${bad.join(', ')}`);
});

test('REASON_SUMMARIES contains no duplicate keys (object literal is naturally unique, but verify count)', () => {
  const keys = Object.keys(REASON_SUMMARIES);
  // [#8] At least 65 unique reason codes across all coupled modules.
  assert.ok(keys.length >= 65, `expected 65+ reason summaries, got ${keys.length}`);
});

test('traycer-adapter frozen-module reason codes are covered', () => {
  const frozenCodes = [
    'traycer-field-absent', 'traycer-field-unconforming',
    'availability-pending', 'harness-catalog-absent', 'native-usage-unobserved',
  ];
  for (const code of frozenCodes) {
    assert.ok(REASON_SUMMARIES[code], `frozen-module code '${code}' missing summary`);
  }
});

test('runtime-snapshot frozen-module reason codes are covered', () => {
  const frozenCodes = [
    'no-cached-observation', 'cached-field-absent',
    'cached-state-absent', 'model-evidence-absent', 'model-comparison-unavailable',
  ];
  for (const code of frozenCodes) {
    assert.ok(REASON_SUMMARIES[code], `frozen-module code '${code}' missing summary`);
  }
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall reason-summaries tests passed');
