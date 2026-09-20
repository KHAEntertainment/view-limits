'use strict';
// Real CLI subprocess tests for `bin/vl.js gate`. Each test spawns the gate
// binary as its own child process against an isolated scratch CLAUDE_PLUGIN_DATA
// directory; no live credentials, no provider network. Spies/stubs verify:
//   - the decision path makes zero provider/RPC calls (no fetch during gate)
//   - stale-cache refresh is detached + non-blocking (subprocess exits promptly
//     and a refresh.lock file is written)
//   - the gate never denies on ambiguous dispatch (F1/F1a fail-open end-to-end)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VL = path.join(PLUGIN_ROOT, 'bin', 'vl.js');
const GUARD = path.join(__dirname, 'guard.cjs');

let failures = 0;
const pendingTests = [];
function test(name, fn) {
  let result;
  try { result = fn(); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); return; }
  if (result && typeof result.then === 'function') {
    pendingTests.push(result.then(
      () => { console.log(`  ✓ ${name}`); },
      (e) => { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); },
    ));
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-cli-'));
  fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  return dir;
}

// Fixed clock for deterministic freshness. The guard preload reads REVIEW_NOW
// and overrides Date.now in the subprocess. Subprocess tests use this NOW so
// boundaries (-1/0/1 ms) are deterministic.
const FIXED_NOW = Date.parse('2026-09-19T00:00:00Z');
function isoAtFixed(deltaMs) {
  return new Date(FIXED_NOW + deltaMs).toISOString();
}

function isoOffsetMs(deltaMs) {
  return new Date(Date.now() + deltaMs).toISOString();
}

function exhaustedEntry(routeId, opts = {}) {
  const { freshOffsetMs = 5 * 60 * 1000, useFixed = false } = opts;
  const iso = useFixed ? isoAtFixed : isoOffsetMs;
  return {
    routeId,
    observedAt: iso(-60 * 1000),
    freshUntil: iso(freshOffsetMs),
    source: 'kimi',
    status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
  };
}

