'use strict';
// A refresh must not HIDE a failure (Issue #60, R1).
//
// A route whose fetch failed keeps its prior observation — with its prior
// age — but the output still has to say that the fetch failed, which route it
// was and what the error was. Before #60 the inventory carried the error
// inline (the route had been overwritten with an unknown status); after #60
// the route keeps its old fact, so the failure moves to its own line.
//
// One real subprocess per assertion against an isolated data directory, with
// the repo's own fake provider (test/fixtures/refresh-cli-preload.cjs): no
// network, no keychain, no real credential.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VL = path.join(PLUGIN_ROOT, 'bin', 'vl.js');
const PRELOAD = path.join(__dirname, 'fixtures', 'refresh-cli-preload.cjs');

const ROUTE_ID = 'kimi-code-plan';
const PRIOR_AT = '2026-10-13T09:45:00.000Z';
const PRIOR_UNTIL = '2026-10-13T09:48:00.000Z';
const ERROR = 'HTTP 502: upstream unavailable';

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

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-refresh-fail-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [{ id: ROUTE_ID, provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 123 }],
    gate: { mode: 'deny', injectContext: true },
    refreshOnSessionStart: true,
  }));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    updatedAt: PRIOR_AT,
    routes: {
      [ROUTE_ID]: {
        routeId: ROUTE_ID,
        observedAt: PRIOR_AT,
        freshUntil: PRIOR_UNTIL,
        source: 'kimi',
        status: {
          state: 'healthy',
          windows: [{ type: 'rolling-5h', remaining: 10, limit: 100 }],
          balance: null,
          resetAt: null,
        },
      },
    },
  }));
  return dir;
}

function refresh(dir, args = []) {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    CLAUDE_PLUGIN_DATA: dir,
    NODE_OPTIONS: `--require=${PRELOAD}`,
    VL_REFRESH_FAIL: '1',
  };
  const r = spawnSync(process.execPath, [VL, 'refresh', ...args], { env, encoding: 'utf8', timeout: 15000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('a failed fetch keeps the prior observation AND says so on stdout', () => {
  const dir = scratch();
  const r = refresh(dir);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.match(r.stdout, new RegExp(ROUTE_ID), 'the route id is named');
  assert.match(r.stdout, /refresh failed/, 'the failure is named');
  assert.match(r.stdout, /HTTP 502: upstream unavailable/, 'the error is named');
  assert.match(r.stdout, new RegExp(PRIOR_AT), 'the retained observation time is named');
  assert.match(r.stdout, new RegExp(`rotate via /view-limits:update ${ROUTE_ID}`),
    'the rotate hint the inventory printed is kept');
  // The prior entry survived, with its age.
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.strictEqual(doc.routes[ROUTE_ID].observedAt, PRIOR_AT, 'the age is unchanged');
  assert.strictEqual(doc.routes[ROUTE_ID].freshUntil, PRIOR_UNTIL, 'the age is unchanged');
  assert.strictEqual(doc.routes[ROUTE_ID].status.state, 'healthy', 'the prior facts are kept');
});

test('--quiet prints nothing at all', () => {
  const dir = scratch();
  const r = refresh(dir, ['--quiet']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.strictEqual(r.stdout, '', 'a quiet refresh is silent, even about a failure');
});

test('the failure line is one line, whatever the provider error carries', () => {
  const dir = scratch();
  const r = refresh(dir);
  const lines = r.stdout.split('\n').filter((l) => l.includes('refresh failed'));
  assert.strictEqual(lines.length, 1, 'exactly one failure line');
  assert.ok(!lines[0].includes('\n'), 'the failure line is one line');
});

if (failures) {
  console.error(`\n${failures} refresh failure test(s) failed`);
  process.exit(1);
}
console.log('\nall refresh failure tests passed');
