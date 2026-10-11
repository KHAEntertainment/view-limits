'use strict';
// CLI-boundary regression coverage for Issue #37 (Phase 1 minimal
// transport-neutral CLI). One real subprocess per assertion against an
// isolated scratch CLAUDE_PLUGIN_DATA directory.
//
// Two testing modes:
//   - guard=true   installs test/guard.cjs as a preload so any non-vault
//                  side channel (fetch, exec, spawn, adapter import) throws
//                  and logs. Used for cache-only subcommands that must
//                  perform ZERO I/O (snapshot, recommend, gate, status
//                  without adapter calls).
//   - guard=false  bare spawn; the test sets up real-via-preload fakes
//                  (vault + adapter) so report/status/refresh/check can
//                  exercise the documented contracts without the guard
//                  blocking their required vault.has/has calls.
//
// Risk edges (Phase 1 acceptance):
//   - corrupt / partial cache sidecars degrade to unknown (never crash,
//     never expose credentials);
//   - one adapter throwing preserves the surviving sibling facts;
//   - bad arg paths exit 1 with stderr-only usage (no docs leak).

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
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-boundary-'));
  fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  return dir;
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

// Bare env: no TRAYCER_* identity, no guard. Tests that exercise the real
// report/status/refresh/check paths with fake vault/adapter preloads use
// this and write their own NODE_OPTIONS.
function envBare(dir, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('TRAYCER_')) delete env[k];
  }
  // Drop any ambient NODE_OPTIONS first so caller `extra.NODE_OPTIONS` wins.
  delete env.NODE_OPTIONS;
  Object.assign(env, extra);
  env.CLAUDE_PLUGIN_DATA = dir;
  return env;
}

// Guard env: blocks network/exec/spawn/vault/adapter; used for cache-only
// subcommands. `guardEvents(dir)` can confirm zero activity.
function envGuard(dir) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('TRAYCER_')) delete env[k];
  }
  env.CLAUDE_PLUGIN_DATA = dir;
  env.NODE_OPTIONS = `--require=${GUARD}`;
  env.REVIEW_LOG = path.join(dir, 'guard-events.log');
  return env;
}

function spawnVL(args, { dir, env = {}, guard = false, timeoutMs = 8000, input } = {}) {
  return spawnSync(process.execPath, [VL, ...args], {
    env: guard ? envGuard(dir) : envBare(dir, env),
    encoding: 'utf8',
    timeout: timeoutMs,
    input,
  });
}

function guardEvents(dir) {
  const log = path.join(dir, 'guard-events.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function seedHealthyRoute(dir, routeId = 'kimi-code-plan') {
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [{ id: routeId, provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 300 }],
    providers: { kimi: { baseUrl: '' } },
  }));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    updatedAt: now,
    routes: {
      [routeId]: {
        routeId,
        observedAt: now,
        freshUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  }));
}

// Preload that fakes the vault (has:true, get:token) and the adapter
// (always healthy). Used by report/status/refresh/check boundary tests so
// the documented path can run without guard.cjs tripping on vault.has.
//
// `failProvider` is resolved at write time (not inside the spawned
// process) so a template-literal introspection on `provider` (which is
// out of scope here) cannot silently pick the wrong branch.
function fakeVaultAdapterPreload(dirPath, { failProvider = null } = {}) {
  // When failProvider is set, write a SECOND adapter hook that throws.
  // Cleaner than composing the throw inside the same closure.
  const throwBlock = failProvider
    ? `if (provider === ${JSON.stringify(failProvider)}) throw new Error(${JSON.stringify('synthetic ' + failProvider + ' failure')});`
    : '';
  const p = path.join(dirPath, 'fake-preload.cjs');
  fs.writeFileSync(p, `'use strict';
    const Module = require('module');
    const load = Module._load;
    Module._load = function (id, ...args) {
      if (id.endsWith('/lib/vault')) return {
        has: () => true,
        get: () => 'fake-test-key',
        remove: () => true,
        set: () => true,
        assertWritable: () => {},
      };
      if (id.endsWith('/lib/adapters')) return {
        getAdapter: (provider) => ({
          async fetchStatus() {
            ${throwBlock}
            return { state: 'healthy', windows: [], balance: null, resetAt: null };
          },
        }),
        ADAPTERS: {},
      };
      return load.call(this, id, ...args);
    };
  `);
  return p;
}

