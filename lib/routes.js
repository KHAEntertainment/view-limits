'use strict';
// Route/account resolution. A route is the stable identity of a specific
// quota/balance pool; the same model can appear under multiple routes (direct
// plan vs OpenRouter vs a proxy vs another harness's backend).

// Resolve a dispatch to a route, or null when ambiguous/unknown (fail open).
//   model   — the raw model string from tool_input
//   context — { surface: 'claude'|'traycer'|..., harness: string|null }
//   routes  — the configured route list
function resolveRoute(model, context, routes) {
  const m = String(model || '').toLowerCase();
  const h = String((context && context.harness) || '').toLowerCase();
  let best = null;
  let bestScore = -1;

  for (const r of routes || []) {
    const match = r.match || {};
    const mm = String(match.model || '').toLowerCase();
    const mh = String(match.harness || '').toLowerCase();
    const modelHit = mm && m.includes(mm);
    const harnessHit = mh && h.includes(mh);
    if (!modelHit && !harnessHit) continue;

    // A model match is the stronger signal; longer substrings are more specific.
    let score = 0;
    if (modelHit) score += 1000 + mm.length;
    if (harnessHit) score += 500 + mh.length;
    if (score > bestScore) { bestScore = score; best = r; }
  }

  return best || null;
}

// Derive dispatch context (surface + harness) from a hook event.
function dispatchContext(evt) {
  const tool = String(evt.tool_name || '');
  const ti = (evt.tool_input && typeof evt.tool_input === 'object') ? evt.tool_input : {};
  if (tool === 'Agent' || tool === 'Task') {
    return { surface: 'claude', harness: 'claude', model: ti.model };
  }
  if (tool.startsWith('mcp__traycer_a2a__')) {
    return { surface: 'traycer', harness: ti.harnessId || ti.profile || 'traycer', model: ti.model };
  }
  return { surface: 'unknown', harness: null, model: ti.model };
}

module.exports = { resolveRoute, dispatchContext };
