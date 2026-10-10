'use strict';
// Chains the normal Xiaomi CLI preload (synthetic cookies/transport/vault
// spy), then overrides buildHelper to SUCCEED without compiling. Used by the
// N2 ordering regressions: the helper build succeeds, and THEN the
// owned-state reset refuses unsafe metadata — the config commit must not
// have happened yet, so the prior selection survives. Never compiles,
// installs, or executes anything.
require('./xiaomi-cli-preload.cjs');

const Module = require('module');
const originalLoad = Module._load;

Module._load = function okBuildLoad(id) {
  const mod = originalLoad.apply(this, arguments);
  if (typeof id === 'string' && id.endsWith('/lib/helper-install')) {
    return {
      ...mod,
      buildHelper: async () => ({ ok: true, helperPath: 'synthetic-ok-build' }),
    };
  }
  return mod;
};

module.exports = {};
