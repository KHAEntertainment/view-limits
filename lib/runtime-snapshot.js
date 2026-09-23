'use strict';
// Transport-neutral normalized runtime snapshot — schemaVersion 1.
//
// getRuntimeSnapshot({ refresh: false }) assembles the snapshot from local
// request context (injected callerContext) plus on-disk caches only:
// status.json (v1 route cache) and runtime.json (versioned sidecar). It
// performs NO subprocess, RPC, provider request, filesystem write, refresh
// scheduling, or worker acquisition.
//
// `refresh: true` runs the independent live sources concurrently: the
// supported Traycer CLI adapter (lib/traycer-adapter.js) plus any injected
// io.liveReads entries shaped { key, read(args) }. Identical requests — same
// key or same function — coalesce to one invocation. Each source returns
// { caller, sessions, harnesses, profiles, diagnostics }; live rows merge
// with cached rows by composite key (a live row replaces the same-key cached
// row; cache-only rows survive untouched). Injected sources apply first and
// the authoritative Traycer read applies last. A failed or malformed source
// degrades to a scoped diagnostic — siblings and cached facts survive.
//
// Truthfulness rules (see sprint-05/slice-05a contract):
//   * every fact is { value, provenance, source, observedAt, freshUntil, reason }
//   * unknown = value null + provenance 'unknown' + a stable reason code —
//     never false / 0 / 'exhausted' / 'unavailable'
//   * configured / observed / unknown provenance are distinct
//   * cached evidence (state, observedAt, freshUntil, source) is carried
//     verbatim; snapshot generation never renews it
//   * the caller section is assembled at request time — nothing is read from
//     the sidecar or kept in module state between calls

const fs = require('fs');
const path = require('path');
const { dataDir, DEFAULTS, deepMerge } = require('./config');
const { parseStrictIsoTimestamp } = require('./gate');
const { readRuntimeSidecar, SECTION_KEYS } = require('./runtime-sidecar');
const traycerAdapter = require('./traycer-adapter');

const SNAPSHOT_SCHEMA_VERSION = 1;
const STATUS_FILE = 'status.json';
const CONFIG_FILE = 'config.json';

const PROVENANCES = new Set(['observed', 'configured', 'unknown']);

const DIAG_SUMMARIES = {
  'runtime-sidecar-corrupt': 'runtime snapshot cache (runtime.json) is unreadable; runtime facts are unknown.',
  'runtime-sidecar-unsupported': 'runtime snapshot cache version is unsupported; runtime facts are unknown.',
  'runtime-sidecar-section-invalid': 'part of the runtime snapshot cache failed validation and was ignored.',
  'status-cache-corrupt': 'status cache (status.json) is unreadable; cached resource states are unknown.',
  'status-entry-malformed': 'a cached route entry has a malformed status and was ignored.',
  'config-corrupt': 'config.json is unreadable; built-in defaults are in effect.',
  'caller-context-absent': 'no caller context was supplied; caller identity is unknown.',
  'live-reads-unavailable': 'live refresh was requested but no supported live source was available for this caller; showing cached facts only.',
  'traycer-cli-missing': 'the supported Traycer CLI is not installed or not on PATH; Traycer runtime facts are unknown.',
  'traycer-read-timeout': 'a bounded Traycer CLI read exceeded its deadline; that section’s live facts are unknown.',
  'traycer-read-failed': 'a Traycer CLI read failed; that section’s live facts are unknown.',
  'traycer-output-malformed': 'a Traycer CLI read returned unusable output; that section’s live facts are unknown.',
  'traycer-caller-mismatch': 'supplied caller identity does not match the Traycer-verified identity; authoritative caller facts are withheld.',
  'traycer-caller-row-absent': 'the Traycer-verified caller has no own row in the agent listing; caller row facts are unknown.',
  'traycer-epic-unverified': 'the caller epic id was supplied without launch-environment evidence; session rows were withheld rather than keyed on an unverified claim.',
  'traycer-host-unresolved': 'no host identity could be confirmed for Traycer catalog rows; they were withheld.',
  'live-source-failed': 'a bounded live source failed during refresh; that source’s live facts are unknown.',
  'live-source-malformed': 'a bounded live source returned unusable output during refresh; that source’s live facts are unknown.',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function diag(code, scope) {
  return { code, scope, summary: DIAG_SUMMARIES[code] };
}

// ---- facts ------------------------------------------------------------------

function fact(value, provenance, { source = null, observedAt = null, freshUntil = null } = {}) {
  return { value, provenance, source, observedAt, freshUntil, reason: null };
}

function observedFact(value, source) {
  return fact(value, 'observed', { source });
}

function configuredFact(value, source) {
  return fact(value, 'configured', { source });
}

function unknown(reason) {
  return { value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason };
}

function factIsKnown(f) {
  return isPlainObject(f) && f.provenance !== 'unknown' && f.value !== null && f.value !== undefined;
}

// ---- injected readers --------------------------------------------------------

// status.json reader with corruption visibility (lib/cache.js#readCache swallows
// errors for the gate's fail-open path; the snapshot needs to report them).
function defaultReadStatus(dir) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, STATUS_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { doc: null, corrupt: false, exists: false };
    return { doc: null, corrupt: true, exists: true };
  }
  try {
    const doc = JSON.parse(raw);
    if (!isPlainObject(doc)) return { doc: null, corrupt: true, exists: true };
    return { doc, corrupt: false, exists: true };
  } catch {
    return { doc: null, corrupt: true, exists: true };
  }
}

