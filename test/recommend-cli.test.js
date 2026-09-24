'use strict';
// Real CLI subprocess tests for `bin/vl.js recommend --json` (Issue #11).
// Each test spawns the binary against an isolated scratch CLAUDE_PLUGIN_DATA
// directory under test/guard.cjs, which blocks+logs every network/exec/spawn/
// vault/provider path. The recommend path must produce ZERO guard events and
// ZERO filesystem writes: it is advisory-only and the Jev network path is
// dormant behind the readiness gate.

const assert = require('assert');
const crypto = require('crypto');
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-rec-cli-'));
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

// Recursive relative listing of a directory (files hashed so in-place
// rewrites are caught, not just created/deleted names).
function listTree(dir) {
  const out = [];
  (function walk(rel) {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const p = path.join(rel, name);
      const st = fs.statSync(path.join(abs, name));
      if (st.isDirectory()) {
        out.push(p + '/');
        walk(p);
      } else {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(abs, name))).digest('hex');
        out.push(`${p}:${digest}`);
      }
    }
  })('');
  return out;
}

function cleanEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('TRAYCER_')) delete env[k];
  }
  Object.assign(env, extra);
  env.CLAUDE_PLUGIN_DATA = dir;
  return env;
}

function runRecommend(args, dir, { guard = true, log = true, env = {}, timeoutMs = 8000 } = {}) {
  const childEnv = cleanEnv(dir, env);
  if (guard) childEnv.NODE_OPTIONS = `--require=${GUARD}`;
  if (log) childEnv.REVIEW_LOG = path.join(dir, 'guard-events.log');
  return spawnSync(process.execPath, [VL, 'recommend', ...args], {
    env: childEnv, encoding: 'utf8', timeout: timeoutMs,
  });
}

function guardEvents(dir) {
  const log = path.join(dir, 'guard-events.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function seedStatus(dir) {
  writeJson(dir, 'status.json', {
    updatedAt: new Date().toISOString(),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date().toISOString(),
        freshUntil: new Date(Date.now() + 300_000).toISOString(), source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
      'deepseek-direct': {
        routeId: 'deepseek-direct', observedAt: new Date().toISOString(),
        freshUntil: new Date(Date.now() + 300_000).toISOString(), source: 'deepseek',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
}

console.log('recommend cli — single JSON document, dormant Jev, zero I/O');

test('vl recommend --json → exit 0, one JSON doc, jev dormant, exhausted route rejected', () => {
  const dir = scratch();
  seedStatus(dir);
  const r = runRecommend(['--json'], dir);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(r.stdout, JSON.stringify(doc, null, 2) + '\n', 'stdout must be exactly the one document');
  assert.strictEqual(doc.schemaVersion, 1);
  assert.strictEqual(doc.advisoryOnly, true);
  assert.strictEqual(doc.jev.status, 'dormant');
  assert.strictEqual(doc.jev.reason, 'jev-readiness-gate-closed');
  assert.ok(doc.candidates.rejected.some((c) => c.candidateId === 'deepseek-direct'));
  assert.ok(doc.candidates.scored.some((c) => c.candidateId === 'kimi-code-plan'));
  assert.strictEqual(doc.recommendation.candidateId, 'kimi-code-plan');
});

test('under guard: zero guard events, zero filesystem writes — advisory path is inert', () => {
  const dir = scratch();
  seedStatus(dir);
  const before = listTree(dir);
  const r = runRecommend(['--json', '--task', '{"kind":"code"}'], dir);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.deepStrictEqual(guardEvents(dir), [], 'guard observed forbidden activity');
  assert.deepStrictEqual(
    listTree(dir).filter((p) => !/^guard-events\.log:[0-9a-f]{64}$/.test(p)), before,
    'recommend must not create or modify files under dataDir',
  );
});

test('a configured jev block still stays dormant — no transport, no network', () => {
  const dir = scratch();
  seedStatus(dir);
  writeJson(dir, 'config.json', {
    jev: { model: 'acme/jev-1.13', baseUrl: 'https://example.invalid', catalogUrl: 'https://example.invalid/models' },
  });
  const r = runRecommend(['--json'], dir);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.jev.status, 'dormant');
  assert.strictEqual(doc.jev.attempted, false);
  assert.deepStrictEqual(guardEvents(dir), [], 'configured jev must not produce network activity while gate closed');
});

console.log('\nrecommend cli — argument validation + registration');

test('recommend without --json → exit 1, usage on stderr, empty stdout', () => {
  const dir = scratch();
  const r = runRecommend([], dir);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout.trim(), '');
  assert.match(r.stderr, /recommend/);
  assert.match(r.stderr, /--json/);
});

test('unknown flag / bad --task JSON → exit 1, usage or error on stderr', () => {
  const dir = scratch();
  let r = runRecommend(['--json', '--bogus'], dir);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /recommend/);
  r = runRecommend(['--json', '--task', '{oops'], dir);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /invalid JSON/);
});

