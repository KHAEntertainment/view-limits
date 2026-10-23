'use strict';
// Shared normalized status representation. Adapters produce this shape; the gate
// and renderer consume only this — never provider-specific raw fields.

const STATES = ['healthy', 'constrained', 'exhausted', 'unknown'];

// What measurement a status's numbers came from. `token-count` is a plan's
// remaining token counts (Xiaomi console); `quota-window` is a rolling /
// weekly / monthly quota window; `balance` is account credit; `none` means no
// measurement evidence is present. This label is diagnostic only — it never
// changes the state or the gate decision.
const BASES = ['quota-window', 'token-count', 'balance', 'none'];

// Build a status from provider-specific signals already extracted by the adapter.
function buildStatus({ exhausted = false, constrained = false, unknown = false, windows = [], balance = null, resetAt = null, detail = null, basis = null }) {
  let state = 'healthy';
  if (exhausted) state = 'exhausted';
  else if (constrained) state = 'constrained';
  else if (unknown) state = 'unknown';
  const out = {
    state,
    windows,
    balance,
    resetAt: resetAt || earliestReset(windows),
    detail,
  };
  // Additive: only statuses that declare a basis carry the field, so every
  // existing adapter's JSON stays byte-identical.
  if (BASES.includes(basis)) out.basis = basis;
  return out;
}

// The basis label for any status: an explicit adapter-declared basis wins;
// otherwise derive it from the evidence the status carries. Pure and total —
// malformed input yields `none` rather than throwing.
function basisOf(status) {
  const st = status && typeof status === 'object' && !Array.isArray(status) ? status : {};
  if (BASES.includes(st.basis)) return st.basis;
  // [#80 fix] A basis claims a measurement, so it requires usable numeric
  // evidence — malformed objects (missing/null/NaN counts, non-numeric
  // balance) must never yield a non-`none` basis. A finite numeric balance
  // is evidence; a window is evidence only when both remaining and limit are
  // finite numbers (limit > 0).
  const balance = st.balance;
  if (balance && typeof balance === 'object' && !Array.isArray(balance)) {
    const available = num(balance.available);
    if (Number.isFinite(available)) return 'balance';
  }
  const windows = Array.isArray(st.windows)
    ? st.windows.filter((w) => w && typeof w === 'object' && !Array.isArray(w))
    : [];
  const measured = windows.filter((w) => {
    const remaining = num(w.remaining);
    const limit = num(w.limit);
    return Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0;
  });
  if (measured.length) {
    return measured.every((w) => w.type === 'tokens') ? 'token-count' : 'quota-window';
  }
  return 'none';
}

// A window of quota: type ∈ rolling-5h | weekly | monthly | credit | concurrency.
function window(type, remaining, limit, resetAt = null) {
  return { type, remaining, limit, resetAt };
}

// Earliest reset across windows, as an ISO string or null.
function earliestReset(windows) {
  let earliest = null;
  for (const w of windows || []) {
    if (!w.resetAt) continue;
    const t = new Date(w.resetAt).getTime();
    if (!Number.isFinite(t)) continue;
    if (earliest === null || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

// Mark a route constrained when any window is below the configured fraction.
function isConstrained(windows, threshold) {
  return (windows || []).some((w) => {
    if (w.limit == null || w.remaining == null || w.limit <= 0) return false;
    return w.remaining / w.limit < threshold;
  });
}

// Coerce a provider reset value (ISO string, epoch seconds, or epoch millis)
// into an ISO-8601 string, or null.
function coerceReset(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n) && String(v).trim() !== '') {
    const ms = n < 1e12 ? n * 1000 : n;
    const t = new Date(ms).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Numeric parser for provider numbers or complete decimal strings. Callers
// still validate finiteness before treating the result as evidence.
function num(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string' || v.trim() === '') return NaN;
  const text = v.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return NaN;
  return Number(text);
}

module.exports = { STATES, BASES, buildStatus, basisOf, window, earliestReset, isConstrained, coerceReset, num };
