'use strict';
// [#95] Integration coverage for the runner's WIRING (main()).
//
// test/data-dir-isolation.test.js unit-tests the helpers; this file pins that
// main() actually uses them. The choke point can otherwise be reverted while
// every unit test stays green — a review mutation probe showed exactly that
// (dropping `env: childEnv`, disabling the backstop, snapshotting nothing, or
// commenting out the scratch cleanup all survived).
//
// The pattern is the one test/run-failure.test.js already uses: run.js is
// copied into a temp dir together with the guard fixture and a few planted
// *.test.js files, and the COPY is spawned. The copy discovers only the
// planted files, so this never spawns the real suite and cannot recurse.
//
// Every case runs with an explicit, disposable environment:
//   HOME=<fake>              so the runner never watches the real ~/.view-limits
//   CLAUDE_PLUGIN_DATA=<sentinel>   the inherited dir the run must not touch
// The sentinel and the fake home are created under mktemp and removed after.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'run.js');
const PRELOAD = path.join(__dirname, 'fixtures', 'data-dir-guard.cjs');
const CONFIG = path.join(ROOT, 'lib', 'config.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const tmpdir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });

// A runner sandbox: a copy of run.js, the guard fixture next to it (so the
// copy's installPreload() finds it, exactly as the real runner does) and the
// planted test files.
function sandbox(planted) {
  const dir = tmpdir('vl-runner-iso-');
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  fs.copyFileSync(RUNNER, path.join(dir, 'run.js'));
  fs.copyFileSync(PRELOAD, path.join(dir, 'fixtures', 'data-dir-guard.cjs'));
  for (const [name, src] of Object.entries(planted)) {
    fs.writeFileSync(path.join(dir, name), src);
  }
  return dir;
}

// Spawn the copied runner with a disposable environment.
function runRunner(dir, extraEnv = {}) {
  const sentinel = tmpdir('vl-sentinel-');
  const home = tmpdir('vl-home-');
  const r = spawnSync(process.execPath, [path.join(dir, 'run.js')], {
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: sentinel, ...extraEnv },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return {
    r, sentinel, home,
    cleanup() { rm(sentinel); rm(home); },
  };
}

// The runner prints the scratch data dir it used; the scratch root is its
// parent.
function scratchRoot(stdout) {
  const m = String(stdout || '').match(/scratch CLAUDE_PLUGIN_DATA: (.+)/);
  return m ? path.dirname(m[1].trim()) : null;
}

function listing(dir) {
  try { return fs.readdirSync(dir).sort(); } catch { return []; }
}

console.log('runner wiring — the scratch dir and the guard are actually used');

test('a planted dataDir() write lands under the scratch path, not the inherited dir', () => {
  const artifact = tmpdir('vl-artifact-');
  const dir = sandbox({
    'a.test.js': `
'use strict';
const fs = require('fs');
const path = require('path');
const { dataDir } = require(${JSON.stringify(CONFIG)});
const dir = dataDir();
fs.writeFileSync(path.join(dir, 'planted.json'), 'planted-bytes');
// Copy the artifact out: the runner deletes the scratch tree when the run ends.
fs.copyFileSync(path.join(dir, 'planted.json'), path.join(process.env.VL_ARTIFACT_DIR, 'planted.json'));
console.log('PLANTED_DATA_DIR=' + dir);
console.log('PLANTED_SCRATCH=' + process.env.VL_TEST_SCRATCH);
`,
  });
  let run;
  try {
    run = runRunner(dir, { VL_ARTIFACT_DIR: artifact });
    assert.strictEqual(run.r.status, 0,
      `the run must pass, got ${run.r.status}: ${run.r.stderr || ''}`);
    const dataDir = (run.r.stdout.match(/PLANTED_DATA_DIR=(.+)/) || [])[1];
    const scratch = (run.r.stdout.match(/PLANTED_SCRATCH=(.+)/) || [])[1];
    assert.ok(dataDir && scratch, `the planted test must report where it wrote: ${run.r.stdout}`);
    assert.strictEqual(dataDir, path.join(scratch, 'data'),
      'dataDir() must resolve to the scratch data dir the runner handed the child');
    assert.notStrictEqual(dataDir, run.sentinel,
      'dataDir() must not resolve to the inherited dir');
    assert.deepStrictEqual(listing(run.sentinel), [],
      'the inherited dir must be untouched');
    assert.deepStrictEqual(listing(artifact), ['planted.json'],
      'the planted write must really have landed in the scratch dir');
    assert.strictEqual(fs.readFileSync(path.join(artifact, 'planted.json'), 'utf8'), 'planted-bytes');
  } finally {
    if (run) run.cleanup();
    rm(dir);
    rm(artifact);
  }
});

test('a planted write into the inherited dir fails the run with the [#95] message', () => {
  const sentinel = tmpdir('vl-sentinel-');
  const dir = sandbox({
    'a.test.js': `
'use strict';
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(sentinel, 'planted-inherited.json'))}, 'planted');
`,
  });
  const home = tmpdir('vl-home-');
  try {
    const r = spawnSync(process.execPath, [path.join(dir, 'run.js')], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: sentinel },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.strictEqual(r.status, 1, `the run must fail, got ${r.status}: ${r.stderr || ''}`);
    assert.match(r.stderr, /\[#95\] the inherited data dir changed during the run/,
      `the backstop must say what happened: ${r.stderr}`);
    assert.match(r.stderr, /planted-inherited\.json/,
      `the backstop must name the changed path: ${r.stderr}`);
  } finally {
    rm(dir);
    rm(sentinel);
    rm(home);
  }
});

test('a planted dataDir() that resolves to the inherited dir fails with vl-test-guard', () => {
  const sentinel = tmpdir('vl-sentinel-');
  const dir = sandbox({
    'a.test.js': `
'use strict';
process.env.CLAUDE_PLUGIN_DATA = ${JSON.stringify(sentinel)};
const { dataDir } = require(${JSON.stringify(CONFIG)});
console.log('PLANTED_DATA_DIR=' + dataDir());
`,
  });
  const home = tmpdir('vl-home-');
  try {
    const r = spawnSync(process.execPath, [path.join(dir, 'run.js')], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: sentinel },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.strictEqual(r.status, 1, `the run must fail, got ${r.status}: ${r.stderr || ''}`);
    assert.match(r.stderr, /vl-test-guard/,
      `the read guard must fire: ${r.stderr}`);
    assert.deepStrictEqual(listing(sentinel), [],
      'the inherited dir must still be untouched');
  } finally {
    rm(dir);
    rm(sentinel);
    rm(home);
  }
});

test('the scratch dir is gone after a failing test', () => {
  const dir = sandbox({
    'a.test.js': "process.exit(3);",
  });
  let run;
  try {
    run = runRunner(dir);
    assert.strictEqual(run.r.status, 1, `a failing test must fail the run, got ${run.r.status}`);
    const scratch = scratchRoot(run.r.stdout);
    assert.ok(scratch, `the runner must print the scratch dir: ${run.r.stdout}`);
    assert.strictEqual(fs.existsSync(scratch), false,
      `the scratch dir must be removed even when a test failed: ${scratch}`);
  } finally {
    if (run) run.cleanup();
    rm(dir);
  }
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall runner isolation tests passed');
