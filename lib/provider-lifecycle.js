'use strict';
// Shared custom-provider lifecycle: id allocation, validation, probe, and the
// recoverable persistence of route config / vault credential / cache row
// (Issue #58). One service so the CLI today and a dashboard later cannot drift
// into two different definitions of "add a provider".
//
// Transport-neutral: every side effect arrives through the injected `io`
// object, so the whole decision surface is unit-testable without a filesystem,
// a vault or a provider. The only direct I/O in this module is the mutation
// lock (fs, O_EXCL) — it has no meaning as a pure value and is injected into
// the operations through `io.lock` anyway.
//
// Invariants this module enforces:
//   * validate → probe → persist, in that order. A failed probe persists
//     NOTHING, so an existing working route is never disturbed by a new one.
//   * A non-monitorable probe outcome REQUIRES an explicit retention choice.
//     There is no default and no prompt: headless callers get a stable status
//     and a stable exit code instead of a hang.
//   * Persistence order is vault → config → cache, each stage reported
//     separately. A config failure rolls the credential back; a cache failure
//     is a warning the next refresh self-heals.
//   * Removal clears only state view-limits owns (route entry, vault key,
//     cache row). It never runs a subprocess and never touches another CLI's
//     session — there is no native logout anywhere on this path.

const fs = require('fs');
const path = require('path');
const {
  validateLabel, validateMonitor, configRevision, classifyCapability, isConfigObsolete,
} = require('./monitor-schema');
const { getRecipe, knownRecipes, routeNeedsVaultCredential } = require('./recipes');
const { getOptionSpec } = require('./recipes/option-specs');

// Stable machine-readable outcome of a lifecycle operation. These strings are
// part of the headless contract: they are matched by callers and mapped to
// exit codes below, so they are additive-only — never renamed.
const STATUS = Object.freeze({
  OK: 'ok',
  CACHE_STALE_WARNING: 'cache-stale-warning',
  RETENTION_CHOICE_REQUIRED: 'retention-choice-required',
  ID_COLLISION: 'id-collision',
  INVALID_ROUTE: 'invalid-route',
  UNSUPPORTED_RECIPE: 'unsupported-recipe',
  VAULT_UNAVAILABLE: 'vault-unavailable',
  PERSIST_FAILED: 'persist-failed',
  LOCK_BUSY: 'lock-busy',
  NOT_FOUND: 'not-found',
});

// What the read-only probe established about the route.
//
//   monitored    a real capacity state (healthy / constrained / exhausted).
//   unmonitored  the recipe itself declares no quota source (capability says
//                monitorable:false) — truthful, not a failure.
//   no-signal    the source answered but reported no usable state (e.g. a
//                diagnostic-scope compat endpoint, or an actionable unknown).
//   failed       the probe threw or returned nothing at all.
//
// Only `monitored` persists without an explicit retention choice. The other
// three are the design's "nothing to monitor" branch and are reported with the
// adapter's own stable reason, never a free-form message.
const PROBE_OUTCOME = Object.freeze({
  MONITORED: 'monitored',
  UNMONITORED: 'unmonitored',
  NO_SIGNAL: 'no-signal',
  FAILED: 'failed',
});

// Explicit retention choice for a non-monitorable outcome. No default: absence
// is its own answer (`retention-choice-required`).
const RETENTION = Object.freeze({
  KEEP: 'keep-unmonitored',
  CLEAR: 'clear-credential',
});

// Status → process exit code. `1` stays reserved for bad arguments (the
// existing CLI contract), so every lifecycle classification gets its own code
// and a script can branch without parsing text.
const EXIT_CODES = Object.freeze({
  [STATUS.OK]: 0,
  [STATUS.CACHE_STALE_WARNING]: 0,
  [STATUS.RETENTION_CHOICE_REQUIRED]: 2,
  [STATUS.ID_COLLISION]: 3,
  [STATUS.INVALID_ROUTE]: 4,
  [STATUS.UNSUPPORTED_RECIPE]: 4,
  [STATUS.VAULT_UNAVAILABLE]: 5,
  [STATUS.PERSIST_FAILED]: 5,
  [STATUS.LOCK_BUSY]: 6,
  [STATUS.NOT_FOUND]: 7,
});

