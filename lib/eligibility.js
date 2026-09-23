'use strict';
// Deterministic eligibility over normalized candidates — Issue #9.
//
// evaluate(candidate, policy, registry) is a PURE function: no provider I/O,
// no network, no filesystem, no clock, no randomness, no environment reads.
// The same input always produces the same result and the same ordered reason
// codes.
//
// The result is three-valued:
//   'ineligible'  — at least one KNOWN violated hard constraint
//   'unresolved'  — no violated hard constraint, but a required capability or
//                   identity cannot be proven
//   'eligible'    — every requirement is proven and nothing is violated
//
// `unresolved` is never collapsed into `eligible` or `ineligible`, and a
// capability or identity is never guessed to force a decision. Known violated
// hard constraints outrank everything: a healthy route cannot make a
// candidate that misses a required harness or skill eligible.
//
// Input shapes (malformed input degrades to unknown facts, never throws):
//
//   candidate = {
//     id,                       — informational only
//     model,                    — effective model identity
//     harness,                  — harness identity
//     harnessAvailable,         — harness availability observation; proven
//                               —   positive: true | 'available'; proven
//                               —   negative: false | 'unavailable';
//                               —   anything else is unproven
//     profile,                  — profile/account identity
//     family,                   — declared model family (fallback evidence)
//     skills,                   — observed executable-skill inventory
//     taskCapabilities,         — declared model task capabilities (used only
//     executionCapabilities,    —   when the registry has no entry)
//     route: { id, state },     — route identity + observed resource state
//   }
//   Every field accepts a primitive or a fact object
//   { value, provenance, source, observedAt, freshUntil, reason }.
//   Primitives become 'observed' facts sourced from the candidate document
//   itself; absent fields and provenance 'unknown' become unknown facts.
//
//   policy = {
//     require: {
//       models,                 — allowlist of model ids/names/aliases
//       harnesses,              — allowlist of harness ids/names/aliases
//       taskCapabilities,       — required model task capabilities
//       executionCapabilities,  — required harness execution capabilities
//       skills,                 — required executable skills
//       route,                  — truthy: route identity must be proven
//       usableRoute,            — truthy: route state must be a proven
//                               —   positive (a recognized usable state)
//     },
//     forbid: { routes, profiles, models, harnesses },
//     review: {
//       requireDifferentFamily, — truthy: candidate and subject families must
//                               —   both be proven and differ
//       subject,                — { model } | { family } | '<family name>'
//     },
//   }
//
// Evidence rules:
//   * Registry entries are the authoritative capability list for registered
//     models/harnesses: a required capability absent from a KNOWN entry is a
//     violated hard constraint (ineligible). Declared candidate capabilities
//     are consulted only when the model/harness is unregistered — a partial
//     observation can prove presence but never absence.
//   * Skills are installable per-agent, not model/harness-intrinsic: a
//     required skill is proven by ANY proven source (harness entry or
//     candidate inventory) and proven missing only when EVERY source is known
//     and lacks it; otherwise unresolved.
//   * Family aliases resolve in the registry only — never in runtime
//     discovery. An unregistered family literal still compares as a literal
//     (a supplied family name is evidence of itself), but an unproven family
//     under a different-family review requirement yields 'unresolved'.
//   * Sentinel treatment is unified by one proven-positive predicate: for
//     both route state and harness availability only an explicit positive
//     (true, or a domain positive-vocabulary value) proves usability.
//     'unavailable'/'exhausted'/false are proven negatives (ineligible);
//     'unknown', 'false', '', 0, and unrecognized values are unproven —
//     never silently positive.

const { STATES } = require('./normalize');
const { defaultRegistry } = require('./capability-registry');

const RESULTS = ['eligible', 'ineligible', 'unresolved'];

// Route states that prove a route usable: every recognized state except the
// terminal 'exhausted' and the sentinel 'unknown' (shared vocabulary from
// lib/normalize.js).
const USABLE_ROUTE_STATES = new Set(STATES.filter((s) => s !== 'exhausted' && s !== 'unknown'));
// Harness availability positive vocabulary: `true` or 'available' is a proven
// positive; `false` or 'unavailable' is a proven negative.
const AVAILABLE_VOCAB = new Set(['available']);