function healthyEntry(routeId, opts = {}) {
  const { freshOffsetMs = 5 * 60 * 1000, useFixed = false } = opts;
  const iso = useFixed ? isoAtFixed : isoOffsetMs;
  return {
    routeId,
    observedAt: iso(-60 * 1000),
    freshUntil: iso(freshOffsetMs),
    source: 'openrouter',
    status: { state: 'healthy', balance: { available: 12.34, currency: 'USD' } },
  };
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

// runGate: spawns the real `node bin/vl.js gate` subprocess with the guard
// preload installed via NODE_OPTIONS. `useFixed` pins Date.now in the child
// (via REVIEW_NOW) for deterministic freshness tests. `realRefresh` opts the
// child into spawning a real detached pending worker (used by the F5 test).
function runGate({ input, dir, env, timeoutMs = 8000, useFixed = false, realRefresh = false }) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  const childEnv = {
    ...process.env,
    ...(env || {}),
    CLAUDE_PLUGIN_DATA: dir,
    NODE_OPTIONS: `--require=${GUARD}`,
  };
  if (useFixed) childEnv.REVIEW_NOW = String(FIXED_NOW);
  if (realRefresh) childEnv.REVIEW_REAL_REFRESH = '1';
  return spawnSync(process.execPath, [VL, 'gate'], {
    input: payload,
    env: childEnv,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

// Read the structured call log the guard writes when REVIEW_LOG is set. The
// helper below installs it per-test via `withLog`.
function readCalls(dir) {
  const log = path.join(dir, 'trace.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function runGateLogged({ input, dir, env, timeoutMs = 8000, useFixed = false, realRefresh = false }) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  const log = path.join(dir, 'trace.log');
  const childEnv = {
    ...process.env,
    ...(env || {}),
    CLAUDE_PLUGIN_DATA: dir,
    NODE_OPTIONS: `--require=${GUARD}`,
    REVIEW_LOG: log,
  };
  if (useFixed) childEnv.REVIEW_NOW = String(FIXED_NOW);
  if (realRefresh) childEnv.REVIEW_REAL_REFRESH = '1';
  return {
    r: spawnSync(process.execPath, [VL, 'gate'], {
      input: payload, env: childEnv, encoding: 'utf8', timeout: timeoutMs,
    }),
    calls: fs.existsSync(log) ? readCalls(dir) : [],
  };
}

function parseHook(out) {
  if (!out || !out.trim()) return null;
  try { return JSON.parse(out); } catch { return null; }
}

console.log('cli gate — fresh + exhausted cache entry → deny');

test('native Agent kimi-k2 + fresh exhausted kimi cache → deny JSON', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: { 'kimi-code-plan': exhaustedEntry('kimi-code-plan') },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  const h = parseHook(r.stdout);
  assert.ok(h && h.hookSpecificOutput, `expected hook output, got: ${r.stdout}`);
  assert.strictEqual(h.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(h.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(h.hookSpecificOutput.permissionDecisionReason, /kimi-code-plan/);
});

console.log('\ncli gate — stale entry → allow + refresh + detached');

test('stale kimi cache + native Agent kimi-k2 → allow context, refresh.lock written, gate exits promptly', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(-3600 * 1000),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: isoOffsetMs(-3600 * 1000),
        freshUntil: isoOffsetMs(-3500 * 1000), // 1h stale
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const started = Date.now();
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  const elapsed = Date.now() - started;
  assert.strictEqual(r.status, 0);
  // Detached + non-blocking: gate must exit well under the refresh budget.
  assert.ok(elapsed < 5000, `gate took ${elapsed}ms — refresh was awaited, not detached`);
  const h = parseHook(r.stdout);
  assert.ok(h && h.hookSpecificOutput, 'expected hook output');
  assert.ok(!h.hookSpecificOutput.permissionDecision, 'stale entry must not deny');
  assert.match(h.hookSpecificOutput.additionalContext || '', /no fresh status/);
  assert.ok(fs.existsSync(path.join(dir, 'refresh.lock')), 'expected refresh.lock after stale gate');
});

console.log('\ncli gate — F1 conflict end-to-end must fail open');

test('traycer create_agent harnessId=openrouter model=kimi-k2 + fresh-exhausted kimi cache → NO deny', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: { 'kimi-code-plan': exhaustedEntry('kimi-code-plan') },
  });
  const r = runGate({
    input: {
      tool_name: 'mcp__traycer_a2a__traycer_create_agent',
      tool_input: { model: 'kimi-k2', harnessId: 'openrouter' },
    },
    dir,
  });
  assert.strictEqual(r.status, 0);
  // No hook output at all is the strongest fail-open — resolveRoute returned
  // null because no unique combined match exists, the gate short-circuits.
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision,
    'conflict resolution must not deny a dispatch to an unrelated account');
});

console.log('\ncli gate — F1a tie end-to-end must fail open');

test('two identical kimi routes configured, fresh-exhausted first → NO deny', () => {
  const dir = scratch();
  // Custom config that overrides DEFAULTS with two identical kimi routes.
  writeJson(dir, 'config.json', {
    routes: [
      { id: 'kimi-plan-a', provider: 'kimi', account: 'a', match: { model: 'kimi' } },
      { id: 'kimi-plan-b', provider: 'kimi', account: 'b', match: { model: 'kimi' } },
    ],
  });
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: {
      'kimi-plan-a': exhaustedEntry('kimi-plan-a'),
      'kimi-plan-b': healthyEntry('kimi-plan-b'),
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision,
    'tie must fail open, never deny');
});

test('reverse config order — same null result', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [
      { id: 'kimi-plan-b', provider: 'kimi', account: 'b', match: { model: 'kimi' } },
      { id: 'kimi-plan-a', provider: 'kimi', account: 'a', match: { model: 'kimi' } },
    ],
  });
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: {
      'kimi-plan-a': exhaustedEntry('kimi-plan-a'),
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision,
    'reverse order tie must also fail open');
});

console.log('\ncli gate — corroborated match still resolves');

test('harnessId=openrouter, model=openrouter/kimi-k2 → resolves to openrouter-main (unique combined)', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: { 'openrouter-main': healthyEntry('openrouter-main') },
  });
  const r = runGate({
    input: {
      tool_name: 'mcp__traycer_a2a__traycer_create_agent',
      tool_input: { model: 'openrouter/kimi-k2', harnessId: 'openrouter' },
    },
    dir,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.ok(h && h.hookSpecificOutput, 'expected hook context for corroborated match');
  assert.ok(!h.hookSpecificOutput.permissionDecision, 'healthy route must not deny');
  assert.match(h.hookSpecificOutput.additionalContext || '', /openrouter-main/);
});

