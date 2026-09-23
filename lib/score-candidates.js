'use strict';
// Deterministic candidate scoring — Issue #11 / AC5.
//
// Scores ELIGIBLE candidates on six dimensions — task fit, harness/session
// affinity, resource pressure, cost/speed preferences, continuity, and review
// independence — producing a stable ranked order with documented reasons and
// alternatives.
//
// Purity contract (same as lib/eligibility.js): no I/O, no provider calls, no
// randomness, no environment reads, no clock reads — `now` is a parameter.
// The same inputs always produce the same score, the same order, and the same
// ordered reason codes.
//
// Unresolvable dimensions stay visible: a dimension whose inputs cannot be
// proven is reported { status:'unresolved', reason } inside the candidate's
// dimension record and contributes ZERO weight — its weight is never
// redistributed to other dimensions and it never becomes an implicit score.
//
// Scores are integer milli-points (0–1000 per dimension × static weight), so
// totals are exact and ordering never depends on floating-point summation.

const { STATES } = require('./normalize');
const { defaultRegistry } = require('./capability-registry');
const { parseStrictIsoTimestamp } = require('./gate');
const { factIsKnown } = require('./task-profile');

// Canonical dimension order — fixed declaration order, never input order.
const DIMENSION_ORDER = Object.freeze([
  'taskFit', 'harnessAffinity', 'resourcePressure',
  'costSpeed', 'continuity', 'reviewIndependence',
]);

const WEIGHTS = Object.freeze({
  taskFit: 4,
  harnessAffinity: 2,
  resourcePressure: 3,
  costSpeed: 1,
  continuity: 2,
  reviewIndependence: 1,
});

// Reason codes, in canonical emission order: unresolved codes first (they
// explain missing weight), then evidence codes (they explain the score).
const REASON_ORDER = [
  // unresolved — evidence that could not be proven
  'task-kind-unproven',
  'model-capabilities-unproven',
  'caller-harness-unproven',
  'candidate-harness-unproven',
  'route-binding-absent',
  'route-state-unproven',
  'cost-signal-unproven',
  'speed-signal-unproven',
  'selected-profile-unproven',
  'candidate-profile-unproven',
  'family-unproven',
  // scored — the evidence that produced the contribution
  'task-capability-covered',
  'task-capability-uncovered',
  'same-harness',
  'different-harness',
  'route-healthy',
  'route-constrained',
  'route-state-negative',
  'route-evidence-stale',
  'route-freshness-unproven',
  'route-freshness-not-evaluated',
  'preference-absent',
  'cost-tier',
  'speed-tier',
  'continuity-match',
  'continuity-different',
  'independence-proven',
  'independence-violated',
  'independence-not-required',
];

