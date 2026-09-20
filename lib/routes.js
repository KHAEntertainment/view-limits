'use strict';
// Route/account resolution. A route is the stable identity of a specific
// quota/balance pool; the same model can appear under multiple routes (direct
// plan vs OpenRouter vs a proxy vs another harness's backend).
//
// Resolution is fail-open: any ambiguity the configured matches cannot
// disambiguate (ties, conflicting harness/model signals with no combined
// winner) returns null so the gate never denies against the wrong account.

const RE_HARNESS_HINT = /^mcp__traycer_a2a__/;

// Resolve a dispatch to a route, or null when ambiguous/unknown (fail open).
//   model   — the raw model string from tool_input
//   context — { surface: 'claude'|'traycer'|..., harness: string|null }
//   routes  — the configured route list
//
// Resolution rules (in order):
//   1. A unique route whose `match` matches BOTH model and harness wins.
//      Equal-best combined matches across distinct accounts → null.
//   2. No combined match exists, but both signals do (each picking different
//      routes) → null. The config cannot prove which account is charged.
//   3. Only one signal has hits → resolve via that signal, longest-specificity
//      wins; equal-best across distinct accounts → null.
//   4. No hits → null. Absent identity stays absent.
function resolveRoute(model, context, routes) {
  const m = String(model || '').toLowerCase();
  const h = String((context && context.harness) || '').toLowerCase();
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

  // 1) Unique combined winner disambiguates overlapping model-only matches.
  if (combinedHits.length) {
    return pickBySpecificity(combinedHits, true) || null;
  }

  // 2) Harness and model each pick different pools — no route can prove the
  // account identity, so the gate fails open rather than guess.
  if (modelHits.length && harnessHits.length) return null;

  // 3) Only one signal has hits.
  const candidates = modelHits.length ? modelHits : harnessHits;
  if (!candidates.length) return null;
  return pickBySpecificity(candidates, modelHits.length > 0) || null;
}

// Pick the route with the highest specificity score; equal best → null. When
// `modelAxis` is true, score is (1000 + model-substring-length); otherwise
// (500 + harness-substring-length). Mirrors the original "longer substring is
// more specific" rule but treats a tie between distinct accounts as ambiguous.
function pickBySpecificity(routes, modelAxis) {
  let best = null;
  let bestScore = -1;
  let tied = false;
  for (const r of routes) {
    const match = (r && r.match) || {};
    const mm = String(match.model || '').toLowerCase();
    const mh = String(match.harness || '').toLowerCase();
    const score = modelAxis
      ? (mm ? 1000 + mm.length : 0)
      : (mh ? 500 + mh.length : 0);
    if (score > bestScore) { bestScore = score; best = r; tied = false; }
    else if (score === bestScore) { tied = true; }
  }
  return tied ? null : best;
}

// Derive dispatch context (surface + harness + model) from a hook event.
// Missing dispatch identity stays missing: a Traycer `profile` is never
// promoted to a harness, and a missing harnessId never falls back to a
// default surface string — both would let the gate resolve the wrong account.
function dispatchContext(evt) {
  const evtObj = (evt && typeof evt === 'object') ? evt : {};
  const tool = String(evtObj.tool_name || '');
  const ti = (evtObj.tool_input && typeof evtObj.tool_input === 'object')
    ? evtObj.tool_input : {};
  if (tool === 'Agent' || tool === 'Task') {
    return { surface: 'claude', harness: 'claude', model: ti.model };
  }
  if (RE_HARNESS_HINT.test(tool)) {
    const harness = (typeof ti.harnessId === 'string' && ti.harnessId) ? ti.harnessId : null;
    return { surface: 'traycer', harness, model: ti.model };
  }
  return { surface: 'unknown', harness: null, model: ti.model };
}

module.exports = { resolveRoute, dispatchContext };
