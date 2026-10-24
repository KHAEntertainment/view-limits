'use strict';
// CLI coverage for `vl.js view` (Issue #59) — the versioned view schema
// rendered as text or as one always-valid JSON envelope.
//
// One real subprocess per assertion against an isolated CLAUDE_PLUGIN_DATA
// directory. No network, no real credentials: the credential store is
// exercised only through the FILE backend in a scratch directory, and only
// for presence.
//
// The configuration states the command distinguishes are asserted by their
// exit code, which is the dispatch's own vocabulary:
//   0  a confirmed configuration (the empty envelope when it has no routes)
//   8  stored credentials that were never migrated into routes
//   9  a configuration that could not be confirmed
//  10  a configuration that exists but cannot be parsed

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VL = path.join(PLUGIN_ROOT, 'bin', 'vl.js');
const GUARD = path.join(__dirname, 'guard.cjs');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-view-'));
}

function writeConfig(dir, routes) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes,
    gate: { mode: 'off', constrainedThreshold: 0.2 },
    vault: { backend: 'file', service: 'com.kha.view-limits' },
  }, null, 2));
}

const ROUTES = [
  { id: 'minimax-token-plan', provider: 'minimax', account: 'token-plan', match: { model: 'minimax' }, ttlSeconds: 180 },
  { id: 'deepseek-direct', provider: 'deepseek', account: 'personal', match: { model: 'deepseek' }, ttlSeconds: 120 },
];

function writeCache(dir, rows) {
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    routes: rows,
  }, null, 2));
}

function freshEntry(id, status) {
  return {
    routeId: id,
    observedAt: '2026-10-13T09:45:00Z',
    freshUntil: '2099-01-01T00:00:00Z',
    source: 'adapter',
    status,
  };
}