const REASON_SUMMARIES = {
  'task-kind-unproven': 'the task profile kind is unresolved, so task fit cannot be scored.',
  'model-capabilities-unproven': 'the candidate model is unregistered and carries no proven declared task capabilities.',
  'caller-harness-unproven': 'the caller harness is unproven, so harness affinity cannot be scored.',
  'candidate-harness-unproven': 'the candidate harness identity is unproven, so harness affinity cannot be scored.',
  'route-binding-absent': 'the candidate has no route binding, so resource pressure cannot be scored.',
  'route-state-unproven': 'the candidate route state is unproven, so resource pressure cannot be scored.',
  'cost-signal-unproven': 'a cost preference is configured but the candidate carries no proven cost signal.',
  'speed-signal-unproven': 'a speed preference is configured but the candidate carries no proven speed signal.',
  'selected-profile-unproven': 'the caller selected profile/account is unproven, so continuity cannot be scored.',
  'candidate-profile-unproven': 'the candidate profile/account identity is unproven, so continuity cannot be scored.',
  'family-unproven': 'a model family needed for the review-independence check is unproven.',
  'task-capability-covered': 'the candidate model covers a task-required capability.',
  'task-capability-uncovered': 'the candidate model lacks a task-required capability.',
  'same-harness': 'the candidate runs on the caller’s own harness.',
  'different-harness': 'the candidate runs on a different harness than the caller.',
  'route-healthy': 'the candidate route is observed healthy.',
  'route-constrained': 'the candidate route is observed constrained.',
  'route-state-negative': 'the candidate route state is a proven non-usable value.',
  'route-evidence-stale': 'the route observation is past its freshUntil; the resource score is discounted.',
  'route-freshness-unproven': 'no freshUntil evidence exists; the resource score is discounted.',
  'route-freshness-not-evaluated': 'no decision clock was supplied; route freshness was not evaluated.',
  'preference-absent': 'no cost/speed preference is configured; the dimension scores neutral.',
  'cost-tier': 'the candidate cost tier was compared against the configured cost preference.',
  'speed-tier': 'the candidate speed tier was compared against the configured speed preference.',
  'continuity-match': 'the candidate profile/account matches the caller’s selected identity.',
  'continuity-different': 'the candidate profile/account differs from the caller’s selected identity.',
  'independence-proven': 'candidate and subject families are proven different; review stays independent.',
  'independence-violated': 'candidate and subject families are proven equal; review independence is not met.',
  'independence-not-required': 'the policy does not require an independent review family; the dimension scores neutral.',
};

const REASON_RANK = new Map(REASON_ORDER.map((code, i) => [code, i]));

const PROVENANCES = new Set(['observed', 'configured', 'unknown']);

// Task-kind → required model task capabilities. Additional needs are layered
// from other profile dimensions below.
const TASK_CAPABILITY_MAP = Object.freeze({
  code: ['code'],
  review: ['review'],
  planning: ['planning'],
  research: ['long-context'],
  documentation: ['code'],
  operations: ['tool-use'],
  mixed: ['code', 'tool-use'],
});

const COST_TIERS = Object.freeze({ low: 1000, medium: 500, high: 100 });
const SPEED_TIERS = Object.freeze({ fast: 1000, standard: 600, slow: 200 });

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function norm(v) {
  return nonEmptyString(v) ? v.trim().toLowerCase() : null;
}

function observedFact(value, source) {
  return { value, provenance: 'observed', source, observedAt: null, freshUntil: null, reason: null };
}

function unknown(reason) {
  return { value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason };
}

// Normalize one candidate/caller field into a fact — same discipline as
// lib/eligibility.js#candidateFact: primitives are observed evidence sourced
// from the supplying document; fact-shaped input keeps its own provenance;
// absent or unknown-provenance input is unknown with a stable reason.
function fieldFact(input, source) {
  if (input === undefined || input === null) return unknown(`${source}-fact-absent`);
  if (isPlainObject(input)) {
    if (!('value' in input) || input.value === null || input.value === undefined ||
        input.provenance === 'unknown') {
      return unknown(nonEmptyString(input.reason) ? input.reason : `${source}-fact-absent`);
    }
    return {
      value: input.value,
      provenance: PROVENANCES.has(input.provenance) ? input.provenance : 'observed',
      source: nonEmptyString(input.source) ? input.source : source,
      observedAt: nonEmptyString(input.observedAt) ? input.observedAt : null,
      freshUntil: nonEmptyString(input.freshUntil) ? input.freshUntil : null,
      reason: null,
    };
  }
  return observedFact(input, source);
}

function knownString(f) {
  return factIsKnown(f) && nonEmptyString(f.value) ? f.value : null;
}

function knownStringSet(f) {
  if (!factIsKnown(f) || !Array.isArray(f.value)) return null;
  const out = new Set();
  for (const v of f.value) {
    const n = norm(v);
    if (n) out.add(n);
  }
  return out;
}

// Canonical family id for a supplied family name — same rule as eligibility:
// registered canonical id when resolvable, else the literal lowercase name.
function canonicalFamily(reg, name) {
  const n = norm(name);
  if (!n) return null;
  return reg.canonicalFamilyId(n) || n;
}

