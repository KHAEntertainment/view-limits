'use strict';
// On-disk status cache + freshness + single-flight refresh ownership.
//
// Cache shape:
//   { updatedAt,
//     routes: { [routeId]: { routeId, observedAt, freshUntil, source, status,
//                            configRevision? } } }
//
// `configRevision` is ADDITIVE (#54): present only when the writer supplied
// `options.routes` so the per-route revision tag is known. Pre-#54 cache
// files remain readable; entries without `configRevision` are treated as
// time-fresh only (no obsolete-config guard), and the gate falls open as it
// does today.
//
// The gate reads this synchronously and never performs network I/O.
//
// Files in dataDir():
//   status.json          — the published cache (atomic replacement below).
//   refresh.scheduled    — gate-side throttle marker (mtime-based, non-blocking).
//                          Separates "the gate just spawned a refresh" from
//                          "a refresh worker is actually running", so a
//                          scheduled child cannot reject its own reservation
//                          against a worker lock it doesn't yet hold.
//   refresh-workers/     — unique per-process ownership records; see refresh-owner.js.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { dataDir } = require('./config');
const { acquireWorker, releaseWorker } = require('./refresh-owner');
const { configRevision, isConfigObsolete } = require('./monitor-schema');

function cachePath() {
  return path.join(dataDir(), 'status.json');
}

function schedulePath() {
  return path.join(dataDir(), 'refresh.scheduled');
}

function readCache() {
  try {
    const doc = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc) ||
        !doc.routes || typeof doc.routes !== 'object' || Array.isArray(doc.routes)) {
      return { updatedAt: null, routes: {} };
    }
    // Keep valid siblings, but never hand report/gate consumers a null,
    // primitive or array where the cache contract requires a route object.
    const routes = Object.fromEntries(Object.entries(doc.routes).filter(([, entry]) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)));
    return { ...doc, routes };
  } catch {
    return { updatedAt: null, routes: {} };
  }
}

// Atomic cache publication: write JSON to a unique per-writer temp file in
// the cache directory, then rename onto status.json. Each writer's temp name
// is unique (pid + random bytes) so concurrent workers never clobber one
// another's temp file. A failure before rename leaves the previous cache
// intact and only the writer's own temp file is cleaned up. Readers during
// the rename always see complete old or new JSON — never a torn document.
//
// `options.routes` (optional) — when supplied, the matching route's
// `configRevision` is attached ADDITIVELY to each entry, never replacing or
// renaming any existing field. Without it the cache shape is byte-identical
// to pre-#54 caches (back-compat / diagnostic JSON unchanged).
function writeCache(routeStatuses, options) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const enriched = attachRevisions(routeStatuses, options);
  const doc = { updatedAt: new Date().toISOString(), routes: enriched };
  const payload = JSON.stringify(doc, null, 2) + '\n';
  const cp = cachePath();
  const tmp = `${cp}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, cp);
  } catch (e) {
    // Best-effort cleanup of the writer's own temp; cache is unchanged.
    try { fs.unlinkSync(tmp); } catch { /* temp may already be gone */ }
    throw e;
  }
  return doc;
}

// Attach configRevision per routeId ADDITIVELY. Pure helper, exposed via
// module.exports for fixture tests; never mutates the input.
function attachRevisions(routeStatuses, options) {
  if (!options || !Array.isArray(options.routes)) return routeStatuses;
  const routeById = new Map();
  for (const r of options.routes) {
    if (r && typeof r === 'object' && !Array.isArray(r) && typeof r.id === 'string') {
      routeById.set(r.id, r);
    }
  }
  const out = {};
  for (const [id, entry] of Object.entries(routeStatuses || {})) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { out[id] = entry; continue; }
    const route = routeById.get(id);
    if (route) {
      out[id] = Object.assign({}, entry, { configRevision: configRevision(route) });
    } else {
      out[id] = entry;
    }
  }
  return out;
}

// Bound an entry's freshUntil (epoch ms) by the status's known recovery.
// Applies only to custom routes (a route.monitor with a non-built-in recipe)
// whose status is `exhausted` with a parseable resetAt: a deny-eligible
// observation must not outlive the moment the provider said the quota
// recovers. Built-in routes — including an explicit `recipe: 'built-in'` —
// keep TTL-only freshness unchanged. Pure; returns epoch ms.
function recoveryBoundedFreshUntil(route, status, ttlFreshUntilMs) {
  if (!route || !route.monitor || typeof route.monitor !== 'object') return ttlFreshUntilMs;
  if (route.monitor.recipe === 'built-in') return ttlFreshUntilMs;
  if (!status || status.state !== 'exhausted') return ttlFreshUntilMs;
  const recovery = Date.parse(status.resetAt);
  if (!Number.isFinite(recovery)) return ttlFreshUntilMs;
  return Math.min(ttlFreshUntilMs, recovery);
}

// Fresh if now is at or before the entry's freshUntil.
function isFresh(entry, now) {
  if (!entry || !entry.freshUntil) return false;
  const t = Date.parse(entry.freshUntil);
  return Number.isFinite(t) && now <= t;
}

// Gate-only scheduling throttle. Returns true (and touches the marker) only
// if no gate-spawned refresh was scheduled within the last `throttleSeconds`.
// This is intentionally separate from worker ownership: the gate never holds
// the worker lock, it just decides whether to spawn another detached child.
// Cheap mtime check, non-blocking, never races against the worker lock the
// child will try to acquire.
function tryScheduleRefresh(now, throttleSeconds) {
  try { fs.mkdirSync(dataDir(), { recursive: true }); } catch { return false; }
  const sp = schedulePath();
  try {
    const st = fs.statSync(sp);
    if (now - st.mtimeMs < throttleSeconds * 1000) return false;
  } catch { /* no marker yet */ }
  try {
    fs.writeFileSync(sp, String(now));
    return true;
  } catch {
    return false;
  }
}

// Detached background refresh; fire-and-forget (the gate never waits on it).
// The child runs `vl.js refresh --quiet` which independently acquires the
// worker ownership before performing any provider calls.
function spawnRefresh(pluginRoot) {
  try {
    const child = spawn(process.execPath, [path.join(pluginRoot, 'bin', 'vl.js'), 'refresh', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    if (typeof child.on === 'function') child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  cachePath, schedulePath,
  readCache, writeCache, attachRevisions, isFresh, isConfigObsolete, recoveryBoundedFreshUntil,
  tryScheduleRefresh,
  acquireWorker, releaseWorker,
  spawnRefresh,
};