test('F2: non-object --task/--policy JSON → exit 1 and NO recommendation document', () => {
  const dir = scratch();
  seedStatus(dir);
  for (const [flag, value] of [
    ['--policy', 'null'], ['--policy', '[]'], ['--policy', '42'],
    ['--task', 'null'], ['--task', '[]'], ['--task', '42'],
  ]) {
    const r = runRecommend(['--json', flag, value], dir);
    assert.strictEqual(r.status, 1, `${flag} ${value} must exit non-zero (got ${r.status})`);
    assert.match(r.stderr, /JSON object/, `${flag} ${value}: stderr=${r.stderr}`);
    assert.strictEqual(r.stdout.trim(), '', 'a malformed doc must never produce a recommendation');
  }
});

test('F2: explicit object --policy still merges ({} = deliberate no-requirements)', () => {
  const dir = scratch();
  seedStatus(dir);
  const r = runRecommend(['--json', '--policy', '{}'], dir);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.recommendation.candidateId, 'kimi-code-plan');
  // And the strict default (no --policy) keeps unknown-state routes
  // undecided, not eligible — routes with no cached observation are
  // 'route-state-unproven', never scored.
  const r2 = runRecommend(['--json'], dir);
  assert.strictEqual(r2.status, 0);
  const doc2 = JSON.parse(r2.stdout);
  assert.ok(
    doc2.candidates.undecided.some(
      (c) => c.reasons && c.reasons.some((x) => x.code === 'route-state-unproven'),
    ),
    'unobserved configured routes must land in undecided under the strict default',
  );
  assert.ok(doc2.candidates.scored.every(
    (c) => c.candidateId === 'kimi-code-plan',
  ), 'only the proven-healthy route may be scored');
});

test('dispatch case present; usage line mentions recommend', () => {
  const dir = scratch();
  const bad = spawnSync(process.execPath, [VL, 'no-such-command'], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dir }, encoding: 'utf8', timeout: 5000,
  });
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /recommend --json/);
  const src = fs.readFileSync(VL, 'utf8');
  assert.ok(/case 'recommend'/.test(src), 'dispatch case missing');
});

console.log('\nrecommend cli — existing subcommands byte-identical');

test('vl snapshot --json output is unchanged by the recommend addition', () => {
  const dir = scratch();
  seedStatus(dir);
  const r = spawnSync(process.execPath, [VL, 'snapshot', '--json'], {
    env: cleanEnv(dir, { NODE_OPTIONS: `--require=${GUARD}` }),
    encoding: 'utf8', timeout: 8000,
  });
  assert.strictEqual(r.status, 0);
  const doc = JSON.parse(r.stdout);
  assert.deepStrictEqual(new Set(Object.keys(doc)), new Set([
    'schemaVersion', 'generatedAt', 'requestedRefresh', 'completeness',
    'diagnostics', 'caller', 'sessions', 'harnesses', 'profiles', 'routes',
  ]));
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall recommend-cli tests passed');