function exitCodeFor(status) {
  return Object.prototype.hasOwnProperty.call(EXIT_CODES, status) ? EXIT_CODES[status] : 1;
}

const LOCK_FILE = 'provider-lifecycle.lock';
const LOCK_STALE_MS = 30 * 1000;

const ID_PREFIX = 'custom-';
const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;
const MAX_TTL_SECONDS = 86400;

// Route-level fields a lifecycle write may set. `retention` is deliberately
// route-level and NOT a `route.monitor` field: ALLOWED_MONITOR_FIELDS is a
// frozen allow-list, and `normalizedMonitor` feeds configRevision — a flag
// about what the user chose to keep has nothing to do with how the quota
// source is read, so it must not change the revision hash.
const MUTABLE_MONITOR_FIELDS = ['endpoint', 'model', 'account', 'profile', 'region', 'recipeOptions'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function fail(status, error, extra) {
  return Object.assign({ ok: false, status, error }, extra || {});
}

// ---- mutation lock -----------------------------------------------------------
//
// Serializes lifecycle mutations so two concurrent `provider` commands cannot
// interleave a read-modify-write of config.json (and so a future collector can
// trust that a published revision belongs to a complete mutation). Exclusive
// create, with a single stale takeover for a holder that died mid-write.

function acquireMutationLock(dir, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now() : Date.now();
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : LOCK_STALE_MS;
  const lockPath = path.join(dir, LOCK_FILE);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the open below reports it */ }
  // Two attempts at most: acquire, or take over exactly one stale lock.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }) + '\n');
      } finally {
        fs.closeSync(fd);
      }
      return {
        ok: true,
        path: lockPath,
        release() { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } },
      };
    } catch (e) {
      const code = e && e.code;
      if (code !== 'EEXIST') return { ok: false, error: code || 'lock-unavailable' };
      let age = Infinity;
      try { age = now - fs.statSync(lockPath).mtimeMs; } catch { age = Infinity; }
      if (Number.isFinite(age) && age < staleMs) return { ok: false, error: 'held' };
      try { fs.unlinkSync(lockPath); } catch { return { ok: false, error: 'held' }; }
    }
  }
  return { ok: false, error: 'held' };
}

// ---- identity ----------------------------------------------------------------

// `custom-<slug>` from a validated explicit label. A colliding id is REFUSED,
// never overwritten: the caller picks another label or removes the existing
// route first.
function allocateRouteId(label, existingIds) {
  const v = validateLabel(label);
  if (!v.ok) return fail(STATUS.INVALID_ROUTE, `label: ${v.error}`);
  const id = ID_PREFIX + v.slug;
  const ids = existingIds instanceof Set
    ? existingIds
    : new Set(Array.isArray(existingIds) ? existingIds : []);
  if (ids.has(id)) {
    return fail(STATUS.ID_COLLISION,
      `route "${id}" already exists — choose another label or remove the existing route first`, { id });
  }
  return { ok: true, status: STATUS.OK, id, slug: v.slug };
}

// ---- draft construction ------------------------------------------------------

