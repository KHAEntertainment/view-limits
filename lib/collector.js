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
const { getRuntimeSnapshot } = require('./runtime-snapshot');
const traycerAdapter = require('./traycer-adapter');

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
  NATIVE_UNAVAILABLE: 'native-unavailable',
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
    // The bounded native observation: the same live path `snapshot --refresh`
    // uses (lib/runtime-snapshot.js#getRuntimeSnapshot with refresh: true).
    // It stays injectable, so the collector's tests are hermetic.
    getRuntimeSnapshot: typeof o.getRuntimeSnapshot === 'function' ? o.getRuntimeSnapshot : getRuntimeSnapshot,
    callerContext: o.callerContext || null,
    liveReads: Array.isArray(o.liveReads) ? o.liveReads : undefined,
    readTraycer: typeof o.readTraycer === 'function' ? o.readTraycer : undefined,
    traycerRun: typeof o.traycerRun === 'function' ? o.traycerRun : undefined,
    env: o.env || undefined,
    readStatus: typeof o.readStatus === 'function' ? o.readStatus : undefined,
    readConfig: typeof o.readConfig === 'function' ? o.readConfig : undefined,
    readSidecar: typeof o.readSidecar === 'function' ? o.readSidecar : undefined,
    // Optional: build the readStatus the native snapshot uses from the
    // external statuses (the view projects live Xiaomi statuses display-only
    // — round-2 R2-2).
    readStatusFor: typeof o.readStatusFor === 'function' ? o.readStatusFor : undefined,
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
    // Like every eligible route it is PENDING until the fetch resolves (pass
    // 1 always resolves it), so a collection that loses the lock reports it
    // pending rather than skipped.
    if (deps.xiaomi.isXiaomiRoute(route)) {
      state.outcome = ROUTE_OUTCOME.PENDING;
      eligible.push(route);
      continue;
    }
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
    // Issue #60 (B3): the bounded native observation this collection ran, and
    // its outcome. null when no native observation was attempted (the lock
    // was lost, or the collection failed before it ran).
    snapshot: null,
    native: null,
  }, partial || {});
}

// The bounded native observation. It is the SAME live path `snapshot --refresh`
// uses: lib/runtime-snapshot.js#getRuntimeSnapshot with refresh: true. It
// never throws by contract; a defensive catch still yields a classified
// failure so a native source can never take a collection down.
//
// "Observed" is decided from what THIS run's live sources returned, never
// from the merged snapshot: the snapshot also carries cached sidecar rows
// (mergeSectionRows returns the sidecar base unchanged when the live rows are
// empty), and a cached row is not an observation made now (CR5). Section
// rows have no per-row provenance and the sidecar keeps whatever `source` its
// writer stored, so live and cached rows cannot be told apart in the merged
// document; the rows are recorded at the source boundary instead.

// The io members through which getRuntimeSnapshot({refresh:true}) takes its
// live sources — see collectLiveSources in lib/runtime-snapshot.js. EVERY
// default live source must be wrapped here; test/collector.test.js pins this
// list against that function so a new source cannot slip past unnoticed.
const LIVE_SOURCE_IO_MEMBERS = Object.freeze(['liveReads', 'readTraycer']);

const LIVE_SECTIONS = Object.freeze(['sessions', 'harnesses', 'profiles']);

// Wrap one live read so a SUCCESSFUL return records its rows. The wrapper is
// transparent: it forwards `this` and the arguments, returns the very same
// value, and lets a throw or rejection propagate untouched, so
// runtime-snapshot still produces its own diagnostics (R2-1 classification is
// unaffected). A failed source records nothing.
function recordingRead(read, rows) {
  return async function recordedLiveRead(...args) {
    const out = await read.apply(this, args);
    if (isPlainObject(out)) {
      for (const section of LIVE_SECTIONS) {
        if (Array.isArray(out[section])) {
          for (const row of out[section]) if (isPlainObject(row)) rows.push(row);
        }
      }
    }
    return out;
  };
}

