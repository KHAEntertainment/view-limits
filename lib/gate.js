'use strict';
// Pure dispatch-gate decision. No network, no filesystem, no Claude hook APIs —
// takes a resolved route + cached entry + clock, returns a decision.
//
// Tolerant of malformed inputs (null, primitives, arrays, bad timestamps,
// nested status fields of unexpected shape): any cache shape the consumer
// can't prove is fresh + exhausted fails open rather than deny. This protects
// against crashes and against false denies driven by a corrupt status file.

function decide({ route, entry, now, config }) {
  if (!route) return { action: 'allow' };

  const fresh = isFreshEntry(entry, now);

  if (!entry || !fresh) {
    return {
      action: 'allow',
      refresh: true,
      context: `view-limits: no fresh status cached for "${route.id}" (model may be dispatched; refresh scheduled).`,
    };
  }

  const st = safeStatus(entry);
  if (st.state === 'exhausted') {
    const resetTs = safeIso(st.resetAt);
    const reset = resetTs ? ` Resets ${new Date(resetTs).toLocaleString()}.` : '';
    return {
      action: 'deny',
      reason: `view-limits: route "${route.id}" is exhausted. Dispatch blocked.${reset}`,
    };
  }

  // healthy / constrained / unknown → allow, inject a one-line status.
  return { action: 'allow', context: summarize(route, st) };
}

// True only when `entry` is a plain object with a parseable freshUntil that
// hasn't expired. Anything else — null, primitives, arrays, bad timestamps —
// is treated as not-fresh, so the gate falls through to the fail-open branch.
function isFreshEntry(entry, now) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (typeof entry.freshUntil !== 'string' || !entry.freshUntil) return false;
  const t = Date.parse(entry.freshUntil);
  if (!Number.isFinite(t)) return false;
  return now <= t;
}

// entry.status as a plain object, or {} — never an array, never a primitive.
function safeStatus(entry) {
  const st = entry && entry.status;
  if (!st || typeof st !== 'object' || Array.isArray(st)) return {};
  return st;
}

// Return `v` as an ISO string if it parses; otherwise null. Defends the deny
// reason string from "Invalid Date" if a provider's resetAt is malformed.
function safeIso(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Validate a single window shape: must be a non-null object with at least the
// fields the summary reads (`type`, `limit`, `remaining`). Anything else —
// null, primitive, array — is silently dropped so a corrupt window cannot
// crash the hook.
function safeWindow(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  return w;
}

// Validate that `windows` is an iterable array of valid window objects. A
// non-array (e.g. object used as a bag by a misbehaving adapter) becomes an
// empty list so `for (const w of windows)` never throws.
function safeWindows(windows) {
  if (!Array.isArray(windows)) return [];
  const out = [];
  for (const w of windows) {
    const sw = safeWindow(w);
    if (sw) out.push(sw);
  }
  return out;
}

// Validate balance: must be an object, and `available` must be defined to
// render. Otherwise omit the balance line.
function safeBalance(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  if (b.available == null) return null;
  return b;
}

function summarize(route, st) {
  const parts = [];
  const balance = safeBalance(st.balance);
  if (balance) parts.push(`balance ${balance.available} ${balance.currency || ''}`);
  for (const w of safeWindows(st.windows)) {
    if (w.limit && w.remaining != null) {
      const pct = w.limit > 0 ? Math.round((w.remaining / w.limit) * 100) : null;
      const label = w.type || 'window';
      parts.push(pct != null ? `${label} ${pct}%` : `${label} ${w.remaining}/${w.limit}`);
    }
  }
  const suffix = parts.length ? ` (${parts.join(', ')})` : '';
  return `view-limits: ${route.id} → ${st.state}${suffix}`;
}

module.exports = { decide, summarize };