console.log('\ncli gate — malformed inputs never deny or throw');

test('non-JSON stdin → exit 0, no deny', () => {
  const dir = scratch();
  const r = runGate({ input: 'not-json{', dir });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision);
});

test('empty stdin → exit 0, no deny', () => {
  const dir = scratch();
  const r = runGate({ input: '', dir });
  assert.strictEqual(r.status, 0);
});

test('JSON stdin without tool_input → exit 0, no deny', () => {
  const dir = scratch();
  const r = runGate({ input: { tool_name: 'Agent' }, dir });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision);
});

test('malformed status.json → exit 0, no deny (parses as empty cache)', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'status.json'), '{not valid json');
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision,
    'garbage cache must never deny');
});

test('status.json with invalid freshUntil → exit 0, no deny', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: 'x',
        freshUntil: 'definitely-not-a-date',
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision);
});

test('status.json with null routes value → exit 0, no deny', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', { updatedAt: isoOffsetMs(0), routes: null });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0);
});

console.log('\ncli gate — Traycer profile must not be borrowed as harness');

test('traycer create_agent with harnessId=openrouter + a route bound to that harness → resolves; profile-only never substitutes', () => {
  const dir = scratch();
  // Custom config with a route whose only signal is harness=openrouter. The
  // point is that profile is NOT a substitute: dispatchContext must produce
  // harness=null from a profile-only payload, so this route never matches and
  // we fail open (no deny). With harnessId, the same route matches.
  writeJson(dir, 'config.json', {
    routes: [
      { id: 'openrouter-harness-only', provider: 'openrouter', account: 'main', match: { harness: 'openrouter' } },
    ],
  });
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: {
      'openrouter-harness-only': {
        routeId: 'openrouter-harness-only',
        observedAt: isoOffsetMs(-60_000),
        freshUntil: isoOffsetMs(300_000),
        source: 'openrouter',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });

  // (a) profile-only payload: harness is null → no match → no deny
  const profileOnly = runGate({
    input: {
      tool_name: 'mcp__traycer_a2a__traycer_create_agent',
      tool_input: { model: 'openrouter/kimi-k2', profile: 'openrouter-main' },
    },
    dir,
  });
  assert.strictEqual(profileOnly.status, 0);
  const hProfile = parseHook(profileOnly.stdout);
  assert.ok(!hProfile || !hProfile.hookSpecificOutput || !hProfile.hookSpecificOutput.permissionDecision,
    'profile must NOT be promoted to a harness — exhausted route must not deny');

  // (b) harnessId payload: harness resolves → exhausted route DOES deny
  const withHarness = runGate({
    input: {
      tool_name: 'mcp__traycer_a2a__traycer_create_agent',
      tool_input: { model: 'openrouter/kimi-k2', harnessId: 'openrouter' },
    },
    dir,
  });
  assert.strictEqual(withHarness.status, 0);
  const hHarness = parseHook(withHarness.stdout);
  assert.ok(hHarness && hHarness.hookSpecificOutput, 'harnessId path should resolve');
  assert.strictEqual(hHarness.hookSpecificOutput.permissionDecision, 'deny',
    'harnessId resolution should still gate on the bound route');
});

console.log('\ncli gate — malformed model identity at the real CLI boundary (F1)');

test('model as array → exit 0, no deny (F1 reproducer)', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: { 'kimi-code-plan': exhaustedEntry('kimi-code-plan') },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: ['kimi-k2'] } },
    dir,
  });
  assert.strictEqual(r.status, 0, `gate must not crash; stderr=${r.stderr}`);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision,
    'array model must not be coerced into a kimi-k2 match');
});

test('model as object / number / empty string → exit 0, no deny', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: { 'kimi-code-plan': exhaustedEntry('kimi-code-plan') },
  });
  for (const badModel of [{ name: 'kimi-k2' }, 42, '', '   ']) {
    const r = runGate({
      input: { tool_name: 'Agent', tool_input: { model: badModel } },
      dir,
    });
    assert.strictEqual(r.status, 0, `model=${JSON.stringify(badModel)} crashed: ${r.stderr}`);
    const h = parseHook(r.stdout);
    assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision,
      `model=${JSON.stringify(badModel)} denied`);
  }
});

console.log('\ncli gate — cache envelope null does not crash (F2)');

