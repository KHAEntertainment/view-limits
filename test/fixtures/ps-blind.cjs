'use strict';
// Test-only: blinds the dashboard's process-identity read for ONE pid, the way
// a machine whose `ps` cannot answer would be. lib/dashboard/identity.js calls
// `execFileSync('ps', ['-o', 'lstart=', '-p', pid])` directly and turns any
// throw or unparseable output into a null token, which is exactly the condition
// the daemon reports as UNVERIFIED — a record naming a process whose identity
// cannot be established, that must not be trusted, replaced or signalled.
//
// Set VL_PS_BLIND_PID to the pid to blind, and require this file through
// NODE_OPTIONS. It is deliberately narrow: every other `ps` read, and every
// other execFileSync caller, goes through to the real implementation.
//
// Installed before the app loads (NODE_OPTIONS), so identity.js's
// `const { execFileSync } = require('child_process')` picks up the patched
// property when it is required.
const cp = require('child_process');

const target = process.env.VL_PS_BLIND_PID;
const real = cp.execFileSync;

cp.execFileSync = function patched(file, args) {
  if (target && file === 'ps' && Array.isArray(args)) {
    const i = args.indexOf('-p');
    if (i !== -1 && String(args[i + 1]) === String(target)) {
      const e = new Error('ps: this test cannot read the process start time');
      e.code = 'EPERM';
      throw e;
    }
  }
  return real.apply(this, arguments);
};
