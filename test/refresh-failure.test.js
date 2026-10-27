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

function refresh(dir, args = [], extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    CLAUDE_PLUGIN_DATA: dir,
    NODE_OPTIONS: `--require=${PRELOAD}`,
    VL_REFRESH_FAIL: '1',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [VL, 'refresh', ...args], { env, encoding: 'utf8', timeout: 15000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('no credentials: refresh output is byte-identical to the pre-#60 message, and no native path runs', () => {
  const dir = scratch();
  const expected = 'view-limits: no credentials configured yet.\n\n' +
    'Run /view-limits:setup to add your provider keys (auto-imports MiniMax\n' +
    'from ~/.mmx/config.json, then opens a local browser form for the rest).\n';
  const r = refresh(dir, [], { VL_REFRESH_NO_VAULT: '1' });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.strictEqual(r.stdout, expected, 'the native-only no-credentials message is unchanged');
  assert.strictEqual(r.stderr, '');
});

test('a failed fetch keeps the prior observation AND says so on stdout', () => {
  const dir = scratch();
  const r = refresh(dir);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.match(r.stdout, new RegExp(ROUTE_ID), 'the route id is named');
  assert.match(r.stdout, /refresh failed/, 'the failure is named');
  assert.match(r.stdout, /HTTP 502: upstream unavailable/, 'the error is named');
  assert.match(r.stdout, new RegExp(PRIOR_AT), 'the retained observation time is named');
  assert.match(r.stdout, new RegExp(`rotate ${ROUTE_ID} via /view-limits:update`),
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

test('a multi-line provider error folds into exactly one line, and no fragment leaks onto its own line', () => {
  const dir = scratch();
  const r = refresh(dir, [], { VL_REFRESH_FAIL_MULTILINE: '1' });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  // The EXACT failure line, with the error folded by oneLine into one line.
  const expected =
    'view-limits: kimi-code-plan refresh failed (HTTP 502: upstream unavailable retry later); ' +
    'showing the last observation from 2026-10-13T09:45:00.000Z ' +
    '(rotate kimi-code-plan via /view-limits:update)';
  assert.ok(r.stdout.includes(expected), `the exact folded failure line is missing:\n${r.stdout}`);
  // No fragment of the raw multi-line error reaches a line of its own.
  const lines = r.stdout.split('\n');
  const errorLines = lines.filter((l) => l.includes('upstream') || l.includes('retry later'));
  assert.strictEqual(errorLines.length, 1, 'the error appears on exactly one line');
  assert.strictEqual(errorLines[0], expected, 'that line IS the failure line');
  for (const line of lines) {
    assert.ok(!line.includes('\r'), 'no carriage return leaks into a line');
  }
});

test('terminal control characters (ESC, C1, BEL) never reach stdout raw', () => {
  const dir = scratch();
  const r = refresh(dir, [], { VL_REFRESH_FAIL_CONTROLS: '1' });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  // The fixture error carries ESC, C1 CSI and BEL.
  assert.ok(!r.stdout.includes('\u001b'), 'no raw ESC in stdout');
  assert.ok(!r.stdout.includes('\u009b'), 'no raw C1 CSI in stdout');
  assert.ok(!r.stdout.includes('\u0007'), 'no raw BEL in stdout');
  // The escaped forms are present on the single failure line.
  assert.ok(r.stdout.includes('\\u001b[2J'), 'the ESC is escaped (\\u001b)');
  assert.ok(r.stdout.includes('\\u009b31m'), 'the C1 CSI is escaped (\\u009b)');
  assert.ok(r.stdout.includes('\\u0007'), 'BEL is escaped (\\u0007)');
  const failureLines = r.stdout.split('\n').filter((l) => l.includes('refresh failed'));
  assert.strictEqual(failureLines.length, 1, 'exactly one failure line');
});

if (failures) {
  console.error(`\n${failures} refresh failure test(s) failed`);
  process.exit(1);
}
console.log('\nall refresh failure tests passed');