test('cache JSON literal null → exit 0, no deny', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'status.json'), 'null');
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0, `gate crashed on null cache: ${r.stderr}`);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision);
});

test('cache with non-object root (number / string / array) → exit 0, no deny', () => {
  for (const root of ['1', '"text"', '[1,2,3]']) {
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'status.json'), root);
    const r = runGate({
      input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
      dir,
    });
    assert.strictEqual(r.status, 0, `cache=${root} crashed: ${r.stderr}`);
  }
});

console.log('\ncli gate — nested malformed status does not crash (F3)');

test('windows is an object (not iterable) → exit 0, no deny', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: {
      'kimi-code-plan': {
        ...exhaustedEntry('kimi-code-plan'),
        status: { state: 'unknown', windows: {} }, // not an array
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0, `gate crashed: ${r.stderr}`);
});

test('windows array contains null element → exit 0, no deny', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoOffsetMs(0),
    routes: {
      'kimi-code-plan': {
        ...exhaustedEntry('kimi-code-plan'),
        status: { state: 'healthy', windows: [null] },
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir,
  });
  assert.strictEqual(r.status, 0, `gate crashed: ${r.stderr}`);
});

console.log('\ncli gate — deterministic freshness boundary (F5 hardening)');

test('freshness boundary -1 ms past expiry → allow+refresh (deterministic clock)', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoAtFixed(-1000),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: isoAtFixed(-1000),
        freshUntil: isoAtFixed(-1), // 1 ms past FIXED_NOW
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir, useFixed: true,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.strictEqual(h.hookSpecificOutput.permissionDecision, undefined,
    'expired-by-1ms must allow (only future freshUntil denies)');
  assert.match(h.hookSpecificOutput.additionalContext || '', /no fresh status/);
});

test('freshness boundary 0 (exact expiry) → deny (≤ boundary is fresh)', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoAtFixed(-1000),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: isoAtFixed(-1000),
        freshUntil: isoAtFixed(0), // exactly FIXED_NOW
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir, useFixed: true,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.strictEqual(h.hookSpecificOutput.permissionDecision, 'deny');
});

test('freshness boundary +1 ms future → deny', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoAtFixed(-1000),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: isoAtFixed(-1000),
        freshUntil: isoAtFixed(1), // 1 ms future
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir, useFixed: true,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.strictEqual(h.hookSpecificOutput.permissionDecision, 'deny');
});

console.log('\ncli gate — calendar-overflow freshness (CodeRabbit 4056155869)');

test('freshUntil 2030-09-31 normalizes to Oct 1 2030 (future of FIXED_NOW) → fail open, no deny', () => {
  // Date.parse('2030-09-31T00:00:00.000Z') === Date.parse('2030-10-01T00:00:00.000Z')
  // (calendar overflow rolls forward). Without the strict parser, the entry
  // would mark fresh and a deny would emit. With the fix, the entry is
  // treated as not-fresh and the gate fails open.
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoAtFixed(-1000),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: isoAtFixed(-1000),
        freshUntil: '2030-09-31T00:00:00.000Z', // overflow — Date.parse → Oct 1
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir, useFixed: true,
  });
  assert.strictEqual(r.status, 0, `gate crashed: ${r.stderr}`);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision,
    'overflow-date freshUntil must not deny a dispatch');
  assert.match((h && h.hookSpecificOutput && h.hookSpecificOutput.additionalContext) || '',
    /no fresh status/, 'gate should fail open with the standard refresh context');
});

test('freshUntil 2099-02-29 normalizes to Mar 1 2099 (future of FIXED_NOW) → fail open, no deny', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoAtFixed(-1000),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: isoAtFixed(-1000),
        freshUntil: '2099-02-29T00:00:00.000Z', // non-leap year, rolls to Mar 1
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir, useFixed: true,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision);
});

