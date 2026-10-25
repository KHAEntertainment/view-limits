'use strict';
// The LAN projection of the daemon's status document (Issue #62 hardening).
//
// Redaction happens HERE, on the server, before serialization: the LAN
// listener never sends the loopback document and hides nothing in the page.
// The projection is an ALLOWLIST. Each field is copied in by name, after a
// type check, so a field added to the status document later stays off the
// LAN until someone adds it here on purpose.
//
// What a LAN viewer gets: labels, states, usage windows, balances, reset
// times, observation times, the fixed reason-code vocabulary and a bare
// "login expired" flag. What it never gets: account, pool, profile, session
// or host identifiers; route ids (replaced by an opaque key); provider ids;
// re-login URLs and profile hints; provider error text; dispatch eligibility;
// the daemon's instance id, host, port or start time; any secret.

const { VIEW_REASON_CODES } = require('../view-model');

const ROUTE_STATES = ['healthy', 'constrained', 'exhausted', 'unknown'];
const DAEMON_STATUSES = ['pending', 'ok', 'stale', 'unavailable'];
const VIEW_STATUSES = ['ok', 'empty', 'pending', 'failed', 'not-configured'];
const FRESHNESS = ['fresh', 'stale', 'unknown'];
const BUILTIN_RECIPES = ['alibaba-coding-plan', 'stepfun-plan'];
const ROUTE_OUTCOMES = ['completed', 'failed', 'pending', 'skipped'];
const ATTEMPT_OUTCOMES = ['completed', 'partial', 'in-progress', 'failed', 'no-credentials', 'not-run', 'timeout', 'error'];

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function str(v, max = 200) { return typeof v === 'string' && v ? v.slice(0, max) : null; }
function iso(v) { return typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null; }
function oneOf(v, list, fallback = null) { return typeof v === 'string' && list.includes(v) ? v : fallback; }
function codes(v) {
  const out = [];
  for (const c of Array.isArray(v) ? v : []) if (typeof c === 'string' && VIEW_REASON_CODES.includes(c) && !out.includes(c)) out.push(c);
  return out;
}

function windowsOf(list) {
  return (Array.isArray(list) ? list : []).filter(isPlainObject).map((w) => ({
    type: str(w.type, 40),
    unit: str(w.unit, 40),
    remaining: num(w.remaining),
    limit: num(w.limit),
    remainingRatio: num(w.remainingRatio),
    resetAt: iso(w.resetAt),
  }));
}

function balanceOf(b) {
  if (!isPlainObject(b) || num(b.amount) === null) return null;
  const s = isPlainObject(b.spent) ? b.spent : null;
  const spent = s ? { daily: num(s.daily), weekly: num(s.weekly), monthly: num(s.monthly) } : null;
  return {
    amount: num(b.amount),
    currency: str(b.currency, 12),
    spent: spent && (spent.daily !== null || spent.weekly !== null || spent.monthly !== null) ? spent : null,
  };
}

function routeOf(r, index) {
  // A recipe is a fixed catalog id for the built-in recipes; any other recipe
  // means a user-defined route, which the page labels "Custom route".
  const recipe = typeof r.recipe === 'string' && r.recipe
    ? (BUILTIN_RECIPES.includes(r.recipe) ? r.recipe : 'custom')
    : null;
  const collection = isPlainObject(r.collection) ? { outcome: oneOf(r.collection.outcome, ROUTE_OUTCOMES, 'failed'), error: null } : null;
  return {
    id: `r${index + 1}`,
    label: str(r.label, 80) || `Route ${index + 1}`,
    provider: null,
    recipe,
    accountId: null,
    poolId: null,
    state: oneOf(r.state, ROUTE_STATES, 'unknown'),
    freshness: oneOf(r.freshness, FRESHNESS, 'unknown'),
    observedAt: iso(r.observedAt),
    windows: windowsOf(r.windows),
    balance: balanceOf(r.balance),
    // A bare flag: the LAN page says "log in again on your Mac" (A2).
    reauth: isPlainObject(r.reauth) ? { required: true, reason: null, url: null, profile: null, reasonCodes: [] } : null,
    quotaEligibility: null,
    reasonCodes: codes(r.reasonCodes),
    error: null,
    collection,
  };
}

function profileOf(p) {
  return {
    identity: null,
    harness: str(p.harness, 40),
    state: oneOf(p.state, ROUTE_STATES, 'unknown'),
    freshness: oneOf(p.freshness, FRESHNESS, 'unknown'),
    observedAt: null,
    windows: windowsOf(p.windows),
    reasonCodes: codes(p.reasonCodes),
  };
}

// The loopback status document → the LAN document. Pure; never throws.
function redactForLan(doc) {
  const d = isPlainObject(doc) ? doc : {};
  const c = isPlainObject(d.collection) ? d.collection : {};
  const a = isPlainObject(c.lastAttempt) ? c.lastAttempt : null;
  const v = isPlainObject(d.view) ? d.view : null;
  return {
    schemaVersion: num(d.schemaVersion),
    status: oneOf(d.status, DAEMON_STATUSES, 'unavailable'),
    daemon: { intervalSeconds: num(isPlainObject(d.daemon) ? d.daemon.intervalSeconds : null) },
    collection: {
      state: c.state === 'collecting' ? 'collecting' : 'idle',
      lastGoodAt: iso(c.lastGoodAt),
      observationAgeSeconds: num(c.observationAgeSeconds),
      stale: c.stale === true,
      // The outcome word only: the attempt's error text is a diagnostic.
      lastAttempt: a ? { outcome: oneOf(a.outcome, ATTEMPT_OUTCOMES, 'error') } : null,
    },
    view: v ? {
      schemaVersion: num(v.schemaVersion),
      generatedAt: iso(v.generatedAt),
      status: oneOf(v.status, VIEW_STATUSES, 'failed'),
      reasonCodes: codes(v.reasonCodes),
      routes: (Array.isArray(v.routes) ? v.routes : []).filter(isPlainObject).map(routeOf),
      profiles: (Array.isArray(v.profiles) ? v.profiles : []).filter(isPlainObject).map(profileOf),
    } : null,
  };
}

module.exports = { redactForLan };
