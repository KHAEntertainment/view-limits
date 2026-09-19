'use strict';
// On-disk status cache + freshness + single-flight refresh lock.
//
// Cache shape:
//   { updatedAt, routes: { [routeId]: { routeId, observedAt, freshUntil, source, status } } }
//
// The gate reads this synchronously and never performs network I/O.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dataDir } = require('./config');

function cachePath() {
  return path.join(dataDir(), 'status.json');
}

function lockPath() {
  return path.join(dataDir(), 'refresh.lock');
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    return { updatedAt: null, routes: {} };
  }
}

function writeCache(routeStatuses) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const doc = { updatedAt: new Date().toISOString(), routes: routeStatuses };
  fs.writeFileSync(cachePath(), JSON.stringify(doc, null, 2) + '\n');
  return doc;
}

// Fresh if now is at or before the entry's freshUntil.
function isFresh(entry, now) {
  if (!entry || !entry.freshUntil) return false;
  const t = Date.parse(entry.freshUntil);
  return Number.isFinite(t) && now <= t;
}

// Best-effort single-flight guard: return true (and touch the lock) only if no
// refresh was triggered within the last `lockSeconds`. Prevents refresh storms
// when many concurrent dispatches all see stale data.
function tryAcquireRefreshLock(now, lockSeconds) {
  fs.mkdirSync(dataDir(), { recursive: true });
  try {
    const st = fs.statSync(lockPath());
    if (now - st.mtimeMs < lockSeconds * 1000) return false;
  } catch {
    /* no lock yet */
  }
  try {
    fs.writeFileSync(lockPath(), String(now));
    return true;
  } catch {
    return false;
  }
}

// Detached background refresh; fire-and-forget (the gate never waits on it).
function spawnRefresh(pluginRoot) {
  try {
    const child = spawn(process.execPath, [path.join(pluginRoot, 'bin', 'vl.js'), 'refresh', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  cachePath, lockPath, readCache, writeCache, isFresh,
  tryAcquireRefreshLock, spawnRefresh,
};