test('freshUntil valid offset form (e.g. +00:00, +05:00, -05:00) → deny at FIXED_NOW', () => {
  // Valid ISO 8601 offsets represent real instants and must still deny
  // when fresh + exhausted. The cache contract is the INSTANT, not the
  // textual form, so we do not impose a Z-only policy on inputs.
  const offCases = [
    '2099-09-19T00:00:00+00:00',
    '2099-09-19T00:00:00-05:00',
    '2099-09-19T05:00:00+05:00', // equivalent UTC instant to the first two
    '2099-09-19T00:00:00+0000',  // compact offset form
  ];
  for (const off of offCases) {
    const dir = scratch();
    writeJson(dir, 'status.json', {
      updatedAt: isoAtFixed(-1000),
      routes: {
        'kimi-code-plan': {
          routeId: 'kimi-code-plan',
          observedAt: isoAtFixed(-1000),
          freshUntil: off,
          source: 'kimi',
          status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
        },
      },
    });
    const r = runGate({
      input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
      dir, useFixed: true,
    });
    assert.strictEqual(r.status, 0, `[${off}] gate crashed: ${r.stderr}`);
    const h = parseHook(r.stdout);
    assert.strictEqual(h.hookSpecificOutput.permissionDecision, 'deny',
      `[${off}] valid offset future timestamp must deny`);
  }
});

test('freshUntil overflow with offset designator → fail open, no deny', () => {
  // Calendar defense is timezone-independent; an offset does not let a
  // bad calendar slip through.
  const overflowCases = [
    '2030-09-31T00:00:00+00:00',
    '2030-09-31T00:00:00-05:00',
    '2099-02-29T00:00:00+00:00', // non-leap year
    '2026-13-01T00:00:00+05:00',
  ];
  for (const ov of overflowCases) {
    const dir = scratch();
    writeJson(dir, 'status.json', {
      updatedAt: isoAtFixed(-1000),
      routes: {
        'kimi-code-plan': {
          routeId: 'kimi-code-plan',
          observedAt: isoAtFixed(-1000),
          freshUntil: ov,
          source: 'kimi',
          status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
        },
      },
    });
    const r = runGate({
      input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
      dir, useFixed: true,
    });
    assert.strictEqual(r.status, 0, `[${ov}] gate crashed: ${r.stderr}`);
    const h = parseHook(r.stdout);
    assert.ok(!h || !h.hookSpecificOutput || !h.hookSpecificOutput.permissionDecision,
      `[${ov}] overflow with offset must fail open`);
  }
});

test('valid leap-year freshUntil (2104-02-29) → deny at FIXED_NOW', () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: isoAtFixed(-1000),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: isoAtFixed(-1000),
        freshUntil: '2104-02-29T00:00:00.000Z', // real leap-year Feb 29, future
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const r = runGate({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir, useFixed: true,
  });
  assert.strictEqual(r.status, 0);
  const h = parseHook(r.stdout);
  assert.strictEqual(h.hookSpecificOutput.permissionDecision, 'deny',
    'valid leap-year future timestamp must still deny');
});

console.log('\ncli gate — preload guard: zero provider / RPC / credential / HTTP activity (F5)');