// Build and validate a route from lifecycle inputs. Returns the route exactly
// as it will be persisted, so what is probed is what is written.
function buildRouteDraft(input) {
  if (!isPlainObject(input)) return fail(STATUS.INVALID_ROUTE, 'input must be an object');
  if (!nonEmptyString(input.id)) return fail(STATUS.INVALID_ROUTE, 'route id is required');
  const recipeId = input.recipe;
  if (!nonEmptyString(recipeId)) {
    return fail(STATUS.INVALID_ROUTE, 'a custom route requires an explicit monitor recipe');
  }
  const recipe = getRecipe(recipeId);
  if (!recipe) {
    return fail(STATUS.UNSUPPORTED_RECIPE,
      `unknown recipe "${recipeId}" (known: ${Array.from(knownRecipes()).sort().join(', ')})`);
  }
  // A wire-family recipe fixes route.provider: resolveEffectiveConfig refuses a
  // mismatch (`recipe-family-mismatch`), so default it here rather than let the
  // user discover the constraint at probe time.
  const provider = nonEmptyString(input.provider) ? input.provider.trim() : recipe.family;
  if (!nonEmptyString(provider)) {
    return fail(STATUS.INVALID_ROUTE, `recipe "${recipeId}" has no fixed wire family — a provider is required`);
  }
  if (!PROVIDER_RE.test(provider)) {
    return fail(STATUS.INVALID_ROUTE, 'provider must match [a-z0-9][a-z0-9-]*[a-z0-9]');
  }
  if (recipe.family && recipe.family !== provider) {
    return fail(STATUS.INVALID_ROUTE,
      `recipe "${recipeId}" serves only provider "${recipe.family}" (got "${provider}")`);
  }

  const monitor = { recipe: recipeId };
  for (const field of MUTABLE_MONITOR_FIELDS) {
    if (input[field] !== undefined && input[field] !== null) monitor[field] = input[field];
  }

  const route = { id: input.id.trim(), provider };
  if (input.match !== undefined && input.match !== null) {
    if (!isPlainObject(input.match)) return fail(STATUS.INVALID_ROUTE, 'match must be an object');
    const match = {};
    for (const k of ['model', 'harness']) {
      if (input.match[k] !== undefined) {
        if (!nonEmptyString(input.match[k])) {
          return fail(STATUS.INVALID_ROUTE, `match.${k} must be a non-empty string`);
        }
        match[k] = input.match[k].trim();
      }
    }
    for (const k of Object.keys(input.match)) {
      if (!['model', 'harness'].includes(k)) return fail(STATUS.INVALID_ROUTE, `unsupported match field "${k}"`);
    }
    if (Object.keys(match).length) route.match = match;
  }
  if (input.ttlSeconds !== undefined && input.ttlSeconds !== null) {
    if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 0 || input.ttlSeconds > MAX_TTL_SECONDS) {
      return fail(STATUS.INVALID_ROUTE, `ttlSeconds must be an integer in [0, ${MAX_TTL_SECONDS}]`);
    }
    route.ttlSeconds = input.ttlSeconds;
  }
  route.monitor = monitor;
  if (input.retention !== undefined && input.retention !== null) {
    if (input.retention !== RETENTION.KEEP) {
      return fail(STATUS.INVALID_ROUTE, `unsupported retention "${input.retention}"`);
    }
    route.retention = RETENTION.KEEP;
  }

  // The schema is authoritative for everything inside `monitor`, including the
  // credential-shaped name/value rejections. Nothing bypasses it.
  const validation = validateMonitor(route);
  if (!validation.ok) return fail(STATUS.INVALID_ROUTE, validation.error);
  const capability = classifyCapability(route.monitor, knownRecipes());
  return { ok: true, status: STATUS.OK, route, capability, needsCredential: routeNeedsVaultCredential(route) };
}

// ---- probe classification ----------------------------------------------------

// Classify a probe result. Pure and total: an unexpected shape is `failed`,
// never silently monitorable. An `unknown` state is NEVER promoted into
// observed capacity — it is reported with the adapter's own stable reason.
function classifyProbe(result) {
  if (!isPlainObject(result)) {
    return { outcome: PROBE_OUTCOME.FAILED, reason: 'probe-no-result', state: null };
  }
  const cap = result.capability;
  if (isPlainObject(cap) && cap.monitorable === false) {
    return {
      outcome: PROBE_OUTCOME.UNMONITORED,
      reason: nonEmptyString(cap.reason) ? cap.reason : 'unmonitored',
      state: null,
    };
  }
  const st = result.status;
  if (!isPlainObject(st)) {
    return { outcome: PROBE_OUTCOME.FAILED, reason: 'probe-no-status', state: null };
  }
  if (st.state === 'healthy' || st.state === 'constrained' || st.state === 'exhausted') {
    return { outcome: PROBE_OUTCOME.MONITORED, reason: null, state: st.state };
  }
  const detail = isPlainObject(st.detail) ? st.detail : {};
  const reason = nonEmptyString(detail.reason) ? detail.reason
    : (nonEmptyString(detail.error) ? 'probe-error' : 'probe-no-usable-signal');
  return { outcome: PROBE_OUTCOME.NO_SIGNAL, reason, state: st.state === 'unknown' ? 'unknown' : null };
}

// ---- persistence -------------------------------------------------------------