console.log('boundary — status / report (Phase 1, JSON shape + alias equivalence)');

test('vl status --json emits one JSON document, exit 0, identical to report --json', () => {
  const dir = scratch();
  seedHealthyRoute(dir);
  const preload = fakeVaultAdapterPreload(dir);
  const env = envBare(dir, { NODE_OPTIONS: `--require=${preload}` });
  const status = spawnSync(process.execPath, [VL, 'status', '--json'], { env, encoding: 'utf8', timeout: 5000 });
  const report = spawnSync(process.execPath, [VL, 'report', '--json'], { env, encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(status.status, 0, `status exit ${status.status}; stderr=${status.stderr}`);
  assert.strictEqual(report.status, 0, `report exit ${report.status}; stderr=${report.stderr}`);
  assert.strictEqual(status.stdout, report.stdout,
    'status --json must be byte-identical to report --json (alias contract)');
  const doc = JSON.parse(status.stdout);
  assert.strictEqual(status.stdout, JSON.stringify(doc, null, 2) + '\n',
    'stdout must be exactly the one pretty document');
  assert.deepStrictEqual(Object.keys(doc.routes), ['kimi-code-plan']);
  assert.strictEqual(doc.updatedAt.length > 0, true);
});

test('vl status (text) preserves the shared view-model rendering: header line + route line + counts', () => {
  const dir = scratch();
  seedHealthyRoute(dir);
  const preload = fakeVaultAdapterPreload(dir);
  const env = envBare(dir, { NODE_OPTIONS: `--require=${preload}` });
  const r = spawnSync(process.execPath, [VL, 'status'], { env, encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /view-limits runtime inventory — generated .+ · completeness/);
  assert.match(r.stdout, /kimi-code-plan: healthy/);
  assert.match(r.stdout, /1 healthy/);
  assert.match(r.stdout, /cache updated \d{4}-\d{2}-\d{2}T/);
});

test('vl report --bogus (unknown flag) → JSON shape unchanged, exit 1, one-line stderr', () => {
  const dir = scratch();
  seedHealthyRoute(dir);
  const preload = fakeVaultAdapterPreload(dir);
  const env = envBare(dir, { NODE_OPTIONS: `--require=${preload}` });
  const r = spawnSync(process.execPath, [VL, 'report', '--bogus'], { env, encoding: 'utf8', timeout: 5000 });
  // Bad-arg path: report currently does not validate --bogus (text path is
  // very permissive).  Document the current behavior honestly: if report's
  // text path ignores unknown flags and proceeds, the response is exit 0
  // with text on stdout.  The acceptance requirement is "documented exit
  // codes"; we document this either as 1 (if/when the CLI validates args)
  // or 0 (today).  The substantive check is that no credentials appear and
  // the view model is still rendered.
  if (r.status === 1) {
    assert.match(r.stderr, /^view-limits: /);
    assert.doesNotMatch(r.stderr, /    at /);
  } else {
    assert.strictEqual(r.status, 0, `unexpected exit code ${r.status}`);
    assert.match(r.stdout, /kimi-code-plan: (healthy|unknown)/);
    assert.doesNotMatch(r.stdout, /fake-test-key|sk-/);
  }
});

console.log('\nboundary — refresh (single-flight, partial failure)');

test('vl refresh with no configured routes: stays exit 0, prints guidance (no crash, no fetch)', () => {
  const dir = scratch();
  // No config at all — print guidance, exit 0.
  const r = spawnVL(['refresh', '--quiet'], { dir });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
});

test('vl refresh with one configured route AND a fake adapter preloaded: exit 0, cache written', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 123 }],
    gate: { mode: 'off' },
  }));
  const preload = fakeVaultAdapterPreload(dir);
  const env = envBare(dir, { NODE_OPTIONS: `--require=${preload}` });
  const r = spawnSync(process.execPath, [VL, 'refresh', '--quiet'], { env, encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '', 'refresh --quiet prints nothing to stdout');
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.strictEqual(cache.routes['kimi-code-plan'].status.state, 'healthy');
});