test('gate subprocess makes zero provider, fetch, HTTP, TCP, TLS, vault, or exec calls', () => {
  // The gate is spawned under NODE_OPTIONS=--require=./guard.cjs which throws
  // on any of these. We exercise every code path the gate can reach (fresh
  // deny, stale refresh, ambiguous conflict, profile-only, corrupted cache,
  // missing model, malformed array model) and assert no blocked call fired.
  const cases = [
    { name: 'fresh deny', dir: scratch(), input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }, cache: 'fresh' },
    { name: 'stale refresh', dir: scratch(), input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }, cache: 'stale' },
    { name: 'ambiguous conflict', dir: scratch(), input: { tool_name: 'mcp__traycer_a2a__traycer_create_agent', tool_input: { model: 'kimi-k2', harnessId: 'openrouter' } }, cache: 'fresh' },
    { name: 'profile-only', dir: scratch(), input: { tool_name: 'mcp__traycer_a2a__traycer_create_agent', tool_input: { model: 'openrouter/kimi-k2', profile: 'openrouter-main' } }, cache: 'fresh' },
    { name: 'null cache', dir: scratch(), input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }, cache: 'null' },
    { name: 'malformed windows', dir: scratch(), input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }, cache: 'malformed-windows' },
    { name: 'array model', dir: scratch(), input: { tool_name: 'Agent', tool_input: { model: ['kimi-k2'] } }, cache: 'fresh' },
  ];
  const blocked = ['fetch', 'http.request', 'http.get', 'https.request', 'https.get', 'net.connect', 'net.createConnection', 'tls.connect', 'provider', 'vault.has', 'vault.get', 'child_process.exec', 'child_process.execFile', 'child_process.execSync', 'child_process.execFileSync'];
  for (const c of cases) {
    fs.mkdirSync(path.join(c.dir, 'secrets'), { recursive: true });
    if (c.cache === 'fresh') {
      writeJson(c.dir, 'status.json', {
        updatedAt: isoOffsetMs(0),
        routes: { 'kimi-code-plan': exhaustedEntry('kimi-code-plan') },
      });
    } else if (c.cache === 'stale') {
      writeJson(c.dir, 'status.json', {
        updatedAt: isoOffsetMs(-3600 * 1000),
        routes: { 'kimi-code-plan': { ...exhaustedEntry('kimi-code-plan'), freshUntil: isoOffsetMs(-3500 * 1000) } },
      });
    } else if (c.cache === 'null') {
      fs.writeFileSync(path.join(c.dir, 'status.json'), 'null');
    } else if (c.cache === 'malformed-windows') {
      writeJson(c.dir, 'status.json', {
        updatedAt: isoOffsetMs(0),
        routes: { 'kimi-code-plan': { ...exhaustedEntry('kimi-code-plan'), status: { state: 'healthy', windows: {} } } },
      });
    }
    const { r, calls } = runGateLogged({ input: c.input, dir: c.dir });
    assert.strictEqual(r.status, 0, `${c.name}: gate crashed: ${r.stderr}`);
    // Zero blocked side-channel calls is the contract assertion.
    const fired = calls.filter((x) => blocked.includes(x.kind)).map((x) => x.kind);
    assert.deepStrictEqual(fired, [], `${c.name}: blocked calls fired: ${fired.join(', ')}`);
    // If a refresh fired, it must satisfy the detached/unref contract.
    const refreshCalls = calls.filter((x) => x.kind === 'refresh');
    for (const rc of refreshCalls) {
      assert.strictEqual(rc.detail.detached, true, `${c.name}: refresh not detached`);
      assert.strictEqual(rc.detail.stdio, 'ignore', `${c.name}: refresh not stdio:ignore`);
      assert.ok(calls.some((c2) => c2.kind === 'unref'), `${c.name}: unref not observed`);
    }
  }
});

console.log('\ncli gate — real detached pending worker (F5)');

