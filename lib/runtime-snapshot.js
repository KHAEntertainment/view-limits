'use strict';
// Transport-neutral normalized runtime snapshot — schemaVersion 1.
//
// getRuntimeSnapshot({ refresh: false }) assembles the snapshot from local
// request context (injected callerContext) plus on-disk caches only:
// status.json (v1 route cache) and runtime.json (versioned sidecar). It
// performs NO subprocess, RPC, provider request, filesystem write, refresh
// scheduling, or worker acquisition. `refresh: true` currently has no live
// source in this build; the request is recorded in requestedRefresh and the
// result remains cache-only with a live-reads-unavailable diagnostic.
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
const { readRuntimeSidecar } = require('./runtime-sidecar');

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
  'live-reads-unavailable': 'live refresh was requested but no live source is available in this build; showing cached facts only.',
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
  } catch {
    return { doc: null, corrupt: false, exists: false };
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
  } catch {
    return { cfg, corrupt: false };
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

function assembleCaller(callerContext) {
  const ctx = isPlainObject(callerContext) ? callerContext : {};
  const caller = {};
  for (const field of CALLER_FIELDS) caller[field] = callerFact(ctx[field]);

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

function routeRow(id, cfgRoute, cacheEntry, nowMs) {
  const match = (cfgRoute && isPlainObject(cfgRoute.match)) ? cfgRoute.match : {};
  const { resource, malformed } = cacheEntry === undefined
    ? { resource: unknownResource('no-cached-observation'), malformed: false }
    : resourceFor(cacheEntry, nowMs);
  return {
    row: {
      id,
      kind: 'external-provider',
      provider: cfgRoute ? configuredField(cfgRoute.provider) : unknown('route-not-configured'),
      account: cfgRoute ? configuredField(cfgRoute.account) : unknown('route-not-configured'),
      modelBinding: cfgRoute ? configuredField(match.model) : unknown('route-not-configured'),
      harnessBinding: cfgRoute ? configuredField(match.harness) : unknown('route-not-configured'),
      configured: !!cfgRoute,
      resource,
    },
    malformed,
  };
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
  if (refresh) {
    diagnostics.push(diag('live-reads-unavailable', 'envelope'));
  }

  const sidecar = readSidecar(root);
  for (const d of (sidecar && sidecar.degradations) || []) diagnostics.push(d);
  const sidecarDoc = (sidecar && sidecar.doc) || { sessions: [], harnesses: [], profiles: [] };

  const cfg = readConfig(root);
  if (cfg.corrupt) diagnostics.push(diag('config-corrupt', 'routes'));

  const status = readStatus(root);
  if (status.corrupt) diagnostics.push(diag('status-cache-corrupt', 'routes'));

  const { rows: routes, anyMalformed } = assembleRoutes(cfg.cfg, status.doc, nowMs);
  if (anyMalformed) diagnostics.push(diag('status-entry-malformed', 'routes'));

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    requestedRefresh: !!refresh,
    completeness: 'empty',
    diagnostics,
    caller: assembleCaller(callerContext),
    sessions: sidecarDoc.sessions || [],
    harnesses: sidecarDoc.harnesses || [],
    profiles: sidecarDoc.profiles || [],
    routes,
  };
  snapshot.completeness = computeCompleteness(snapshot, diagnostics);
  return snapshot;
}

module.exports = { getRuntimeSnapshot, SNAPSHOT_SCHEMA_VERSION };