// Shared proven-positive predicate — a value is positive evidence ONLY when
// it is exactly `true` or a member of the domain's positive vocabulary.
// Everything else (false, 'unavailable', 'unknown', '', 0, 'false',
// unrecognized strings, non-strings) is either a proven negative or unproven;
// it is NEVER a positive. One predicate used by both route state and harness
// availability so the same sentinel can never be read two ways.
function provenPositive(v, positiveVocabulary) {
  if (v === true) return true;
  const n = norm(v);
  return n !== null && positiveVocabulary.has(n);
}

// Canonical reason order: all ineligible codes first (in check order), then
// all unresolved codes. Emitted reasons are sorted by this order, then scope,
// so output ordering does not depend on input enumeration order.
const REASON_ORDER = [
  // ineligible — violated hard constraints
  'route-forbidden',
  'profile-forbidden',
  'model-forbidden',
  'harness-forbidden',
  'route-exhausted',
  'harness-unavailable',
  'harness-not-allowed',
  'model-not-allowed',
  'model-capability-missing',
  'execution-capability-missing',
  'required-skill-missing',
  'review-same-family',
  // unresolved — required evidence that could not be proven
  'route-identity-unproven',
  'route-state-unproven',
  'profile-identity-unproven',
  'model-identity-unproven',
  'model-capability-unproven',
  'harness-identity-unproven',
  'harness-availability-unproven',
  'execution-capability-unproven',
  'required-skill-unproven',
  'family-unproven',
];

const REASON_SUMMARIES = {
  'route-forbidden': 'the candidate route identity is forbidden by policy.',
  'profile-forbidden': 'the candidate profile identity is forbidden by policy.',
  'model-forbidden': 'the candidate model identity is forbidden by policy.',
  'harness-forbidden': 'the candidate harness identity is forbidden by policy.',
  'route-exhausted': 'the candidate route is observed exhausted.',
  'harness-unavailable': 'the candidate harness is observed unavailable.',
  'harness-not-allowed': 'the candidate harness is outside the policy allowlist.',
  'model-not-allowed': 'the candidate model is outside the policy allowlist.',
  'model-capability-missing': 'the registered model capability set lacks a required task capability.',
  'execution-capability-missing': 'the registered harness capability set lacks a required execution capability.',
  'required-skill-missing': 'every proven skill source lacks a required executable skill.',
  'review-same-family': 'independent review requires a different model family; candidate and subject families are proven equal.',
  'route-identity-unproven': 'route identity is required by policy and cannot be proven.',
  'route-state-unproven': 'policy requires a proven-usable route and the route state is unknown.',
  'profile-identity-unproven': 'profile identity is required by policy and cannot be proven.',
  'model-identity-unproven': 'model identity is required by policy and cannot be proven.',
  'model-capability-unproven': 'a required task capability cannot be proven; the model is unregistered and no proven declared capabilities cover it.',
  'harness-identity-unproven': 'harness identity is required by policy and cannot be proven.',
  'harness-availability-unproven': 'a harness requirement exists and harness availability cannot be proven.',
  'execution-capability-unproven': 'a required execution capability cannot be proven; the harness is unregistered and no proven declared capabilities cover it.',
  'required-skill-unproven': 'a required executable skill cannot be proven present or absent.',
  'family-unproven': 'independent review requires proven model families; a family is unknown.',
};

const REASON_RANK = new Map(REASON_ORDER.map((code, i) => [code, i]));

const PROVENANCES = new Set(['observed', 'configured', 'unknown']);

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

function factIsKnown(f) {
  return isPlainObject(f) && f.provenance !== 'unknown' && f.value !== null && f.value !== undefined;
}

function knownString(f) {
  return factIsKnown(f) && nonEmptyString(f.value) ? f.value : null;
}

// Normalize one candidate/policy field into a fact — same discipline as
// runtime-snapshot's callerFact: primitives are observed evidence sourced
// from the supplying document; fact-shaped input keeps its own provenance;
// absent or unknown-provenance input is unknown with a stable reason.
function candidateFact(input) {
  if (input === undefined || input === null) return unknown('candidate-fact-absent');
  if (isPlainObject(input)) {
    if (!('value' in input) || input.value === null || input.value === undefined ||
        input.provenance === 'unknown') {
      return unknown(nonEmptyString(input.reason) ? input.reason : 'candidate-fact-absent');
    }
    return {
      value: input.value,
      provenance: PROVENANCES.has(input.provenance) ? input.provenance : 'observed',
      source: nonEmptyString(input.source) ? input.source : 'candidate',
      observedAt: nonEmptyString(input.observedAt) ? input.observedAt : null,
      freshUntil: nonEmptyString(input.freshUntil) ? input.freshUntil : null,
      reason: null,
    };
  }
  return observedFact(input, 'candidate');
}