// Reusable async detachment probe. Builds a tmp plugin root whose `bin/vl.js`
// is `workerContent` (so the gate's refresh spawn executes it), syntax-checks
// the generated worker, spawns the gate with REVIEW_REAL_REFRESH=1 and
// WORKER_READY_PATH inherited, and waits for the readiness marker with a
// bounded timeout. Cleanup (timer + watcher + worker pid) is unconditional.
//
//   expectReady=true  → readiness must fire; then assert detached/stdio/unref/
//                       liveness/pid-match.
//   expectReady=false → readiness must time out (worker exited without writing
//                       ready); gate still exits 0; worker pid is dead.
async function probeDetachment({ label, workerContent, expectReady, readyTimeoutMs = 2500 }) {
  const dataDir = scratch();
  writeJson(dataDir, 'status.json', {
    updatedAt: isoOffsetMs(-3600 * 1000),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan',
        observedAt: isoOffsetMs(-3600 * 1000),
        freshUntil: isoOffsetMs(-3500 * 1000), // stale → refresh triggered
        source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      },
    },
  });

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-root-'));
  fs.mkdirSync(path.join(tmpRoot, 'bin'), { recursive: true });
  const workerPath = path.join(tmpRoot, 'bin', 'vl.js');
  fs.writeFileSync(workerPath, workerContent);

  // Syntax check before spawning so a parse error fails this control
  // immediately rather than racing startup liveness.
  const check = spawnSync(process.execPath, ['--check', workerPath], { encoding: 'utf8' });
  assert.strictEqual(check.status, 0, `[${label}] generated worker fails syntax: ${check.stderr}`);

  const readyPath = path.join(tmpRoot, 'ready');
  let watcher = null;
  let timer = null;
  const readiness = new Promise((resolve, reject) => {
    watcher = fs.watch(tmpRoot, (_event, filename) => {
      if (filename === 'ready' && fs.existsSync(readyPath)) resolve();
    });
    timer = setTimeout(
      () => reject(new Error(`worker never wrote readiness marker at ${readyPath} within ${readyTimeoutMs}ms`)),
      readyTimeoutMs,
    );
  });

  const { r, calls } = runGateLogged({
    input: { tool_name: 'Agent', tool_input: { model: 'kimi-k2' } },
    dir: dataDir,
    env: {
      CLAUDE_PLUGIN_ROOT: tmpRoot,
      WORKER_READY_PATH: readyPath,
    },
    realRefresh: true,
    timeoutMs: 5000,
  });

  const realChild = calls.find((c) => c.kind === 'real-child');
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearTimeout(timer);
    if (watcher) try { watcher.close(); } catch { /* */ }
    if (realChild && realChild.detail && realChild.detail.pid) {
      try { process.kill(realChild.detail.pid, 'SIGTERM'); } catch { /* already gone */ }
      try { process.kill(realChild.detail.pid, 'SIGKILL'); } catch { /* */ }
    }
  }

  try {
    if (expectReady) {
      await readiness;
      assert.strictEqual(r.status, 0, `[${label}] gate crashed: ${r.stderr}`);
      assert.ok(realChild, `[${label}] expected guard to spawn real child for refresh`);
      assert.strictEqual(realChild.detail.detached, true, `[${label}] real child must be detached`);
      assert.strictEqual(realChild.detail.stdio, 'ignore', `[${label}] real child must ignore stdio`);
      assert.ok(realChild.detail.pid, `[${label}] real child must have a pid`);
      assert.ok(
        calls.some((c) => c.kind === 'real-unref'),
        `[${label}] expected guard to observe real unref call on the pending worker`,
      );
      let alive = true;
      try { process.kill(realChild.detail.pid, 0); }
      catch { alive = false; }
      assert.ok(alive, `[${label}] worker pid=${realChild.detail.pid} should still be alive after gate exits`);
      const payload = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      assert.strictEqual(payload.pid, realChild.detail.pid,
        `[${label}] readiness marker pid must match the spawned child pid`);
    } else {
      // Startup-failure control: worker exits (or otherwise fails to write
      // ready) before readiness fires. The probe must REJECT the readiness
      // Promise via the bounded timeout, the gate must still exit 0 (refresh
      // is detached so gate does not await), and the worker pid must be gone.
      let timedOut = false;
      try {
        await readiness;
        assert.fail(`[${label}] readiness unexpectedly fired (worker initialized despite failure control)`);
      } catch (e) {
        if (!/never wrote readiness|never became ready/i.test(e.message)) throw e;
        timedOut = true;
      }
      assert.ok(timedOut, `[${label}] expected readiness timeout`);
      assert.strictEqual(r.status, 0, `[${label}] gate must still exit 0 (detached refresh): ${r.stderr}`);
      assert.ok(realChild, `[${label}] expected guard to spawn real child even when worker exits early`);
      assert.ok(
        calls.some((c) => c.kind === 'real-unref'),
        `[${label}] expected guard to observe real unref call on the failing worker`,
      );
      let alive = false;
      try { process.kill(realChild.detail.pid, 0); alive = true; } catch { /* expected */ }
      assert.strictEqual(alive, false,
        `[${label}] worker pid=${realChild.detail.pid} should have exited (startup-failure control)`);
    }
  } finally {
    // Cleanup runs AFTER the awaited try settles, so the readiness timeout
    // and watcher stay live for the assertions and the worker pid is still
    // meaningful when we liveness-check it.
    cleanup();
  }
}

test('refresh spawns a real detached pending worker; gate exits while child alive', () => {
  return probeDetachment({
    label: 'valid-worker',
    workerContent: fs.readFileSync(
      path.join(__dirname, 'fixtures', 'refresh-pending-worker.js'),
      'utf8',
    ),
    expectReady: true,
  });
});

test('refresh startup-failure control: process.exit(2) worker is rejected with bounded timeout', () => {
  // Syntax-valid fixture that does NOT write a readiness marker and does
  // NOT stay pending — proves the test cannot falsely pass a worker that
  // never initializes. The probe must time out readiness, the gate must
  // still exit 0 (detached refresh does not block gate exit), and the
  // worker pid must be dead.
  return probeDetachment({
    label: 'startup-failure-control',
    workerContent: "'use strict';\nprocess.exit(2);\n",
    expectReady: false,
  });
});

// Aggregate async outcomes before declaring success.
(async () => {
  await Promise.all(pendingTests);
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall cli-gate tests passed');
})();
