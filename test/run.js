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
  const r = spawnSync(process.execPath, [path.join(testDir, f)], { stdio: 'inherit' });
  if (r.error) {
    console.error(`  spawn error: ${r.error.message}`);
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
