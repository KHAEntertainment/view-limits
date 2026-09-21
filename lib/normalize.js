'use strict';
// Shared normalized status representation. Adapters produce this shape; the gate
// and renderer consume only this — never provider-specific raw fields.

const STATES = ['healthy', 'constrained', 'exhausted', 'unknown'];

// Build a status from provider-specific signals already extracted by the adapter.
function buildStatus({ exhausted = false, constrained = false, unknown = false, windows = [], balance = null, resetAt = null, detail = null }) {
  let state = 'healthy';
  if (exhausted) state = 'exhausted';
  else if (constrained) state = 'constrained';
  else if (unknown) state = 'unknown';
  return {
    state,
    windows,
    balance,
    resetAt: resetAt || earliestReset(windows),
    detail,
  };
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

module.exports = { STATES, buildStatus, window, earliestReset, isConstrained, coerceReset, num };