// Upsert `route` into an effective route list, preserving order.
function upsertRoute(routes, route) {
  const out = [];
  let replaced = false;
  for (const r of routes) {
    if (r && typeof r === 'object' && r.id === route.id) {
      out.push(route);
      replaced = true;
    } else {
      out.push(r);
    }
  }
  if (!replaced) out.push(route);
  return out;
}

// Write route config + credential + cache row, in that order, reporting each
// stage. The route list written back is always the EFFECTIVE list: config.json
// merges arrays by replacement, so writing only the user document's own routes
// would silently drop the shipped defaults.
function persistRoute({ route, routes, credential, needsCredential, previousSecret, isNew, io }) {
  const persisted = { credential: false, config: false, cache: false };

  if (needsCredential) {
    try {
      io.vault.set(route.id, credential);
      persisted.credential = true;
    } catch {
      return fail(STATUS.PERSIST_FAILED, `credential could not be stored: ${VAULT_WRITE_FAILED}`,
        { stage: 'vault', persisted, recovery: 'nothing was persisted; verify vault access and rerun' });
    }
  }

  const userDoc = io.readUserConfig();
  const doc = isPlainObject(userDoc) ? userDoc : {};
  const nextRoutes = upsertRoute(routes, route);
  doc.routes = nextRoutes;
  try {
    io.saveConfig(doc);
    persisted.config = true;
  } catch (e) {
    // Roll the credential back so a failed add leaves no orphan secret, and a
    // failed rotation leaves the PREVIOUS working key in place. `persisted`
    // reports the state AFTER the rollback: a credential that was written and
    // then successfully rolled back is not persisted, and saying otherwise
    // would send the caller looking for a secret that is not there.
    let recovery;
    let rollback = null;
    if (!needsCredential) {
      recovery = 'nothing was persisted; fix config.json write access and rerun';
    } else if (isNew) {
      try {
        io.vault.remove(route.id);
        persisted.credential = false;
        rollback = 'credential-removed';
        recovery = 'credential rollback succeeded; nothing was persisted';
      } catch {
        rollback = 'failed';
        recovery = `credential rollback FAILED — remove it with: vl.js remove ${route.id}`;
      }
    } else if (nonEmptyString(previousSecret)) {
      try {
        io.vault.set(route.id, previousSecret);
        persisted.credential = false;
        rollback = 'previous-credential-restored';
        recovery = 'previous credential restored; route config unchanged';
      } catch {
        rollback = 'failed';
        recovery = `credential rollback FAILED — the new key is stored but config is unchanged; rerun: vl.js update ${route.id}`;
      }
    } else {
      rollback = 'not-possible';
      recovery = `credential was rotated and cannot be rolled back (previous value unreadable); route config unchanged — rerun: vl.js provider update ${route.id}`;
    }
    return fail(STATUS.PERSIST_FAILED, `route config could not be written: ${messageOf(e)}`,
      { stage: 'config', persisted, rollback, recovery });
  }

  // Cache: drop any observation left over from a previous incarnation of this
  // id, and republish revision metadata for the surviving rows so a collector
  // can reject an obsolete one.
  const cacheResult = dropCacheRow(route.id, nextRoutes, io);
  persisted.cache = cacheResult.ok;
  if (!cacheResult.ok) {
    return {
      ok: true,
      status: STATUS.CACHE_STALE_WARNING,
      error: `status cache could not be updated: ${cacheResult.error}`,
      stage: 'cache',
      persisted,
      recovery: 'route and credential are persisted; the next refresh replaces the stale row',
      route,
      configRevision: safeRevision(route),
    };
  }
  return {
    ok: true,
    status: STATUS.OK,
    persisted,
    route,
    configRevision: safeRevision(route),
  };
}

// Remove one cache row and republish revisions for the rest. Best-effort by
// contract: the caller decides whether a failure downgrades the operation.
function dropCacheRow(routeId, routes, io) {
  try {
    const cache = io.readCache();
    const rows = isPlainObject(cache) && isPlainObject(cache.routes) ? { ...cache.routes } : {};
    const had = Object.prototype.hasOwnProperty.call(rows, routeId);
    delete rows[routeId];
    io.writeCache(rows, { routes });
    return { ok: true, removed: had };
  } catch (e) {
    return { ok: false, error: messageOf(e) };
  }
}