// Effective config for an injected dir — same merge semantics as loadConfig()
// but with corruption visibility and no dependence on the global dataDir().
function defaultReadConfig(dir) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { cfg, corrupt: false };
    return { cfg, corrupt: true };
  }
  try {
    const user = JSON.parse(raw);
    if (!isPlainObject(user)) return { cfg, corrupt: true };
    return { cfg: deepMerge(cfg, user), corrupt: false };
  } catch {
    return { cfg, corrupt: true };
  }
}

// ---- caller ------------------------------------------------------------------

const CALLER_FIELDS = [
  'ade', 'host', 'surface', 'harness', 'epicId', 'sessionId', 'agentId',
  'configuredModel', 'defaultModel', 'effectiveModel',
  'selectedProfile', 'selectedAccount',
];

// Normalize one callerContext field into a fact. Primitives become observed
// facts sourced from the caller context itself; fact-shaped objects are
// validated and keep their own provenance/source; anything absent is unknown.
function callerFact(input) {
  if (input === undefined || input === null) return unknown('caller-fact-absent');
  if (isPlainObject(input)) {
    if (!('value' in input) || input.value === null || input.value === undefined ||
        input.provenance === 'unknown') {
      return unknown(nonEmptyString(input.reason) ? input.reason : 'caller-fact-absent');
    }
    return {
      value: input.value,
      provenance: PROVENANCES.has(input.provenance) ? input.provenance : 'observed',
      source: nonEmptyString(input.source) ? input.source : 'callerContext',
      observedAt: nonEmptyString(input.observedAt) ? input.observedAt : null,
      freshUntil: nonEmptyString(input.freshUntil) ? input.freshUntil : null,
      reason: null,
    };
  }
  return observedFact(input, 'callerContext');
}

function assembleCaller(callerContext, overlay) {
  const ctx = isPlainObject(callerContext) ? callerContext : {};
  const caller = {};
  for (const field of CALLER_FIELDS) caller[field] = callerFact(ctx[field]);

  // A verified live read may overlay authoritative facts (e.g. the Traycer
  // caller row). Overlay values pass through callerFact for the same
  // validation discipline as supplied context; differsFromDefault is still
  // recomputed afterwards, never carried.
  if (isPlainObject(overlay)) {
    for (const field of CALLER_FIELDS) {
      if (field in overlay) caller[field] = callerFact(overlay[field]);
    }
  }

  const eff = caller.effectiveModel;
  const def = caller.defaultModel;
  caller.differsFromDefault = (factIsKnown(eff) && factIsKnown(def))
    ? observedFact(eff.value !== def.value, 'callerContext')
    : unknown('model-comparison-unavailable');
  return caller;
}

// ---- routes ------------------------------------------------------------------