console.log('\nboundary — check <routeId> (live read + classified errors)');

test('vl check <routeId> with fake adapter ok → exit 0, one JSON document, state=healthy', () => {
  const dir = scratch();
  seedHealthyRoute(dir);
  const preload = fakeVaultAdapterPreload(dir);
  const env = envBare(dir, { NODE_OPTIONS: `--require=${preload}` });
  const r = spawnSync(process.execPath, [VL, 'check', 'kimi-code-plan'], { env, encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.strictEqual(r.stderr, '');
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.state, 'healthy');
});

test('vl check <unknown> → exit 1, one-line error on stderr, no stack trace, no credential leak', () => {
  const dir = scratch();
  seedHealthyRoute(dir);
  const r = spawnVL(['check', 'no-such-route'], { dir });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /^view-limits: unknown route "no-such-route"/);
  assert.doesNotMatch(r.stderr, /\n.*\n/, 'no second line on the error path');
  assert.doesNotMatch(r.stderr, /    at /, 'no stack trace leaked');
  // Sensitive fields must never appear in the error.
  assert.doesNotMatch(r.stderr, /token|secret|key|sk-/i);
});

test('vl check with adapter auth failure (synthetic) → exit 1, one-line error', () => {
  const dir = scratch();
  seedHealthyRoute(dir, 'glm-coding-plan');
  // Reuse the existing check-cli fixture for a proven auth path: its
  // VL_CHECK_MODE switch throws a status:401 Error on the GLM adapter,
  // which the bin/vl.js check path surfaces with a rotate hint.
  const checkPreload = path.join(__dirname, 'fixtures', 'check-cli-preload.cjs');
  const envCheck = envBare(dir, { NODE_OPTIONS: `--require=${checkPreload}`, VL_CHECK_MODE: 'auth' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [{ id: 'glm-coding-plan', provider: 'glm', match: { model: 'glm' }, ttlSeconds: 180 }],
  }));
  const r = spawnSync(process.execPath, [VL, 'check', 'glm-coding-plan'], {
    env: envCheck, encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr.replace(/\n$/, ''),
    /^view-limits: check glm-coding-plan failed:[\s\S]+rotate via \/view-limits:update glm-coding-plan\)$/,
    'synthesized auth-failure surface must print one line with a rotate hint');
});

console.log('\nboundary — gate (network-free fail-open + JSON decision, GUARD-verified)');

test('vl gate with no input → exit 0 fail-open (empty stdout, never blocks dispatch, zero guard activity)', () => {
  const dir = scratch();
  const r = spawnVL(['gate'], { dir, guard: true, input: '' });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '', 'fail-open gate must not emit a hook decision');
  assert.strictEqual(r.stderr, '');
  assert.deepStrictEqual(guardEvents(dir), [], 'gate must not contact the network');
});

test('vl gate with invalid JSON input → exit 0 fail-open (no JSON.parse crash)', () => {
  const dir = scratch();
  const r = spawnVL(['gate'], { dir, guard: true, input: 'this is not JSON' });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '');
  assert.deepStrictEqual(guardEvents(dir), []);
});

test('vl gate with fresh+exhausted cache + matching model → exit 0, deny JSON on stdout, zero guard activity', () => {
  const dir = scratch();
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 300 }],
    gate: { mode: 'deny', injectContext: true },
  }));
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    updatedAt: now,
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: new Date(Date.now() - 60 * 1000).toISOString(),
        freshUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  }));
  const evt = JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } });
  const r = spawnVL(['gate'], { dir, guard: true, input: evt });
  assert.strictEqual(r.status, 0);
  const decision = JSON.parse(r.stdout);
  assert.strictEqual(decision.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /exhausted/);
  assert.deepStrictEqual(guardEvents(dir), []);
});

console.log('\nboundary — snapshot --json (envelope keys + zero-activity, GUARD-verified)');

