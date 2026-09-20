'use strict';
// Route/account resolution. A route is the stable identity of a specific
// quota/balance pool; the same model can appear under multiple routes (direct
// plan vs OpenRouter vs a proxy vs another harness's backend).
//
// Resolution is fail-open: any ambiguity the configured matches cannot
// disambiguate (ties, conflicting harness/model signals with no combined
// winner) returns null so the gate never denies against the wrong account.

const RE_HARNESS_HINT = /^mcp__traycer_a2a__/;

// True iff `v` is a non-empty trimmed string. Anything else (null, undefined,
// array, object, number, empty string, whitespace-only) is not a valid model
// identity and must not be coerced into one. The exported boundary enforces
// this so a malformed `tool_input.model` cannot survive stringification into
// a route match.
function isModelIdentity(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// True iff `v` is a non-empty trimmed string. Harness identity follows the
// same rule: a non-string or empty harness is absent, not a match signal.
function isHarnessIdentity(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Resolve a dispatch to a route, or null when ambiguous/unknown (fail open).
//   model   — the raw model string from tool_input
//   context — { surface: 'claude'|'traycer'|..., harness: string|null }
//   routes  — the configured route list
//
// Resolution rules (in order):
//   1. A unique route whose `match` matches BOTH model and harness wins. The
//      score combines model and harness specificity (the baseline rule), so a
//      strictly longer harness match disambiguates overlapping model-only
//      matches. Equal-best combined matches across distinct accounts → null.
//   2. No combined match exists, but both signals do (each picking different
//      routes) → null. The config cannot prove which account is charged.
//   3. Only one signal has hits → resolve via that signal, longest-specificity
//      wins; equal-best across distinct accounts → null.
//   4. No hits, or no model identity at all → null. Absent identity stays
//      absent; an invalid model (array/object/number/empty) is not promoted
//      into a signal.
function resolveRoute(model, context, routes) {
  const modelOk = isModelIdentity(model);
  const harnessOk = isHarnessIdentity(context && context.harness);
  const m = modelOk ? model.toLowerCase() : '';
  const h = harnessOk ? context.harness.toLowerCase() : '';
  const list = Array.isArray(routes) ? routes : [];

  const modelHits = [];
  const harnessHits = [];
  const combinedHits = [];

  for (const r of list) {
    const match = (r && r.match) || {};
    const mm = String(match.model || '').toLowerCase();
    const mh = String(match.harness || '').toLowerCase();
    const modelHit = !!(mm && m && m.includes(mm));
    const harnessHit = !!(mh && h && h.includes(mh));
    if (!modelHit && !harnessHit) continue;
    if (modelHit) modelHits.push(r);
    if (harnessHit) harnessHits.push(r);
    if (modelHit && harnessHit) combinedHits.push(r);
  }

  // 1) Combined specificity disambiguates overlapping model-only matches.
  //    Score = 1000+mm.length + 500+mh.length (baseline rule); ties → null.
  if (combinedHits.length) {
    return pickBySpecificity(combinedHits, 'combined') || null;
  }

  // 2) Harness and model each pick different pools — no route can prove the
  // account identity, so the gate fails open rather than guess.
  if (modelHits.length && harnessHits.length) return null;

  // 3) Only one signal has hits.
  if (modelHits.length) return pickBySpecificity(modelHits, 'model') || null;
  if (harnessHits.length) return pickBySpecificity(harnessHits, 'harness') || null;

  // 4) No hits, or no identity at all.
  return null;
}

// Pick the route with the highest specificity score; equal best → null. Mode
// selects the scoring axis: 'model' (1000+mm.length), 'harness' (500+mh.length),
// or 'combined' (sum of both, mirroring the baseline's additive rule so
// strictly longer harness matches disambiguate equal model matches).
function pickBySpecificity(routes, mode) {
  let best = null;
  let bestScore = -1;
  let tied = false;
  for (const r of routes) {
    const match = (r && r.match) || {};
    const mm = String(match.model || '').toLowerCase();
    const mh = String(match.harness || '').toLowerCase();
    let score = 0;
    if (mode === 'combined' || mode === 'model') {
      if (mm) score += 1000 + mm.length;
    }
    if (mode === 'combined' || mode === 'harness') {
      if (mh) score += 500 + mh.length;
    }
    if (score > bestScore) { bestScore = score; best = r; tied = false; }
    else if (score === bestScore) { tied = true; }
  }
  return tied ? null : best;
}

// Derive dispatch context (surface + harness + model) from a hook event.
// Missing dispatch identity stays missing: a Traycer `profile` is never
// promoted to a harness, a missing harnessId never falls back to a default
// surface string, and a non-string `model` is rejected (not coerced) so a
// malformed array/object can never stringify into a route match.
function dispatchContext(evt) {
  const evtObj = (evt && typeof evt === 'object') ? evt : {};
  const tool = String(evtObj.tool_name || '');
  const ti = (evtObj.tool_input && typeof evtObj.tool_input === 'object')
    ? evtObj.tool_input : {};
  if (tool === 'Agent' || tool === 'Task') {
    return { surface: 'claude', harness: 'claude', model: isModelIdentity(ti.model) ? ti.model : null };
  }
  if (RE_HARNESS_HINT.test(tool)) {
    const harness = isHarnessIdentity(ti.harnessId) ? ti.harnessId : null;
    return { surface: 'traycer', harness, model: isModelIdentity(ti.model) ? ti.model : null };
  }
  return { surface: 'unknown', harness: null, model: isModelIdentity(ti.model) ? ti.model : null };
}

module.exports = {
  resolveRoute,
  dispatchContext,
  isModelIdentity,
  isHarnessIdentity,
};