function messageOf(e) {
  const m = e && e.message ? String(e.message) : String(e);
  return m.replace(/\s+/g, ' ').trim() || 'unknown error';
}

// A vault exception's text is NEVER surfaced. The keychain backend shells out
// to `security add-generic-password … -w <secret>`, and a failed execFileSync
// puts its whole argv in `error.message` (verified against the real binary) —
// so repeating that message would print the credential into stdout, the JSON
// result and any log that captures them. Callers get a fixed sentence and the
// actionable recovery line instead.
const VAULT_WRITE_FAILED = 'the credential store refused the write';
const VAULT_DELETE_FAILED = 'the credential store refused the delete';

function safeRevision(route) {
  try { return configRevision(route); } catch { return null; }
}

// ---- operations --------------------------------------------------------------

// Add a custom provider route: validate → probe → persist.
//
// The lock is taken BEFORE the effective routes are read, so the collision
// check and the write it guards see the same route list: two concurrent adds
// of the same label cannot both pass validation.
async function setupProvider(input, io) {
  const inputs = isPlainObject(input) ? input : {};
  const lock = io.lock();
  if (!lock.ok) {
    return withCommand('add', fail(STATUS.LOCK_BUSY,
      `another provider mutation is in progress (${lock.error || 'held'}) — retry shortly`, { id: null }));
  }
  try {
    const routes = effectiveRoutes(io);
    const alloc = allocateRouteId(inputs.label, new Set(routes.map((r) => r && r.id).filter(Boolean)));
    if (!alloc.ok) return withCommand('add', alloc);

    const draft = buildRouteDraft({ ...inputs, id: alloc.id, retention: undefined });
    if (!draft.ok) return withCommand('add', draft);

    const needsCredential = draft.needsCredential;
    if (needsCredential && !nonEmptyString(inputs.key)) {
      return withCommand('add', fail(STATUS.INVALID_ROUTE,
        `recipe "${inputs.recipe}" needs a credential — pass --key`, { id: alloc.id }));
    }
    if (!needsCredential && nonEmptyString(inputs.key)) {
      return withCommand('add', fail(STATUS.INVALID_ROUTE,
        `recipe "${inputs.recipe}" stores no credential (its own CLI owns authentication) — drop --key`,
        { id: alloc.id }));
    }
    if (needsCredential) {
      try {
        io.vault.assertWritable();
      } catch (e) {
        return withCommand('add', fail(STATUS.VAULT_UNAVAILABLE,
          `credential vault is unavailable: ${messageOf(e)}`, { id: alloc.id }));
      }
    }

    const probe = await runProbe(draft.route, needsCredential ? inputs.key : null, io);
    const gated = applyRetention({
      command: 'add', route: draft.route, probe, retention: inputs.retention,
      needsCredential, id: alloc.id,
    });
    if (gated) return gated;
    const result = persistRoute({
      route: probe.outcome === PROBE_OUTCOME.MONITORED
        ? draft.route
        : { ...draft.route, retention: RETENTION.KEEP },
      routes,
      credential: inputs.key,
      needsCredential,
      previousSecret: null,
      isNew: true,
      io,
    });
    return withCommand('add', { ...result, id: alloc.id, probe });
  } finally {
    lock.release();
  }
}

