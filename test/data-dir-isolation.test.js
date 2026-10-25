'use strict';
// [#95] Regression coverage for the runner's per-run data-dir isolation.
//
// Two layers, both unit-tested here without spawning the suite (spawning
// test/run.js from a test file would make the runner discover — and re-run —
// this file, so the acceptance evidence is produced from the shell instead,
// see the PR):
//
//   1. The runner hands every child an explicit env: CLAUDE_PLUGIN_DATA is a
//      fresh per-run scratch dir and the forbidden set (the dirs the runner
//      inherited) travels in VL_FORBIDDEN_DATA_DIRS. HOME is inherited
//      unchanged — the Traycer native read needs the real HOME. The scratch
//      tree is removed when the run ends, failure or not.
//
//   2. test/fixtures/data-dir-guard.cjs is installed into every child via
//      NODE_OPTIONS and makes dataDir() throw when it resolves to a forbidden
//      dir. This is the READ guard.
//
// The runner's before/after snapshot of the inherited dirs is the WRITE
// backstop and the guard of record — it catches a write that never went
// through dataDir(), which the read guard cannot see (calls made from inside
// lib/config.js itself use the local function and bypass the exported one).
// Its diff logic is unit-tested here.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const runner = require('./run.js');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'lib', 'config.js');
const PRELOAD = path.join(__dirname, 'fixtures', 'data-dir-guard.cjs');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Run a snippet in a child process with the read guard installed. The child
// resolves lib/config.js dataDir() and prints it; a forbidden dir must make
// the guard throw instead.
function resolveDataDir(env) {
  const childEnv = {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require="${PRELOAD}"`,
    ...env,
  };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  const script = `const { dataDir } = require(${JSON.stringify(CONFIG)}); process.stdout.write(String(dataDir()));`;
  const r = spawnSync(process.execPath, ['-e', script], { env: childEnv, encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

console.log('runner — inherited data dir is never handed to a child');

test('inheritedTargets lists the inherited CLAUDE_PLUGIN_DATA and the ~/.view-limits fallback', () => {
  const targets = runner.inheritedTargets({ CLAUDE_PLUGIN_DATA: '/inherited/data' }, '/home/me');
  assert.ok(targets.includes(path.resolve('/inherited/data')),
    `the inherited CLAUDE_PLUGIN_DATA must be forbidden, got ${JSON.stringify(targets)}`);
  assert.ok(targets.includes(path.resolve('/home/me/.view-limits')),
    `the ~/.view-limits fallback must be forbidden, got ${JSON.stringify(targets)}`);
});

test('inheritedTargets without CLAUDE_PLUGIN_DATA still forbids the home fallback', () => {
  const targets = runner.inheritedTargets({}, '/home/me');
  assert.deepStrictEqual(targets, [path.resolve('/home/me/.view-limits')]);
});

test('forbiddenFromEnv reads the set a parent runner passed down', () => {
  const raw = [path.resolve('/a/b'), path.resolve('/c/d')].join(path.delimiter);
  assert.deepStrictEqual(runner.forbiddenFromEnv({ [runner.FORBIDDEN_ENV]: raw }),
    [path.resolve('/a/b'), path.resolve('/c/d')]);
  assert.deepStrictEqual(runner.forbiddenFromEnv({}), []);
});

test('buildChildEnv points CLAUDE_PLUGIN_DATA at the scratch tree', () => {
  const env = runner.buildChildEnv({ PATH: '/bin', CLAUDE_PLUGIN_DATA: '/inherited/data' }, '/scratch', ['/inherited/data']);
  assert.strictEqual(env.CLAUDE_PLUGIN_DATA, path.join('/scratch', 'data'));
  assert.strictEqual(env[runner.SCRATCH_ENV], '/scratch');
  assert.strictEqual(env[runner.FORBIDDEN_ENV], path.resolve('/inherited/data'));
  assert.strictEqual(env.PATH, '/bin', 'the rest of the environment is inherited unchanged');
});

test('buildChildEnv does NOT override HOME — the Traycer native read needs it', () => {
  // A scratch HOME makes dataDir()'s ~/.view-limits fallback hermetic, but it
  // breaks lib/traycer-adapter.js: the `traycer` CLI it spawns needs the real
  // HOME to find its own state, and view-cli.test.js then dies with
  // "collection failed — native-unavailable (traycer-read-failed)". The
  // fallback is covered by forbidding the real ~/.view-limits instead.
  const env = runner.buildChildEnv({ PATH: '/bin', HOME: '/home/me' }, '/scratch', []);
  assert.strictEqual(env.HOME, '/home/me', 'HOME must be inherited unchanged');
  assert.ok(!env.HOME.startsWith('/scratch'), 'HOME must not point into the scratch tree');
});

test('buildChildEnv keeps the forbidden set of a parent runner', () => {
  const inherited = path.resolve('/inherited/data');
  const parent = path.resolve('/parent/forbidden');
  const env = runner.buildChildEnv({ [runner.FORBIDDEN_ENV]: parent }, '/scratch', [inherited]);
  const list = env[runner.FORBIDDEN_ENV].split(path.delimiter);
  assert.ok(list.includes(inherited) && list.includes(parent),
    `both forbidden dirs must survive, got ${env[runner.FORBIDDEN_ENV]}`);
});

test('installPreload adds the read guard and keeps an existing NODE_OPTIONS', () => {
  const env = runner.installPreload({ NODE_OPTIONS: '--require=/other.cjs' }, __dirname);
  assert.match(env.NODE_OPTIONS, /--require=.*data-dir-guard\.cjs/);
  assert.match(env.NODE_OPTIONS, /--require=\/other\.cjs/, 'the existing NODE_OPTIONS must survive');
});

test('installPreload leaves NODE_OPTIONS alone when the preload is not next to the runner', () => {
  const dir = tmpdir('vl-no-fixtures-');
  try {
    const env = runner.installPreload({ NODE_OPTIONS: '--require=/other.cjs' }, dir);
    assert.strictEqual(env.NODE_OPTIONS, '--require=/other.cjs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('\nrunner — the scratch tree is removed when the run ends');
// The scratch cleanup is covered end-to-end by test/run-isolation.test.js
// ("the scratch dir is gone after a failing test"), which spawns the runner.
// A source-regex check used to stand in for it here, and a review mutation
// probe showed it survives commenting the cleanup out — the regex matched the
// text inside the comment. The behavioural check replaced it.

console.log('\nwrite backstop — the snapshot diff sees every change');

test('snapshotTree + diffSnapshots report added, removed and modified entries', () => {
  const dir = tmpdir('vl-snap-');
  try {
    fs.writeFileSync(path.join(dir, 'status.json'), '{"a":1}');
    const before = runner.snapshotTree(dir);
    assert.deepStrictEqual(runner.diffSnapshots(before, runner.snapshotTree(dir)), [],
      'an unchanged tree must diff clean');

    fs.writeFileSync(path.join(dir, 'status.json'), '{"a":2}');
    fs.writeFileSync(path.join(dir, 'extra.json'), '{}');
    fs.rmSync(path.join(dir, 'status.json'));
    const changes = runner.diffSnapshots(before, runner.snapshotTree(dir));
    const kinds = changes.map((c) => `${c.change}:${c.path}`);
    assert.ok(kinds.includes('added:extra.json'),
      `the added entry must be reported, got ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('removed:status.json'),
      `the removed entry must be reported, got ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes('modified:.'),
      `the root dir mtime must be reported too, got ${JSON.stringify(kinds)}`);

    fs.writeFileSync(path.join(dir, 'status.json'), '{"a":1}');
    const modified = runner.diffSnapshots(before, runner.snapshotTree(dir));
    assert.ok(modified.some((c) => c.change === 'modified' && c.path === 'status.json'),
      `a rewritten file must be reported as modified, got ${JSON.stringify(modified)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a same-size rewrite with the mtime restored is still caught (ctime)', () => {
  const dir = tmpdir('vl-snap-');
  try {
    const file = path.join(dir, 'status.json');
    fs.writeFileSync(file, '{"a":1}');
    const before = runner.snapshotTree(dir);
    const st = fs.statSync(file);
    fs.writeFileSync(file, '{"a":2}'); // same size, different bytes
    fs.utimesSync(file, st.atimeMs / 1000, st.mtimeMs / 1000); // restore the mtime
    const after = fs.statSync(file);
    assert.strictEqual(after.size, st.size, 'the rewrite must be the same size');
    assert.ok(Math.abs(after.mtimeMs - st.mtimeMs) < 0.001,
      `the mtime must be restored, got ${after.mtimeMs} vs ${st.mtimeMs}`);
    const changes = runner.diffSnapshots(before, runner.snapshotTree(dir));
    assert.ok(changes.some((c) => c.path === 'status.json'),
      `a same-size, mtime-restored rewrite must still be caught, got ${JSON.stringify(changes)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file created and deleted inside the run is caught (root dir mtime)', () => {
  const dir = tmpdir('vl-snap-');
  try {
    fs.writeFileSync(path.join(dir, 'status.json'), '{"a":1}');
    const before = runner.snapshotTree(dir);
    const tmp = path.join(dir, 'refresh.lock');
    fs.writeFileSync(tmp, 'x');
    fs.rmSync(tmp); // the lock file's normal lifecycle
    const changes = runner.diffSnapshots(before, runner.snapshotTree(dir));
    assert.ok(changes.some((c) => c.path === '.' && c.change === 'modified'),
      `the root dir mtime must catch the create+delete, got ${JSON.stringify(changes)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('snapshotTree of a missing dir is empty rather than an error', () => {
  const snap = runner.snapshotTree(path.join(os.tmpdir(), 'vl-does-not-exist-' + process.pid));
  assert.strictEqual(snap.size, 0);
});

console.log('\nread guard — dataDir() refuses the inherited dir');

test('dataDir() throws when it resolves to a forbidden dir', () => {
  const forbidden = tmpdir('vl-forbidden-');
  try {
    const r = resolveDataDir({
      CLAUDE_PLUGIN_DATA: forbidden,
      VL_FORBIDDEN_DATA_DIRS: forbidden,
    });
    assert.notStrictEqual(r.status, 0, 'the guard must fail the child');
    assert.match(r.stderr, /vl-test-guard/,
      `the guard must say why it failed, got: ${r.stderr}`);
  } finally {
    fs.rmSync(forbidden, { recursive: true, force: true });
  }
});

test('dataDir() still resolves a scratch dir the runner handed the child', () => {
  const scratch = tmpdir('vl-allowed-');
  try {
    const r = resolveDataDir({
      CLAUDE_PLUGIN_DATA: scratch,
      VL_FORBIDDEN_DATA_DIRS: path.resolve('/somewhere/else'),
    });
    assert.strictEqual(r.status, 0, `the guard must not fire on the scratch dir: ${r.stderr}`);
    assert.strictEqual(r.stdout, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('dataDir() throws when the ~/.view-limits fallback is forbidden', () => {
  const home = tmpdir('vl-home-');
  try {
    const r = resolveDataDir({
      HOME: home,
      VL_FORBIDDEN_DATA_DIRS: path.join(home, '.view-limits'),
    });
    assert.notStrictEqual(r.status, 0, 'the guard must fail the child');
    assert.match(r.stderr, /vl-test-guard/,
      `the guard must say why it failed, got: ${r.stderr}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('dataDir() resolves the ~/.view-limits fallback when it is not forbidden', () => {
  const home = tmpdir('vl-home-');
  try {
    const r = resolveDataDir({
      HOME: home,
      VL_FORBIDDEN_DATA_DIRS: path.resolve('/somewhere/else'),
    });
    assert.strictEqual(r.status, 0, `the guard must not fire on an allowed home: ${r.stderr}`);
    assert.strictEqual(r.stdout, path.join(home, '.view-limits'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall data-dir isolation tests passed');
