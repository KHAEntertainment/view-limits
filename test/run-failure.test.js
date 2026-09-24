'use strict';
// Runner failure propagation: an injected test file that exits non-zero or
// receives a signal must make test/run.js exit 1; subsequent discovered test
// files must still run (so a single bad file does not silently truncate the
// suite). Copies test/run.js into a temp dir with crafted *.test.js files
// and spawns it from there. Does NOT modify the real run.js or any committed
// test file.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'run.js');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

function tempRunner() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-runner-'));
  fs.copyFileSync(RUNNER, path.join(dir, 'run.js'));
  return dir;
}

console.log('runner — non-zero exit propagates and subsequent files still run');

test('injected test exiting 7 makes runner exit 1 and LAST_FILE_RAN still printed', () => {
  const dir = tempRunner();
  fs.writeFileSync(path.join(dir, 'a.test.js'), 'process.exit(0)');
  fs.writeFileSync(path.join(dir, 'b.test.js'), 'process.exit(7)');
  fs.writeFileSync(path.join(dir, 'c.test.js'), "console.log('LAST_FILE_RAN')");
  const r = spawnSync(process.execPath, [path.join(dir, 'run.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `runner must exit 1 when a test exits 7; got ${r.status}`);
  assert.match(r.stdout, /LAST_FILE_RAN/, 'subsequent test files must still run after a failure');
});

test('injected test killed by SIGTERM makes runner exit 1', () => {
  const dir = tempRunner();
  fs.writeFileSync(path.join(dir, 'a.test.js'), 'process.exit(0)');
  fs.writeFileSync(path.join(dir, 'b.test.js'), "process.kill(process.pid, 'SIGTERM')");
  fs.writeFileSync(path.join(dir, 'c.test.js'), 'process.exit(0)');
  const r = spawnSync(process.execPath, [path.join(dir, 'run.js')], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `runner must exit 1 when a test is killed by signal; got ${r.status}`);
});

// Meta-test on the harness itself: a hung test file must fail the suite via
// run.js's per-file spawn timeout — the gate is only real if it is pinned.
// The copied runner's timeout is shortened so this test is deterministic.
test('a hanging test file makes the runner exit 1 with TIMEOUT (hang-fails-suite pin)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-runner-'));
  const src = fs.readFileSync(RUNNER, 'utf8');
  const patched = src.replace('timeout: 60_000', 'timeout: 750');
  assert.notStrictEqual(patched, src, 'runner source must contain the 60s timeout literal');
  fs.writeFileSync(path.join(dir, 'run.js'), patched);
  fs.writeFileSync(path.join(dir, 'a.test.js'), 'process.exit(0)');
  fs.writeFileSync(path.join(dir, 'z.test.js'), 'setInterval(() => {}, 1000)');
  const r = spawnSync(process.execPath, [path.join(dir, 'run.js')],
    { encoding: 'utf8', timeout: 15000 });
  assert.strictEqual(r.status, 1, `runner must exit 1 when a test file hangs; got ${r.status}`);
  assert.match(r.stderr, /TIMEOUT/, `hang must be reported as TIMEOUT: ${r.stderr}`);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall runner failure tests passed');
