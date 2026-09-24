'use strict';
// Typed task profile — Issue #11 / AC2.
//
// A model-agnostic characterization of a task across eight dimensions:
// task kind, exploration, specification, reasoning, risk, autonomy,
// verification, execution style. Every dimension is a fact
// { value, provenance, source, observedAt, freshUntil, reason } conforming to
// the repo truthfulness contract: unknown is explicit
// (value null + provenance 'unknown' + a stable reason), never a sentinel,
// and a dimension is never guessed to fill the profile.
//
// Two producers feed this shape:
//   * buildProfile(input, opts)      — deterministic: caller-supplied task
//                                      metadata (observed) and policy defaults
//                                      (configured); anything else unresolved.
//   * validateClassifierResponse(raw) — schema validation for a Jev response
//                                      before it may become profile evidence.
//
// The dimension vocabularies are the contract between the classifier prompt
// (lib/jev-client.js) and this validator — they are declared HERE so the
// prompt builder and the validator can never drift apart. Registry data is
// never part of a task profile (AC7).

const PROFILE_SCHEMA_VERSION = 1;

// Dimension vocabulary. Order of this declaration is the canonical dimension
// order everywhere a profile is rendered, scored, or serialized.
const DIMENSIONS = Object.freeze({
  taskKind: {
    values: Object.freeze(['code', 'review', 'planning', 'research', 'documentation', 'operations', 'mixed']),
    summary: 'the kind of work the task performs',
  },
  exploration: {
    values: Object.freeze(['closed', 'scoped', 'open']),
    summary: 'how much codebase/context exploration the task needs',
  },
  specification: {
    values: Object.freeze(['precise', 'partial', 'vague']),
    summary: 'how completely the task is specified',
  },
  reasoning: {
    values: Object.freeze(['low', 'moderate', 'deep']),
    summary: 'the depth of reasoning the task demands',
  },
  risk: {
    values: Object.freeze(['low', 'moderate', 'high']),
    summary: 'the blast radius of a wrong execution',
  },
  autonomy: {
    values: Object.freeze(['supervised', 'standard', 'autonomous']),
    summary: 'how much unattended autonomy the task expects',
  },
  verification: {
    values: Object.freeze(['none', 'self-check', 'automated', 'independent-review']),
    summary: 'the verification bar the task must clear',
  },
  executionStyle: {
    values: Object.freeze(['interactive', 'batch', 'long-running']),
    summary: 'how the task runs once dispatched',
  },
});

const DIMENSION_ORDER = Object.freeze(Object.keys(DIMENSIONS));

// Reason codes this module emits — the reason-summaries completeness test
// imports this registry so a new emitted literal without a summary fails
// the suite. `profile.<dim>-invalid` codes are generated per dimension and
// are covered via DIMENSION_ORDER instead of a literal here.
const TASK_PROFILE_REASONS = Object.freeze({
  FIELD_ABSENT: 'task-profile-field-absent',
  VALUE_INVALID: 'task-profile-value-invalid',
  RESPONSE_NOT_OBJECT: 'response-not-object',
  CONFIDENCE_INVALID: 'confidence-invalid',
  PROFILE_NOT_OBJECT: 'profile-not-object',
  SUGGESTED_CANDIDATE_ID_INVALID: 'suggestedCandidateId-invalid',
});