// Update an existing route: mutable monitor fields, match/ttl, and credential
// rotation. `id`, `provider` and `recipe` are immutable — a different recipe is
// a different quota source, so it is a new route, not an edit.
async function updateProvider(input, io) {
  const inputs = isPlainObject(input) ? input : {};
  const routeId = inputs.routeId;
  const lock = io.lock();
  if (!lock.ok) {
    return withCommand('update', fail(STATUS.LOCK_BUSY,
      `another provider mutation is in progress (${lock.error || 'held'}) — retry shortly`,
      { id: routeId || null }));
  }
  try {
    const routes = effectiveRoutes(io);
    const current = routes.find((r) => r && r.id === routeId);
    if (!nonEmptyString(routeId) || !current) {
      return withCommand('update', fail(STATUS.NOT_FOUND, `unknown route "${routeId}"`, { id: routeId || null }));
    }
    const currentMonitor = isPlainObject(current.monitor) ? current.monitor : null;
    if (!currentMonitor || !nonEmptyString(currentMonitor.recipe)) {
      return withCommand('update', fail(STATUS.INVALID_ROUTE,
        `route "${routeId}" is a built-in route with no monitor recipe — rotate its key with: vl.js update ${routeId}`,
        { id: routeId }));
    }
    for (const [field, value] of [['provider', inputs.provider], ['recipe', inputs.recipe]]) {
      const currentValue = field === 'provider' ? current.provider : currentMonitor.recipe;
      if (nonEmptyString(value) && value.trim() !== currentValue) {
        return withCommand('update', fail(STATUS.INVALID_ROUTE,
          `${field} is immutable (route "${routeId}" is "${currentValue}") — add a new route instead`,
          { id: routeId }));
      }
    }

    const draftInput = {
      id: routeId,
      provider: current.provider,
      recipe: currentMonitor.recipe,
      match: inputs.match !== undefined ? inputs.match : current.match,
      ttlSeconds: inputs.ttlSeconds !== undefined ? inputs.ttlSeconds : current.ttlSeconds,
    };
    for (const field of MUTABLE_MONITOR_FIELDS) {
      draftInput[field] = inputs[field] !== undefined ? inputs[field] : currentMonitor[field];
    }
    const draft = buildRouteDraft(draftInput);
    if (!draft.ok) return withCommand('update', { ...draft, id: routeId });

    const needsCredential = draft.needsCredential;
    const rotating = nonEmptyString(inputs.key);
    if (!needsCredential && rotating) {
      return withCommand('update', fail(STATUS.INVALID_ROUTE,
        `recipe "${currentMonitor.recipe}" stores no credential — drop --key`, { id: routeId }));
    }
    let previousSecret = null;
    if (needsCredential) {
      try {
        io.vault.assertWritable();
      } catch (e) {
        return withCommand('update', fail(STATUS.VAULT_UNAVAILABLE,
          `credential vault is unavailable: ${messageOf(e)}`, { id: routeId }));
      }
      try { previousSecret = io.vault.get(routeId); } catch { previousSecret = null; }
      if (!rotating && !nonEmptyString(previousSecret)) {
        return withCommand('update', fail(STATUS.INVALID_ROUTE,
          `route "${routeId}" has no stored credential — pass --key`, { id: routeId }));
      }
    }

    const credential = rotating ? inputs.key : previousSecret;
    const probe = await runProbe(draft.route, needsCredential ? credential : null, io);
    if (probe.outcome !== PROBE_OUTCOME.MONITORED && inputs.retention === RETENTION.CLEAR) {
      // "Clear the credential" on an existing route means the route stops
      // existing: credential, route entry and cache row all go.
      const removal = removeWithinLock({ routeId, routes, io });
      return withCommand('update', { ...removal, id: routeId, probe, cleared: true });
    }
    const gated = applyRetention({
      command: 'update', route: draft.route, probe, retention: inputs.retention,
      needsCredential, id: routeId,
    });
    if (gated) return gated;
    const nextRoute = probe.outcome === PROBE_OUTCOME.MONITORED
      ? draft.route
      : { ...draft.route, retention: RETENTION.KEEP };
    const result = persistRoute({
      route: nextRoute,
      routes,
      credential,
      // Only write the vault when the caller actually supplied a new secret:
      // an unchanged credential must not be rewritten (and cannot fail).
      needsCredential: needsCredential && rotating,
      previousSecret,
      isNew: false,
      io,
    });
    return withCommand('update', { ...result, id: routeId, probe, rotated: needsCredential && rotating });
  } finally {
    lock.release();
  }
}

