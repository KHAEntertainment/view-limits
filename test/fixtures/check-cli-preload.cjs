'use strict';
// `vl.js check` with a fake vault and adapter; no network or credentials.
// VL_CHECK_MODE picks the adapter outcome: ok | auth | multiline | plain.
const Module = require('module');
const { isModuleId } = require('./module-id.cjs');
global.fetch = () => { throw new Error('network forbidden'); };
const load = Module._load;
Module._load = function (id, ...args) {
  if (isModuleId(id, 'vault')) return { has: () => true, get: () => 'fake-test-key' };
  if (isModuleId(id, 'adapters')) return { getAdapter: () => ({
    async fetchStatus() {
      switch (process.env.VL_CHECK_MODE) {
        case 'auth':
          throw Object.assign(new Error('Z.ai auth failed (code 1000: Authentication Failed)'), { status: 401 });
        case 'multiline':
          throw Object.assign(new Error('HTTP 502: <html>\n  <body>Bad Gateway</body>\n</html>'), { status: 502 });
        case 'plain':
          throw new Error('Z.ai code 500: no active coding plan on this account');
        default:
          return { state: 'healthy', windows: [], balance: null, resetAt: null };
      }
    },
  }) };
  return load.call(this, id, ...args);
};