function vl(dir, args, opts = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dir };
  if (opts.guard) {
    env.NODE_OPTIONS = `--require ${GUARD}`;
    if (opts.log) env.REVIEW_LOG = opts.log;
  }
  const r = spawnSync(process.execPath, [VL, ...args], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---- the happy path ---------------------------------------------------------

test('view renders the expanded text format', () => {
  const dir = scratch();
  writeConfig(dir, ROUTES);
  writeCache(dir, {
    'minimax-token-plan': freshEntry('minimax-token-plan', {
      state: 'healthy',
      windows: [{ type: 'rolling-5h', remaining: 72, limit: 100, resetAt: '2099-01-01T12:00:00Z' }],
    }),
    'deepseek-direct': freshEntry('deepseek-direct', {
      state: 'healthy',
      balance: { available: 8.42, currency: 'USD' },
    }),
  });
  const r = vl(dir, ['view']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.startsWith('+---------------------------+\n|        View-Limits        |\n'), 'the view header');
  assert.ok(r.stdout.includes('QUOTA REMAINING'));
  assert.ok(r.stdout.includes('MiniMax                                          HEALTHY      FRESH'));
  assert.ok(r.stdout.includes('  5-hour   [##############------]   72% left'));
  assert.ok(r.stdout.includes('  Balance  8.42 USD'));
  assert.ok(r.stdout.includes('2 healthy | 0 constrained | 0 exhausted | 0 unknown'), 'the summary line');
  assert.ok(!r.stdout.includes('*'), 'no markdown asterisks in the text');
});

test('view --condensed renders the condensed table', () => {
  const dir = scratch();
  writeConfig(dir, ROUTES);
  writeCache(dir, {
    'minimax-token-plan': freshEntry('minimax-token-plan', {
      state: 'healthy',
      windows: [{ type: 'rolling-5h', remaining: 72, limit: 100, resetAt: '2099-01-01T12:00:00Z' }],
    }),
    'deepseek-direct': freshEntry('deepseek-direct', {
      state: 'healthy',
      balance: { available: 8.42, currency: 'USD' },
    }),
  });
  const r = vl(dir, ['view', '--condensed']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const lines = r.stdout.split('\n');
  assert.strictEqual(lines[0], 'VIEW-LIMITS | QUOTA REMAINING');
  assert.ok(lines.includes('PROVIDER       WINDOW   REMAINING                LEFT  STATE'));
  assert.ok(lines.includes('MiniMax        5-hour   [##############------]    72%  HEALTHY'));
  assert.ok(lines.includes('DeepSeek       Balance  8.42 USD                       HEALTHY'));
});

test('view --json prints exactly one always-valid envelope', () => {
  const dir = scratch();
  writeConfig(dir, ROUTES);
  writeCache(dir, {
    'minimax-token-plan': freshEntry('minimax-token-plan', {
      state: 'healthy',
      windows: [{ type: 'rolling-5h', remaining: 72, limit: 100 }],
    }),
  });
  const r = vl(dir, ['view', '--json']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.status, 'ok');
  assert.ok(Array.isArray(doc.routes));
  assert.strictEqual(doc.routes.length, 2, 'both configured routes appear');
  const minimax = doc.routes.find((x) => x.id === 'minimax-token-plan');
  assert.strictEqual(minimax.provider, 'minimax');
  assert.strictEqual(minimax.state, 'healthy');
  assert.strictEqual(minimax.freshness, 'fresh');
  assert.strictEqual(minimax.quotaEligibility, 'eligible');
  assert.deepStrictEqual(minimax.windows[0], {
    type: 'rolling-5h', unit: null, remaining: 72, limit: 100, remainingRatio: 0.72, resetAt: null,
  });
  assert.strictEqual(minimax.balance, null);
  assert.strictEqual(minimax.reauth, null);
  // A configured route with no observation is unknown — never healthy.
  const deepseek = doc.routes.find((x) => x.id === 'deepseek-direct');
  assert.strictEqual(deepseek.state, 'unknown');
  assert.strictEqual(deepseek.quotaEligibility, 'unresolved');
  assert.ok(deepseek.reasonCodes.includes('no-cached-observation'));
});

test('a fresh install (a confirmed configuration with no routes) prints the empty envelope', () => {
  const dir = scratch();
  writeConfig(dir, []);
  const r = vl(dir, ['view', '--json']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.status, 'empty');
  assert.deepStrictEqual(doc.routes, []);
  assert.deepStrictEqual(doc.reasonCodes, ['no-routes-configured']);
});

test('the text form of a fresh install is a valid empty view', () => {
  const dir = scratch();
  writeConfig(dir, []);
  const r = vl(dir, ['view']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes('QUOTA REMAINING'));
  assert.ok(r.stdout.includes('0 healthy | 0 constrained | 0 exhausted | 0 unknown'));
});

// ---- the refusing states ----------------------------------------------------

test('a configuration that cannot be confirmed exits 9 with a valid envelope', () => {
  const dir = scratch();
  const r = vl(dir, ['view', '--json']);
  assert.strictEqual(r.status, 9, `exit 9 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.status, 'failed');
  assert.deepStrictEqual(doc.routes, []);
  assert.deepStrictEqual(doc.reasonCodes, ['config-inconclusive']);
  assert.ok(r.stderr.includes('config'), 'the diagnostic goes to stderr');
});

test('a corrupt configuration exits 10 with a valid envelope', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json at all');
  const r = vl(dir, ['view', '--json']);
  assert.strictEqual(r.status, 10, `exit 10 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.status, 'failed');
  assert.deepStrictEqual(doc.routes, []);
  assert.deepStrictEqual(doc.reasonCodes, ['config-corrupt']);
});

test('stored credentials that were never migrated exit 8 with a valid envelope', () => {
  const dir = scratch();
  writeConfig(dir, []);
  writeCache(dir, { 'minimax-token-plan': freshEntry('minimax-token-plan', { state: 'healthy' }) });
  // A stored credential for a route the configuration does not define: the
  // credential vault→routes migration has not resolved. The FILE backend
  // keeps one encrypted blob per route id inside the data directory, and the
  // probe reads its presence only — never the secret.
  fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'secrets', 'minimax-token-plan.enc'), 'not-a-real-ciphertext');
  const r = vl(dir, ['view', '--json']);
  assert.strictEqual(r.status, 8, `exit 8 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.status, 'failed');
  assert.deepStrictEqual(doc.routes, []);
  assert.deepStrictEqual(doc.reasonCodes, ['migration-pending']);
});

// ---- the cache-only guarantee -----------------------------------------------

test('view performs no network access and no subprocess', () => {
  const dir = scratch();
  const log = path.join(dir, 'review.log');
  writeConfig(dir, ROUTES);
  writeCache(dir, {
    'minimax-token-plan': freshEntry('minimax-token-plan', { state: 'healthy', windows: [{ type: 'weekly', remaining: 5, limit: 10 }] }),
  });
  const r = vl(dir, ['view'], { guard: true, log });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes('MiniMax'));
  const attempts = fs.existsSync(log)
    ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  assert.deepStrictEqual(attempts, [], 'the guard observed no side channel');
});

// ---- the report surface is untouched ----------------------------------------

test('report still renders its own surface, unchanged by view', () => {
  const dir = scratch();
  writeConfig(dir, ROUTES);
  writeCache(dir, {
    'minimax-token-plan': freshEntry('minimax-token-plan', { state: 'healthy', windows: [{ type: 'weekly', remaining: 5, limit: 10 }] }),
  });
  // A synthetic credential in the isolated FILE vault, so the report has a
  // configured route to show. No real credential is touched.
  fs.writeFileSync(path.join(dir, 'master.key'), 'synthetic-test-key');
  const previousDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  try {
    require('../lib/vault').set('minimax-token-plan', 'synthetic-secret');
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previousDir;
  }
  const r = vl(dir, ['report']);
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes('view-limits runtime inventory'), 'the report keeps its own header');
  assert.ok(r.stdout.includes('minimax-token-plan'), 'the report still lists the route');
  assert.ok(!r.stdout.includes('QUOTA REMAINING'), 'the report does not render the view layout');
});

// ---- bad arguments ----------------------------------------------------------

test('an unknown flag is a usage error', () => {
  const dir = scratch();
  writeConfig(dir, []);
  const r = vl(dir, ['view', '--nope']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('usage: vl.js view'));
  assert.strictEqual(r.stdout, '', 'no partial output on a usage error');
});

if (failures) {
  console.error(`\n${failures} view CLI test(s) failed`);
  process.exit(1);
}
console.log('\nall view CLI tests passed');