// Sorted, de-duplicated lowercase requirement list from a policy field that
// may be a string, an array, or anything else (non-conforming → empty).
function reqList(v) {
  const items = Array.isArray(v) ? v : [v];
  const out = [];
  for (const item of items) {
    const n = norm(item);
    if (n && !out.includes(n)) out.push(n);
  }
  out.sort();
  return out;
}

// A fact's value as a proven lowercase string list, or null when the fact is
// unknown or the value is not a list of names. An empty observed array is
// still a KNOWN (proven-empty) inventory — it proves absence.
function knownStringSet(f) {
  if (!factIsKnown(f) || !Array.isArray(f.value)) return null;
  const out = new Set();
  for (const v of f.value) {
    const n = norm(v);
    if (n) out.add(n);
  }
  return out;
}

// All matchable names for an identity: the literal supplied value plus the
// registered canonical id and aliases. Returns null when identity is unknown.
function nameSet(identityFact, entryFact) {
  const out = new Set();
  const literal = knownString(identityFact);
  if (literal === null) return null;
  out.add(norm(literal));
  if (factIsKnown(entryFact) && isPlainObject(entryFact.value)) {
    const id = norm(entryFact.value.id);
    if (id) out.add(id);
    for (const a of Array.isArray(entryFact.value.aliases) ? entryFact.value.aliases : []) {
      const n = norm(a);
      if (n) out.add(n);
    }
  }
  return out;
}

function intersects(setA, listB) {
  if (!setA) return false;
  return listB.some((b) => setA.has(b));
}

// Canonical family id for a supplied family name: the registered canonical
// id when the name or its alias is registered, else the literal lowercase
// name (a supplied family value is evidence of itself — deterministic
// comparison, never a guess).
function canonicalFamily(reg, name) {
  const n = norm(name);
  if (!n) return null;
  return reg.canonicalFamilyId(n) || n;
}

// The candidate's proven family: the registered model's configured family
// wins; otherwise a declared candidate.family fact canonicalizes through the
// registry's family aliases. Null when no source is proven.
function candidateFamily(reg, modelEntryFact, declaredFamilyFact) {
  if (factIsKnown(modelEntryFact) && isPlainObject(modelEntryFact.value) && nonEmptyString(modelEntryFact.value.family)) {
    return canonicalFamily(reg, modelEntryFact.value.family);
  }
  const declared = knownString(declaredFamilyFact);
  return declared === null ? null : canonicalFamily(reg, declared);
}

// The review subject's proven family: an explicit subject.family (or bare
// string subject) canonicalizes through family aliases; otherwise
// subject.model resolves through the registry. Null when unproven.
function subjectFamily(reg, subject) {
  if (nonEmptyString(subject)) return canonicalFamily(reg, subject);
  if (!isPlainObject(subject)) return null;
  const fam = knownString(candidateFact(subject.family));
  if (fam !== null) return canonicalFamily(reg, fam);
  const model = knownString(candidateFact(subject.model));
  if (model === null) return null;
  const entry = reg.lookupModel(model);
  if (factIsKnown(entry) && isPlainObject(entry.value) && nonEmptyString(entry.value.family)) {
    return canonicalFamily(reg, entry.value.family);
  }
  return null;
}