function unknownResource(reason) {
  return {
    state: unknown(reason === 'no-cached-observation' ? 'no-cached-observation' : 'cached-state-absent'),
    windows: [],
    balance: null,
    usage: null,
    error: null,
    resetAt: unknown(reason === 'no-cached-observation' ? 'no-cached-observation' : 'cached-field-absent'),
    observedAt: unknown(reason === 'no-cached-observation' ? 'no-cached-observation' : 'cached-field-absent'),
    freshUntil: unknown(reason === 'no-cached-observation' ? 'no-cached-observation' : 'cached-field-absent'),
    freshness: 'unknown',
    source: unknown(reason === 'no-cached-observation' ? 'no-cached-observation' : 'cached-field-absent'),
  };
}

// Build the resource block for one cache entry. `entry` may be any JSON value
// from the cache; only type-conforming fields are carried, verbatim.
function resourceFor(entry, nowMs) {
  if (!isPlainObject(entry) || !isPlainObject(entry.status)) {
    return { resource: unknownResource('cached-field-absent'), malformed: isPlainObject(entry) || entry !== undefined };
  }
  const st = entry.status;
  return {
    malformed: false,
    resource: {
      state: nonEmptyString(st.state)
        ? observedFact(st.state, 'status.json')
        : unknown('cached-state-absent'),
      windows: Array.isArray(st.windows) ? st.windows.filter(isPlainObject) : [],
      balance: isPlainObject(st.balance) ? st.balance : null,
      // Whitelisted detail carries: usage evidence and the provider error
      // string are normalized adapter output; raw response bodies (e.g.
      // MiniMax detail.raw) never enter the snapshot.
      usage: isPlainObject(st.detail) && isPlainObject(st.detail.usage) ? st.detail.usage : null,
      error: isPlainObject(st.detail) && nonEmptyString(st.detail.error) ? st.detail.error : null,
      resetAt: nonEmptyString(st.resetAt)
        ? observedFact(st.resetAt, 'status.json')
        : (st.resetAt == null ? unknown('cached-field-absent') : unknown('cached-field-invalid')),
      observedAt: nonEmptyString(entry.observedAt)
        ? observedFact(entry.observedAt, 'status.json')
        : unknown('cached-field-absent'),
      freshUntil: nonEmptyString(entry.freshUntil)
        ? observedFact(entry.freshUntil, 'status.json')
        : unknown('cached-field-absent'),
      freshness: freshnessOf(entry.freshUntil, nowMs),
      source: nonEmptyString(entry.source)
        ? observedFact(entry.source, 'status.json')
        : unknown('cached-field-absent'),
    },
  };
}

// Freshness is computed at request time from the stored freshUntil vs the
// injected clock, using the gate's strict ISO parser. It never qualifies the
// verbatim `state` — a stale exhausted entry still reads `state: 'exhausted'`
// with `freshness: 'stale'`.
function freshnessOf(freshUntil, nowMs) {
  const t = nonEmptyString(freshUntil) ? parseStrictIsoTimestamp(freshUntil) : null;
  if (t == null) return 'unknown';
  return nowMs <= t ? 'fresh' : 'stale';
}

function configuredField(v) {
  return nonEmptyString(v) ? configuredFact(v, 'config') : unknown('config-field-absent');
}

// The quota-pool identity is the configured provider+account pair — the only
// pool identity the composer may assert on its own. Two routes sharing it
// share a pool; a native resource joins it only through a proven binding
// (see resolveResourceBindings), never through name similarity.
function poolFact(cfgRoute) {
  if (!cfgRoute) return unknown('route-not-configured');
  if (nonEmptyString(cfgRoute.provider) && nonEmptyString(cfgRoute.account)) {
    return configuredFact({ provider: cfgRoute.provider, account: cfgRoute.account }, 'config');
  }
  return unknown('config-field-absent');
}

// Models evidenced by the cached provider observation: the adapter's
// normalized detail.model plus every name in detail.models. Configured
// match.model stays a dispatch-binding hint (modelBinding), never evidence.
function modelsEvidence(entry) {
  const st = isPlainObject(entry) && isPlainObject(entry.status) ? entry.status : null;
  const detail = st && isPlainObject(st.detail) ? st.detail : null;
  if (!detail) return null;
  const names = [];
  const push = (v) => { if (nonEmptyString(v) && !names.includes(v)) names.push(v); };
  push(detail.model);
  if (Array.isArray(detail.models)) {
    for (const m of detail.models) {
      if (nonEmptyString(m)) push(m);
      else if (isPlainObject(m)) push(m.name);
    }
  }
  return names.length ? names : null;
}

