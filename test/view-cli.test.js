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
// The hermetic collector face for the tests that run a LIVE collection: a fake
// vault, a fake adapter, no network, and — the part #131 is about — a native
// Traycer read that never spawns a CLI.
const PRELOAD = path.join(PLUGIN_ROOT, 'test', 'fixtures', 'view-cli-preload.cjs');

// Issue #103: the static banner header — the ascii.rest "View-Limits" banner
// as plain text, 8 lines.
const EXPECTED_BANNER = [
  '▓┓  ▓┓ ▓▓▓┓ ▓▓▓▓▓┓ ▓┓  ▓┓       ▓┓     ▓▓▓┓ ▓┓  ▓┓ ▓▓▓┓ ▓▓▓▓▓┓  ▓▓▓┓',
  '▓┃  ▓┃ ┗▓┏┛ ▓┏━━━┛ ▓┃  ▓┃       ▓┃     ┗▓┏┛ ▓▓┓▓▓┃ ┗▓┏┛ ┗━▓┏━┛ ▓┏━━▓┓',
  '▓┃  ▓┃  ▓┃  ▓┃     ▓┃  ▓┃       ▓┃      ▓┃  ▓┏▓┏▓┃  ▓┃    ▓┃   ▓┃  ┗┛',
  '▓┃  ▓┃  ▓┃  ▓▓▓▓┓  ▓┃▓┓▓┃ ▓▓▓▓┓ ▓┃      ▓┃  ▓┃▓┃▓┃  ▓┃    ▓┃   ┗▓▓▓┓',
  '▓┃  ▓┃  ▓┃  ▓┏━━┛  ▓┃▓┃▓┃ ┗━━━┛ ▓┃      ▓┃  ▓┃┗┛▓┃  ▓┃    ▓┃    ┗━━▓┓',
  '┗▓┓▓┏┛  ▓┃  ▓┃     ▓▓┏▓▓┃       ▓┃      ▓┃  ▓┃  ▓┃  ▓┃    ▓┃   ▓┓  ▓┃',
  ' ┗▓┏┛  ▓▓▓┓ ▓▓▓▓▓┓ ▓┏┛┗▓┃       ▓▓▓▓▓┓ ▓▓▓┓ ▓┃  ▓┃ ▓▓▓┓   ▓┃   ┗▓▓▓┏┛',
  '  ┗┛   ┗━━┛ ┗━━━━┛ ┗┛  ┗┛       ┗━━━━┛ ┗━━┛ ┗┛  ┗┛ ┗━━┛   ┗┛    ┗━━┛',
];

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
  // [#131] A shell that belongs to an agent session exports TRAYCER_AGENT_ID,
  // TRAYCER_EPIC_ID and TRAYCER_CLI. Handed that launch identity, the spawned
  // `vl.js view` performs a REAL bounded Traycer read (lib/traycer-adapter.js)
  // — up to 10 s per CLI call — and a route-less view treats a read timeout as
  // fatal, so this file flaked at random on a loaded machine. No test here is
  // about the native read, and none may depend on a live Traycer, so the
  // inherited variables are dropped: without a launch identity the collector
  // never spawns a read at all. This is the same isolation
  // test/traycer-cli.test.js applies to its own children; a test that wants to
  // observe the native path stubs it through its preload instead.
  for (const key of Object.keys(env)) {
    if (key.startsWith('TRAYCER_')) delete env[key];
  }
  if (opts.guard) {
    env.NODE_OPTIONS = `--require ${GUARD}`;
    if (opts.log) env.REVIEW_LOG = opts.log;
  }
  if (opts.preload) {
    env.NODE_OPTIONS = `--require ${opts.preload}`;
  }
  if (opts.env) Object.assign(env, opts.env);
  const r = spawnSync(process.execPath, [VL, ...args], { env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Hold the shared refresh-worker lock, so the next collector finds another
// owner. The record names THIS process (which is alive), so the lock's
// recovery pass keeps it and the contender yields.
function holdWorkerLock(dir) {
  const workers = path.join(dir, 'refresh-workers');
  fs.mkdirSync(workers, { recursive: true });
  const file = path.join(workers, `${process.pid}-${'a'.repeat(32)}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, owner: 'test-holder', number: 1 }));
  return () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
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
  assert.ok(r.stdout.startsWith(EXPECTED_BANNER.join('\n') + '\n'), 'the view header');
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

test('a confirmed configuration with no routes is the always-valid empty envelope', () => {
  const dir = scratch();
  writeConfig(dir, []);
  // No routes, so this is the live collection with nothing to collect: the
  // native read must be the stub's, never a real Traycer's (#131).
  const r = vl(dir, ['view', '--json'], { preload: PRELOAD });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.status, 'empty');
  assert.deepStrictEqual(doc.routes, []);
  assert.deepStrictEqual(doc.reasonCodes, ['no-routes-configured']);
});

test('the text form of a confirmed configuration with no routes is a valid empty view', () => {
  const dir = scratch();
  writeConfig(dir, []);
  // The reported flake (#131): with nothing to render, a native Traycer read
  // that timed out failed the command instead of degrading.
  const r = vl(dir, ['view'], { preload: PRELOAD });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  assert.ok(r.stdout.includes('QUOTA REMAINING'));
  assert.ok(r.stdout.includes('0 healthy | 0 constrained | 0 exhausted | 0 unknown'));
});

// ---- the refusing states ----------------------------------------------------

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

test('an ABSENT configuration is the migration-pending class: exit 8, not a retry', () => {
  const dir = scratch();
  const r = vl(dir, ['view', '--json']);
  assert.strictEqual(r.status, 8, `exit 8 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.status, 'not-configured');
  assert.deepStrictEqual(doc.routes, []);
  assert.deepStrictEqual(doc.reasonCodes, ['config-absent']);
  assert.match(r.stderr, /No configuration yet/, 'the hint names the state');
  assert.match(r.stderr, /\/view-limits:setup/, 'the hint names the action');
});

test('a configuration that exists but cannot be confirmed is exit 9', () => {
  const dir = scratch();
  // Present by lstat (a swap in flight leaves the file there) but unreadable
  // by the reader: the unconfirmable class. A rerun may succeed.
  fs.symlinkSync(path.join(dir, 'never-published.json'), path.join(dir, 'config.json'));
  const r = vl(dir, ['view', '--json']);
  assert.strictEqual(r.status, 9, `exit 9 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.status, 'failed');
  assert.deepStrictEqual(doc.routes, []);
  assert.deepStrictEqual(doc.reasonCodes, ['config-inconclusive']);
});

// ---- the live collection (Issue #60) ---------------------------------------
//
// The view is a LIVE surface now: it runs the shared collector with a bounded
// wait and then renders what the collection published — or what it kept. The
// gate and the snapshot stay cache-only.

test('view --json emits exactly ONE envelope for a successful collection', () => {
  const dir = scratch();
  writeConfig(dir, ROUTES);
  const r = vl(dir, ['view', '--json'], { preload: PRELOAD });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout); // exactly one JSON document
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.collection.outcome, 'completed');
  assert.strictEqual(doc.collection.published, true);
  const minimax = doc.routes.find((x) => x.id === 'minimax-token-plan');
  assert.strictEqual(minimax.collection.outcome, 'completed');
  assert.strictEqual(minimax.state, 'healthy');
  assert.strictEqual(minimax.freshness, 'fresh');
});

test('view --json projects a live Xiaomi success as healthy/fresh (R2-2)', () => {
  const dir = scratch();
  writeConfig(dir, [{
    id: 'xiaomi-token-plan', provider: 'xiaomi', account: 'token-plan',
    match: { model: 'mimo' }, ttlSeconds: 0, credentialSource: 'chrome-cookies',
  }]);
  const r = vl(dir, ['view', '--json'], { preload: PRELOAD });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  const row = doc.routes.find((x) => x.id === 'xiaomi-token-plan');
  assert.ok(row, 'the Xiaomi route is listed');
  assert.strictEqual(row.state, 'healthy', 'the live observation renders healthy');
  assert.strictEqual(row.freshness, 'fresh', 'the live observation renders fresh');
  assert.strictEqual(row.windows[0].remaining, 75);
  assert.strictEqual(row.windows[0].type, 'tokens');
});

test('view --json: a SLOW native read does not expire the live Xiaomi display (F1)', () => {
  const dir = scratch();
  writeConfig(dir, [{
    id: 'xiaomi-token-plan', provider: 'xiaomi', account: 'token-plan',
    match: { model: 'mimo' }, ttlSeconds: 0, credentialSource: 'chrome-cookies',
  }]);
  // The native reader is delayed by 1500 ms — longer than the display
  // entry's one-second lifetime. The display projection must be built when
  // the status reader runs (after the native await), so the live Xiaomi row
  // still renders healthy/fresh.
  const r = vl(dir, ['view', '--json'], {
    preload: PRELOAD,
    env: { VL_VIEW_NATIVE_DELAY_MS: '1500' },
  });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  const row = doc.routes.find((x) => x.id === 'xiaomi-token-plan');
  assert.ok(row, 'the Xiaomi route is listed');
  assert.strictEqual(row.state, 'healthy', 'the live observation renders healthy despite the slow native read');
  assert.strictEqual(row.freshness, 'fresh', 'the live observation renders fresh despite the slow native read');
  assert.strictEqual(row.windows[0].remaining, 75);
  // The GATE cache entry is unchanged: raw, zero-TTL, with the live facts.
  const published = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  const entry = published.routes['xiaomi-token-plan'];
  assert.ok(entry, 'the cache entry was published');
  assert.strictEqual(entry.status.state, 'healthy');
  assert.ok(Date.parse(entry.freshUntil) - Date.parse(entry.observedAt) <= 1000,
    'the gate cache keeps ttlSeconds 0 (raw entry, display-only projection)');
});

// CR4 — a busy collector (another worker owns the lock) observes nothing, so
// the overlay would strip the cached Xiaomi entry and add nothing back. The
// row must be projected as pending instead, like refresh's contention path.
// The two lock outcomes the busy view handles: another worker owns the lock
// (in-progress), and the lock storage itself is unusable (lock-unavailable —
// here the workers directory is a regular file).
const LOCK_OUTCOMES = [
  {
    name: 'in-progress',
    hold: (dir) => holdWorkerLock(dir),
    outcome: 'in-progress', routeOutcome: 'pending', status: 0,
  },
  {
    name: 'lock-unavailable',
    hold: (dir) => { fs.writeFileSync(path.join(dir, 'refresh-workers'), 'not a directory'); return () => {}; },
    outcome: 'failed', routeOutcome: 'failed', status: 1,
  },
];

for (const lock of LOCK_OUTCOMES) {
  test(`view --json: a busy collector (${lock.name}) keeps the Xiaomi row, pending and never eligible (CR4)`, () => {
    const dir = scratch();
    writeConfig(dir, [{
      id: 'xiaomi-token-plan', provider: 'xiaomi', account: 'token-plan',
      match: { model: 'mimo' }, ttlSeconds: 0, credentialSource: 'chrome-cookies',
    }, ROUTES[0]]);
    // A cached entry the GATE reads as healthy and fresh: left alone, the raw
    // entry would make the row eligible beside its pending, unknown display.
    writeCache(dir, {
      'xiaomi-token-plan': freshEntry('xiaomi-token-plan', {
        state: 'healthy', windows: [{ type: 'tokens', remaining: 90, limit: 100 }],
      }),
    });
    const release = lock.hold(dir);
    try {
      const r = vl(dir, ['view', '--json'], { preload: PRELOAD });
      assert.strictEqual(r.status, lock.status, `exit ${lock.status} (stderr: ${r.stderr})`);
      const doc = JSON.parse(r.stdout);
      assert.strictEqual(doc.collection.outcome, lock.outcome);
      const row = doc.routes.find((x) => x.id === 'xiaomi-token-plan');
      assert.ok(row, 'the Xiaomi row is present — never dropped on a busy collector');
      assert.strictEqual(row.collection.outcome, lock.routeOutcome);
      assert.strictEqual(row.state, 'unknown', 'pending renders unknown');
      assert.match(row.error, /refresh in progress/, 'the row is the pending projection');
      assert.strictEqual(row.freshness, 'fresh', 'the pending display is current, not a stale cached entry');
      assert.strictEqual(row.source, 'xiaomi');
      assert.notStrictEqual(row.state, 'healthy', 'pending is never healthy');
      assert.deepStrictEqual(row.windows, [], 'the cached counts do not leak through');
      assert.strictEqual(row.quotaEligibility, 'unresolved', 'unknown is never eligible');
      assert.ok(row.reasonCodes.includes('state-unknown'));
    } finally {
      release();
    }
  });
}

test('view --json: a busy collector over a fresh EXHAUSTED Xiaomi entry stays ineligible (the deny wins)', () => {
  const dir = scratch();
  writeConfig(dir, [{
    id: 'xiaomi-token-plan', provider: 'xiaomi', account: 'token-plan',
    match: { model: 'mimo' }, ttlSeconds: 0, credentialSource: 'chrome-cookies',
  }, ROUTES[0]]);
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 3600 * 1000).toISOString();
  writeCache(dir, {
    'xiaomi-token-plan': {
      routeId: 'xiaomi-token-plan', observedAt: at, freshUntil: later, source: 'xiaomi',
      status: { state: 'exhausted', windows: [{ type: 'tokens', remaining: 0, limit: 100 }] },
    },
  });
  const release = holdWorkerLock(dir);
  try {
    const r = vl(dir, ['view', '--json'], { preload: PRELOAD });
    assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
    const row = JSON.parse(r.stdout).routes.find((x) => x.id === 'xiaomi-token-plan');
    assert.strictEqual(row.state, 'unknown', 'the display is still the pending projection');
    assert.strictEqual(row.quotaEligibility, 'ineligible', 'the gate would deny a fresh exhausted entry; the view is never looser');
  } finally {
    release();
  }
});

test('view --json emits exactly ONE envelope when there are no credentials', () => {
  const dir = scratch();
  writeConfig(dir, ROUTES);
  const r = vl(dir, ['view', '--json'], { preload: PRELOAD, env: { VL_VIEW_NO_VAULT: '1' } });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.collection.outcome, 'no-credentials');
  assert.strictEqual(doc.collection.published, false);
  assert.strictEqual(doc.routes.length, 2, 'the configured routes are still listed');
});

test('view --json emits exactly ONE envelope when another worker owns the collector', () => {
  const dir = scratch();
  writeConfig(dir, ROUTES);
  writeCache(dir, {
    'minimax-token-plan': freshEntry('minimax-token-plan', { state: 'healthy', windows: [] }),
  });
  const release = holdWorkerLock(dir);
  try {
    const r = vl(dir, ['view', '--json'], { preload: PRELOAD });
    assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
    const doc = JSON.parse(r.stdout);
    assert.strictEqual(doc.collection.outcome, 'in-progress');
    assert.strictEqual(doc.collection.published, false);
    const minimax = doc.routes.find((x) => x.id === 'minimax-token-plan');
    assert.strictEqual(minimax.collection.outcome, 'pending');
    assert.ok(minimax.reasonCodes.includes('collection-pending'));
    assert.match(r.stderr, /collection in progress/);
  } finally {
    release();
  }
});

test('view --json emits exactly ONE envelope for a partial failure, and the failed route keeps its age', () => {
  const dir = scratch();
  writeConfig(dir, ROUTES);
  writeCache(dir, {
    'minimax-token-plan': freshEntry('minimax-token-plan', {
      state: 'healthy', windows: [{ type: 'weekly', remaining: 5, limit: 10 }],
    }),
  });
  const r = vl(dir, ['view', '--json'], {
    preload: PRELOAD,
    env: { VL_VIEW_FAIL: 'minimax-token-plan' },
  });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.collection.outcome, 'partial');
  const minimax = doc.routes.find((x) => x.id === 'minimax-token-plan');
  assert.strictEqual(minimax.collection.outcome, 'failed');
  assert.match(minimax.collection.error, /synthetic provider failure/);
  assert.ok(minimax.reasonCodes.includes('collection-failed'));
  // The prior fact is still the fact, with its own age.
  assert.strictEqual(minimax.observedAt, '2026-10-13T09:45:00Z');
  assert.strictEqual(minimax.state, 'healthy');
  // The successful sibling published independently.
  const deepseek = doc.routes.find((x) => x.id === 'deepseek-direct');
  assert.strictEqual(deepseek.collection.outcome, 'completed');
  assert.match(r.stderr, /collection partial/);
  assert.match(r.stderr, /minimax-token-plan/, 'the notice names the failed route');
  assert.match(r.stderr, /synthetic provider failure/, 'the notice names the error');
  // The cache kept the failed route's prior entry verbatim.
  const published = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.strictEqual(published.routes['minimax-token-plan'].observedAt, '2026-10-13T09:45:00Z');
});

// ---- the cache-only guarantee -----------------------------------------------

test('the gate and the snapshot stay cache-only: no network, no subprocess', () => {
  const dir = scratch();
  const log = path.join(dir, 'review.log');
  writeConfig(dir, ROUTES);
  writeCache(dir, {
    'minimax-token-plan': freshEntry('minimax-token-plan', { state: 'healthy', windows: [{ type: 'weekly', remaining: 5, limit: 10 }] }),
  });
  const snap = vl(dir, ['snapshot', '--json'], { guard: true, log });
  assert.strictEqual(snap.status, 0, `exit 0 (stderr: ${snap.stderr})`);
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

test('a native profile is carried in the JSON envelope', () => {
  const dir = scratch();
  writeConfig(dir, []);
  // The native profile lives in the runtime sidecar, the same place the
  // runtime snapshot reads it from.
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
    version: 1,
    sessions: [],
    harnesses: [],
    profiles: [{
      key: { host: 'mac', provider: 'claude-code', profileId: 'ambient' },
      harness: { value: 'claude', provenance: 'observed' },
      authStatus: { value: 'ok', provenance: 'observed' },
      rateLimitStatus: { value: 'healthy', provenance: 'observed' },
      usageUpdatedAt: { value: '2026-10-13T09:45:00Z', provenance: 'observed' },
      nativeRateLimits: {
        value: {
          provider: 'claude-code',
          available: true,
          fiveHour: { usedPercent: 36, resetsAt: 1790067599749, durationMinutes: 300 },
        },
        provenance: 'observed',
        observedAt: '2026-10-13T09:45:00Z',
        // A CURRENT deadline: the freshness is positive evidence only.
        freshUntil: '2099-01-01T00:00:00Z',
      },
    }],
  }, null, 2));
  const r = vl(dir, ['view', '--json'], { preload: PRELOAD });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.profiles.length, 1, 'the native profile is carried');
  assert.deepStrictEqual(doc.profiles[0].identity, {
    host: 'mac', provider: 'claude-code', profileId: 'ambient',
  });
  assert.strictEqual(doc.profiles[0].harness, 'claude');
  assert.strictEqual(doc.profiles[0].state, 'healthy');
  assert.strictEqual(doc.profiles[0].freshness, 'fresh');
  assert.strictEqual(doc.profiles[0].windows.length, 1);
  assert.strictEqual(doc.profiles[0].windows[0].remainingRatio, 0.64);
  // The profile identity stays separate from the route identity.
  assert.deepStrictEqual(doc.routes, []);

  // The text layouts show providers only: the owner-approved examples have
  // no profile rows, and a profile row is #62's design review.
  const text = vl(dir, ['view']);
  assert.strictEqual(text.status, 0);
  assert.ok(!text.stdout.includes('claude-code'), 'the text layouts carry no profile rows');
  assert.ok(!text.stdout.includes('ambient'), 'the text layouts carry no profile rows');
});

test('a native fact with no expiry is never promoted to healthy', () => {
  const dir = scratch();
  writeConfig(dir, []);
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
    version: 1,
    sessions: [],
    harnesses: [],
    profiles: [{
      key: { host: 'mac', provider: 'claude-code', profileId: 'ambient' },
      nativeRateLimits: {
        value: { provider: 'claude-code', available: true, fiveHour: { usedPercent: 36 } },
        provenance: 'observed',
        observedAt: '2026-10-13T09:45:00Z',
        freshUntil: null,
      },
    }],
  }, null, 2));
  const r = vl(dir, ['view', '--json'], { preload: PRELOAD });
  assert.strictEqual(r.status, 0, `exit 0 (stderr: ${r.stderr})`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.profiles.length, 1);
  assert.strictEqual(doc.profiles[0].state, 'unknown', 'no expiry means no state');
  assert.strictEqual(doc.profiles[0].freshness, 'unknown');
  assert.ok(doc.profiles[0].reasonCodes.includes('freshness-unproven'));
  assert.strictEqual(doc.profiles[0].windows.length, 1, 'the typed windows are kept');
  assert.strictEqual(doc.profiles[0].windows[0].remainingRatio, 0.64);
});

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