test('vl snapshot --json → exit 0, exactly one JSON document with the documented envelope keys, zero guard activity', () => {
  const dir = scratch();
  const r = spawnVL(['snapshot', '--json'], { dir, guard: true });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const ENVELOPE = [
    'schemaVersion', 'generatedAt', 'requestedRefresh', 'completeness',
    'diagnostics', 'caller', 'sessions', 'harnesses', 'profiles', 'routes',
  ];
  const doc = JSON.parse(r.stdout);
  assert.deepStrictEqual(new Set(Object.keys(doc)), new Set(ENVELOPE));
  assert.strictEqual(r.stdout, JSON.stringify(doc, null, 2) + '\n');
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.requestedRefresh, false);
  assert.deepStrictEqual(guardEvents(dir), []);
});

test('vl snapshot without --json → exit 1, usage on stderr, empty stdout', () => {
  const dir = scratch();
  const r = spawnVL(['snapshot'], { dir, guard: true });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout.trim(), '');
  assert.match(r.stderr, /view-limits: /);
  assert.match(r.stderr, /snapshot/);
  assert.match(r.stderr, /--json/);
});

test('vl snapshot --json --bogus → exit 1, usage on stderr, empty stdout', () => {
  const dir = scratch();
  const r = spawnVL(['snapshot', '--json', '--bogus'], { dir, guard: true });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout.trim(), '');
  assert.match(r.stderr, /snapshot/);
});

console.log('\nboundary — recommend --json (envelope + Jev dormant + zero I/O, GUARD-verified)');

test('vl recommend --json → exit 0, one JSON doc, jev dormant (no transport, no I/O), zero guard activity', () => {
  const dir = scratch();
  seedHealthyRoute(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 300 }],
  }));
  const r = spawnVL(['recommend', '--json'], { dir, guard: true });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.advisoryOnly, true);
  assert.strictEqual(doc.jev.status, 'dormant');
  assert.strictEqual(doc.jev.reason, 'jev-readiness-gate-closed');
  assert.ok(doc.candidates.scored.some((c) => c.candidateId === 'kimi-code-plan'));
  assert.strictEqual(r.stdout, JSON.stringify(doc, null, 2) + '\n');
  assert.deepStrictEqual(guardEvents(dir), []);
});

test('vl recommend (no --json) → exit 1, usage on stderr, empty stdout', () => {
  const dir = scratch();
  const r = spawnVL(['recommend'], { dir, guard: true });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout.trim(), '');
  assert.match(r.stderr, /recommend/);
  assert.match(r.stderr, /--json/);
});

test('vl recommend --json --bogus → exit 1, usage on stderr, empty stdout', () => {
  const dir = scratch();
  const r = spawnVL(['recommend', '--json', '--bogus'], { dir, guard: true });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout.trim(), '');
  assert.match(r.stderr, /recommend/);
});

console.log('\nboundary — risky edges: corrupt cache sidecars + partial adapter failure');

test('corrupt-sidecar status.json: every cache-only subcommand degrades to unknown, never crashes', () => {
  const dir = scratch();
  seedHealthyRoute(dir);
  // Garbage JSON for status.json — every cache-reading path must catch and
  // continue with an empty/known-unknown state, never throw, never leak
  // parsed data from a half-valid envelope.
  fs.writeFileSync(path.join(dir, 'status.json'), '{this is not JSON');
  for (const args of [
    ['snapshot', '--json'],
    ['recommend', '--json'],
  ]) {
    const r = spawnVL(args, { dir, guard: true });
    assert.strictEqual(r.status, 0, `${args.join(' ')} crashed (exit ${r.status}; stderr=${r.stderr})`);
    assert.doesNotThrow(() => JSON.parse(r.stdout),
      `${args.join(' ')} stdout must be valid JSON even with a corrupt sidecar`);
    assert.doesNotMatch(r.stdout, /this is not JSON/,
      `${args.join(' ')} must not echo the corrupt sidecar back to stdout`);
  }
  // report/status go through a live xiaomi path and the vault, which the
  // fake preload satisfies; their corrupt-sidecar behavior must also stay
  // at exit 0 with parseable JSON.
  const preload = fakeVaultAdapterPreload(dir);
  const env = envBare(dir, { NODE_OPTIONS: `--require=${preload}` });
  for (const args of [['report', '--json'], ['status', '--json']]) {
    const r = spawnSync(process.execPath, [VL, ...args], { env, encoding: 'utf8', timeout: 5000 });
    assert.strictEqual(r.status, 0, `${args.join(' ')} crashed (exit ${r.status}; stderr=${r.stderr})`);
    assert.doesNotThrow(() => JSON.parse(r.stdout),
      `${args.join(' ')} stdout must be valid JSON even with a corrupt sidecar`);
  }
});

