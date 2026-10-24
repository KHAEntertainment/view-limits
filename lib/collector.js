'use strict';
// Transport-neutral shared live collector (Issue #60).
//
// ONE collection operation, shared by every live surface:
//
//   bin/vl.js refresh   — the manual / SessionStart / gate-spawned refresh
//   bin/vl.js view      — the explicit view (a bounded wait, then a render)
//   (Phase 3-4)         — the dashboard daemon's interval collection
//
// The collector owns the WHOLE live operation and nothing else:
//
//   1. which routes are eligible (config + credential presence),
//   2. the shared refresh-worker ownership (lib/refresh-owner.js),
//   3. the adapter fan-out (ONE Xiaomi session call for every alias),
//   4. the cache entries (the observed facts and their own age),
//   5. the cache publish (lib/cache.js#writeCache).
//
// It is transport-neutral: no Claude hook APIs, no stdin, no stdout, no
// process exit. The CALLER owns the configuration read, the rendering and
// the exit codes. Everything the collector touches is injected, so a test
// can drive it with fixtures and a fake provider — never a live one.
//
// The TRUTHFULNESS rules the collector keeps:
//
//   * A route whose fetch FAILED keeps its PRIOR entry verbatim — the same
//     observedAt, the same freshUntil, the same facts. A failed fetch never
//     writes a fresh timestamp over old facts, so the route's age is the age
//     of the observation it still carries and it ages out on its own clock.
//   * A route with NO prior entry and a failed fetch still publishes the
//     classified unknown status it always published (an unknown state
//     carrying the error), so a first-time failure is visible rather than
//     absent.
//   * A route that was OBSERVED publishes a fresh entry, and its siblings
//     publish independently: one provider's failure never withholds
//     another's observation.
//   * The configRevision is attached ONLY to the routes this round actually
//     observed (lib/cache.js#attachRevisions). A retained entry keeps the
//     revision it was observed under, so the gate's obsolete-config guard
//     still sees it as obsolete after its route's configuration changed.
//   * The cache document's top-level `updatedAt` is a CACHE-level fact. A
//     route's age comes only from that route's own observedAt / freshUntil,
//     never from the document timestamp.

const crypto = require('crypto');
const { readCache, writeCache, recoveryBoundedFreshUntil } = require('./cache');
const { acquireWorker, releaseWorker } = require('./refresh-owner');
const { validateMonitor } = require('./monitor-schema');
const { routeNeedsVaultCredential } = require('./recipes');
const { getAdapter } = require('./adapters');
const vault = require('./vault');
const xiaomiSession = require('./xiaomi-session');

// The collection outcome — the ONE word that says what the operation did.
const OUTCOME = Object.freeze({
  // Every eligible route was observed and the cache was republished.
  COMPLETED: 'completed',
  // The collection ran and published; at least one route FAILED and kept
  // its prior data.
  PARTIAL: 'partial',
  // Another worker owns the collection. This process observed nothing and
  // published nothing.
  IN_PROGRESS: 'in-progress',
  // The collection could not run (the lock errored) or could not publish,
  // or every attempted route failed.
  FAILED: 'failed',
  // No route was eligible: there is nothing to collect.
  NO_CREDENTIALS: 'no-credentials',
});

// The per-route outcome — what happened to ONE route in this round.
const ROUTE_OUTCOME = Object.freeze({
  // Observed and published.
  COMPLETED: 'completed',
  // The fetch failed. The prior entry was kept, unchanged.
  FAILED: 'failed',
  // Not attempted: another worker owns the collection.
  PENDING: 'pending',
  // Not eligible: no credential, an unknown provider, or an unmonitored
  // source. The route is not part of this collection.
  SKIPPED: 'skipped',
});

