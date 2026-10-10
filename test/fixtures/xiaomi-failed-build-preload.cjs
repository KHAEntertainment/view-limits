'use strict';
// Chains the normal Xiaomi CLI preload (synthetic cookies/transport/vault
// spy), then overrides buildHelper to throw the classified failure named by
// VL_XIAOMI_BUILD_FAIL_CODE (default helper-build-failed). Used by the F3
// setup-ordering regressions: compile vs install failure must both preserve
// prior config/suppression and keep a first setup disabled.
require('./xiaomi-cli-preload.cjs');

const Module = require('module');
const originalLoad = Module._load;

Module._load = function failedBuildLoad(id) {
  const mod = originalLoad.apply(this, arguments);
  if (typeof id === 'string' && id.endsWith('/lib/helper-install')) {
    return {
      ...mod,
      buildHelper: async () => {
        const code = process.env.VL_XIAOMI_BUILD_FAIL_CODE || 'helper-build-failed';
        const error = new Error(code);
        error.code = code;
        throw error;
      },
    };
  }
  return mod;
};

module.exports = {};