function evaluate(candidate, policy, registry) {
  const reg = isPlainObject(registry) && typeof registry.lookupModel === 'function'
    ? registry
    : defaultRegistry();
  const pol = isPlainObject(policy) ? policy : {};
  const require = isPlainObject(pol.require) ? pol.require : {};
  const forbid = isPlainObject(pol.forbid) ? pol.forbid : {};
  const review = isPlainObject(pol.review) ? pol.review : {};

  const cand = isPlainObject(candidate) ? candidate : {};
  const model = candidateFact(cand.model);
  const harness = candidateFact(cand.harness);
  const harnessAvailable = candidateFact(cand.harnessAvailable);
  const profile = candidateFact(cand.profile);
  const declaredFamily = candidateFact(cand.family);
  const declaredSkills = candidateFact(cand.skills);
  const declaredTaskCaps = candidateFact(cand.taskCapabilities);
  const declaredExecCaps = candidateFact(cand.executionCapabilities);
  const routeObj = isPlainObject(cand.route) ? cand.route : {};
  const routeId = candidateFact(routeObj.id);
  const routeState = candidateFact(routeObj.state);

  const modelEntry = factIsKnown(model) ? reg.lookupModel(model.value) : null;
  const harnessEntry = factIsKnown(harness) ? reg.lookupHarness(harness.value) : null;
  const modelNames = nameSet(model, modelEntry);
  const harnessNames = nameSet(harness, harnessEntry);

  const forbidRoutes = reqList(forbid.routes);
  const forbidProfiles = reqList(forbid.profiles);
  const forbidModels = reqList(forbid.models);
  const forbidHarnesses = reqList(forbid.harnesses);
  const reqModels = reqList(require.models);
  const reqHarnesses = reqList(require.harnesses);
  const reqTaskCaps = reqList(require.taskCapabilities);
  const reqExecCaps = reqList(require.executionCapabilities);
  const reqSkills = reqList(require.skills);
  const needRouteId = require.route === true || forbidRoutes.length > 0;
  const needRouteState = require.usableRoute === true;

  const ineligible = [];
  const unresolved = [];
  const push = (list, code, scope) => {
    const key = JSON.stringify([code, scope]);
    if (!list.some((r) => JSON.stringify([r.code, r.scope]) === key)) {
      list.push({ code, scope, summary: REASON_SUMMARIES[code] });
    }
  };

  // ---- forbidden identities -------------------------------------------------
  // A non-empty forbid list makes the corresponding identity required: known
  // and listed → ineligible; unproven → unresolved.
  if (forbidRoutes.length) {
    const id = knownString(routeId);
    // An unproven route identity is reported once by the unified route
    // requirement below (needRouteId already covers forbid.routes).
    if (id !== null && forbidRoutes.includes(norm(id))) push(ineligible, 'route-forbidden', `route:${id}`);
  }
  if (forbidProfiles.length) {
    const id = knownString(profile);
    if (id === null) push(unresolved, 'profile-identity-unproven', 'profile');
    else if (forbidProfiles.includes(norm(id))) push(ineligible, 'profile-forbidden', `profile:${id}`);
  }
  if (forbidModels.length) {
    if (modelNames === null) push(unresolved, 'model-identity-unproven', 'model');
    else if (intersects(modelNames, forbidModels)) push(ineligible, 'model-forbidden', `model:${model.value}`);
  }
  if (forbidHarnesses.length) {
    if (harnessNames === null) push(unresolved, 'harness-identity-unproven', 'harness');
    else if (intersects(harnessNames, forbidHarnesses)) push(ineligible, 'harness-forbidden', `harness:${harness.value}`);
  }

  // ---- known violated hard constraints (policy-independent) ------------------
  // A proven exhausted route or unavailable harness denies regardless of what
  // the policy requires — resource health never enters as a positive signal.
  // Proven negatives deny outright; proven positives pass; every other value
  // ('unknown', 'false', '', 0, unrecognized strings, absent facts) is
  // unproven — handled below only where the policy actually requires it.
  const routeExhausted = factIsKnown(routeState) && norm(routeState.value) === 'exhausted';
  const routeProvenUsable = factIsKnown(routeState) && provenPositive(routeState.value, USABLE_ROUTE_STATES);
  if (routeExhausted) {
    const id = knownString(routeId);
    push(ineligible, 'route-exhausted', `route:${id === null ? 'candidate' : id}`);
  }
  const harnessUnavailable = factIsKnown(harnessAvailable) &&
    (harnessAvailable.value === false || norm(harnessAvailable.value) === 'unavailable');
  const harnessProvenAvailable = factIsKnown(harnessAvailable) &&
    provenPositive(harnessAvailable.value, AVAILABLE_VOCAB);
  if (harnessUnavailable) {
    const h = knownString(harness);
    push(ineligible, 'harness-unavailable', `harness:${h === null ? 'candidate' : h}`);
  }

  // ---- allowlists -------------------------------------------------------------
  if (reqModels.length) {
    if (modelNames === null) push(unresolved, 'model-identity-unproven', 'model');
    else if (!intersects(modelNames, reqModels)) push(ineligible, 'model-not-allowed', `model:${model.value}`);
  }
  if (reqHarnesses.length) {
    if (harnessNames === null) push(unresolved, 'harness-identity-unproven', 'harness');
    else if (!intersects(harnessNames, reqHarnesses)) push(ineligible, 'harness-not-allowed', `harness:${harness.value}`);
  }

  // ---- route requirements ------------------------------------------------------
  if (needRouteId && knownString(routeId) === null) {
    push(unresolved, 'route-identity-unproven', 'route');
  }
  // usableRoute requires a proven-positive state: 'exhausted' is a proven
  // negative (ineligible above, not unproven); 'unknown' and unrecognized
  // values are unproven.
  if (needRouteState && !routeExhausted && !routeProvenUsable) {
    push(unresolved, 'route-state-unproven', 'route');
  }

  // ---- model task capabilities ---------------------------------------------------
  // The registry entry is the authoritative capability list for a registered
  // model; for an unregistered model only declared capability evidence can
  // prove presence — absence is never provable there.
  for (const cap of reqTaskCaps) {
    if (factIsKnown(modelEntry)) {
      if (!modelEntry.value.taskCapabilities.includes(cap)) {
        push(ineligible, 'model-capability-missing', `capability:${cap}`);
      }
    } else {
      const declared = knownStringSet(declaredTaskCaps);
      if (declared === null || !declared.has(cap)) {
        push(unresolved, 'model-capability-unproven', `capability:${cap}`);
      }
    }
  }

  // ---- harness execution capabilities ---------------------------------------------
  for (const cap of reqExecCaps) {
    if (factIsKnown(harnessEntry)) {
      if (!harnessEntry.value.executionCapabilities.includes(cap)) {
        push(ineligible, 'execution-capability-missing', `capability:${cap}`);
      }
    } else {
      const declared = knownStringSet(declaredExecCaps);
      if (declared === null || !declared.has(cap)) {
        push(unresolved, 'execution-capability-unproven', `capability:${cap}`);
      }
    }
  }

  // ---- required executable skills ----------------------------------------------------
  // Skills are installable per-agent: presence is proven by ANY known source,
  // absence only when every source is known and lacks the skill.
  const harnessSkills = factIsKnown(harnessEntry) && Array.isArray(harnessEntry.value.skills)
    ? new Set(harnessEntry.value.skills) : null;
  const candSkills = knownStringSet(declaredSkills);
  for (const skill of reqSkills) {
    const present = (harnessSkills !== null && harnessSkills.has(skill)) ||
      (candSkills !== null && candSkills.has(skill));
    if (present) continue;
    if (harnessSkills !== null && candSkills !== null) {
      push(ineligible, 'required-skill-missing', `skill:${skill}`);
    } else {
      push(unresolved, 'required-skill-unproven', `skill:${skill}`);
    }
  }

  // ---- harness availability -----------------------------------------------------------
  // Required whenever the policy makes harness demands (allowlist or
  // execution capabilities). Proven negatives already produced ineligible
  // above; anything that is not a proven positive — including 'unknown',
  // 'false', '', 0 — stays unresolved under a harness requirement. The
  // availability check is fail-closed: only `true` / 'available' proves it.
  if ((reqHarnesses.length || reqExecCaps.length) && !harnessUnavailable && !harnessProvenAvailable) {
    push(unresolved, 'harness-availability-unproven', 'harness');
  }

  // ---- independent review family check ----------------------------------------------------
  if (review.requireDifferentFamily) {
    const candFam = candidateFamily(reg, modelEntry, declaredFamily);
    const subjFam = subjectFamily(reg, review.subject);
    if (candFam === null) push(unresolved, 'family-unproven', 'family:candidate');
    if (subjFam === null) push(unresolved, 'family-unproven', 'family:subject');
    if (candFam !== null && subjFam !== null && candFam === subjFam) {
      push(ineligible, 'review-same-family', 'review');
    }
  }

  const rank = (r) => (REASON_RANK.has(r.code) ? REASON_RANK.get(r.code) : REASON_ORDER.length);
  const sortReasons = (rs) => rs.slice().sort((a, b) => (rank(a) - rank(b)) || (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  const ordered = [...sortReasons(ineligible), ...sortReasons(unresolved)];
  const result = ineligible.length ? 'ineligible' : (unresolved.length ? 'unresolved' : 'eligible');
  return { result, reasons: ordered };
}

module.exports = { evaluate, RESULTS, REASON_ORDER };