function routeRow(id, cfgRoute, cacheEntry, nowMs) {
  const match = (cfgRoute && isPlainObject(cfgRoute.match)) ? cfgRoute.match : {};
  const { resource, malformed } = cacheEntry === undefined
    ? { resource: unknownResource('no-cached-observation'), malformed: false }
    : resourceFor(cacheEntry, nowMs);
  const models = modelsEvidence(cacheEntry);
  return {
    row: {
      id,
      kind: 'external-provider',
      provider: cfgRoute ? configuredField(cfgRoute.provider) : unknown('route-not-configured'),
      account: cfgRoute ? configuredField(cfgRoute.account) : unknown('route-not-configured'),
      pool: poolFact(cfgRoute),
      modelBinding: cfgRoute ? configuredField(match.model) : unknown('route-not-configured'),
      harnessBinding: cfgRoute ? configuredField(match.harness) : unknown('route-not-configured'),
      models: models
        ? observedFact(models, 'status.json')
        : unknown(cacheEntry === undefined ? 'no-cached-observation' : 'model-evidence-absent'),
      configured: !!cfgRoute,
      // Harness keys whose resourceRefs prove a shared route/pool binding —
      // populated by resolveResourceBindings; empty means no proven binding.
      boundBy: [],
      resource,
    },
    malformed,
  };
}

// A native harness resource binds to an external route only through a proven
// shared account/pool identity: a resourceRef naming the route id, or a ref
// carrying the route's configured provider+account pair. Provider or harness
// name similarity alone never binds — without a proven ref the native
// resource and the external route stay separate sections.
function resolveResourceBindings(routes, harnessRows) {
  for (const h of Array.isArray(harnessRows) ? harnessRows : []) {
    const key = isPlainObject(h) && isPlainObject(h.key) ? h.key : null;
    if (!key || !Array.isArray(h.resourceRefs)) continue;
    for (const ref of h.resourceRefs) {
      if (!isPlainObject(ref)) continue;
      for (const route of routes) {
        const bound = (nonEmptyString(ref.routeId) && ref.routeId === route.id) ||
          (nonEmptyString(ref.provider) && nonEmptyString(ref.account) &&
            factIsKnown(route.provider) && factIsKnown(route.account) &&
            route.provider.value === ref.provider && route.account.value === ref.account);
        if (bound && !route.boundBy.some((b) => b.host === key.host && b.harness === key.harness && b.surface === key.surface)) {
          route.boundBy.push({ host: key.host, harness: key.harness, surface: key.surface });
        }
      }
    }
  }
}

function assembleRoutes(cfg, statusDoc, nowMs) {
  const byId = new Map();
  const cfgRoutes = Array.isArray(cfg && cfg.routes) ? cfg.routes : [];
  for (const r of cfgRoutes) {
    if (isPlainObject(r) && nonEmptyString(r.id) && !byId.has(r.id)) byId.set(r.id, { cfg: r, entry: undefined });
  }
  const cacheRoutes = isPlainObject(statusDoc && statusDoc.routes) ? statusDoc.routes : {};
  const orphanIds = [];
  for (const [id, entry] of Object.entries(cacheRoutes)) {
    if (byId.has(id)) byId.get(id).entry = entry;
    else orphanIds.push([id, entry]);
  }
  orphanIds.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [id, entry] of orphanIds) byId.set(id, { cfg: null, entry });

  const rows = [];
  let anyMalformed = false;
  for (const [id, { cfg: r, entry }] of byId) {
    const { row, malformed } = routeRow(id, r, entry, nowMs);
    if (malformed) anyMalformed = true;
    rows.push(row);
  }
  return { rows, anyMalformed };
}

// ---- live row merge ------------------------------------------------------------

