'use strict';
// [#78] Env isolation for the gated-CLI test harness.
//
// cliEnv()/withEnv() live in test/helpers/gated-env.cjs and MUST scrub the
// ambient plugin keys (CLAUDE_PLUGIN_DATA / CLAUDE_PLUGIN_ROOT /
// VIEW_LIMITS_ROOT) from the child env: withEnv deletes only the keys present
// in the object it is given, so the pre-#78 cliEnv omitted them unless a
// caller passed them — and a parent shell exporting any of them leaked into
// `node bin/vl.js gate`, which then read a foreign config/cache instead of
// the hermetic fixture. The leak's only observable symptom was #78: the deny
// path never fires and opencode-harness.test.js dies at its
// `a fresh exhausted route must deny through the wired CLI` assertion (:259).
//
// Why #78 could not have been a time bomb: test/guard.cjs:91 freezes
// Date.now() to REVIEW_NOW inside the gated child, so the fixture is fresh by
// design on any commit and any date. Ambient env was the only variable —
// the recorded "fails on bf98da8 and 6b07421" reproductions came from
// shells with CLAUDE_PLUGIN_DATA exported; the same command in a clean shell
// passes on all three checkouts. Verbatim repro (pre-#78 fix, any checkout):
//   CLAUDE_PLUGIN_DATA=~/.view-limits node test/opencode-harness.test.js
//
// Two pins, both of which fail without the one-line cliEnv fix:
//   1. MECHANISM — inside the withEnv scope built by cliEnv(), the three keys
//      are deleted from process.env even when the parent exported them, and
//      restored afterwards; explicit options still win.
//   2. REPRO — the verbatim #78 command, run as a subprocess with all three
//      keys exported to hostile foreign values, exits 0.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cliEnv, withEnv } = require('./helpers/gated-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const HARNESS = path.join(__dirname, 'opencode-harness.test.js');
const GUARD = path.join(__dirname, 'guard.cjs');

const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-foreign-'));
// Hostile CLAUDE_PLUGIN_DATA: a gate-off config for the very route the
// harness expects to deny — if it reached the gated CLI, the deny could never
// fire. Hostile VIEW_LIMITS_ROOT: a nonexistent checkout, which would make the
// plugin's CLI resolution fail open. Either leak kills the repro below.
const foreignData = path.join(foreign, 'data');
fs.mkdirSync(foreignData, { recursive: true });
fs.writeFileSync(path.join(foreignData, 'config.json'), JSON.stringify({
  routes: [{ id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' } }],
  gate: { mode: 'off' },
}));

const AMBIENT = {
  CLAUDE_PLUGIN_DATA: foreignData,
  CLAUDE_PLUGIN_ROOT: path.join(foreign, 'plugin-root'),
  VIEW_LIMITS_ROOT: path.join(foreign, 'no-such-checkout'),
};

const BINDINGS = {
  PATH: process.env.PATH,
  home: path.join(foreign, 'home'),
  NODE_OPTIONS: `--require=${GUARD}`,
  REVIEW_NOW: '0',
  REVIEW_LOG: path.join(foreign, 'log'),
};

(async () => {
  try {
    // ---- 1. MECHANISM: the three ambient keys are scrubbed -----------------
    for (const [key, value] of Object.entries(AMBIENT)) process.env[key] = value;

    let observed = null;
    withEnv(cliEnv(BINDINGS), () => {
      observed = {
        CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
        CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
        VIEW_LIMITS_ROOT: process.env.VIEW_LIMITS_ROOT,
      };
    });
    for (const key of Object.keys(AMBIENT)) {
      assert.strictEqual(observed[key], undefined,
        `${key} must be deleted inside the withEnv scope — a leak lets the `
        + 'gated CLI child read a foreign config/cache instead of the '
        + 'hermetic fixture (#78)');
      assert.strictEqual(process.env[key], AMBIENT[key],
        `${key} must be restored after the withEnv scope`);
    }

    // An explicit option still wins over the scrub.
    withEnv(cliEnv(BINDINGS, { VIEW_LIMITS_ROOT: '/explicit-root' }), () =>
      assert.strictEqual(process.env.VIEW_LIMITS_ROOT, '/explicit-root',
        'explicit VIEW_LIMITS_ROOT must pass through cliEnv unchanged'));

    // STUB_STDOUT set by a caller (installStubCli) is untouched by cliEnv().
    process.env.STUB_STDOUT = 'canned';
    withEnv(cliEnv(BINDINGS), () =>
      assert.strictEqual(process.env.STUB_STDOUT, 'canned',
        'conditional STUB_* pass-through must keep working'));
    delete process.env.STUB_STDOUT;

    // ---- 2. REPRO: the verbatim #78 command with all three keys exported ---
    const r = spawnSync(process.execPath, [HARNESS], {
      cwd: ROOT,
      env: { ...process.env, ...AMBIENT },
      encoding: 'utf8',
      timeout: 55_000,
    });
    assert.strictEqual(r.status, 0,
      'opencode-harness must pass with ambient plugin env exported '
      + '(verbatim #78 repro: CLAUDE_PLUGIN_DATA=~/.view-limits node '
      + 'test/opencode-harness.test.js):\n'
      + `${r.stdout || ''}\n${r.stderr || ''}`);

    console.log('cliEnv/withEnv ambient-key scrubbing + dirty-shell #78 repro: PASS');
    fs.rmSync(foreign, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    console.error(`  ✗ ${e.stack || e.message}`);
    process.exit(1);
  }
})();
