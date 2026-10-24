'use strict';
// The module ids the CLI test preloads stub.
//
// Issue #60: lib/collector.js requires lib/adapters and lib/vault from
// INSIDE lib/, so the request id there is './adapters' / './vault' rather
// than '../lib/adapters' / '../lib/vault'. The Node module cache is keyed
// by the RESOLVED file, so a preload that intercepts only one spelling
// would hand the collector the REAL module. Every stub therefore matches
// both spellings.
//
// The './' spelling is unambiguous inside this repository: lib/collector.js
// is the only module that requires './adapters' or './vault'.
function isModuleId(id, leaf) {
  if (typeof id !== 'string') return false;
  return id.endsWith(`/lib/${leaf}`) || id === `./${leaf}`;
}

module.exports = { isModuleId };
