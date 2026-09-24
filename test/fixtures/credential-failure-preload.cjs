'use strict';

// Deterministic credential-path fault injection for subprocess integration
// tests. It never reads a real vault or invokes a platform credential store.

const fs = require('fs');
const childProcess = require('child_process');

const originalRenameSync = fs.renameSync;
fs.renameSync = function renameSync(from, to) {
  const route = process.env.VL_FAIL_VAULT_ROUTE;
  if (route && String(to).endsWith(`${route}.enc`)) {
    throw new Error(`injected vault failure ${process.env.VL_THROW_SENTINEL || ''}`);
  }
  return originalRenameSync.apply(this, arguments);
};

if (process.env.VL_SPAWN_LOG) {
  childProcess.spawn = function blockedSpawn(command, args) {
    fs.appendFileSync(process.env.VL_SPAWN_LOG, JSON.stringify({
      command: String(command),
      args: (Array.isArray(args) ? args : []).map(String),
    }) + '\n');
    if (process.env.VL_SPAWN_STUB) return { unref() {}, on() {}, kill() {} };
    throw new Error('unexpected spawn');
  };
}