// Remove everything view-limits owns for a route: the config entry, the vault
// key (only when the recipe keeps one with us), and the cache row.
//
// NO NATIVE LOGOUT. This path spawns no process and reads no other tool's
// credential store, so a recipe that authenticates through its own CLI keeps
// that CLI's session exactly as it was.
function removeProvider(input, io) {
  const inputs = isPlainObject(input) ? input : {};
  const routeId = inputs.routeId;
  if (!nonEmptyString(routeId)) {
    return withCommand('remove', fail(STATUS.NOT_FOUND, 'a route id is required', { id: null }));
  }
  const routes = effectiveRoutes(io);
  const route = routes.find((r) => r && r.id === routeId) || null;
  const needsCredential = route ? routeNeedsVaultCredential(route) : true;
  let hasCredential = false;
  if (needsCredential) {
    try { hasCredential = nonEmptyString(io.vault.get(routeId)); } catch { hasCredential = false; }
  }
  let hasCacheRow = false;
  try {
    const cache = io.readCache();
    hasCacheRow = isPlainObject(cache) && isPlainObject(cache.routes)
      && Object.prototype.hasOwnProperty.call(cache.routes, routeId);
  } catch { hasCacheRow = false; }
  if (!route && !hasCredential && !hasCacheRow) {
    return withCommand('remove', fail(STATUS.NOT_FOUND,
      `nothing to remove for "${routeId}" (no route, no credential, no cached status)`, { id: routeId }));
  }

  const lock = io.lock();
  if (!lock.ok) {
    return withCommand('remove', fail(STATUS.LOCK_BUSY,
      `another provider mutation is in progress (${lock.error || 'held'}) — retry shortly`, { id: routeId }));
  }
  try {
    return withCommand('remove', removeWithinLock({ routeId, routes, io }));
  } finally {
    lock.release();
  }
}

// Removal body, assuming the mutation lock is held. Order is credential →
// config → cache, each step reported, and every step is idempotent so a
// partially-completed removal is finished by simply running it again.
function removeWithinLock({ routeId, routes, io }) {
  const route = routes.find((r) => r && r.id === routeId) || null;
  const needsCredential = route ? routeNeedsVaultCredential(route) : true;
  const removed = { credential: false, config: false, cache: false, nativeLogout: false };

  if (needsCredential) {
    try {
      removed.credential = io.vault.remove(routeId) === true;
    } catch {
      return fail(STATUS.PERSIST_FAILED, `credential could not be removed: ${VAULT_DELETE_FAILED}`,
        { stage: 'vault', removed, recovery: 'verify vault access and rerun the removal', id: routeId });
    }
  }

  const userDoc = io.readUserConfig();
  const doc = isPlainObject(userDoc) ? userDoc : {};
  const docEntry = Array.isArray(doc.routes) ? doc.routes.find((r) => r && r.id === routeId) : null;
  // Only a CUSTOM route — one carrying a `monitor` — is a route this lifecycle
  // owns, so only its config entry is deleted. A shipped built-in keeps
  // today's semantics exactly: its credential and cache row go, the configured
  // route stays (deleting it from the user document would permanently drop a
  // default, since config.json merges route arrays by replacement).
  const isCustom = isPlainObject(route ? route.monitor : (docEntry && docEntry.monitor));
  if (isCustom && (route || docEntry)) {
    const remaining = routes.filter((r) => !(r && r.id === routeId));
    doc.routes = remaining;
    try {
      io.saveConfig(doc);
      removed.config = true;
    } catch (e) {
      return fail(STATUS.PERSIST_FAILED, `route config could not be written: ${messageOf(e)}`, {
        stage: 'config',
        removed,
        recovery: removed.credential
          ? 'the credential is already removed, so the route reads as unconfigured and the gate stays fail-open; rerun the removal once config.json is writable'
          : 'nothing was removed; fix config.json write access and rerun',
        id: routeId,
      });
    }
    const cacheResult = dropCacheRow(routeId, remaining, io);
    removed.cache = cacheResult.ok && cacheResult.removed === true;
    if (!cacheResult.ok) {
      return {
        ok: true,
        status: STATUS.CACHE_STALE_WARNING,
        error: `status cache could not be updated: ${cacheResult.error}`,
        stage: 'cache',
        removed,
        recovery: 'route and credential are removed; the next refresh drops the stale row',
        id: routeId,
      };
    }
    return { ok: true, status: STATUS.OK, removed, id: routeId };
  }

  // A built-in route, or an orphaned credential / cache row: clear what we own
  // and say plainly that the configured route remains.
  const cacheResult = dropCacheRow(routeId, routes, io);
  removed.cache = cacheResult.ok && cacheResult.removed === true;
  if (!cacheResult.ok) {
    return {
      ok: true,
      status: STATUS.CACHE_STALE_WARNING,
      error: `status cache could not be updated: ${cacheResult.error}`,
      stage: 'cache',
      removed,
      recovery: 'the credential is removed; the next refresh drops the stale row',
      id: routeId,
    };
  }
  return { ok: true, status: STATUS.OK, removed, id: routeId, routeRetained: route ? 'built-in' : null };
}

