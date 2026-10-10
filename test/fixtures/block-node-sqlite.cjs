'use strict';
// Preload that makes `require('node:sqlite')` fail, simulating a Node runtime
// without node:sqlite (Node 18 bearer installs). Modules that lazy-load it
// must still load and must classify the missing capability actionably.

const Module = require('module');
const originalLoad = Module._load;
Module._load = function blockNodeSqlite(id, ...rest) {
  if (id === 'node:sqlite') {
    const error = new Error('node:sqlite is unavailable in this runtime');
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return originalLoad.call(this, id, ...rest);
};
