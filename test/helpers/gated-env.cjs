'use strict';
// Shared env harness for tests that drive the gated CLI
// (`node bin/vl.js gate` under test/guard.cjs).
//
// Build the child env for a gated CLI invocation. `bindings` are the
// per-test constants (isolated HOME, guard preload, frozen clock, review log)
// and `options` are the keys a caller explicitly wants to inject for one call.
//
// [#78] CLAUDE_PLUGIN_DATA / CLAUDE_PLUGIN_ROOT / VIEW_LIMITS_ROOT are ALWAYS
// emitted, undefined unless passed through `options`. withEnv below deletes
// only the keys present in the object it is given, so when cliEnv omitted
// these three unless a caller set them, a parent shell exporting any of them
// leaked into the gated CLI child — which then read a foreign config/cache
// instead of the hermetic fixture. That is the #78 failure: the deny path
// never fires and opencode-harness.test.js dies at its
// `a fresh exhausted route must deny through the wired CLI` assertion (:259).
// The #78 time-bomb premise was wrong — test/guard.cjs:91 freezes Date.now()
// to REVIEW_NOW, so the fixture can never go stale on any commit or date;
// ambient env was the only variable. Repro on plain bf98da8 / 6b07421:
//   CLAUDE_PLUGIN_DATA=~/.view-limits node test/opencode-harness.test.js
//
// STUB_STDOUT / STUB_CAPTURE stay conditional: installStubCli sets
// STUB_STDOUT straight on process.env in the parent, so withEnv must not
// delete it for callers that never name it.
function cliEnv(bindings, options = {}) {
  const env = { ...bindings };
  for (const key of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'VIEW_LIMITS_ROOT']) {
    env[key] = options[key]; // undefined ⇒ withEnv deletes it from process.env
  }
  for (const key of ['STUB_STDOUT', 'STUB_CAPTURE']) {
    if (options[key] !== undefined) env[key] = options[key];
  }
  return env;
}

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try { return fn(); } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

module.exports = { cliEnv, withEnv };
