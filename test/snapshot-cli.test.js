'use strict';
// Real CLI subprocess tests for `bin/vl.js snapshot`. Each test spawns the
// binary against an isolated scratch CLAUDE_PLUGIN_DATA directory under the
// test/guard.cjs preload, which blocks+logs every network/exec/spawn/vault/
// provider path. The cache-only snapshot must produce zero guard events and
// zero filesystem writes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-snap-cli-'));
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

// Recursive relative listing of a directory (sorted, files+dirs as relpaths).
function listTree(dir) {
  const out = [];
  (function walk(rel) {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const p = path.join(rel, name);
      out.push(p + (fs.statSync(path.join(abs, name)).isDirectory() ? '/' : ''));
      if (fs.statSync(path.join(abs, name)).isDirectory()) walk(p);
    }
  })('');
  return out;
}

function runSnapshot({ args = ['--json'], dir, env = {}, timeoutMs = 5000, guard = true, log = true }) {
  const childEnv = {
    ...process.env,
    ...env,
    CLAUDE_PLUGIN_DATA: dir,
  };
  if (guard) childEnv.NODE_OPTIONS = `--require=${GUARD}`;
  if (log) childEnv.REVIEW_LOG = path.join(dir, 'guard-events.log');
  return spawnSync(process.execPath, [VL, 'snapshot', ...args], {
    env: childEnv, encoding: 'utf8', timeout: timeoutMs,
  });
}

function guardEvents(dir) {
  const log = path.join(dir, 'guard-events.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const ENVELOPE_KEYS = [
  'schemaVersion', 'generatedAt', 'requestedRefresh', 'completeness',
  'diagnostics', 'caller', 'sessions', 'harnesses', 'profiles', 'routes',
];

console.log('snapshot cli — single JSON document on stdout');

test('vl snapshot --json → exit 0, stdout is exactly one pretty JSON document with the ten envelope keys', () => {
  const dir = scratch();
  const r = runSnapshot({ dir });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout); // whole stdout must parse — one document only
  assert.deepStrictEqual(new Set(Object.keys(doc)), new Set(ENVELOPE_KEYS));
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.requestedRefresh, false);
  // Exact-bytes contract: stdout is JSON.stringify(doc, null, 2) + '\n'.
  assert.strictEqual(r.stdout, JSON.stringify(doc, null, 2) + '\n', 'stdout must be exactly the one document');
  // CLI caller facts: host + surface observed, identity unknown.
  assert.strictEqual(doc.caller.surface.value, 'cli');
  assert.strictEqual(doc.caller.host.provenance, 'observed');
  assert.strictEqual(doc.caller.agentId.provenance, 'unknown');
});

test('diagnostics go to stderr, stdout still parses as the one document', () => {
  const dir = scratch();
  writeJson(dir, 'runtime.json', '{corrupt-json');
  const r = runSnapshot({ dir });
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /runtime-sidecar-corrupt/);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.diagnostics.some((d) => d.code === 'runtime-sidecar-corrupt'));
});

console.log('\nsnapshot cli — zero-activity + zero-writes (C16)');

test('guard log empty, no files created or modified, exits promptly', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: new Date().toISOString(),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date().toISOString(),
        freshUntil: new Date(Date.now() + 300_000).toISOString(), source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const before = listTree(dir);
  const started = Date.now();
  const r = runSnapshot({ dir });
  const elapsed = Date.now() - started;
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.ok(elapsed < 5000, `snapshot took ${elapsed}ms — something blocked`);
  const events = guardEvents(dir);
  assert.deepStrictEqual(events, [], `guard observed forbidden activity: ${JSON.stringify(events)}`);
  assert.deepStrictEqual(listTree(dir).filter((p) => p !== 'guard-events.log'), before,
    'cache-only snapshot must not create or modify files under dataDir');
});

test('nonexistent dataDir is not created by the snapshot', () => {
  const base = scratch();
  const missing = path.join(base, 'does-not-exist');
  const r = runSnapshot({ dir: missing });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.ok(!fs.existsSync(missing), 'snapshot created the data dir — that is a write');
});

console.log('\nsnapshot cli — --refresh stays cache-only (C17)');

test('--refresh → requestedRefresh true, live-reads-unavailable, still zero activity', () => {
  const dir = scratch();
  const r = runSnapshot({ args: ['--json', '--refresh'], dir });
  assert.strictEqual(r.status, 0);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.requestedRefresh, true);
  assert.ok(doc.diagnostics.some((d) => d.code === 'live-reads-unavailable'));
  assert.match(r.stderr, /live-reads-unavailable/);
  const events = guardEvents(dir);
  assert.deepStrictEqual(events, [], `refresh path leaked activity: ${JSON.stringify(events)}`);
  assert.ok(!fs.existsSync(path.join(dir, 'refresh.scheduled')));
  assert.ok(!fs.existsSync(path.join(dir, 'refresh-workers')));
});

console.log('\nsnapshot cli — argument validation (C19)');

test('snapshot without --json → exit 1, empty stdout, usage on stderr', () => {
  const dir = scratch();
  const r = runSnapshot({ args: [], dir });
  assert.strictEqual(r.status, 1, `exit ${r.status}`);
  assert.strictEqual(r.stdout.trim(), '', 'stdout must be empty');
  assert.match(r.stderr, /snapshot/);
  assert.match(r.stderr, /--json/);
});

test('unknown flag → exit 1, usage on stderr', () => {
  const dir = scratch();
  const r = runSnapshot({ args: ['--json', '--bogus'], dir });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout.trim(), '');
  assert.match(r.stderr, /snapshot/);
});

console.log('\nsnapshot cli — registration (C21)');

test('usage line mentions snapshot; dispatch case present; unknown command still fails', () => {
  const dir = scratch();
  const bad = spawnSync(process.execPath, [VL, 'no-such-command'], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /snapshot --json/);
  const src = fs.readFileSync(VL, 'utf8');
  assert.ok(/case 'snapshot'/.test(src), 'dispatch case missing');
});

console.log('\nsnapshot cli — repeat invocations stay clean (C20)');

test('two subprocess invocations both exit 0 promptly with identical structure', () => {
  const dir = scratch();
  const r1 = runSnapshot({ dir });
  const r2 = runSnapshot({ dir });
  assert.strictEqual(r1.status, 0);
  assert.strictEqual(r2.status, 0);
  const d1 = JSON.parse(r1.stdout);
  const d2 = JSON.parse(r2.stdout);
  assert.deepStrictEqual(Object.keys(d1).sort(), Object.keys(d2).sort());
  assert.deepStrictEqual(
    { ...d1, generatedAt: null },
    { ...d2, generatedAt: null },
    'two cache-only runs differ only in generatedAt',
  );
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall snapshot-cli tests passed');
