'use strict';
// Actual CLI integration with fake vault/provider; no external credentials or I/O.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const cp = require('child_process');
const { isModuleId } = require('./module-id.cjs');
const dir = process.env.CLAUDE_PLUGIN_DATA;
function log(kind, extra = {}) {
  fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({ kind, pid: process.pid, ...extra }) + '\n');
}
global.fetch = () => { throw new Error('network forbidden'); };
for (const module of ['http', 'https']) {
  for (const method of ['get', 'request']) require(module)[method] = global.fetch;
}
for (const method of ['connect', 'createConnection']) require('net')[method] = global.fetch;
require('tls').connect = global.fetch;
for (const method of ['exec', 'execFile', 'execSync', 'execFileSync']) cp[method] = global.fetch;
const spawn = cp.spawn;
cp.spawn = function (...args) {
  const child = spawn.apply(this, args);
  log('spawn', { child: child.pid, detached: args[2]?.detached, stdio: args[2]?.stdio });
  return child;
};
process.on('exit', () => log('exit', { command: process.argv[2] }));
const load = Module._load;
Module._load = function (id, ...args) {
  if (isModuleId(id, 'vault')) return { has: () => true, get: () => 'fake-test-key' };
  if (isModuleId(id, 'adapters')) return { getAdapter: () => ({
    async fetchStatus() {
      log('provider');
      // VL_REFRESH_FAIL=1 makes the provider throw, so a test can drive the
      // failed-fetch path (the route keeps its prior observation and the
      // refresh says so). VL_REFRESH_FAIL_MULTILINE=1 makes the error
      // multi-line, so the one-line sanitization is testable.
      if (process.env.VL_REFRESH_FAIL === '1') {
        throw new Error(process.env.VL_REFRESH_FAIL_MULTILINE === '1'
          ? 'HTTP 502: upstream\nunavailable\r\n  retry later'
          : process.env.VL_REFRESH_FAIL_CONTROLS === '1'
            ? 'HTTP 502: \u001b[2J\u001b[HFAKE HEALTHY\u009b31m\u0007'
            : 'HTTP 502: upstream unavailable');
      }
      const end = Date.now() + 8000;
      while (!fs.existsSync(path.join(dir, 'release'))) {
        if (Date.now() > end) throw new Error('test provider release timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return { state: 'healthy', windows: [], balance: null, resetAt: null };
    },
  }) };
  if (isModuleId(id, 'traycer-adapter')) {
    // The collector's bounded native observation (B3) must stay hermetic in
    // the CLI tests: never spawn a real traycer CLI (the test env may carry
    // the launch identity). Keep every other export (the CLI reads
    // traycerEnvCallerContext from this module).
    const real = load.call(this, id, ...args);
    return Object.assign({}, real, {
      readTraycerRuntime: async () => ({ caller: null, sessions: [], harnesses: [], profiles: [], diagnostics: [] }),
    });
  }
  return load.call(this, id, ...args);
};
if (process.env.VL_FAIL_SCHEDULING) {
  const mkdir = fs.mkdirSync;
  fs.mkdirSync = function (p, ...args) {
    if (p === dir || p === path.join(dir, 'refresh-workers')) throw Object.assign(new Error('test permission denied'), { code: 'EACCES' });
    return mkdir.call(this, p, ...args);
  };
}
