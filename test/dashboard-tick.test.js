'use strict';
// Issue #61 — the interval loop end to end: a real daemon collects on start and
// then on its configured tick. Its own file because the shortest valid
// interval is 15 s, and test/run.js gives each file 60 s.

const assert = require('assert');
const {
  ROUTE, scratch, vl, apiStatus, providerCalls, until, note, cleanup, dirs,
} = require('./helpers/dashboard-harness');
const fs = require('fs');

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('collects on start, then on interval ticks (config interval honoured; the flag overrides it)', async () => {
  const dir = scratch({ routes: [ROUTE], gate: { mode: 'deny' }, dashboard: { intervalSeconds: 15 } });
  assert.strictEqual((await vl(dir, ['dashboard', 'start'])).status, 0);
  note(dir);
  const st = JSON.parse((await vl(dir, ['dashboard', 'status', '--json'], { preload: false })).stdout);
  assert.strictEqual(st.intervalSeconds, 15, 'config.dashboard.intervalSeconds');
  await until(() => providerCalls(dir) >= 1, 'the startup collection');
  await until(() => providerCalls(dir) >= 2, 'the first interval tick', 25_000);
  assert.ok((await apiStatus(dir)).collection.attempts >= 2);
  assert.strictEqual((await vl(dir, ['dashboard', 'stop'], { preload: false })).status, 0);

  const flagged = await vl(dir, ['dashboard', 'start', '--interval', '20']);
  assert.strictEqual(flagged.status, 0, flagged.stderr);
  note(dir);
  assert.match(flagged.stdout, /interval 20s, from flag/);
  assert.strictEqual(JSON.parse((await vl(dir, ['dashboard', 'status', '--json'], { preload: false })).stdout).intervalSeconds, 20);
});

(async () => {
  try {
    for (const { name, fn } of cases) {
      try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
    }
  } finally { await cleanup(); }
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall dashboard-tick tests passed');
  process.exit(0);
})();