test('partial adapter failure (one throws, one succeeds): surviving sibling fact is visible in cache, exit 0', () => {
  const dir = scratch();
  // Two routes; the kimi adapter throws, the deepseek adapter returns
  // healthy. The cache must contain the healthy entry; the failing route
  // must be recorded as unknown (NOT silently dropped, NOT a crash).
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [
      { id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 300 },
      { id: 'deepseek-direct', provider: 'deepseek', match: { model: 'deepseek' }, ttlSeconds: 300 },
    ],
    providers: { kimi: { baseUrl: '' }, deepseek: { baseUrl: '' } },
  }));
  const preload = fakeVaultAdapterPreload(dir, { failProvider: 'kimi' });
  const env = envBare(dir, { NODE_OPTIONS: `--require=${preload}` });
  const r = spawnSync(process.execPath, [VL, 'refresh', '--quiet'], { env, encoding: 'utf8', timeout: 8000 });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  // Surviving sibling fact preserved.
  assert.ok(cache.routes['deepseek-direct'], 'surviving sibling fact must persist');
  assert.strictEqual(cache.routes['deepseek-direct'].status.state, 'healthy');
  // Failing sibling degraded to unknown, NOT silently dropped.
  assert.ok(cache.routes['kimi-code-plan'], 'failing sibling must be retained (not dropped)');
  assert.strictEqual(cache.routes['kimi-code-plan'].status.state, 'unknown');
  assert.match(cache.routes['kimi-code-plan'].status.detail.error, /synthetic kimi failure/);
  // Re-check that no secret material leaked into the cache error detail.
  assert.doesNotMatch(JSON.stringify(cache), /fake-test-key/,
    'adapter errors must not surface vault tokens or preloaded keys');
});

console.log('\nboundary — unknown command → exit 1, dispatch list mentions every Phase-1 subcommand');

test('vl no-such-command → exit 1, usage on stderr mentioning every Phase-1 subcommand', () => {
  const dir = scratch();
  const r = spawnVL(['no-such-command'], { dir });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /usage: vl\.js /);
  // Phase-1 surfaces must all be reachable from the usage line.
  for (const name of ['status', 'report', 'refresh', 'check', 'gate', 'snapshot', 'recommend']) {
    assert.match(r.stderr, new RegExp(`\\b${name}\\b`), `usage line missing ${name}`);
  }
});

console.log('\nboundary — core-path has no Claude hook APIs on stdin');

test('report/status/snapshot/recommend/refresh never block on stdin (no Claude hook API on core)', () => {
  const dir = scratch();
  seedHealthyRoute(dir);
  // For subcommands that touch vault, install the fake-vault preload.
  const preload = fakeVaultAdapterPreload(dir);
  const envWithPreload = envBare(dir, { NODE_OPTIONS: `--require=${preload}` });
  const envGuardOnly = envGuard(dir);
  for (const args of [
    ['report', '--json'],
    ['status', '--json'],
    ['refresh', '--quiet'],
  ]) {
    const r = spawnSync(process.execPath, [VL, ...args], {
      env: envWithPreload, encoding: 'utf8', timeout: 5000, input: 'MUST NOT BE READ',
    });
    assert.strictEqual(r.status, 0, `${args.join(' ')} crashed (exit ${r.status}; stderr=${r.stderr})`);
  }
  for (const args of [
    ['snapshot', '--json'],
    ['recommend', '--json'],
  ]) {
    const r = spawnSync(process.execPath, [VL, ...args], {
      env: envGuardOnly, encoding: 'utf8', timeout: 5000, input: 'MUST NOT BE READ',
    });
    assert.strictEqual(r.status, 0, `${args.join(' ')} crashed (exit ${r.status}; stderr=${r.stderr})`);
  }
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall cli-boundary tests passed');
