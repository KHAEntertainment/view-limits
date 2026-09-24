'use strict';
// Advisory recommendation — Issue #11.
//
// recommend() composes the deterministic substrate into one advisory result:
//
//   readiness gate (lib/jev-readiness.js)
//     → CLOSED on current evidence: the Jev network path stays dormant and is
//       never invoked (AC1). OPEN only when every readiness item is PASS and
//       the configured model's structured-output support verifies.
//   task profile (lib/task-profile.js)
//     → Jev classification when the gate is open and the response validates;
//       otherwise the deterministic metadata/default-policy fallback (AC3).
//   hard eligibility (lib/eligibility.js)
//     → unchanged by anything Jev says; an ineligible candidate stays
//       ineligible at any confidence (AC4). Eligibility 'unresolved'
//       candidates are never scored or recommended.
//   scoring (lib/score-candidates.js)
//     → eligible candidates only; unresolved dimensions contribute zero
//       weight and stay visible with reasons (AC5).
//
// Advisory boundary (AC6): the result carries advisory parameters and
// rationale ONLY. This module performs no spawn, no agent configuration or
// forking, no command selection, no auto-dispatch, no balance queries, and
// no model substitution — a candidate model that cannot be proven stays an
// explicit unknown fact in the output. Every transport is injected; nothing
// here performs I/O of its own.
//
// Truthfulness contract: identical to lib/runtime-snapshot.js — advisory
// parameters are facts { value, provenance, source, observedAt, freshUntil,
// reason }; unresolved evidence is listed with stable reason codes, never a
// sentinel.

const { evaluate } = require('./eligibility');
const { defaultRegistry } = require('./capability-registry');
const { evaluateReadiness, READINESS_ITEMS } = require('./jev-readiness');
const { buildProfile, fallbackProfile } = require('./task-profile');
const { classify, verifyModelSupport } = require('./jev-client');
const { scoreCandidates } = require('./score-candidates');

const RECOMMEND_SCHEMA_VERSION = 1;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return v !== null && typeof v === 'string' && v.length > 0;
}

function observedFact(value, source) {
  return { value, provenance: 'observed', source, observedAt: null, freshUntil: null, reason: null };
}

function unknown(reason) {
  return { value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason };
}

// Normalize an advisory parameter into a fact — same discipline as
// eligibility's candidateFact: primitives are observed evidence sourced from
// the candidate document; fact-shaped input keeps its provenance; absent or
// unknown stays unknown with a stable reason.
function paramFact(input) {
  if (input === undefined || input === null) return unknown('candidate-fact-absent');
  if (isPlainObject(input)) {
    if (!('value' in input) || input.value === null || input.value === undefined ||
        input.provenance === 'unknown') {
      return unknown(nonEmptyString(input.reason) ? input.reason : 'candidate-fact-absent');
    }
    return {
      value: input.value,
      provenance: ['observed', 'configured'].includes(input.provenance) ? input.provenance : 'observed',
      source: nonEmptyString(input.source) ? input.source : 'candidate',
      observedAt: nonEmptyString(input.observedAt) ? input.observedAt : null,
      freshUntil: nonEmptyString(input.freshUntil) ? input.freshUntil : null,
      reason: null,
    };
  }
  return observedFact(input, 'candidate');
}

function candidateId(cand, index) {
  return isPlainObject(cand) && nonEmptyString(cand.id) ? cand.id : `candidate-${index}`;
}

// Interpret the caller-supplied model-verification evidence. Only an explicit
// positive verifies — anything else is unverified.
function modelVerifiedFlag(v) {
  if (v === true) return true;
  if (isPlainObject(v)) {
    if (v.verified === true || v.status === 'verified') return true;
  }
  return false;
}

