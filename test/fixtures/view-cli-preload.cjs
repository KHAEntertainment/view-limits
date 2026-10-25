'use strict';
// Preload for the view CLI tests (installed via NODE_OPTIONS).
//
// A fake vault (a credential is present), a fake adapter (one healthy
// observation) and a controllable failure. No network, no keychain, no
// provider: every provider call is this file's fake.
//
//   VL_VIEW_FAIL=<routeId>   the adapter throws for that route (an external
//                            failure), so the collector has to keep the
//                            route's prior entry.
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { isModuleId } = require('./module-id.cjs');

const dir = process.env.CLAUDE_PLUGIN_DATA;

function log(kind, extra = {}) {
  try {
    fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({ kind, ...extra }) + '\n');
  } catch { /* the scratch dir may be gone at teardown */ }
}

global.fetch = () => { throw new Error('network forbidden'); };

const emptyNativeRead = async () => {
  // F1 regression hook: a REAL delay in the native reader, so the display
  // entry's one-second lifetime is genuinely exercised against a slow read.
  const delay = Number(process.env.VL_VIEW_NATIVE_DELAY_MS || 0);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  return { caller: null, sessions: [], harnesses: [], profiles: [], diagnostics: [] };
};

const load = Module._load;
Module._load = function (id, ...args) {
  if (isModuleId(id, 'vault')) {
    const noVault = process.env.VL_VIEW_NO_VAULT === '1';
    return {
      has: (routeId) => { log('vault-has', { routeId }); return noVault ? false : true; },
      get: (routeId) => { log('vault-get', { routeId }); return noVault ? null : 'fake-test-key'; },
    };
  }
  if (isModuleId(id, 'adapters')) {
    return {
      getAdapter: (provider, route) => ({
        async fetchStatus() {
          const routeId = route && route.id;
          log('provider', { routeId, provider });
          if (process.env.VL_VIEW_FAIL && process.env.VL_VIEW_FAIL === routeId) {
            throw new Error('synthetic provider failure');
          }
          return {
            state: 'healthy',
            windows: [{ type: 'rolling-5h', remaining: 72, limit: 100 }],
            balance: null,
            resetAt: null,
            detail: {},
          };
        },
      }),
      ADAPTERS: {},
    };
  }
  if (isModuleId(id, 'xiaomi-session')) {
    // A synthetic successful Xiaomi session for the R2-2 view projection: the
    // collector's ONE session call returns healthy token counts.
    const real = load.call(this, id, ...args);
    return Object.assign({}, real, {
      fetchStatus: async () => ({
        state: 'healthy',
        windows: [{ type: 'tokens', remaining: 75, limit: 100 }],
        balance: null,
        resetAt: null,
        detail: {},
        basis: 'token-count',
      }),
    });
  }
  if (isModuleId(id, 'traycer-adapter')) {
    // The collector's bounded native observation (B3) must stay hermetic in
    // the CLI tests: never spawn a real traycer CLI. Keep every other export
    // (the CLI reads traycerEnvCallerContext from this module).
    const real = load.call(this, id, ...args);
    return Object.assign({}, real, {
      readTraycerRuntime: emptyNativeRead,
    });
  }
  return load.call(this, id, ...args);
};