// Inventory for the lifecycle surface: what is configured, what holds a
// credential, and whether a cached observation still describes the route.
// Read-only — no probe, no network, no subprocess.
function listProviders(io) {
  const routes = effectiveRoutes(io);
  let cacheRoutes = {};
  try {
    const cache = io.readCache();
    if (isPlainObject(cache) && isPlainObject(cache.routes)) cacheRoutes = cache.routes;
  } catch { cacheRoutes = {}; }
  const rows = routes.map((route) => {
    const monitor = isPlainObject(route.monitor) ? route.monitor : null;
    const entry = isPlainObject(cacheRoutes[route.id]) ? cacheRoutes[route.id] : null;
    const needsCredential = routeNeedsVaultCredential(route);
    let hasCredential = false;
    if (needsCredential) {
      try { hasCredential = nonEmptyString(io.vault.get(route.id)); } catch { hasCredential = false; }
    }
    return {
      id: route.id,
      provider: route.provider,
      recipe: monitor ? (monitor.recipe || null) : null,
      custom: !!monitor,
      capability: classifyCapability(monitor, knownRecipes()),
      retention: route.retention === RETENTION.KEEP ? RETENTION.KEEP : null,
      needsCredential,
      hasCredential,
      configRevision: safeRevision(route),
      cachedRevision: entry && typeof entry.configRevision === 'string' ? entry.configRevision : null,
      configObsolete: isConfigObsolete(entry, route),
      observedAt: entry && typeof entry.observedAt === 'string' ? entry.observedAt : null,
    };
  });
  return { ok: true, status: STATUS.OK, command: 'list', routes: rows };
}

// ---- helpers -----------------------------------------------------------------

function effectiveRoutes(io) {
  const routes = io && typeof io.effectiveRoutes === 'function' ? io.effectiveRoutes() : null;
  return Array.isArray(routes) ? routes.filter((r) => isPlainObject(r)) : [];
}

async function runProbe(route, token, io) {
  let result = null;
  try {
    result = await io.probe(route, token);
  } catch (e) {
    return { outcome: PROBE_OUTCOME.FAILED, reason: 'probe-threw', state: null, detail: messageOf(e) };
  }
  return classifyProbe(result);
}

// Enforce the explicit retention choice. Returns a terminal result when the
// operation must stop, or null when persistence may proceed.
//
// There is no prompt and no default anywhere on this path: the caller either
// said what to do with a non-monitorable route, or gets a stable classification
// back and nothing is written.
function applyRetention({ command, probe, retention, needsCredential, id }) {
  if (probe.outcome === PROBE_OUTCOME.MONITORED) return null;
  if (retention === RETENTION.KEEP) return null;
  if (retention === RETENTION.CLEAR) {
    // Nothing was persisted yet on the add path, so "clear" is simply "do not
    // store it". The update path handles its own clear (an existing route) and
    // never reaches here with CLEAR.
    return withCommand(command, {
      ok: true,
      status: STATUS.OK,
      id,
      probe,
      cleared: true,
      persisted: { credential: false, config: false, cache: false },
      detail: needsCredential
        ? 'no credential was stored and no route was created'
        : 'no route was created',
    });
  }
  return withCommand(command, fail(STATUS.RETENTION_CHOICE_REQUIRED,
    `the probe found nothing to monitor (${probe.reason}) — rerun with --keep-unmonitored to register the route as unmonitored, or --clear-credential to abandon it`,
    { id, probe, persisted: { credential: false, config: false, cache: false } }));
}

function withCommand(command, result) {
  return Object.assign({ command }, result);
}

module.exports = {
  STATUS,
  PROBE_OUTCOME,
  RETENTION,
  EXIT_CODES,
  exitCodeFor,
  LOCK_FILE,
  LOCK_STALE_MS,
  acquireMutationLock,
  allocateRouteId,
  buildRouteDraft,
  classifyProbe,
  persistRoute,
  setupProvider,
  updateProvider,
  removeProvider,
  listProviders,
  getOptionSpec,
};