async function recommend({
  task = {},
  candidates = [],
  policy,
  registry,
  caller = {},
  readiness,
  modelVerification,
  jev = {},
  now = null,
} = {}) {
  const reg = isPlainObject(registry) && typeof registry.lookupModel === 'function'
    ? registry
    : defaultRegistry();
  // Fail closed on a missing or malformed policy: anything that is not a
  // plain object (absent, null, array, primitive) gets the strict default —
  // proven route identity and a proven-usable route state. A silently
  // dropped requirement would let an unknown-state route read as eligible.
  // An explicit {} remains a deliberate "no requirements" caller choice.
  const pol = isPlainObject(policy)
    ? policy
    : { require: { route: true, usableRoute: true } };
  const candList = Array.isArray(candidates) ? candidates : [];
  const callerCtx = isPlainObject(caller) ? caller : {};
  const jevCfg = isPlainObject(jev) && isPlainObject(jev.config) ? jev.config : {};
  const jevIo = isPlainObject(jev) && isPlainObject(jev.io) ? jev.io : {};
  const nowMs = typeof now === 'function' ? now() : (Number.isFinite(now) ? now : null);

  // ---- AC1: readiness gate ---------------------------------------------------
  // Model verification is attempted only when every readiness item already
  // passes — a closed evidence set never triggers any verification I/O.
  const itemsOnly = evaluateReadiness({ items: readiness, modelVerified: false });
  let verification = modelVerification;
  if (verification === undefined && itemsOnly.notPass.length === 0) {
    try {
      verification = await verifyModelSupport({ config: jevCfg, io: jevIo });
    } catch {
      verification = { status: 'unverified', reason: 'jev-catalog-unreachable' };
    }
  }
  const gate = evaluateReadiness({ items: readiness, modelVerified: modelVerifiedFlag(verification) });
  const verificationDetail = isPlainObject(verification)
    ? { status: nonEmptyString(verification.status) ? verification.status : 'unverified',
        reason: nonEmptyString(verification.reason) ? verification.reason : null }
    : (verification === true
      ? { status: 'verified', reason: null }
      : { status: 'unverified',
          reason: itemsOnly.notPass.length === 0 ? 'jev-model-unverified' : 'jev-verification-not-attempted' });

  // ---- task profile: Jev when open+valid, deterministic fallback otherwise ---
  const jevSection = {
    attempted: false,
    status: 'dormant',
    reason: 'jev-readiness-gate-closed',
    modelVerification: verificationDetail,
  };
  let profile;
  let jevSuggestion = null;
  if (gate.open) {
    jevSection.attempted = true;
    jevSection.status = 'unavailable';
    const res = await classify({ task, config: jevCfg, io: jevIo });
    if (res.status === 'ok') {
      jevSection.status = 'applied';
      jevSection.reason = null;
      jevSection.confidence = res.confidence;
      profile = buildProfile([
        { values: res.profile, provenance: 'observed', source: 'jev' },
      ], { source: 'jev' });
      jevSuggestion = res.suggestedCandidateId;
    } else {
      jevSection.reason = res.reason;
      if (res.detail !== undefined) jevSection.detail = res.detail;
      profile = fallbackProfile(task, pol);
      jevSection.fallback = 'deterministic-fallback';
    }
  } else {
    profile = fallbackProfile(task, pol);
  }
  if (itemsOnly.notPass.length === 0 && !gate.open) {
    // Items all PASS but verification did not — record precisely which side
    // kept the gate closed.
    jevSection.reason = 'jev-model-unverified';
  }
  jevSection.notPass = gate.notPass;

  // ---- hard eligibility — Jev output cannot touch this -----------------------
  // Candidate ids name scored candidates throughout the output, so they must
  // be unique: a duplicated id makes verdict lookups and parameter
  // attribution ambiguous (a rejected candidate could shadow an eligible
  // one). Every candidate sharing an id is rejected 'candidate-id-duplicate'
  // WITHOUT eligibility evaluation — the id can never name two candidates.
  const candIds = candList.map((c, i) => candidateId(c, i));
  const idCount = new Map();
  for (const id of candIds) idCount.set(id, (idCount.get(id) || 0) + 1);
  const duplicateIds = new Set(candIds.filter((id) => idCount.get(id) > 1));

  const eligible = [];
  const undecided = [];
  const rejected = [];
  const verdictById = new Map();
  const candById = new Map();
  candList.forEach((cand, i) => {
    const id = candIds[i];
    if (duplicateIds.has(id)) {
      const reasons = [{
        code: 'candidate-id-duplicate',
        scope: `candidate:${id}`,
        summary: 'two or more candidates share this id; attribution would be ambiguous, so the id is rejected outright.',
      }];
      verdictById.set(id, { result: 'ineligible', reasons });
      rejected.push({ candidateId: id, result: 'ineligible', reasons });
      return;
    }
    const verdict = evaluate(cand, pol, reg);
    verdictById.set(id, verdict);
    const rec = { candidateId: id, result: verdict.result, reasons: verdict.reasons };
    if (verdict.result === 'eligible') {
      eligible.push({ cand, id });
      candById.set(id, cand);
    }
    else if (verdict.result === 'unresolved') undecided.push(rec);
    else rejected.push(rec);
  });
  undecided.sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));
  rejected.sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));

  // ---- AC4: a Jev-suggested candidate is re-checked through eligibility ------
  if (jevSuggestion !== null) {
    const verdict = verdictById.get(jevSuggestion);
    jevSection.suggestedCandidateId = jevSuggestion;
    if (!verdict) {
      jevSection.suggestion = { candidateId: jevSuggestion, disposition: 'rejected', code: 'jev-suggestion-unknown-candidate' };
    } else if (verdict.result !== 'eligible') {
      jevSection.suggestion = {
        candidateId: jevSuggestion,
        disposition: 'rejected',
        code: 'jev-suggestion-ineligible',
        reasons: verdict.reasons,
      };
    } else {
      jevSection.suggestion = { candidateId: jevSuggestion, disposition: 'advisory' };
    }
  }

  // ---- AC5: score eligible candidates only ------------------------------------
  const scored = scoreCandidates(
    eligible.map(({ cand, id }) => ({ ...cand, id })),
    { profile, policy: pol, registry: reg, caller: callerCtx, now: nowMs },
  );

  const top = scored.length ? scored[0] : null;
  // Parameters come from the exact candidate object that was scored — the
  // eligible-id map is unique by construction (duplicates never reach it).
  const source = top === null ? {} : (candById.get(top.id) || {});
  const recommendation = top === null ? null : {
    candidateId: top.id,
    score: top.score,
    maxScore: top.maxScore,
    parameters: {
      harness: paramFact(source.harness),
      model: paramFact(source.model),
      route: {
        id: paramFact(isPlainObject(source.route) ? source.route.id : undefined),
        state: paramFact(isPlainObject(source.route) ? source.route.state : undefined),
      },
      profile: paramFact(source.profile),
    },
    rationale: top.rationale,
    alternatives: scored.slice(1).map((s) => ({
      candidateId: s.id,
      score: s.score,
      rationale: s.rationale,
    })),
  };

  // ---- unresolved evidence stays visible --------------------------------------
  const unresolvedEvidence = [];
  for (const u of profile.unresolved) {
    unresolvedEvidence.push({ scope: `task-profile.${u.dimension}`, code: 'profile-dimension-unresolved', reason: u.reason });
  }
  for (const s of scored) {
    for (const u of s.unresolved) {
      unresolvedEvidence.push({ scope: `candidate:${s.id}.${u.dimension}`, code: u.code, reason: u.code });
    }
  }
  unresolvedEvidence.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0) ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

  return {
    schemaVersion: RECOMMEND_SCHEMA_VERSION,
    advisoryOnly: true,
    readiness: gate,
    jev: jevSection,
    taskProfile: profile,
    recommendation,
    candidates: {
      scored: scored.map((s) => ({
        candidateId: s.id,
        score: s.score,
        maxScore: s.maxScore,
        scoredWeight: s.scoredWeight,
        dimensions: s.dimensions,
        unresolved: s.unresolved,
      })),
      undecided,
      rejected,
    },
    unresolved: unresolvedEvidence,
  };
}

module.exports = { recommend, RECOMMEND_SCHEMA_VERSION };
