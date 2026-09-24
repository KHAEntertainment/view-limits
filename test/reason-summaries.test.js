'use strict';
// Reason-code summary completeness test — Issue #13.
//
// [#8] Every reason code in the coupled LIVE registries must have a
// human-readable summary in REASON_SUMMARIES. The registries are exported
// by the modules that emit the codes and are used at the emission sites —
// adding a code to a live registry without a summary fails this suite:
//   REASON_ORDER / SCORE_FALLBACK_REASONS — score-candidates.js
//   JEV_REASONS                            — jev-client.js
//   TASK_PROFILE_REASONS + profile.*-invalid (via DIMENSION_ORDER) — task-profile.js
//   RECOMMEND_REASONS                      — recommend.js
//   READINESS_REASONS                      — jev-readiness.js
//   RECEIPT_REASONS                        — receipts.js
//
// CURATED_FROZEN_REASON_CODES is a HAND-MAINTAINED snapshot of fact-reason
// literals in the frozen modules (traycer-adapter.js, runtime-snapshot.js,
// capability-registry.js). Frozen files cannot export registries, so this
// list is curated coverage, not live/categorical — a new frozen-module
// literal reaches it only through review. Diagnostic codes are out of
// scope: runtime-snapshot/runtime-sidecar self-summarize via
// DIAG_SUMMARIES, and eligibility.js self-summarizes its verdict reasons
// internally.
//
// VERDICTS (eligible/ineligible/unresolved from eligibility.js) are verdict
// VALUES, not reason codes — they are explicitly excluded from this check.

const assert = require('assert');

const {
  allDeclaredReasons, REASON_SUMMARIES, REASON_ORDER,
  SCORE_FALLBACK_REASONS, CURATED_FROZEN_REASON_CODES,
} = require('../lib/score-candidates');
const { JEV_REASONS } = require('../lib/jev-client');
const { DIMENSION_ORDER, TASK_PROFILE_REASONS } = require('../lib/task-profile');
const { RECOMMEND_REASONS } = require('../lib/recommend');
const { READINESS_REASONS } = require('../lib/jev-readiness');
const { RECEIPT_REASONS } = require('../lib/receipts');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

function missingSummaries(codes) {
  return codes.filter((code) => {
    const s = REASON_SUMMARIES[code];
    return !s || typeof s !== 'string' || s.length === 0;
  });
}

console.log('reason-summaries — completeness');

test('every code in the coupled live registries + curated frozen list has a non-empty summary', () => {
  assert.deepStrictEqual(missingSummaries(allDeclaredReasons()), [],
    'declared reason codes missing summaries — every emitted code needs one');
});

for (const [label, codes] of [
  ['score-candidates REASON_ORDER', REASON_ORDER],
  ['score-candidates SCORE_FALLBACK_REASONS', Object.values(SCORE_FALLBACK_REASONS)],
  ['jev-client JEV_REASONS', JEV_REASONS],
  ['task-profile TASK_PROFILE_REASONS', Object.values(TASK_PROFILE_REASONS)],
  ['recommend RECOMMEND_REASONS', Object.values(RECOMMEND_REASONS)],
  ['jev-readiness READINESS_REASONS', Object.values(READINESS_REASONS)],
  ['receipts RECEIPT_REASONS', Object.values(RECEIPT_REASONS)],
  ['CURATED_FROZEN_REASON_CODES (hand-maintained, not live-coupled)', CURATED_FROZEN_REASON_CODES],
]) {
  test(`every ${label} code is covered`, () => {
    assert.deepStrictEqual(missingSummaries(codes), [],
      `${label} codes missing summaries`);
  });
}

test('every profile.*-invalid dimension code is covered', () => {
  assert.deepStrictEqual(
    missingSummaries(DIMENSION_ORDER.map((dim) => `profile.${dim}-invalid`)),
    [], 'profile dimension codes missing summaries',
  );
});

test('allDeclaredReasons composes every live registry (nothing hand-mirrored)', () => {
  const declared = new Set(allDeclaredReasons());
  for (const codes of [
    REASON_ORDER, Object.values(SCORE_FALLBACK_REASONS), JEV_REASONS,
    Object.values(TASK_PROFILE_REASONS), Object.values(RECOMMEND_REASONS),
    Object.values(READINESS_REASONS), Object.values(RECEIPT_REASONS),
    CURATED_FROZEN_REASON_CODES,
  ]) {
    for (const code of codes) {
      assert.ok(declared.has(code), `declared list must include '${code}'`);
    }
  }
});

test('every summary value is a non-empty string', () => {
  const bad = [];
  for (const [code, summary] of Object.entries(REASON_SUMMARIES)) {
    if (typeof summary !== 'string' || summary.length === 0) bad.push(code);
  }
  assert.deepStrictEqual(bad, [], `codes with bad summaries: ${bad.join(', ')}`);
});

test('REASON_SUMMARIES covers at least the declared set (no duplicate keys; count check)', () => {
  const keys = Object.keys(REASON_SUMMARIES);
  assert.ok(keys.length >= allDeclaredReasons().length,
    `expected summaries for all ${allDeclaredReasons().length} declared codes, got ${keys.length}`);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nall reason-summaries tests passed');
