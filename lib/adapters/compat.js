'use strict';
// Shared fetch for the two wire-family compat adapters (openai-compat,
// anthropic-compat). A family supplies its fixed auth headers and header
// parser; everything else — option checks, the single read-only GET, and the
// truthful state derivation — lives here so the two families cannot drift.
//
// Source: one explicit GET to route.monitor.endpoint + recipeOptions.path.
// There is no default path, so no silent `GET /models` fallback, and no
// inference request is ever made from refresh/check.
//
// Truthfulness:
//   scope 'diagnostic' (default) → unknown; numbers kept under
//       detail.throughput only. The endpoint's headers are not proven to
//       describe this route's quota pool.
//   declared scope (account/model/organization) → windows tagged
//       signal:'throughput'. Exhausted only when a window has remaining 0 AND
//       a valid future reset is known; remaining 0 without a known recovery
//       stays unknown. balance is always null (throughput is not credit).
//   Any transport failure, 429, auth rejection, malformed/partial/
//   contradictory header → unknown with a stable reason. Never fabricated.

const { buildStatus, isConstrained } = require('../normalize');
const { validateRecipeOptions, resolvedRecipeOptions, httpsEndpointError } = require('../monitor-schema');
const { boundedGet } = require('./http');

// Visible ASCII only: a token with whitespace/control characters could split
// a header line, and is not a credential either family documents.
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;

function unknown(reason, extra = {}) {
  return buildStatus({
    unknown: true,
    windows: [],
    balance: null,
    resetAt: null,
    detail: Object.assign({ reason, monitorable: false }, extra),
  });
}

// endpoint + path, keeping the endpoint's scheme/host/port fixed. null when
// the endpoint is missing, insecure, or carries a query/fragment.
function sourceUrl(endpoint, path) {
  if (httpsEndpointError(endpoint)) return null;
  const u = new URL(endpoint);
  if (u.search || u.hash) return null;
  u.pathname = u.pathname.replace(/\/+$/, '') + path;
  return u.toString();
}

// family: { id, authHeaders(token, opts) → headers | { error }, parse(headers, opts, now) }
async function fetchCompatStatus(family, cfg, token, ctx = {}) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (!c.baseUrl) return unknown('endpoint-required');
  if (httpsEndpointError(c.baseUrl)) return unknown('insecure-endpoint');
  const check = validateRecipeOptions(family.id, c.recipeOptions || {});
  if (!check.ok) return unknown(check.code || 'invalid-recipe-options');
  const opts = resolvedRecipeOptions(family.id, c.recipeOptions);
  const url = sourceUrl(c.baseUrl, opts.path);
  if (!url) return unknown('insecure-endpoint');
  if (token == null || token === '') return unknown('credential-missing');
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return unknown('credential-invalid');

  const auth = family.authHeaders(token, opts);
  if (auth.error) return unknown(auth.error);
  const headers = Object.assign({ Accept: 'application/json' }, auth);

  const now = typeof ctx.now === 'function' ? ctx.now() : Date.now();
  const res = await boundedGet(url, { headers, timeoutMs: opts.timeoutMs });
  const base = { recipe: family.id, scope: opts.scope, signal: 'throughput' };
  if (!res.ok) {
    const extra = Object.assign({}, base, { error: res.error });
    if (res.status != null) extra.httpStatus = res.status;
    // 429 is a throughput rejection on this endpoint, not proof the plan is
    // exhausted; it never sets `exhausted`.
    if (res.error === 'http-429') extra.note = 'rate-limited response is not evidence of plan exhaustion';
    return unknown(res.error, extra);
  }

  const parsed = family.parse(res.headers, opts, now);
  if (parsed.error) return unknown(parsed.error, base);
  const windows = parsed.windows.map((w) => Object.assign({}, w, { signal: 'throughput' }));

  if (opts.scope === 'diagnostic') {
    return unknown('diagnostic-only-throughput', Object.assign({}, base, { throughput: windows }));
  }

  const drained = windows.filter((w) => w.remaining === 0);
  if (drained.length) {
    const resets = drained.map((w) => (w.resetAt ? Date.parse(w.resetAt) : NaN));
    if (resets.some((t) => !Number.isFinite(t) || t <= now)) {
      return unknown('exhaustion-without-recovery', Object.assign({}, base, { throughput: windows }));
    }
    // Recovery is when the LAST drained window resets; a deny-eligible cache
    // entry must expire by then (bin/vl.js entryFor bounds freshUntil).
    const recoveryAt = new Date(Math.max(...resets)).toISOString();
    return buildStatus({
      exhausted: true,
      windows,
      balance: null,
      resetAt: recoveryAt,
      detail: Object.assign({}, base, { monitorable: true, recoveryAt }),
    });
  }
  const threshold = Number.isFinite(ctx.threshold) ? ctx.threshold : 0.2;
  return buildStatus({
    constrained: isConstrained(windows, threshold),
    windows,
    balance: null,
    detail: Object.assign({}, base, { monitorable: true }),
  });
}

module.exports = { fetchCompatStatus, sourceUrl };
