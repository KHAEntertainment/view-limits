'use strict';
// StepPlan CLI integration preload (#57): no credentials (vault reports none)
// and no external I/O. lib/adapters is NOT stubbed — the real stepfun-plan
// recipe must run and prove it is local-only by never touching the network.
//
// Tripwire design (review addendum a): every forbidden handler pushes an
// event AND throws, so the caller's assertion that no attempt happened can
// actually fail. A handler that throws silently would let a real attempt
// slip past a kind-based assertion. The vault stub (addendum b) counts every
// has/get call so the test can assert the credential-free route never
// consults the vault at all.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const cp = require('child_process');
const dir = process.env.CLAUDE_PLUGIN_DATA;
function log(kind, extra = {}) {
  fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({ kind, pid: process.pid, ...extra }) + '\n');
}
function forbidden(kind, call) {
  return (...args) => {
    log(kind, { call });
    throw new Error(`${kind} forbidden`);
  };
}
global.fetch = forbidden('network', 'fetch');
for (const module of ['http', 'https']) {
  for (const method of ['get', 'request']) {
    require(module)[method] = forbidden('network', `${module}.${method}`);
  }
}
for (const method of ['connect', 'createConnection']) {
  require('net')[method] = forbidden('network', `net.${method}`);
}
require('tls').connect = forbidden('network', 'tls.connect');
for (const module of ['dns', 'dns/promises']) {
  try {
    const dns = require(module);
    for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
      if (typeof dns[method] === 'function') dns[method] = forbidden('network', `${module}.${method}`);
    }
  } catch { /* dns/promises may be absent on very old Node */ }
}
for (const method of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync']) {
  cp[method] = forbidden('exec', `child_process.${method}`);
}
process.on('exit', () => log('exit', { command: process.argv[2] }));
const load = Module._load;
Module._load = function (id, ...args) {
  // No credential exists for stepfun-plan: the vault is present but empty.
  // Every consultation is recorded so the test can assert zero.
  if (id.endsWith('/lib/vault')) {
    return {
      has: (routeId) => { log('vault-has', { routeId }); return false; },
      get: (routeId) => { log('vault-get', { routeId }); return null; },
    };
  }
  return load.call(this, id, ...args);
};