function candidateFamily(reg, modelEntryFact, declaredFamilyFact) {
  if (factIsKnown(modelEntryFact) && isPlainObject(modelEntryFact.value) &&
      nonEmptyString(modelEntryFact.value.family)) {
    return canonicalFamily(reg, modelEntryFact.value.family);
  }
  const declared = knownString(declaredFamilyFact);
  return declared === null ? null : canonicalFamily(reg, declared);
}

function subjectFamily(reg, subject) {
  if (nonEmptyString(subject)) return canonicalFamily(reg, subject);
  if (!isPlainObject(subject)) return null;
  const fam = knownString(fieldFact(subject.family, 'subject'));
  if (fam !== null) return canonicalFamily(reg, fam);
  const model = knownString(fieldFact(subject.model, 'subject'));
  if (model === null) return null;
  const entry = reg.lookupModel(model);
  if (factIsKnown(entry) && isPlainObject(entry.value) && nonEmptyString(entry.value.family)) {
    return canonicalFamily(reg, entry.value.family);
  }
  return null;
}

function reason(code, scope) {
  return { code, scope, summary: REASON_SUMMARIES[code] || null };
}

function sortReasons(list) {
  const rank = (r) => (REASON_RANK.has(r.code) ? REASON_RANK.get(r.code) : REASON_ORDER.length);
  const seen = new Set();
  return list.filter((r) => {
    const key = `${r.code}|${r.scope}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => (rank(a) - rank(b)) ||
    (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

// ---- dimension scorers -------------------------------------------------------
// Each returns { status: 'scored'|'unresolved', contribution, reasons } where
// contribution is 0–1000 before weighting. An unresolved dimension always
// contributes 0 and reports exactly why.

function scoreTaskFit({ profile, reg, modelFact, modelEntryFact, declaredTaskCaps }) {
  const kindFact = isPlainObject(profile) && isPlainObject(profile.dimensions)
    ? profile.dimensions.taskKind : null;
  const kind = factIsKnown(kindFact) ? norm(kindFact.value) : null;
  if (kind === null) {
    const why = isPlainObject(kindFact) && nonEmptyString(kindFact.reason)
      ? kindFact.reason : 'task-profile-field-absent';
    return { status: 'unresolved', contribution: 0, reasons: [reason('task-kind-unproven', `profile:${why}`)] };
  }

  const needed = new Set(TASK_CAPABILITY_MAP[kind] || []);
  const reasoning = isPlainObject(profile.dimensions.reasoning) ? profile.dimensions.reasoning : null;
  if (factIsKnown(reasoning) && norm(reasoning.value) === 'deep') needed.add('reasoning');
  const verification = isPlainObject(profile.dimensions.verification) ? profile.dimensions.verification : null;
  if (factIsKnown(verification) && norm(verification.value) === 'independent-review') needed.add('review');

  let caps = null;
  if (factIsKnown(modelEntryFact)) {
    caps = new Set(modelEntryFact.value.taskCapabilities);
  } else {
    // Unregistered or unidentified model: only declared candidate capability
    // evidence can prove presence — same evidence rule as eligibility.
    caps = knownStringSet(declaredTaskCaps);
  }
  if (caps === null) {
    return { status: 'unresolved', contribution: 0, reasons: [reason('model-capabilities-unproven', 'model')] };
  }

  const reasons = [];
  let covered = 0;
  for (const cap of [...needed].sort()) {
    if (caps.has(cap)) {
      covered += 1;
      reasons.push(reason('task-capability-covered', `capability:${cap}`));
    } else {
      reasons.push(reason('task-capability-uncovered', `capability:${cap}`));
    }
  }
  const contribution = needed.size ? Math.round((covered / needed.size) * 1000) : 1000;
  return { status: 'scored', contribution, reasons };
}

function scoreHarnessAffinity({ reg, harnessFact, callerHarnessFact }) {
  const callerHarness = knownString(callerHarnessFact);
  if (callerHarness === null) {
    const why = nonEmptyString(callerHarnessFact.reason) ? callerHarnessFact.reason : 'caller-fact-absent';
    return { status: 'unresolved', contribution: 0, reasons: [reason('caller-harness-unproven', `caller:${why}`)] };
  }
  const candHarness = knownString(harnessFact);
  if (candHarness === null) {
    const why = nonEmptyString(harnessFact.reason) ? harnessFact.reason : 'candidate-fact-absent';
    return { status: 'unresolved', contribution: 0, reasons: [reason('candidate-harness-unproven', `harness:${why}`)] };
  }
  const same = (reg.canonicalHarnessId(candHarness) || norm(candHarness)) ===
    (reg.canonicalHarnessId(callerHarness) || norm(callerHarness));
  return same
    ? { status: 'scored', contribution: 1000, reasons: [reason('same-harness', `harness:${candHarness}`)] }
    : { status: 'scored', contribution: 300, reasons: [reason('different-harness', `harness:${candHarness}`)] };
}

function scoreResourcePressure({ routeIdFact, routeStateFact, routeFreshFact, nowMs }) {
  if (knownString(routeIdFact) === null) {
    return { status: 'unresolved', contribution: 0, reasons: [reason('route-binding-absent', 'route')] };
  }
  if (!factIsKnown(routeStateFact)) {
    const why = nonEmptyString(routeStateFact.reason) ? routeStateFact.reason : 'cached-state-absent';
    return { status: 'unresolved', contribution: 0, reasons: [reason('route-state-unproven', `route:${why}`)] };
  }
  const state = norm(routeStateFact.value);
  const reasons = [];
  let contribution;
  if (state === 'healthy') {
    contribution = 1000;
    reasons.push(reason('route-healthy', 'route'));
  } else if (state === 'constrained') {
    contribution = 400;
    reasons.push(reason('route-constrained', 'route'));
  } else if (state === 'exhausted') {
    // A proven non-usable state contributes nothing positive. ('exhausted'
    // normally never reaches scoring — ineligible candidates are filtered —
    // but standalone scoring stays honest about it.)
    contribution = 0;
    reasons.push(reason('route-state-negative', 'route:exhausted'));
  } else {
    // 'unknown' and unrecognized values are unproven — same fail-closed
    // reading as eligibility's provenPositive, never a silent negative.
    return { status: 'unresolved', contribution: 0, reasons: [reason('route-state-unproven', `route:${state === null ? 'unrecognized' : state}`)] };
  }

  // Freshness discounts stale or unproven evidence; it never upgrades it.
  if (nowMs === null) {
    reasons.push(reason('route-freshness-not-evaluated', 'route'));
  } else if (!factIsKnown(routeFreshFact)) {
    contribution = Math.round(contribution / 2);
    reasons.push(reason('route-freshness-unproven', 'route'));
  } else {
    const freshMs = parseStrictIsoTimestamp(routeFreshFact.value);
    if (freshMs === null || nowMs > freshMs) {
      contribution = Math.round(contribution / 2);
      reasons.push(reason('route-evidence-stale', 'route'));
    }
  }
  return { status: 'scored', contribution, reasons };
}

function scoreCostSpeed({ preferences, costFact, speedFact }) {
  const costPref = norm(preferences.cost);
  const speedPref = norm(preferences.speed);
  const wantLowCost = costPref === 'minimize' || costPref === 'low';
  const wantFast = speedPref === 'maximize' || speedPref === 'fast';
  if (!wantLowCost && !wantFast) {
    return { status: 'scored', contribution: 1000, reasons: [reason('preference-absent', 'preferences')] };
  }
  const reasons = [];
  const parts = [];
  if (wantLowCost) {
    const tier = factIsKnown(costFact) ? norm(costFact.value) : null;
    if (tier === null || !(tier in COST_TIERS)) {
      return { status: 'unresolved', contribution: 0, reasons: [reason('cost-signal-unproven', 'candidate')] };
    }
    parts.push(COST_TIERS[tier]);
    reasons.push(reason('cost-tier', `cost:${tier}`));
  }
  if (wantFast) {
    const tier = factIsKnown(speedFact) ? norm(speedFact.value) : null;
    if (tier === null || !(tier in SPEED_TIERS)) {
      return { status: 'unresolved', contribution: 0, reasons: [reason('speed-signal-unproven', 'candidate')] };
    }
    parts.push(SPEED_TIERS[tier]);
    reasons.push(reason('speed-tier', `speed:${tier}`));
  }
  const contribution = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  return { status: 'scored', contribution, reasons };
}

function scoreContinuity({ profileFact, callerProfileFact, callerAccountFact }) {
  const callerProfile = knownString(callerProfileFact);
  const callerAccount = knownString(callerAccountFact);
  if (callerProfile === null && callerAccount === null) {
    const why = nonEmptyString(callerProfileFact.reason) ? callerProfileFact.reason
      : (nonEmptyString(callerAccountFact.reason) ? callerAccountFact.reason : 'caller-fact-absent');
    return { status: 'unresolved', contribution: 0, reasons: [reason('selected-profile-unproven', `caller:${why}`)] };
  }
  const candProfile = knownString(profileFact);
  if (candProfile === null) {
    const why = nonEmptyString(profileFact.reason) ? profileFact.reason : 'candidate-fact-absent';
    return { status: 'unresolved', contribution: 0, reasons: [reason('candidate-profile-unproven', `profile:${why}`)] };
  }
  const match = (callerProfile !== null && norm(callerProfile) === norm(candProfile)) ||
    (callerAccount !== null && norm(callerAccount) === norm(candProfile));
  return match
    ? { status: 'scored', contribution: 1000, reasons: [reason('continuity-match', `profile:${candProfile}`)] }
    : { status: 'scored', contribution: 200, reasons: [reason('continuity-different', `profile:${candProfile}`)] };
}

function scoreReviewIndependence({ reg, review, modelEntryFact, declaredFamilyFact }) {
  if (!(isPlainObject(review) && review.requireDifferentFamily)) {
    return { status: 'scored', contribution: 1000, reasons: [reason('independence-not-required', 'review')] };
  }
  const candFam = candidateFamily(reg, modelEntryFact, declaredFamilyFact);
  const subjFam = subjectFamily(reg, review.subject);
  const unproven = [];
  if (candFam === null) unproven.push(reason('family-unproven', 'family:candidate'));
  if (subjFam === null) unproven.push(reason('family-unproven', 'family:subject'));
  if (unproven.length) return { status: 'unresolved', contribution: 0, reasons: unproven };
  if (candFam === subjFam) {
    return { status: 'scored', contribution: 0, reasons: [reason('independence-violated', `family:${candFam}`)] };
  }
  return { status: 'scored', contribution: 1000, reasons: [reason('independence-proven', `family:${candFam}`)] };
}

// ---- candidate scoring ---------------------------------------------------------

// Score one eligible candidate. `now` may be a millisecond number or null;
// null means freshness is not evaluated (deterministic, documented).
function scoreCandidate(candidate, { profile, policy, registry, caller, now } = {}) {
  const reg = isPlainObject(registry) && typeof registry.lookupModel === 'function'
    ? registry
    : defaultRegistry();
  const pol = isPlainObject(policy) ? policy : {};
  const callerCtx = isPlainObject(caller) ? caller : {};
  const cand = isPlainObject(candidate) ? candidate : {};
  const nowMs = Number.isFinite(now) ? now : null;

  const modelFact = fieldFact(cand.model, 'candidate');
  const harnessFact = fieldFact(cand.harness, 'candidate');
  const profileFact = fieldFact(cand.profile, 'candidate');
  const declaredFamily = fieldFact(cand.family, 'candidate');
  const declaredTaskCaps = fieldFact(cand.taskCapabilities, 'candidate');
  const costFact = fieldFact(cand.costTier, 'candidate');
  const speedFact = fieldFact(cand.speedTier, 'candidate');
  const routeObj = isPlainObject(cand.route) ? cand.route : {};
  const routeIdFact = fieldFact(routeObj.id, 'candidate');
  const routeStateFact = fieldFact(routeObj.state, 'candidate');
  const routeFreshFact = fieldFact(routeObj.freshUntil, 'candidate');
  const callerHarnessFact = fieldFact(callerCtx.harness, 'caller');
  const callerProfileFact = fieldFact(callerCtx.selectedProfile, 'caller');
  const callerAccountFact = fieldFact(callerCtx.selectedAccount, 'caller');
  const modelEntryFact = factIsKnown(modelFact) ? reg.lookupModel(modelFact.value) : null;

  const ctx = {
    profile, policy: pol, reg,
    modelFact, modelEntryFact, declaredTaskCaps, harnessFact,
    callerHarnessFact, routeIdFact, routeStateFact, routeFreshFact, nowMs,
    preferences: isPlainObject(pol.preferences) ? pol.preferences : {},
    costFact, speedFact, profileFact, callerProfileFact, callerAccountFact,
    review: isPlainObject(pol.review) ? pol.review : {}, declaredFamilyFact: declaredFamily,
  };

  const scored = {
    taskFit: scoreTaskFit(ctx),
    harnessAffinity: scoreHarnessAffinity(ctx),
    resourcePressure: scoreResourcePressure(ctx),
    costSpeed: scoreCostSpeed(ctx),
    continuity: scoreContinuity(ctx),
    reviewIndependence: scoreReviewIndependence(ctx),
  };

  const dimensions = {};
  const unresolved = [];
  const rationale = [];
  let score = 0;
  let scoredWeight = 0;
  for (const name of DIMENSION_ORDER) {
    const d = scored[name];
    const weight = WEIGHTS[name];
    const weighted = d.status === 'scored' ? weight * d.contribution : 0;
    if (d.status === 'scored') scoredWeight += weight;
    dimensions[name] = {
      status: d.status,
      weight,
      contribution: weighted,
      reasons: sortReasons(d.reasons),
    };
    for (const r of d.reasons) {
      if (d.status === 'unresolved') unresolved.push({ ...r, dimension: name });
      rationale.push(r);
    }
    score += weighted;
  }

  const unresolvedSorted = unresolved.slice().sort((a, b) =>
    ((REASON_RANK.has(a.code) ? REASON_RANK.get(a.code) : REASON_ORDER.length) -
     (REASON_RANK.has(b.code) ? REASON_RANK.get(b.code) : REASON_ORDER.length)) ||
    (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0) ||
    (a.dimension < b.dimension ? -1 : a.dimension > b.dimension ? 1 : 0));

  return {
    id: nonEmptyString(cand.id) ? cand.id : 'candidate',
    score,
    maxScore: DIMENSION_ORDER.reduce((a, n) => a + WEIGHTS[n] * 1000, 0),
    scoredWeight,
    dimensions,
    unresolved: unresolvedSorted,
    rationale: sortReasons(rationale),
  };
}

// Score and rank every candidate in `candidates` (assumed already eligible).
// Order: score desc, then candidate id asc — total, deterministic, and never
// dependent on input enumeration order.
function scoreCandidates(candidates, opts = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).map((c) => scoreCandidate(c, opts));
  list.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return list;
}

module.exports = {
  DIMENSION_ORDER,
  WEIGHTS,
  REASON_ORDER,
  scoreCandidate,
  scoreCandidates,
};
