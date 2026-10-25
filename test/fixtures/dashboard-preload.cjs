'use strict';
// Hermetic preload for the dashboard daemon tests (Issue #61). Installed via
// NODE_OPTIONS=--require, it reaches the daemon AND the `vl.js view` child the
// daemon spawns, so a real daemon runs the real shared collector against a fake
// vault and fake provider adapter. No provider is ever contacted: outbound
// network (fetch, tls, and http(s).request/get to anything but loopback) throws.
//
// The fake provider is steered by files under $CLAUDE_PLUGIN_DATA so a test
// can change behaviour between collections without restarting the daemon:
//   provider-mode   healthy (default) | exhausted | fail | slow:<ms>
// Every provider call is appended to $CLAUDE_PLUGIN_DATA/events as
// {kind:'provider', pid, at} and every concurrent-call high-water mark is
// recorded in `events` too, so a test can count calls and overlap.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { isModuleId } = require('./module-id.cjs');

const dir = process.env.CLAUDE_PLUGIN_DATA;
function log(kind, extra = {}) {
  try { fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({ kind, pid: process.pid, at: Date.now(), ...extra }) + '\n'); } catch { /* teardown */ }
}
function mode() {
  try { return fs.readFileSync(path.join(dir, 'provider-mode'), 'utf8').trim() || 'healthy'; } catch { return 'healthy'; }
}

// Loopback is how the daemon's own client and a test's curl talk to it; every
// other destination — a provider — is refused.
const blocked = () => { throw new Error('network forbidden'); };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
function guardHttp(real) {
  return function (...args) {
    const first = args[0];
    let host;
    if (typeof first === 'string') { try { host = new URL(first).hostname; } catch { host = first; } }
    else if (first && typeof first === 'object') host = first.hostname || first.host || (first.href && new URL(first.href).hostname);
    if (!LOOPBACK.has(host)) return blocked();
    return real.apply(this, args);
  };
}
global.fetch = blocked;
for (const m of ['http', 'https']) for (const k of ['get', 'request']) { const mod = require(m); mod[k] = guardHttp(mod[k]); }
require('tls').connect = blocked;

let active = 0;
const load = Module._load;
Module._load = function (id, ...args) {
  if (isModuleId(id, 'vault')) return { has: () => true, get: () => 'fake-test-key' };
  if (isModuleId(id, 'adapters')) {
    return {
      getAdapter: () => ({
        async fetchStatus() {
          active += 1;
          log('provider', { active });
          try {
            const m = mode();
            if (m === 'fail') throw new Error('HTTP 502: upstream unavailable');
            if (m.startsWith('slow:')) await new Promise((r) => setTimeout(r, Number(m.slice(5))));
            if (m === 'exhausted') return { state: 'exhausted', windows: [], balance: null, resetAt: null };
            return { state: 'healthy', windows: [], balance: null, resetAt: null };
          } finally { active -= 1; }
        },
      }),
    };
  }
  if (isModuleId(id, 'traycer-adapter')) {
    const real = load.call(this, id, ...args);
    return Object.assign({}, real, {
      readTraycerRuntime: async () => ({ caller: null, sessions: [], harnesses: [], profiles: [], diagnostics: [] }),
    });
  }
  return load.call(this, id, ...args);
};