// Wrap every live source `getRuntimeSnapshot` would run. Source keys and
// coalescing are preserved: an injected entry keeps all of its own fields
// (its `key` is carried over explicitly), entries the service ignores are passed through
// as they are (so positional default keys do not move), and one wrapper is
// minted per distinct read FUNCTION — two entries sharing a function still
// share one, so the service's same-function dedupe still runs it once. The
// default Traycer source stays one source under the same key: its read is
// resolved the way the service resolves it and handed over as `readTraycer`.
function recordLiveSources(extraIo, rows) {
  const wrappers = new Map();
  const wrap = (read) => {
    if (!wrappers.has(read)) wrappers.set(read, recordingRead(read, rows));
    return wrappers.get(read);
  };
  const io = Object.assign({}, extraIo);
  if (Array.isArray(extraIo.liveReads)) {
    io.liveReads = extraIo.liveReads.map((s) => {
      if (!isPlainObject(s) || typeof s.read !== 'function') return s;
      // A spread copies own ENUMERABLE properties only, but the service reads
      // `s.key` directly — a non-enumerable or inherited key must survive the
      // clone, or the source would run under a positional key and the default
      // Traycer source (suppressed by a `traycer` key) would run beside it.
      const entry = { ...s, read: wrap(s.read) };
      if (s.key !== undefined) entry.key = s.key;
      return entry;
    });
  }
  const baseTraycer = typeof extraIo.readTraycer === 'function'
    ? extraIo.readTraycer
    : traycerAdapter.readTraycerRuntime;
  io.readTraycer = wrap(baseTraycer);
  return io;
}

async function observeNative(deps, extraIo) {
  const rows = [];
  const io = recordLiveSources(extraIo, rows);
  try {
    const snap = await deps.getRuntimeSnapshot({
      refresh: true,
      callerContext: deps.callerContext || null,
      now: deps.now,
      io,
    });
    // `observed`: this run's live sources returned at least one row. A caller
    // that injects its own `getRuntimeSnapshot` and never runs a live source
    // observes nothing here, so it classifies `unknown`.
    return { snap: isPlainObject(snap) ? snap : null, error: null, observed: rows.length > 0 };
  } catch (e) {
    return { snap: null, error: oneLine(messageOf(e)), observed: false };
  }
}

// The diagnostic codes that mean a native SOURCE was present but the read
// failed. A missing CLI is NOT in this set: it is a plain `unavailable`, not
// a failure (round-2 R2-1).
const NATIVE_FAILURE_CODES = Object.freeze([
  'traycer-read-failed',
  'traycer-read-timeout',
  'traycer-output-malformed',
  'live-source-failed',
  'live-source-malformed',
]);

