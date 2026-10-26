'use strict';
// `vl.js config` with a fake vault: no keychain, no credential files. Only the
// read-only config command runs under this preload; it never fetches or writes.
const Module = require('module');
const { isModuleId } = require('./module-id.cjs');
const load = Module._load;
Module._load = function (id, ...args) {
  if (isModuleId(id, 'vault')) return { has: () => false };
  return load.call(this, id, ...args);
};
