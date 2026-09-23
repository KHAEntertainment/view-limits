'use strict';
// Jev readiness gate — Issue #11.
//
// The eleven-item readiness gate from docs/jev-readiness.md, as data plus a
// pure evaluator. The verdicts below mirror the merged readiness evidence
// verbatim; they are configuration truth (provenance 'configured' semantics —
// recorded evidence, not discovery). Updating readiness means updating this
// data after new evidence lands, never editing the evaluator.
//
// evaluateReadiness({ items, modelVerified }) is PURE: no I/O, no clock, no
// environment. The gate is fail-closed: any item that is not 'pass' — including
// an unrecognized or missing verdict — keeps the gate CLOSED, and the gate
// only opens when ADDITIONALLY the configured model's structured-output
// support has been positively verified (`modelVerified === true`). Both
// conditions are required; neither alone is sufficient.
//
// Current state (docs/jev-readiness.md, Issue #10 evidence):
//   items 2, 3, 11 BLOCKING; items 1, 4 PARTIAL; items 5–10 PASS
//   → the gate evaluates CLOSED. The Jev network path stays dormant.

const VERDICTS = ['pass', 'partial', 'blocking'];

// The eleven-item gate, keyed by item number from the approved delivery plan.
// `item` is a stable identifier; `verdict` is the merged evidence verdict;
// `evidence` points at the doc section that carries the proof.
const READINESS_ITEMS = Object.freeze([
  { id: 1, item: 'caller-identity', verdict: 'partial', evidence: 'docs/jev-readiness.md#item-1' },
  { id: 2, item: 'effective-model-verified', verdict: 'blocking', evidence: 'docs/jev-readiness.md#item-2' },
  { id: 3, item: 'selected-profile-account', verdict: 'blocking', evidence: 'docs/jev-readiness.md#item-3' },
  { id: 4, item: 'native-resource-apis', verdict: 'partial', evidence: 'docs/jev-readiness.md#item-4' },
  { id: 5, item: 'provider-adapters-composed', verdict: 'pass', evidence: 'docs/jev-readiness.md#item-5' },
  { id: 6, item: 'identity-separation', verdict: 'pass', evidence: 'docs/jev-readiness.md#item-6' },
  { id: 7, item: 'cache-only-live-modes', verdict: 'pass', evidence: 'docs/jev-readiness.md#item-7' },
  { id: 8, item: 'gate-network-free', verdict: 'pass', evidence: 'docs/jev-readiness.md#item-8' },
  { id: 9, item: 'capability-registry', verdict: 'pass', evidence: 'docs/jev-readiness.md#item-9' },
  { id: 10, item: 'deterministic-eligibility', verdict: 'pass', evidence: 'docs/jev-readiness.md#item-10' },
  { id: 11, item: 'semantic-inputs-sufficient', verdict: 'blocking', evidence: 'docs/jev-readiness.md#item-11' },
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Normalize one readiness item. A malformed or unrecognized verdict degrades
// to 'blocking' — fail-closed, never silently pass.
function normItem(raw) {
  const item = isPlainObject(raw) ? raw : {};
  const verdict = nonEmptyString(item.verdict) && VERDICTS.includes(item.verdict.trim().toLowerCase())
    ? item.verdict.trim().toLowerCase()
    : 'blocking';
  return {
    id: Number.isInteger(item.id) ? item.id : null,
    item: nonEmptyString(item.item) ? item.item : 'unnamed-item',
    verdict,
    evidence: nonEmptyString(item.evidence) ? item.evidence : null,
  };
}

// Evaluate the gate. `items` defaults to the recorded evidence above; callers
// (tests, a future refresh) may inject a different evidence set — the gate is
// evidence-driven, not a toggle. `modelVerified` is the second required
// condition: exact model / structured-output support verified immediately
// before use. Anything other than literal `true` counts as unverified.
//
// Returns { open, modelVerified, items, notPass } where `items` is the
// normalized evidence ordered by id and `notPass` lists every item holding
// the gate closed (partial and blocking alike — a PARTIAL prerequisite is
// still not PASS).
function evaluateReadiness({ items, modelVerified } = {}) {
  const src = Array.isArray(items) ? items : READINESS_ITEMS;
  const normalized = src.map(normItem)
    .sort((a, b) => ((a.id === null ? Infinity : a.id) - (b.id === null ? Infinity : b.id)) ||
      (a.item < b.item ? -1 : a.item > b.item ? 1 : 0));
  const verified = modelVerified === true;
  const notPass = normalized.filter((i) => i.verdict !== 'pass');
  return {
    open: notPass.length === 0 && verified,
    modelVerified: verified,
    items: normalized,
    notPass,
  };
}

module.exports = { READINESS_ITEMS, VERDICTS, evaluateReadiness };