// Classify the native observation from the snapshot the runtime snapshot
// service RETURNED (diagnostics) and `observed` (whether this run's live
// sources returned rows — see observeNative). The real service never throws for a source failure: it
// catches the source and returns diagnostics (e.g. `traycer-read-failed`,
// `traycer-cli-missing`). The classification is the closed list mapping:
//
//   * any failure code            -> failed   (the source was present but the
//                                             read failed)
//   * `traycer-cli-missing`       -> unavailable (no CLI installed — NOT a
//                                             failure)
//   * rows returned by THIS run's live sources -> completed (cached sidecar
//                                             rows never count — CR5)
//   * nothing observed, no failure -> unknown  (e.g. missing launch identity)
//
// Returns { outcome, codes, error }.
function classifyNative(snap, observed) {
  if (!isPlainObject(snap)) {
    return { outcome: 'failed', codes: ['native-unavailable'], error: 'native observation unavailable' };
  }
  const diags = Array.isArray(snap.diagnostics) ? snap.diagnostics : [];
  const codes = [];
  for (const d of diags) {
    if (d && typeof d.code === 'string' && !codes.includes(d.code)) codes.push(d.code);
  }
  const failures = codes.filter((c) => NATIVE_FAILURE_CODES.includes(c));
  if (failures.length) {
    return { outcome: 'failed', codes: failures, error: failures.join(', ') };
  }
  if (codes.includes('traycer-cli-missing')) {
    return { outcome: 'unavailable', codes: ['traycer-cli-missing'], error: null };
  }
  if (observed === true) {
    return { outcome: 'completed', codes: [], error: null };
  }
  return { outcome: 'unknown', codes: [], error: null };
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

  // Nothing external to collect: no route is eligible. No lock is taken and
  // nothing is published — there is no external observation to publish. The
  // bounded NATIVE observation is NOT part of `collect` (round-2 R2-3): it
  // lives in `collectView`, where the full view runs it outside the worker
  // lock. Refresh therefore stays external-only and byte-identical to
  // 090ef14, including native-only setups.
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

// The FULL view collection (round-2 R2-1/R2-2/R2-3): the external collection,
// then the bounded NATIVE observation OUTSIDE the worker lock.
//
// `collect` owns the external collection exactly as refresh uses it — under
// the worker lock, publishing the cache — and stays byte-identical for
// refresh. The native observation is a read-only live path (the same one
// `snapshot --refresh` uses); it never acquires the worker lock and never
// writes, so holding it outside the lock cannot lengthen any refresh.
//
// The outcome rules:
//   * native failed + external no-credentials -> failed (native-only failure;
//     nonzero exit), disclosed with the diagnostic codes — UNLESS the
//     configuration has NO routes at all (Issue #133): then it stays
//     no-credentials, because there is nothing to collect and a native
//     failure has nothing to invalidate. The native failure is still
//     disclosed, beside an outcome that is not itself a failure (R2-1).
//   * native completed + external no-credentials -> completed (native-only
//     success; nothing published)
//   * native unavailable/unknown + external no-credentials -> no-credentials
//     (exactly as before B3)
//   * native failed + external completed -> partial (the native failure is
//     disclosed beside the external success)
//   * otherwise the external outcome stands
//
// `io.readStatusFor(external)` is optional: when supplied, the native
// snapshot is assembled with it, so a caller (the view) can project live
// Xiaomi statuses display-only (R2-2) while the gate keeps the raw zero-TTL
// cache. It receives the WHOLE external result, not just its statuses: on a
// lock outcome (in-progress, lock-unavailable) `statuses` is empty and the
// caller decides what to show instead (CR4).
async function collectView({ cfg, io = {} } = {}) {
  const deps = resolveDeps(io);
  const external = await collect({ cfg, io });

  const nativeIo = {
    readConfig: deps.readConfig,
    readStatus: deps.readStatus,
    readSidecar: deps.readSidecar,
    liveReads: deps.liveReads,
    readTraycer: deps.readTraycer,
    traycerRun: deps.traycerRun,
    env: deps.env,
  };
  if (typeof deps.readStatusFor === 'function') {
    // LAZY (F1): the display-only Xiaomi projection must be built when the
    // status reader actually runs — i.e. AFTER the native await, when
    // getRuntimeSnapshot assembles the snapshot — not now. Evaluated
    // eagerly, the display entry's one-second lifetime would start before
    // the native read and expire before rendering when the native read is
    // slow. The gate cache stays the raw zero-TTL entry either way.
    const readStatusFor = deps.readStatusFor;
    nativeIo.readStatus = (dir) => readStatusFor(external)(dir);
  }
  const native = await observeNative(deps, nativeIo);
  const verdict = classifyNative(native.snap, native.observed);

  // Issue #133 (Q27-A): "route-less" is LITERALLY zero configured routes —
  // `planRoutes` seeds a per-route outcome for every configured route
  // (including the skipped ones), so an empty list means the configuration
  // itself is empty, not that every route was skipped. A configuration whose
  // routes are merely unmonitorable keeps the native-only failure rule below.
  const routeLess = !Array.isArray(external.routes) || external.routes.length === 0;

  let outcome = external.outcome;
  let reason = external.reason;
  let error = external.error;
  if (external.outcome === OUTCOME.NO_CREDENTIALS) {
    if (verdict.outcome === 'failed' && !routeLess) {
      outcome = OUTCOME.FAILED;
      reason = REASON.NATIVE_UNAVAILABLE;
      error = verdict.error;
    } else if (verdict.outcome === 'completed') {
      outcome = OUTCOME.COMPLETED;
    }
  } else if (external.outcome === OUTCOME.COMPLETED && verdict.outcome === 'failed') {
    outcome = OUTCOME.PARTIAL;
  }

  return result({
    outcome,
    reason,
    error,
    published: external.published,
    routes: external.routes,
    statuses: external.statuses,
    entries: external.entries,
    cache: external.cache,
    snapshot: native.snap,
    native: {
      outcome: verdict.outcome,
      codes: verdict.codes,
      error: verdict.error,
    },
  });
}

module.exports = {
  OUTCOME,
  ROUTE_OUTCOME,
  REASON,
  collect,
  collectView,
  classifyNative,
  LIVE_SOURCE_IO_MEMBERS,
  entryFor,
  unknownStatus,
  isConfiguredRoute,
  isCustomMonitored,
  oneLine,
  xiaomiLiveStatuses,
};
