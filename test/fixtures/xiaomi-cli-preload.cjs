'use strict';
// Preload for the Xiaomi CLI subprocess tests (installed via NODE_OPTIONS).
//
//  - lib/vault: every has/get/set/remove call is appended (method + id) to
//    VL_XIAOMI_VAULT_LOG so tests can prove xiaomi routes never reach the
//    legacy vault. child_process exec family is hard-blocked so no `security`
//    binary can run even by mistake.
//  - lib/xiaomi-session: fetchStatus is wrapped to inject synthetic
//    passwordReader + transport (mode-driven) — no Chrome store, no Keychain,
//    no network. Modes: VL_XIAOMI_FETCH_MODE = ok | auth | network | shape | hang.
//  - lib/helper-install: buildHelper is replaced by a fake compiler seam that
//    writes a synthetic executable + appends VL_XIAOMI_BUILD_LOG — `make` is
//    never run from the CLI in tests.
//  - child_process spawn/spawnSync are logged to VL_XIAOMI_SPAWN_LOG so tests
//    can assert no kh-helper process is ever executed.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const cp = require('child_process');

const VAULT_LOG = process.env.VL_XIAOMI_VAULT_LOG;
const FETCH_LOG = process.env.VL_XIAOMI_FETCH_LOG;
const BUILD_LOG = process.env.VL_XIAOMI_BUILD_LOG;
const SPAWN_LOG = process.env.VL_XIAOMI_SPAWN_LOG;
const KEY_LOG = process.env.VL_XIAOMI_KEY_LOG;
const MODE = process.env.VL_XIAOMI_FETCH_MODE || 'ok';
const GRANT_MODE = process.env.VL_XIAOMI_GRANT_MODE || 'ok';
const PASSWORD = process.env.VL_XIAOMI_PASSWORD || 'synthetic-storage-password';

function append(file, line) {
  if (!file) return;
  try { fs.appendFileSync(file, line + '\n'); } catch { /* log path may be gone */ }
}

function readJson(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ---- exec family hard block (no /usr/bin/security, no make, no helper) -------
for (const fn of ['exec', 'execFile', 'execSync', 'execFileSync']) {
  const original = cp[fn];
  cp[fn] = function blockedExec() {
    append(SPAWN_LOG, JSON.stringify({ blocked: fn, cmd: arguments[0] }));
    throw new Error(`blocked-exec:${fn}`);
  };
  void original;
}
for (const fn of ['spawn', 'spawnSync']) {
  const original = cp[fn];
  cp[fn] = function loggedSpawn(cmd) {
    append(SPAWN_LOG, JSON.stringify({ spawn: fn, cmd: String(cmd) }));
    return original.apply(this, arguments);
  };
}

// ---- synthetic console responses --------------------------------------------
const USAGE = {
  code: 0,
  data: {
    usage: { percent: 0.25, items: [{ name: 'plan_total_token', used: 9631677420, limit: 38000000000, percent: 0.25 }] },
    monthUsage: { percent: 0.2535, items: [] },
  },
};
const DETAIL = { code: 0, data: { currentPeriodEnd: '2026-11-07 23:59:59', expired: false } };

function makeTransport() {
  const transport = async (url, options) => {
    append(FETCH_LOG, JSON.stringify({ url }));
    if (MODE === 'hang') await new Promise((resolve) => setTimeout(resolve, 6000));
    if (MODE === 'network') throw new Error('raw-cli-network-secret');
    if (MODE === 'auth') {
      return { status: 401, body: null, text: async () => JSON.stringify({ code: 401, message: 'echo-cli-secret' }) };
    }
    if (MODE === 'shape') {
      return { status: 200, body: null, text: async () => JSON.stringify(url.endsWith('/usage') ? { code: 0, data: {} } : DETAIL) };
    }
    return { status: 200, body: null, text: async () => JSON.stringify(url.endsWith('/usage') ? USAGE : DETAIL) };
  };
  return transport;
}

// ---- module wrapping ---------------------------------------------------------
const originalLoad = Module._load;
Module._load = function xiaomiTestLoad(id) {
  const mod = originalLoad.apply(this, arguments);
  if (typeof id !== 'string') return mod;
  if (id.endsWith('/lib/vault')) {
    const spy = { ...mod };
    for (const fn of ['has', 'get', 'set', 'remove']) {
      const original = mod[fn];
      spy[fn] = function spyVault(routeId, ...rest) {
        append(VAULT_LOG, JSON.stringify({ fn, id: routeId }));
        return original.call(this, routeId, ...rest);
      };
    }
    return spy;
  }
  if (id.endsWith('/lib/xiaomi-session')) {
    const realFetchStatus = mod.fetchStatus;
    return {
      ...mod,
      fetchStatus: (cfg, route, ctx = {}) => realFetchStatus(cfg, route, {
        ...ctx,
        xiaomiDeps: {
          ...(ctx.xiaomiDeps || {}),
          // One log line per synthetic key read: proves F4 coalescing (exactly
          // one acquisition per operation no matter how many Xiaomi aliases).
          passwordReader: () => {
            append(KEY_LOG, JSON.stringify({ key: 'read' }));
            return Buffer.from(PASSWORD, 'utf8');
          },
          transport: makeTransport(),
        },
      }),
      // Round-4 interactive grant seam: setup/update wiring is proven without
      // any real bridge import, helper execution, or Keychain dialog.
      // VL_XIAOMI_GRANT_MODE = ok | denied | denied-delayed (the delayed mode
      // proves the bare-update path AWAIT the grant before touching siblings).
      grantInteractiveKey: async () => {
        append(KEY_LOG, JSON.stringify({ key: 'interactive-grant', purpose: 'interactive-setup' }));
        if (GRANT_MODE === 'denied-delayed') {
          await new Promise((resolve) => setTimeout(resolve, 400));
          const error = new Error('bridge-denied'); // classified enum only
          error.code = 'bridge-denied';
          throw error;
        }
        if (GRANT_MODE === 'denied') {
          const error = new Error('bridge-denied'); // classified enum only
          error.code = 'bridge-denied';
          throw error;
        }
        return true;
      },
    };
  }
  if (id.endsWith('/lib/helper-install')) {
    return {
      ...mod,
      buildHelper: async (options = {}) => {
        append(BUILD_LOG, JSON.stringify({ dataDir: options.dataDir, pluginRoot: options.pluginRoot }));
        const target = path.join(options.dataDir, 'bin', 'kh-helper');
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
        return { ok: true, helperPath: target };
      },
    };
  }
  return mod;
};

module.exports = { readJson };
