'use strict';
// Discover every test/*.test.js file in this directory and run it as its own
// subprocess so failures in one file do not silently corrupt another. Aggregates
// exit codes; non-zero on any failure. Run: node test/run.js

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDir = __dirname;
const files = fs.readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('no test files found under', testDir);
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  // [#4] Per-file timeout: hung async tests must fail the suite, not silently
  // disappear.  60s is generous for fixture tests; anything longer is a hang.
  const r = spawnSync(process.execPath, [path.join(testDir, f)], { stdio: 'inherit', timeout: 60_000 });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') {
      console.error(`  TIMEOUT after 60s — test file hung (likely deadlocked async test)`);
    } else {
      console.error(`  spawn error: ${r.error.message}`);
    }
    failed += 1;
    continue;
  }
  if (r.status !== 0) failed += 1;
}

if (failed) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}
console.log('\nall test files passed');