// Composite-key signature for a sidecar-shaped row — same tuple encoding as
// the sidecar's keySignature so live and cached rows dedupe identically.
function rowSignature(row, fields) {
  const key = isPlainObject(row) && isPlainObject(row.key) ? row.key : {};
  return JSON.stringify(fields.map((f) => key[f]));
}

// Merge live rows into cached section rows by composite key: a live row
// replaces the same-key cached row (fresher observation of the same
// identity), while cache-only rows survive untouched. Within each source,
// duplicate signatures keep the first occurrence — same rule as the sidecar
// reader. Cached order is preserved; new live rows append in adapter order.
function mergeSectionRows(cachedRows, liveRows, fields) {
  const base = Array.isArray(cachedRows) ? cachedRows : [];
  if (!Array.isArray(liveRows) || liveRows.length === 0) return base;
  const order = [];
  const bySig = new Map();
  for (const row of base) {
    const sig = rowSignature(row, fields);
    if (!bySig.has(sig)) order.push(sig);
    bySig.set(sig, row);
  }
  const liveSeen = new Set();
  for (const row of liveRows) {
    const sig = rowSignature(row, fields);
    if (liveSeen.has(sig)) continue;
    liveSeen.add(sig);
    if (!bySig.has(sig)) order.push(sig);
    bySig.set(sig, row);
  }
  return order.map((sig) => bySig.get(sig));
}

// ---- completeness -------------------------------------------------------------