// The fixed reason codes that classify a collection-level failure. They are
// a closed vocabulary: a provider message never becomes a reason code.
const REASON = Object.freeze({
  LOCK_UNAVAILABLE: 'lock-unavailable',
  PUBLISH_FAILED: 'publish-failed',
  VAULT_UNREADABLE: 'vault-unreadable',
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// One line, no stack: a provider body can carry newlines, and a diagnostic
// must stay one line. The CACHE entry keeps the raw message (the historical
// shape); the diagnostic forms use this.
function oneLine(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

function messageOf(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  return String(e.message || e);
}

// The resolved dependencies. Every external effect is injectable, so the
// collector is unit-testable with fixtures and a fake provider.
function resolveDeps(io) {
  const o = isPlainObject(io) ? io : {};
  return {
    getAdapter: typeof o.getAdapter === 'function' ? o.getAdapter : getAdapter,
    vault: isPlainObject(o.vault) ? o.vault : vault,
    xiaomi: isPlainObject(o.xiaomi) ? o.xiaomi : xiaomiSession,
    acquireWorker: typeof o.acquireWorker === 'function' ? o.acquireWorker : acquireWorker,
    releaseWorker: typeof o.releaseWorker === 'function' ? o.releaseWorker : releaseWorker,
    readCache: typeof o.readCache === 'function' ? o.readCache : readCache,
    writeCache: typeof o.writeCache === 'function' ? o.writeCache : writeCache,
    // A wrapper, not the function itself: a test that overrides the global
    // clock must be picked up.
    now: typeof o.now === 'function' ? o.now : () => Date.now(),
  };
}

// A custom route: a non-null route.monitor that passes schema validation.
function isCustomMonitored(route) {
  if (!route || route.monitor == null) return false;
  return validateMonitor(route).ok;
}

// A route takes part when it has a credential under its id, OR when its recipe
// declares that it authenticates through its own CLI (or documents no quota
// source at all) and holds none for us — keyed on the capability flag, never
// on a recipe id.
function isConfiguredRoute(route, deps) {
  const d = deps && deps.vault ? deps.vault : vault;
  if (!routeNeedsVaultCredential(route)) return true;
  try {
    return d.has(route.id) === true;
  } catch (e) {
    // The credential store could not answer. "Nothing there" and "I could
    // not look" are not the same fact, so this is a failure, never an
    // absence.
    const err = new Error('credential store could not be read');
    err.code = 'VAULT_UNREADABLE';
    err.cause = e;
    throw err;
  }
}

// The classified unknown status a failed fetch publishes when the route has
// no prior entry to keep.
function unknownStatus(detail) {
  return { state: 'unknown', windows: [], balance: null, resetAt: null, detail };
}

// One cache entry for an observed fact: its own observation time and its own
// expiry. A custom route's expiry is bounded by its known recovery (Issue
// #55); a built-in keeps TTL-only freshness.
function entryFor(route, status, source, nowMs) {
  const ttl = route.ttlSeconds != null ? route.ttlSeconds : 180;
  const observedAt = new Date(nowMs).toISOString();
  const freshUntil = new Date(recoveryBoundedFreshUntil(route, status, nowMs + ttl * 1000)).toISOString();
  return { routeId: route.id, observedAt, freshUntil, source, status };
}

// Run the live Xiaomi session ONCE per operation and project that single
// status onto every Xiaomi route alias (F4: one Chrome read + at most one
// usage/detail pair, no matter how many aliases are configured). The session
// never throws by contract; a defensive catch still yields a classified
// unknown so a collection can never fall back to cached counts.
async function xiaomiLiveStatuses(cfg, sessionCtx = {}, deps = {}) {
  const d = deps && isPlainObject(deps.xiaomi) ? deps.xiaomi : xiaomiSession;
  const statusById = {};
  const routes = (Array.isArray(cfg && cfg.routes) ? cfg.routes : []).filter(d.isXiaomiRoute);
  if (!routes.length) return { statusById, failed: false };
  let status;
  let failed = false;
  try {
    status = await d.fetchStatus(cfg, routes[0], sessionCtx);
  } catch {
    status = d.errorStatus(d.DEFAULT_ERROR);
    failed = true;
  }
  for (const route of routes) statusById[route.id] = status;
  return { statusById, failed };
}

// The eligible routes, in configuration order, plus the per-route outcome
// seed for EVERY configured route (the ineligible ones are 'skipped').
function planRoutes(cfg, deps) {
  const routes = Array.isArray(cfg && cfg.routes) ? cfg.routes : [];
  const eligible = [];
  const states = [];
  const routeById = new Map();
  for (const route of routes) {
    if (!isPlainObject(route) || typeof route.id !== 'string' || !route.id) continue;
    routeById.set(route.id, route);
    const state = { id: route.id, outcome: ROUTE_OUTCOME.SKIPPED, error: null, retained: false };
    states.push(state);
    // Xiaomi eligibility is config-only (route presence) — no vault read.
    if (deps.xiaomi.isXiaomiRoute(route)) { eligible.push(route); continue; }
    // A route whose provider is unknown and which carries no valid monitor
    // has no source to read.
    const known = (cfg.providers && cfg.providers[route.provider]) || isCustomMonitored(route);
    if (!known) continue;
    try {
      if (!isConfiguredRoute(route, deps)) continue;
    } catch (e) {
      // The credential store could not be read: this route's eligibility is
      // unproven, so it is a failure, never a silent skip — and it is NOT
      // attempted, because a route whose credential could not be read has
      // no credential to fetch with.
      state.outcome = ROUTE_OUTCOME.FAILED;
      state.error = oneLine(messageOf(e));
      state.reason = REASON.VAULT_UNREADABLE;
      continue;
    }
    // Eligible: the route takes part in this collection. Until the fetch
    // resolves it is PENDING — that is what a loser sees, and what a route
    // whose collection has not run yet is.
    state.outcome = ROUTE_OUTCOME.PENDING;
    eligible.push(route);
  }
  return { eligible, states, routeById };
}

function stateOf(states, id) {
  return states.find((s) => s.id === id) || null;
}

// The collection result. It is ALWAYS a valid object: a caller can read
// `outcome` and `routes` without checking anything else.
function result(partial) {
  return Object.assign({
    outcome: OUTCOME.FAILED,
    reason: null,
    error: null,
    published: false,
    routes: [],
    statuses: {},
    entries: {},
    cache: null,
  }, partial || {});
}

// Collect once.
//
// `cfg` is the CONFIRMED configuration (the caller reads it and owns the
// refusal semantics). `io` injects every external effect.
//
// The returned `outcome` is one of OUTCOME; `routes` carries one per-route
// outcome in configuration order.
async function collect({ cfg, io = {} } = {}) {
  const deps = resolveDeps(io);
  const { eligible, states, routeById } = planRoutes(cfg, deps);

  // Nothing to collect: no route is eligible. No lock is taken and nothing
  // is published — there is no observation to publish.
  if (!eligible.length) {
    const vaultFailure = states.find((s) => s.reason === REASON.VAULT_UNREADABLE);
    if (vaultFailure) {
      return result({
        outcome: OUTCOME.FAILED,
        reason: REASON.VAULT_UNREADABLE,
        error: vaultFailure.error,
        routes: states.map((s) => ({ id: s.id, outcome: s.outcome, error: s.error, retained: s.retained === true })),
      });
    }
    return result({
      outcome: OUTCOME.NO_CREDENTIALS,
      routes: states.map((s) => ({ id: s.id, outcome: s.outcome, error: s.error, retained: s.retained === true })),
    });
  }

  // Shared refresh worker ownership: a manual refresh, the SessionStart
  // refresh, a gate-spawned refresh and the view's collection all converge
  // on this lock. Only one worker performs provider calls; the loser
  // observes nothing and publishes nothing.
  const ownerToken = crypto.randomBytes(16).toString('hex');
  const acq = await deps.acquireWorker({ ownerToken });
  if (!acq || !acq.acquired) {
    const reason = (acq && acq.reason) || 'lock-unavailable';
    const inProgress = reason === 'in-progress';
    for (const s of states) {
      if (s.outcome !== ROUTE_OUTCOME.SKIPPED) {
        s.outcome = inProgress ? ROUTE_OUTCOME.PENDING : ROUTE_OUTCOME.FAILED;
        if (!s.error) s.error = inProgress ? null : oneLine(acq && acq.error ? acq.error : reason);
      }
    }
    return result({
      outcome: inProgress ? OUTCOME.IN_PROGRESS : OUTCOME.FAILED,
      reason: inProgress ? null : REASON.LOCK_UNAVAILABLE,
      error: inProgress ? null : oneLine(acq && acq.error ? acq.error : reason),
      routes: states.map((s) => ({ id: s.id, outcome: s.outcome, error: s.error, retained: s.retained === true })),
    });
  }

  try {
    const threshold = cfg.gate && typeof cfg.gate.constrainedThreshold === 'number'
      ? cfg.gate.constrainedThreshold : 0.2;
    const observed = new Map();
    const failures = new Map();

    // F4: exactly ONE Xiaomi session call for the whole collection — one
    // Chrome read + at most one usage/detail pair, projected to every
    // Xiaomi alias. The other providers keep independent parallel fetches.
    const xiaomiPromise = xiaomiLiveStatuses(cfg, { threshold }, deps);
    await Promise.all([
      xiaomiPromise,
      ...eligible
        .filter((route) => !deps.xiaomi.isXiaomiRoute(route))
        .map(async (route) => {
          try {
            // Credential-free recipes (vaultCredential:false) never read the
            // vault — the adapter receives null instead of triggering a
            // keychain lookup for a secret that cannot exist.
            const routeToken = routeNeedsVaultCredential(route) ? deps.vault.get(route.id) : null;
            observed.set(route.id, await deps.getAdapter(route.provider, route, cfg)
              .fetchStatus(cfg.providers[route.provider], routeToken, { threshold }));
          } catch (e) {
            failures.set(route.id, messageOf(e));
          }
        }),
    ]);
    const xiaomi = await xiaomiPromise;
    for (const [id, status] of Object.entries(xiaomi.statusById)) observed.set(id, status);

    // The prior cache is read ONCE, before the publish: it is the source of
    // the entries a failed route keeps.
    const prior = deps.readCache();
    const priorRoutes = isPlainObject(prior) && isPlainObject(prior.routes) ? prior.routes : {};

    // Pass 1 — resolve the outcome of every ELIGIBLE route. A planning
    // failure (a credential store that could not be read) is already
    // 'failed' and is NOT eligible: it was never attempted.
    for (const route of eligible) {
      const id = route.id;
      const state = stateOf(states, id);
      if (!state) continue;
      if (failures.has(id)) {
        state.outcome = ROUTE_OUTCOME.FAILED;
        state.error = oneLine(failures.get(id));
        continue;
      }
      if (xiaomi.failed && deps.xiaomi.isXiaomiRoute(route)) {
        // The Xiaomi session threw. Its contract says it never does, so this
        // is the unexpected path: the prior fact is kept, not replaced.
        failures.set(id, deps.xiaomi.DEFAULT_ERROR || xiaomiSession.DEFAULT_ERROR);
        state.outcome = ROUTE_OUTCOME.FAILED;
        state.error = oneLine(failures.get(id));
        continue;
      }
      if (!observed.has(id)) {
        // The provider returned nothing observable. Treat it as a failure so
        // the prior fact is kept rather than replaced by an empty one.
        failures.set(id, 'provider returned no status');
        state.outcome = ROUTE_OUTCOME.FAILED;
        state.error = 'provider returned no status';
        continue;
      }
      state.outcome = ROUTE_OUTCOME.COMPLETED;
      state.error = null;
    }

    // Pass 2 — the entries. EVERY route that took part in the collection, or
    // that failed, gets an entry: a route that FAILED keeps its PRIOR entry
    // verbatim, wherever the failure happened (planning or fetch). A
    // sibling's success can therefore never DROP a route's facts — the
    // prior cache is the floor, not the previous publish.
    //
    // A SKIPPED route — still configured, but not eligible this round (no
    // credential: a lenient vault reports a corrupt encrypted credential as
    // absent rather than throwing) — also keeps its PRIOR entry verbatim
    // when it has one. Only a route that is no longer configured disappears.
    const entries = {};
    const fetched = [];
    for (const state of states) {
      const route = routeById.get(state.id);
      if (!route) continue;
      const id = state.id;
      if (state.outcome === ROUTE_OUTCOME.COMPLETED) {
        entries[id] = entryFor(route, observed.get(id), route.provider, deps.now());
        fetched.push(route);
        continue;
      }
      if (state.outcome === ROUTE_OUTCOME.SKIPPED) {
        // Not observed this round. If there is a prior fact, it survives
        // verbatim; there is nothing new to publish for a route that was
        // not attempted.
        const old = priorRoutes[id];
        if (isPlainObject(old)) {
          entries[id] = old;
          state.retained = true;
        }
        continue;
      }
      // FAILED. The prior entry, VERBATIM: the same observedAt, the same
      // freshUntil, the same facts, the same configRevision. A failed fetch
      // never writes a fresh timestamp over old facts.
      const old = priorRoutes[id];
      if (isPlainObject(old)) {
        entries[id] = old;
        state.retained = true;
      } else {
        // No prior fact to keep: publish the classified unknown status, as
        // before, so the failure is visible rather than absent.
        const message = failures.get(id) || state.error || 'collection failed';
        entries[id] = entryFor(route, unknownStatus({ error: message }), route.provider, deps.now());
        state.retained = false;
      }
    }

    // The publish. ONLY the routes observed in this round carry a
    // configRevision: a retained entry keeps the revision it was observed
    // under, so the gate's obsolete-config guard still sees it as obsolete
    // after its route's configuration changed.
    let doc;
    try {
      doc = deps.writeCache(entries, { routes: fetched });
    } catch (e) {
      return result({
        outcome: OUTCOME.FAILED,
        reason: REASON.PUBLISH_FAILED,
        error: oneLine(messageOf(e)),
        routes: states.map((s) => ({ id: s.id, outcome: s.outcome, error: s.error, retained: s.retained === true })),
        statuses: Object.fromEntries(observed),
      });
    }

    const failedCount = states.filter((s) => s.outcome === ROUTE_OUTCOME.FAILED).length;
    const observedCount = states.filter((s) => s.outcome === ROUTE_OUTCOME.COMPLETED).length;
    let outcome = OUTCOME.COMPLETED;
    if (failedCount > 0) outcome = observedCount > 0 ? OUTCOME.PARTIAL : OUTCOME.FAILED;
    return result({
      outcome,
      published: true,
      routes: states.map((s) => ({ id: s.id, outcome: s.outcome, error: s.error, retained: s.retained === true })),
      statuses: Object.fromEntries(observed),
      entries,
      cache: isPlainObject(doc) ? doc : null,
    });
  } finally {
    deps.releaseWorker(acq);
  }
}

module.exports = {
  OUTCOME,
  ROUTE_OUTCOME,
  REASON,
  collect,
  entryFor,
  unknownStatus,
  isConfiguredRoute,
  isCustomMonitored,
  oneLine,
  xiaomiLiveStatuses,
};
