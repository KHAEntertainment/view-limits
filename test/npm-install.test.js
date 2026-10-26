'use strict';
// Issue #103 — the runtime dependency install (lib/npm-install.js) and the
// setup/update wiring around it (bin/vl.js installBannerDependency).
//
// Offline and npm-free, every case:
//   * the unit cases drive the `run` seam with a fake runner
//   * the ENOENT case points PATH at an empty dir, so the REAL runner cannot
//     resolve npm at all
//   * the CLI cases put a fake `npm` first on PATH — it records its argv and
//     exits 1 — so the notice line is proven against a failing install
// No real npm is spawned and no network is touched.
//
// What it covers:
//   * the fixed contract: `npm ci --omit=dev`, cwd = the plugin root
//   * a nonzero status is ok:false — never a throw
//   * a missing npm (ENOENT) is status -1 — never a throw
//   * the pinned version already installed → skipped, nothing run
//   * a stale installed version → runs
//   * setup and update print the notice line and still succeed (exit 0)
//     when the install fails

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VL = path.join(ROOT, 'bin', 'vl.js');

const { installDependencies } = require('../lib/npm-install');

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A plugin root whose package.json pins the dependency at 0.4.0, with an
// optional version installed under node_modules — the only two states the
// skip/run decision turns on.
function pluginRoot({ installed = null } = {}) {
  const root = scratch('vl-plugin-root-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'view-limits-fixture',
    version: '0.0.0',
    private: true,
    dependencies: { 'ascii.rest': '0.4.0' },
  }, null, 2));
  if (installed) {
    const pkg = path.join(root, 'node_modules', 'ascii.rest');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'ascii.rest', version: installed,
    }, null, 2));
  }
  return root;
}

// A fake `npm` on PATH: it writes its own argv to FAKE_NPM_LOG and fails.
function fakeNpm() {
  const bin = scratch('vl-fake-npm-');
  const log = path.join(bin, 'argv.log');
  const script = path.join(bin, 'npm');
  fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_NPM_LOG"\nexit 1\n');
  fs.chmodSync(script, 0o755);
  return { bin, log };
}

function readNpmArgv(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// The CLI under a failing install: the plugin root is pinned but NOT
// installed (so the install runs), PATH finds the fake npm first, and the
// data dir / home are scratch. The guard preload the runner installed stays
// in NODE_OPTIONS — `...process.env` keeps it.
function runCli(args) {
  const data = scratch('vl-npm-data-');
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    routes: [],
    gate: { mode: 'off', constrainedThreshold: 0.2 },
    vault: { backend: 'file', service: 'com.kha.view-limits' },
  }, null, 2));
  const npm = fakeNpm();
  const env = {
    ...process.env,
    PATH: `${npm.bin}${path.delimiter}${process.env.PATH}`,
    HOME: scratch('vl-npm-home-'),
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PLUGIN_ROOT: pluginRoot(),
    VIEW_LIMITS_MASTER_KEY: 'k',
    FAKE_NPM_LOG: npm.log,
  };
  const r = spawnSync(process.execPath, [VL, ...args], {
    env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    npmArgv: readNpmArgv(npm.log),
  };
}

// ---- the seam ----------------------------------------------------------------

test('runs exactly `npm ci --omit=dev`, with cwd = the plugin root', () => {
  const root = pluginRoot();
  const calls = [];
  const r = installDependencies({
    pluginRoot: root,
    run: (call) => { calls.push(call); return { status: 0 }; },
  });
  assert.strictEqual(calls.length, 1, 'the runner was called once');
  assert.deepStrictEqual(calls[0], { command: 'npm', args: ['ci', '--omit=dev'], cwd: root },
    'fixed args and cwd');
  assert.deepStrictEqual(r, { ok: true, status: 0, skipped: false });
});

test('a nonzero status is ok:false, never a throw', () => {
  const root = pluginRoot();
  const r = installDependencies({ pluginRoot: root, run: () => ({ status: 3 }) });
  assert.deepStrictEqual(r, { ok: false, status: 3, skipped: false });
  // A runner that reports no status at all (the spawn died before exiting)
  // is a failure too — still no throw.
  const none = installDependencies({ pluginRoot: root, run: () => ({}) });
  assert.deepStrictEqual(none, { ok: false, status: -1, skipped: false });
});

test('a missing npm (ENOENT) is status -1, never a throw', () => {
  const root = pluginRoot();
  const empty = scratch('vl-empty-path-');
  const previousPath = process.env.PATH;
  let r;
  let probe;
  try {
    process.env.PATH = empty;
    // Premise: that PATH really cannot resolve npm, so the -1 below IS the
    // ENOENT path and not some other failure.
    probe = spawnSync('npm', ['--version'], { encoding: 'utf8' });
    r = installDependencies({ pluginRoot: root }); // the REAL default runner
  } finally {
    process.env.PATH = previousPath;
  }
  assert.ok(probe.error && probe.error.code === 'ENOENT',
    `premise: npm is unresolvable (got ${probe.error && probe.error.code})`);
  assert.deepStrictEqual(r, { ok: false, status: -1, skipped: false });
});

test('the pinned version already installed is skipped, and nothing runs', () => {
  const root = pluginRoot({ installed: '0.4.0' });
  const calls = [];
  const r = installDependencies({
    pluginRoot: root,
    run: (call) => { calls.push(call); return { status: 0 }; },
  });
  assert.strictEqual(calls.length, 0, 'the runner was NOT called');
  assert.deepStrictEqual(r, { ok: true, status: 0, skipped: true });
});

test('a stale installed version runs the install', () => {
  const root = pluginRoot({ installed: '0.3.0' });
  const calls = [];
  const r = installDependencies({
    pluginRoot: root,
    run: (call) => { calls.push(call); return { status: 0 }; },
  });
  assert.strictEqual(calls.length, 1, 'the runner was called once');
  assert.deepStrictEqual(calls[0], { command: 'npm', args: ['ci', '--omit=dev'], cwd: root });
  assert.deepStrictEqual(r, { ok: true, status: 0, skipped: false });
});

// ---- the setup/update wiring --------------------------------------------------

test('update prints the notice line and still succeeds when the install fails', () => {
  const r = runCli(['update']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.strictEqual(r.npmArgv, 'ci\n--omit=dev\n', 'the fake npm ran ci --omit=dev');
  assert.match(r.stderr, /view-limits: installing the view banner dependency/,
    'the line before the install');
  assert.match(r.stderr, /view-limits: could not install the view banner dependency/,
    'the failure notice');
  assert.match(r.stderr, /no credentials to update/, 'the command itself succeeded');
});

test('setup prints the notice line and still succeeds when the install fails', () => {
  const r = runCli(['setup', 'kimi-code-plan', '--key', 'kimi-test-key']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.strictEqual(r.npmArgv, 'ci\n--omit=dev\n', 'the fake npm ran ci --omit=dev');
  assert.match(r.stderr, /view-limits: installing the view banner dependency/,
    'the line before the install');
  assert.match(r.stderr, /view-limits: could not install the view banner dependency/,
    'the failure notice');
  assert.match(r.stderr, /stored credential for "kimi-code-plan"/, 'the command itself succeeded');
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nnpm install: ok');
