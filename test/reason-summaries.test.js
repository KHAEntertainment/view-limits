'use strict';
// Reason-code summary completeness test — Issue #13.
//
// Verifies that every declared reason code across all modules has a
// human-readable summary in REASON_SUMMARIES. Also verifies the dynamic
// profile.*-invalid codes are covered for every dimension.

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
  // There should be at least 60 unique reason codes across all modules.
  assert.ok(keys.length >= 60, `expected 60+ reason summaries, got ${keys.length}`);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall reason-summaries tests passed');
