'use strict';
// Pure dispatch-gate decision. No network, no filesystem, no Claude hook APIs —
// takes a resolved route + cached entry + clock, returns a decision.

// decide({ route, entry, now, config }) →
//   { action: 'allow' }                                            (unmapped → fail open)
//   { action: 'allow', refresh: true, context }                   (stale/missing → fail open + refresh)
//   { action: 'deny', reason }                                    (fresh + exhausted)
//   { action: 'allow', context }                                  (fresh + healthy/constrained/unknown)
function decide({ route, entry, now, config }) {
  if (!route) return { action: 'allow' };

  const fresh = entry && entry.freshUntil &&
    Number.isFinite(Date.parse(entry.freshUntil)) && now <= Date.parse(entry.freshUntil);

  if (!entry || !fresh) {
    return {
      action: 'allow',
      refresh: true,
      context: `view-limits: no fresh status cached for "${route.id}" (model may be dispatched; refresh scheduled).`,
    };
  }

  const st = entry.status || {};
  if (st.state === 'exhausted') {
    const reset = st.resetAt ? ` Resets ${new Date(st.resetAt).toLocaleString()}.` : '';
    return {
      action: 'deny',
      reason: `view-limits: route "${route.id}" is exhausted. Dispatch blocked.${reset}`,
    };
  }

  // healthy / constrained / unknown → allow, inject a one-line status.
  return { action: 'allow', context: summarize(route, st) };
}

function summarize(route, st) {
  const parts = [];
  if (st.balance) parts.push(`balance ${st.balance.available} ${st.balance.currency}`);
  for (const w of st.windows || []) {
    if (w.limit && w.remaining != null) {
      const pct = w.limit > 0 ? Math.round((w.remaining / w.limit) * 100) : null;
      parts.push(pct != null ? `${w.type} ${pct}%` : `${w.type} ${w.remaining}/${w.limit}`);
    }
  }
  const suffix = parts.length ? ` (${parts.join(', ')})` : '';
  return `view-limits: ${route.id} → ${st.state}${suffix}`;
}

module.exports = { decide, summarize };
