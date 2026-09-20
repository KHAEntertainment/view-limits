'use strict';
// On-disk status cache + freshness + single-flight refresh ownership.
//
// Cache shape:
//   { updatedAt, routes: { [routeId]: { routeId, observedAt, freshUntil, source, status } } }
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
    return doc;
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
function writeCache(routeStatuses) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const doc = { updatedAt: new Date().toISOString(), routes: routeStatuses };
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
  readCache, writeCache, isFresh,
  tryScheduleRefresh,
  acquireWorker, releaseWorker,
  spawnRefresh,
};
