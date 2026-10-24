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

// A stubbed `serve` child really listens on its port, because the parent only
// prints a form URL once something is accepting connections there (Issue #81).
// It serves nothing and never touches the vault; unref() lets the parent exit.
function stubChild(args) {
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  let server = null;
  if (Array.isArray(args) && String(args[1]) === 'serve') {
    server = require('net').createServer((socket) => socket.destroy());
    server.listen(Number(args[2]), '127.0.0.1');
  }
  child.unref = () => { if (server) server.unref(); return child; };
  child.kill = () => { if (server) server.close(); return true; };
  return child;
}

if (process.env.VL_SPAWN_LOG) {
  childProcess.spawn = function blockedSpawn(command, args) {
    fs.appendFileSync(process.env.VL_SPAWN_LOG, JSON.stringify({
      command: String(command),
      args: (Array.isArray(args) ? args : []).map(String),
    }) + '\n');
    if (process.env.VL_SPAWN_STUB) return stubChild(args);
    throw new Error('unexpected spawn');
  };
}
