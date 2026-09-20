'use strict';
// Preload guard for gate CLI subprocess tests. Installed via NODE_OPTIONS=--require
// in the actual `node bin/vl.js gate` child, this module records and blocks
// every observable side-channel that the gate's "network-free + non-credential +
// detached refresh" contract promises. It is the runtime enforcement of F5
// (committed regression coverage).
//
// Behavior:
//   - fetch, http/HTTPS request/get, net connect/createConnection, tls connect
//     all throw if called. Logs the attempt kind to REVIEW_LOG when set.
//   - child_process exec/execFile/execSync/execFileSync throw.
//   - child_process spawn is observed. For a refresh spawn:
//       * default: returns a dummy child whose unref() is also observed and
//         log-only (so the gate exits without a real refresh process).
//       * if REVIEW_REAL_REFRESH is set, spawns the original child but
//         intercepts unref() to log it. Used by the real pending-worker test.
//   - importing lib/adapters replaces getAdapter with a blocker.
//   - importing lib/vault replaces has/get with blockers.
//   - Date.now is overridden when REVIEW_NOW is set, so freshness tests run
//     deterministically.

const fs = require('fs');

function log(kind, detail) {
  if (process.env.REVIEW_LOG) {
    try {
      fs.appendFileSync(process.env.REVIEW_LOG, JSON.stringify({ kind, detail: detail || null }) + '\n');
    } catch { /* log path may be gone during teardown */ }
  }
}

function blocked(kind) {
  return function () {
    log(kind);
    throw new Error(`review blocked ${kind}`);
  };
}

// HTTP/RPC transports
global.fetch = blocked('fetch');
for (const mod of ['http', 'https']) {
  for (const key of ['request', 'get']) {
    try { require(mod)[key] = blocked(`${mod}.${key}`); } catch { /* module may be missing in some envs */ }
  }
}
for (const key of ['connect', 'createConnection']) {
  try { require('net')[key] = blocked(`net.${key}`); } catch { /* */ }
}
try { require('tls').connect = blocked('tls.connect'); } catch { /* */ }

// child_process: observe spawn, block exec family
const cp = require('child_process');
const origSpawn = cp.spawn;
cp.spawn = function (cmd, args, opts) {
  const isRefresh = args && args[1] === 'refresh';
  if (isRefresh && process.env.REVIEW_REAL_REFRESH) {
    const child = origSpawn.apply(this, arguments);
    log('real-child', { pid: child.pid, detached: opts && opts.detached, stdio: opts && opts.stdio });
    const origUnref = child.unref.bind(child);
    child.unref = function () { log('real-unref'); return origUnref(); };
    return child;
  }
  if (isRefresh) {
    log('refresh', { cmd, args, detached: opts && opts.detached, stdio: opts && opts.stdio });
    return {
      unref() { log('unref'); },
      then() { log('await-refresh'); return new Promise(() => {}); },
    };
  }
  return origSpawn.apply(this, arguments);
};
for (const key of ['exec', 'execFile', 'execSync', 'execFileSync']) {
  cp[key] = blocked(`child_process.${key}`);
}

// adapter / vault: replace getters so any import resolves to a blocker
const Module = require('module');
const origLoad = Module._load;
Module._load = function (id, parent, isMain) {
  const m = origLoad.apply(this, arguments);
  if (typeof id === 'string' && id.endsWith('/lib/adapters')) {
    return { ...m, getAdapter: blocked('provider') };
  }
  if (typeof id === 'string' && id.endsWith('/lib/vault')) {
    return { ...m, has: blocked('vault.has'), get: blocked('vault.get') };
  }
  return m;
};

// Deterministic clock
if (process.env.REVIEW_NOW) {
  const fixed = Number(process.env.REVIEW_NOW);
  Date.now = function () { return fixed; };
}
