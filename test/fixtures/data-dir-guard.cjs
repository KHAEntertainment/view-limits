'use strict';
// [#95] Preload guard: a test may not resolve the data dir it inherited.
//
// Installed by test/run.js into every spawned test file via NODE_OPTIONS=--require.
// The runner sets CLAUDE_PLUGIN_DATA to a fresh per-run scratch dir and HOME to
// a scratch home, so the only way a child can resolve a dir it inherited is by
// reaching for it explicitly (or by clearing CLAUDE_PLUGIN_DATA and falling
// back to the real ~/.view-limits). When that happens dataDir() throws instead
// of silently reading — or writing — a foreign directory.
//
// The forbidden set arrives in VL_FORBIDDEN_DATA_DIRS: path-delimiter joined
// absolute paths, already resolved by the runner. With the variable unset the
// preload is inert.
//
// KNOWN LIMIT, documented in the PR: this wraps the EXPORTED dataDir. Calls
// made from inside lib/config.js itself use the local function and bypass the
// wrapper, and a module that captured dataDir before this preload ran would
// too. The runner's before/after snapshot of the inherited dirs is the guard
// of record for those paths.
//
// The interception mirrors test/guard.cjs: Module._load is wrapped and the
// module's dataDir export is replaced. The module is matched on its RESOLVED
// path (…/lib/config.js) rather than on the request id, because the same file
// is reached as './config' from lib/, as '../lib/config' from test/ and as
// '../config' from lib/<subdir>/ — see test/fixtures/module-id.cjs for why the
// id spellings are not enough.

const path = require('path');
const Module = require('module');

const forbidden = new Set(
  String(process.env.VL_FORBIDDEN_DATA_DIRS || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((p) => path.resolve(p))
);

const guarded = new WeakSet();

function wrap(mod) {
  if (!mod || typeof mod.dataDir !== 'function') return;
  if (guarded.has(mod)) return;
  const original = mod.dataDir;
  mod.dataDir = function dataDirGuarded(...args) {
    const raw = original.apply(this, args);
    let resolved;
    try { resolved = path.resolve(raw); } catch { return raw; }
    if (forbidden.has(resolved)) {
      throw new Error(
        `[vl-test-guard] dataDir() resolved to the inherited data dir (${resolved}). `
        + 'A test reached the dir it inherited instead of the runner scratch dir. '
        + 'Give the test its own CLAUDE_PLUGIN_DATA (and HOME), or use the '
        + 'scratch dir the runner put in VL_TEST_SCRATCH.'
      );
    }
    // The original value is returned unchanged: resolution is only used for
    // the comparison, so every non-forbidden path behaves exactly as before.
    return raw;
  };
  guarded.add(mod);
}

if (forbidden.size) {
  const origLoad = Module._load;
  const origResolve = Module._resolveFilename;
  Module._load = function (id, parent, isMain) {
    const mod = origLoad.apply(this, arguments);
    try {
      const resolved = origResolve.call(Module, id, parent, isMain);
      if (typeof resolved === 'string' && resolved.endsWith(`${path.sep}lib${path.sep}config.js`)) {
        wrap(mod);
      }
    } catch { /* builtin or unresolvable id */ }
    return mod;
  };
}

module.exports = { forbidden, wrap };
