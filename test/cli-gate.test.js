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

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-cli-'));
  fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
  return dir;
}

function isoOffsetMs(deltaMs) {
  return new Date(Date.now() + deltaMs).toISOString();
}

function exhaustedEntry(routeId, opts = {}) {
  const { freshOffsetMs = 5 * 60 * 1000 } = opts;
  return {
    routeId,
    observedAt: isoOffsetMs(-60 * 1000),
    freshUntil: isoOffsetMs(freshOffsetMs),
    source: 'kimi',
    status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
  };
}

function healthyEntry(routeId, opts = {}) {
  const { freshOffsetMs = 5 * 60 * 1000 } = opts;
  return {
    routeId,
    observedAt: isoOffsetMs(-60 * 1000),
    freshUntil: isoOffsetMs(freshOffsetMs),
    source: 'openrouter',
    status: { state: 'healthy', balance: { available: 12.34, currency: 'USD' } },
  };
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2));
}

function runGate({ input, dir, env, timeoutMs = 8000 }) {
  const payload = typeof input === 'string' ? input : JSON.stringify(input);
  return spawnSync(process.execPath, [VL, 'gate'], {
    input: payload,
    env: { ...process.env, ...(env || {}), CLAUDE_PLUGIN_DATA: dir },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
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

console.log('\ncli gate — decision path is network-free (no fetch on gate)');

test('gate never calls fetch — verified by source inspection of the gate() body', () => {
  // We can't intercept fetch in a child process without a require hook, so we
  // assert the stronger property the design makes true: the gate code path
  // resolves in-process using only loadConfig + readCache + dispatchContext +
  // resolveRoute + decide. None of those import adapters. We re-prove that by
  // reading the file the gate binary executes (bin/vl.js) and grepping for any
  // adapter import in the gate() function.
  const src = fs.readFileSync(VL, 'utf8');
  // Extract just the gate() function body — first `{` after `async function gate()`
  const m = src.match(/async function gate\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'could not locate gate() body in bin/vl.js');
  const body = m[1];
  assert.ok(!/require\(['"]\.\.\/lib\/adapters/.test(body), 'gate() must not require adapters');
  assert.ok(!/getAdapter/.test(body), 'gate() must not call getAdapter');
  assert.ok(!/\bfetch\s*\(/.test(body), 'gate() must not call fetch');
});

console.log('\ncli gate — spawnRefresh is detached + unref (child-process spy in-process)');

test('cache.spawnRefresh spawns node bin/vl.js refresh --quiet with detached:true and unrefs', () => {
  // Spy child_process.spawn and route it back through the original after the call
  // so we don't actually fork a refresh during unit tests. This proves the gate
  // contract: refresh is a fire-and-forget detached child.
  const cp = require('child_process');
  const origSpawn = cp.spawn;
  let calls = [];
  cp.spawn = function (...args) {
    calls.push({ cmd: args[0], args: args[1], opts: args[2] });
    // Return a dummy object the same shape cache.spawnRefresh consumes.
    return { unref() { this.unrefed = true; }, unrefed: false };
  };
  try {
    const cache = require('../lib/cache');
    const ok = cache.spawnRefresh(PLUGIN_ROOT);
    assert.strictEqual(ok, true);
    assert.strictEqual(calls.length, 1, 'expected exactly one spawn call');
    const call = calls[0];
    assert.strictEqual(call.cmd, process.execPath, 'refresh must spawn the same node binary');
    assert.ok(Array.isArray(call.args), 'spawn args must be an array');
    assert.match(call.args[0], /bin\/vl\.js$/, 'spawn target must be bin/vl.js');
    assert.strictEqual(call.args[1], 'refresh');
    assert.strictEqual(call.args[2], '--quiet');
    assert.strictEqual(call.opts.detached, true, 'refresh must be detached (non-blocking)');
    assert.strictEqual(call.opts.stdio, 'ignore', 'refresh must not inherit stdio');
    assert.strictEqual(call.opts.env.CLAUDE_PLUGIN_ROOT, PLUGIN_ROOT, 'plugin root must propagate');
  } finally {
    cp.spawn = origSpawn;
  }
});

console.log('\ncli gate — gate does not await refresh');

test('gate exits without waiting for the spawned refresh child', () => {
  // We can't easily block refresh, but we can verify the gate's gate() function
  // never `await`s spawnRefresh or tryAcquireRefreshLock by code inspection —
  // i.e., the stale-entry test above proves this empirically (the gate exited
  // in <5s against an isolated dir with no real refresh target). This test is a
  // belt-and-braces code-read assertion for the same invariant.
  const src = fs.readFileSync(VL, 'utf8');
  const m = src.match(/async function gate\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m);
  const body = m[1];
  assert.ok(!/await\s+spawnRefresh/.test(body), 'gate must not await spawnRefresh');
  assert.ok(!/await\s+tryAcquireRefreshLock/.test(body), 'gate must not await tryAcquireRefreshLock');
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall cli-gate tests passed');