const PROVENANCES = new Set(['observed', 'configured', 'unknown']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function fact(value, provenance, { source = null, observedAt = null, freshUntil = null } = {}) {
  return { value, provenance, source, observedAt, freshUntil, reason: null };
}

function unknown(reason) {
  return { value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason };
}

function factIsKnown(f) {
  return isPlainObject(f) && f.provenance !== 'unknown' && f.value !== null && f.value !== undefined;
}

// Normalize one dimension value into a fact within `vocab`. Primitives become
// evidence at the caller-supplied provenance/source; fact-shaped input keeps
// its own provenance; a known value outside the vocabulary is NOT evidence —
// it is a recognizable schema violation, reported as
// 'task-profile-value-invalid' rather than silently coerced.
function dimensionFact(input, vocab, { provenance, source }) {
  if (input === undefined || input === null) return unknown(TASK_PROFILE_REASONS.FIELD_ABSENT);
  if (isPlainObject(input)) {
    if (!('value' in input) || input.value === null || input.value === undefined ||
        input.provenance === 'unknown') {
      return unknown(nonEmptyString(input.reason) ? input.reason : TASK_PROFILE_REASONS.FIELD_ABSENT);
    }
    const n = nonEmptyString(input.value) ? input.value.trim().toLowerCase() : null;
    if (n === null || !vocab.includes(n)) return unknown(TASK_PROFILE_REASONS.VALUE_INVALID);
    return {
      value: n,
      provenance: PROVENANCES.has(input.provenance) ? input.provenance : 'observed',
      source: nonEmptyString(input.source) ? input.source : source,
      observedAt: nonEmptyString(input.observedAt) ? input.observedAt : null,
      freshUntil: nonEmptyString(input.freshUntil) ? input.freshUntil : null,
      reason: null,
    };
  }
  const n = nonEmptyString(input) ? input.trim().toLowerCase() : null;
  if (n === null || !vocab.includes(n)) return unknown(TASK_PROFILE_REASONS.VALUE_INVALID);
  return fact(n, provenance, { source });
}

// Build a profile from layered inputs. `layers` is an ordered list of
// { values, provenance, source } applied lowest-precedence-first: each
// dimension keeps the LAST layer that resolves it to a known value. A layer
// that supplies an invalid or absent value never erases an earlier resolved
// value — it simply contributes nothing for that dimension.
function buildProfile(layers, { source = 'task-profile' } = {}) {
  const inputs = (Array.isArray(layers) ? layers : [layers]).filter(isPlainObject);
  const dimensions = {};
  const resolved = [];
  const unresolved = [];
  for (const name of DIMENSION_ORDER) {
    let f = unknown(TASK_PROFILE_REASONS.FIELD_ABSENT);
    for (const layer of inputs) {
      const candidate = dimensionFact(layer.values && layer.values[name], DIMENSIONS[name].values, {
        provenance: nonEmptyString(layer.provenance) ? layer.provenance : 'observed',
        source: nonEmptyString(layer.source) ? layer.source : source,
      });
      if (factIsKnown(candidate)) f = candidate;
      // A supplied-but-invalid or explicitly-unknown field carries more
      // information than a bare absence — keep the informative reason while
      // the dimension remains unresolved.
      else if (!factIsKnown(f) && candidate.reason !== TASK_PROFILE_REASONS.FIELD_ABSENT) f = candidate;
    }
    dimensions[name] = f;
    if (factIsKnown(f)) resolved.push(name);
    else unresolved.push({ dimension: name, reason: f.reason });
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    dimensions,
    resolved,
    unresolved,
    complete: unresolved.length === 0,
  };
}

// The deterministic fallback profile (AC3): task metadata is observed
// evidence from the task document; policy defaults are configured evidence
// from `policy.defaults.taskProfile`. Task metadata wins. Dimensions with no
// evidence stay unresolved — the fallback never invents values.
// `task.kind` is an accepted alias for `task.profile.taskKind`.
function fallbackProfile(task, policy) {
  const t = isPlainObject(task) ? task : {};
  const meta = isPlainObject(t.profile) ? { ...t.profile } : {};
  if (meta.taskKind === undefined && t.kind !== undefined) meta.taskKind = t.kind;
  const pol = isPlainObject(policy) ? policy : {};
  const defaults = isPlainObject(pol.defaults) && isPlainObject(pol.defaults.taskProfile)
    ? pol.defaults.taskProfile
    : {};
  return buildProfile([
    { values: defaults, provenance: 'configured', source: 'default-policy' },
    { values: meta, provenance: 'observed', source: 'task-metadata' },
  ], { source: 'deterministic-fallback' });
}

// Schema-validate a raw Jev classifier response before it becomes evidence.
// A valid response is a plain object:
//   { profile: { <all eight dimensions as in-vocabulary strings> },
//     confidence: <finite number in [0,1]>,
//     suggestedCandidateId?: <non-empty string> }
// Every dimension must be present and in-vocabulary — a partial response is
// schema-invalid, not a partial profile, because the deterministic fallback
// already owns partial-evidence semantics.
// Returns { ok: true, profile, confidence, suggestedCandidateId } or
// { ok: false, violations } with violations sorted for determinism.
function validateClassifierResponse(raw) {
  const violations = [];
  if (!isPlainObject(raw)) {
    return { ok: false, violations: [TASK_PROFILE_REASONS.RESPONSE_NOT_OBJECT] };
  }
  const conf = raw.confidence;
  if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
    violations.push(TASK_PROFILE_REASONS.CONFIDENCE_INVALID);
  }
  const prof = raw.profile;
  if (!isPlainObject(prof)) {
    violations.push(TASK_PROFILE_REASONS.PROFILE_NOT_OBJECT);
  } else {
    for (const name of DIMENSION_ORDER) {
      const v = prof[name];
      const n = nonEmptyString(v) ? v.trim().toLowerCase() : null;
      if (n === null || !DIMENSIONS[name].values.includes(n)) {
        violations.push(`profile.${name}-invalid`);
      }
    }
  }
  if (raw.suggestedCandidateId !== undefined && !nonEmptyString(raw.suggestedCandidateId)) {
    violations.push(TASK_PROFILE_REASONS.SUGGESTED_CANDIDATE_ID_INVALID);
  }
  violations.sort();
  if (violations.length) return { ok: false, violations };
  const dimensions = {};
  for (const name of DIMENSION_ORDER) dimensions[name] = prof[name].trim().toLowerCase();
  return {
    ok: true,
    profile: dimensions,
    confidence: conf,
    suggestedCandidateId: nonEmptyString(raw.suggestedCandidateId) ? raw.suggestedCandidateId : null,
  };
}

module.exports = {
  PROFILE_SCHEMA_VERSION,
  DIMENSIONS,
  DIMENSION_ORDER,
  TASK_PROFILE_REASONS,
  buildProfile,
  fallbackProfile,
  validateClassifierResponse,
  factIsKnown,
};