// Walk the emitted document and classify facts. A fact-shaped object is a
// plain object carrying both `value` and a `provenance` from the enum. Sidecar
// section rows count as observed evidence by their presence (their key fields
// are known values).
function scanFacts(root) {
  let hasObserved = false;
  let hasUnknown = false;
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (!Array.isArray(node) && 'value' in node && PROVENANCES.has(node.provenance)) {
      if (node.provenance === 'observed' && node.value !== null && node.value !== undefined) hasObserved = true;
      if (node.provenance === 'unknown') hasUnknown = true;
      continue;
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return { hasObserved, hasUnknown };
}

function computeCompleteness(snapshot, diagnostics) {
  const { hasObserved, hasUnknown } = scanFacts(snapshot);
  if (!diagnostics.length && !hasUnknown) return 'complete';
  if (hasObserved || snapshot.sessions.length || snapshot.harnesses.length || snapshot.profiles.length) {
    return 'partial';
  }
  return 'empty';
}

// ---- live sources -------------------------------------------------------------

// Independent live sources for refresh:true. The supported Traycer runtime
// read is always present (it internally bounds, pools, and coalesces its own
// CLI reads); io.liveReads may add further independent sources shaped
// { key, read(args) } → { caller, sessions, harnesses, profiles, diagnostics }.
// Identical requests — same key or same read function — coalesce to one
// invocation.
function collectLiveSources(io) {
  const sources = [];
  const seen = new Set();
  const extras = Array.isArray(io.liveReads) ? io.liveReads : [];
  for (const s of extras) {
    if (!isPlainObject(s) || typeof s.read !== 'function') continue;
    const key = nonEmptyString(s.key) ? s.key : `live-${sources.length}`;
    if (seen.has(key) || seen.has(s.read)) continue;
    seen.add(key);
    seen.add(s.read);
    sources.push({ key, read: s.read, traycer: false });
  }
  if (!seen.has('traycer')) {
    sources.push({ key: 'traycer', read: io.readTraycer || traycerAdapter.readTraycerRuntime, traycer: true });
  }
  return sources;
}

// Run every live source concurrently and fold the results into one live
// view. A thrown read or a non-object result degrades to a scoped diagnostic
// and contributes nothing; per-section shape violations mark the source
// malformed without discarding its valid sections. Injected sources apply in
// listed order and the Traycer read applies last — the authoritative
// runtime source wins same-key rows and per-field caller overlay conflicts.
async function runLiveSources(io, callerContext, diagnostics) {
  const live = { caller: null, sessions: [], harnesses: [], profiles: [] };
  const sources = collectLiveSources(io);
  const readArgs = { callerContext, env: io.env || process.env, run: io.traycerRun };
  const settled = await Promise.all(sources.map(async (src) => {
    try {
      return { src, result: await src.read(readArgs) };
    } catch {
      return { src, failed: true };
    }
  }));
  const seenDiag = new Set(diagnostics.map((d) => `${d.code}|${d.scope}`));
  for (const { src, result, failed } of settled) {
    const scope = src.traycer ? 'traycer' : `live:${src.key}`;
    if (failed) {
      diagnostics.push(diag(src.traycer ? 'traycer-read-failed' : 'live-source-failed', scope));
      continue;
    }
    if (!isPlainObject(result)) {
      diagnostics.push(diag('live-source-malformed', scope));
      continue;
    }
    let malformed = false;
    if (result.caller !== undefined && result.caller !== null) {
      if (isPlainObject(result.caller)) live.caller = Object.assign(live.caller || {}, result.caller);
      else malformed = true;
    }
    for (const section of ['sessions', 'harnesses', 'profiles']) {
      const rows = result[section];
      if (rows === undefined) continue;
      if (!Array.isArray(rows)) { malformed = true; continue; }
      live[section] = mergeSectionRows(live[section], rows, SECTION_KEYS[section]);
    }
    if (Array.isArray(result.diagnostics)) {
      for (const d of result.diagnostics) {
        if (!isPlainObject(d) || !nonEmptyString(d.code)) continue;
        const dScope = nonEmptyString(d.scope) ? d.scope : null;
        if (seenDiag.has(`${d.code}|${dScope}`)) continue;
        seenDiag.add(`${d.code}|${dScope}`);
        diagnostics.push({ code: d.code, scope: dScope, summary: nonEmptyString(d.summary) ? d.summary : (DIAG_SUMMARIES[d.code] || null) });
      }
    }
    if (malformed) diagnostics.push(diag('live-source-malformed', scope));
  }
  return live;
}

// ---- snapshot -----------------------------------------------------------------

async function getRuntimeSnapshot({
  refresh = false,
  now = () => Date.now(),
  dataDir: dir,
  callerContext = null,
  io = {},
} = {}) {
  const root = dir || dataDir();
  const readSidecar = io.readSidecar || readRuntimeSidecar;
  const readStatus = io.readStatus || defaultReadStatus;
  const readConfig = io.readConfig || defaultReadConfig;
  const nowMs = now();

  const diagnostics = [];
  if (callerContext === null || callerContext === undefined) {
    diagnostics.push(diag('caller-context-absent', 'caller'));
  }

  // Live reads run only on explicit refresh; refresh:false never reaches a
  // live source (zero Traycer CLI/RPC/subprocess/provider invocations).
  const live = refresh
    ? await runLiveSources(io, callerContext, diagnostics)
    : { caller: null, sessions: [], harnesses: [], profiles: [] };

  const sidecar = readSidecar(root);
  for (const d of (sidecar && sidecar.degradations) || []) diagnostics.push(d);
  const sidecarDoc = (sidecar && sidecar.doc) || { sessions: [], harnesses: [], profiles: [] };

  const cfg = readConfig(root);
  if (cfg.corrupt) diagnostics.push(diag('config-corrupt', 'routes'));

  const status = readStatus(root);
  if (status.corrupt) diagnostics.push(diag('status-cache-corrupt', 'routes'));

  const { rows: routes, anyMalformed } = assembleRoutes(cfg.cfg, status.doc, nowMs);
  if (anyMalformed) diagnostics.push(diag('status-entry-malformed', 'routes'));

  const harnesses = mergeSectionRows(sidecarDoc.harnesses, live.harnesses, SECTION_KEYS.harnesses);
  resolveResourceBindings(routes, harnesses);

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    requestedRefresh: !!refresh,
    completeness: 'empty',
    diagnostics,
    caller: assembleCaller(callerContext, live.caller),
    sessions: mergeSectionRows(sidecarDoc.sessions, live.sessions, SECTION_KEYS.sessions),
    harnesses,
    profiles: mergeSectionRows(sidecarDoc.profiles, live.profiles, SECTION_KEYS.profiles),
    routes,
  };
  snapshot.completeness = computeCompleteness(snapshot, diagnostics);
  return snapshot;
}

module.exports = { getRuntimeSnapshot, SNAPSHOT_SCHEMA_VERSION };
