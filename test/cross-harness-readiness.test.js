'use strict';
// Cross-harness runtime-readiness integration fixtures (Issue #10).
//
// Two layers:
//   1. Library-level getRuntimeSnapshot with injected io — a fake Traycer
//      runner (io.traycerRun + io.env) drives the real lib/traycer-adapter.js
//      end to end, and io.liveReads adds independent live sources. No real
//      Traycer install, network, or subprocess is involved.
//   2. Real CLI subprocesses — `bin/vl.js snapshot --json` runs under the
//      test/guard.cjs preload to prove the cache-only path is zero network /
//      zero subprocess / zero filesystem write, and `bin/vl.js report`
//      proves the renderer is a faithful reduction of the snapshot.
//
// Covered: AC4 (cache-only vs live modes, malformed/partial sources, multiple
// quota windows, precise balances, cross-session isolation, network-free
// gate), AC2 (third-party model backend without inferred family), AC3
// (selected-vs-last-used profile separation, availabilityPending).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { getRuntimeSnapshot } = require('../lib/runtime-snapshot');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VL = path.join(PLUGIN_ROOT, 'bin', 'vl.js');
const GUARD = path.join(__dirname, 'guard.cjs');

let failures = 0;
const pendingTests = [];
function test(name, fn) {
  let result;
  try { result = fn(); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); return; }
  if (result && typeof result.then === 'function') {
    pendingTests.push(result.then(
      () => { console.log(`  ✓ ${name}`); },
      (e) => { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); },
    ));
  } else {
    console.log(`  ✓ ${name}`);
  }
}

const NOW = Date.parse('2026-09-23T00:00:00Z');
const frozen = () => NOW;
const iso = (deltaMs) => new Date(NOW + deltaMs).toISOString();

const HOST_ID = 'host-uuid-1';
const EPIC_ID = 'epic-1';
const SELF_ID = 'agent-self-1';
const TS_RESULT = '2026-09-23T00:00:05.000Z';
const USAGE_MS = Date.parse('2026-09-22T23:58:21.806Z');
const USAGE_ISO = new Date(USAGE_MS).toISOString();

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-xharness-'));
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

function snap(dir, opts = {}) {
  return getRuntimeSnapshot({ refresh: false, now: frozen, dataDir: dir, ...opts });
}

function diagCodes(s) {
  return (s.diagnostics || []).map((d) => `${d.code}@${d.scope}`);
}

// Collect every fact-shaped object in the snapshot for invariant sweeps.
function collectFacts(root, out = []) {
  if (!root || typeof root !== 'object') return out;
  if (!Array.isArray(root) && 'value' in root && 'provenance' in root &&
      ['observed', 'configured', 'unknown'].includes(root.provenance)) {
    out.push(root);
    return out;
  }
  for (const v of Object.values(root)) {
    if (v && typeof v === 'object') collectFacts(v, out);
  }
  return out;
}

// ---- shared fixture ----------------------------------------------------------

// Cache fixture: multiple quota windows on one route, precise balances in
// both adapter-emitted shapes (number AND string — the mixed-type reality is
// pinned, not normalized), one malformed entry, one cache orphan.
function seedStatus(dir) {
  writeJson(dir, 'status.json', {
    updatedAt: iso(0),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: iso(-60_000), freshUntil: iso(300_000),
        source: 'kimi',
        status: {
          state: 'constrained',
          windows: [
            { type: 'rolling-5h', remaining: 63.5, limit: 100 },
            { type: 'weekly', remaining: 41.09375, limit: 100 },
          ],
          balance: null, resetAt: iso(7_200_000),
          detail: { model: 'kimi-for-coding', models: [{ name: 'kimi-for-coding' }, { name: 'kimi-k2' }] },
        },
      },
      'openrouter-main': {
        routeId: 'openrouter-main', observedAt: iso(-30_000), freshUntil: iso(90_000),
        source: 'openrouter',
        status: {
          state: 'healthy', windows: [],
          balance: {
            currency: 'USD',
            available: 4.6689968640000075,
            spent: { daily: 0.031, weekly: 1.2045 },
            limit: { amount: 20, reset: 'monthly' },
          },
          resetAt: null,
        },
      },
      'deepseek-direct': {
        routeId: 'deepseek-direct', observedAt: iso(-45_000), freshUntil: iso(75_000),
        source: 'deepseek',
        status: {
          state: 'healthy', windows: [],
          // The deepseek adapter passes the API's string through verbatim —
          // pinned here so a future normalization change cannot regress it
          // silently. See docs/jev-readiness.md "Known substrate defects".
          balance: { currency: 'USD', available: '2.08' },
          resetAt: null,
        },
      },
      'minimax-token-plan': {
        routeId: 'minimax-token-plan', observedAt: iso(-15_000), freshUntil: iso(165_000),
        source: 'minimax',
        status: { state: 'healthy', windows: [], balance: { currency: 'USD', available: 8.27 }, resetAt: null },
      },
      'glm-coding-plan': 'malformed-entry-payload',
      'phantom-orphan': {
        routeId: 'phantom-orphan', observedAt: iso(-5_000), freshUntil: iso(60_000),
        source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
}

// Sidecar fixture: two agents on ONE harness (claude) stay separate rows; a
// harness row whose availability probe is pending; a last-used profile that
// is NOT the caller's selected profile.
function seedSidecar(dir) {
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: iso(0),
    sessions: [
      {
        key: { host: HOST_ID, ade: 'traycer', epicId: EPIC_ID, agentId: 'agent-claude-A' },
        harness: { value: 'claude', provenance: 'observed', source: 'traycer-cli' },
        surface: { value: 'gui', provenance: 'observed', source: 'traycer-cli' },
        active: { value: true, provenance: 'observed', source: 'traycer-cli' },
      },
      {
        key: { host: HOST_ID, ade: 'traycer', epicId: EPIC_ID, agentId: 'agent-claude-B' },
        harness: { value: 'claude', provenance: 'observed', source: 'traycer-cli' },
        surface: { value: 'gui', provenance: 'observed', source: 'traycer-cli' },
        active: { value: false, provenance: 'observed', source: 'traycer-cli' },
      },
    ],
    harnesses: [
      {
        key: { host: HOST_ID, harness: 'claude', surface: 'gui' },
        available: { value: null, provenance: 'unknown', reason: 'availability-pending' },
        availabilityPending: { value: true, provenance: 'observed', source: 'traycer-cli' },
      },
    ],
    profiles: [
      {
        key: { host: HOST_ID, provider: 'claude-code', profileId: 'ambient' },
        authStatus: { value: 'authenticated', provenance: 'observed', source: 'traycer-cli' },
        isEffectiveLastUsed: { value: true, provenance: 'observed', source: 'traycer-cli' },
      },
    ],
  });
}

function seedAll(dir) {
  seedStatus(dir);
  seedSidecar(dir);
}

// ---- fake Traycer CLI runner --------------------------------------------------

function ndjson(events) {
  return events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
}

function resultOk(data, timestamp = TS_RESULT) {
  return { type: 'result', status: 'ok', data, timestamp };
}

const ok0 = (data) => ({ code: 0, stdout: ndjson([resultOk(data)]), stderr: '' });
const TIMEOUT = { timedOut: true };

// The AC2 live case: the caller's harness is `opencode` while its configured
// model is a third-party backend slug — harness and model must stay separate
// facts and no model family may be inferred from the slug.
const AGENTS_DATA = {
  caller: { agentId: SELF_ID, canSendMessages: true },
  scope: 'user',
  agents: [
    {
      id: SELF_ID, parentId: null, hostId: HOST_ID, isLocal: true,
      surface: 'gui', harnessId: 'opencode', isSelf: true, title: 'Probe',
      active: true, folderPaths: ['/wt/x'], isWorktree: true,
      runConfig: { model: { kind: 'concrete', slug: 'minimax-coding-plan:MiniMax-M3' }, reasoningEffort: null },
    },
    {
      id: 'agent-claude-B', parentId: null, hostId: HOST_ID, isLocal: true,
      surface: 'gui', harnessId: 'claude', isSelf: false, title: 'Sibling',
      active: false, folderPaths: [], isWorktree: false,
      runConfig: { model: { kind: 'concrete', slug: 'default' }, reasoningEffort: null },
    },
  ],
};

// Three-case availability matrix: pending must degrade to unknown, never to
// the raw transport boolean.
const HARNESSES_DATA = {
  harnesses: [
    { id: 'claude', label: 'Claude Code', available: false, availabilityPending: true, error: null },
    { id: 'codex', label: 'Codex', available: true, availabilityPending: false, error: null },
    { id: 'opencode', label: 'OpenCode', available: false, availabilityPending: false, error: null },
  ],
};

const CLAUDE_PROFILES = {
  providerId: 'claude-code',
  profiles: [
    {
      selection: { kind: 'ambient' }, label: 'Terminal account',
      authStatus: 'authenticated', rateLimitStatus: 'ok',
      usageUpdatedAt: USAGE_MS, isEffectiveLastUsed: true,
    },
  ],
};
const CODEX_PROFILES = {
  providerId: 'codex',
  profiles: [
    {
      selection: { kind: 'ambient' }, label: 'Terminal account',
      authStatus: 'unknown', rateLimitStatus: 'unknown',
      usageUpdatedAt: null, isEffectiveLastUsed: false,
    },
  ],
};
const OPENCODE_PROFILES = {
  providerId: 'opencode',
  profiles: [
    {
      selection: { kind: 'ambient' }, label: 'Terminal account',
      authStatus: 'unknown', rateLimitStatus: 'unknown',
      usageUpdatedAt: null, isEffectiveLastUsed: true,
    },
  ],
};

// handlers: [[argsArray, result]] exact argv match; unmatched → terminal error.
// Tracks concurrency so tests can assert the bounded-reads contract.
function makeRun(handlers) {
  const calls = [];
  let inflight = 0;
  let maxInflight = 0;
  const run = async (args) => {
    calls.push(args);
    inflight += 1;
    if (inflight > maxInflight) maxInflight = inflight;
    try {
      for (const [want, result] of handlers) {
        if (args.join('') === want.join('')) {
          return typeof result === 'function' ? result(args) : result;
        }
      }
      return { code: 0, stdout: ndjson([{ type: 'result', status: 'error', error: { code: 'E_UNEXPECTED', message: `no stub for ${args.join(' ')}` }, timestamp: TS_RESULT }]), stderr: '' };
    } finally {
      inflight -= 1;
    }
  };
  return { run, calls, maxInflight: () => maxInflight };
}

// Full live fixture: agent list + harness catalog + per-harness profiles.
// profile-rate-limits times out upstream (as the claude/codex probes
// observed) → traycer-read-timeout scoped per profile, siblings survive.
function liveRun() {
  return makeRun([
    [['agent', 'list', '--json'], ok0(AGENTS_DATA)],
    [['agent', 'list-harnesses', '--json'], ok0(HARNESSES_DATA)],
    [['agent', 'list-profiles', 'claude', '--json'], ok0(CLAUDE_PROFILES)],
    [['agent', 'list-profiles', 'codex', '--json'], ok0(CODEX_PROFILES)],
    [['agent', 'list-profiles', 'opencode', '--json'], ok0(OPENCODE_PROFILES)],
    [['agent', 'profile-rate-limits', 'claude', '--profile', 'ambient', '--json'], TIMEOUT],
    [['agent', 'profile-rate-limits', 'opencode', '--profile', 'ambient', '--json'], TIMEOUT],
  ]);
}

const TRAYCER_ENV = { TRAYCER_AGENT_ID: SELF_ID, TRAYCER_EPIC_ID: EPIC_ID };
const CALLER_CTX = { host: 'MacBookPro.localdomain', surface: 'cli', agentId: SELF_ID, epicId: EPIC_ID };

function liveSnap(dir, extraIo = {}, opts = {}) {
  const fake = liveRun();
  return {
    fake,
    promise: getRuntimeSnapshot({
      refresh: true, now: frozen, dataDir: dir,
      callerContext: CALLER_CTX,
      io: { env: TRAYCER_ENV, traycerRun: fake.run, ...extraIo },
      ...opts,
    }),
  };
}

// ---- CLI helpers ---------------------------------------------------------------

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

function cleanEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('TRAYCER_')) delete env[k];
  }
  Object.assign(env, extra);
  env.CLAUDE_PLUGIN_DATA = dir;
  return env;
}

function runCli(args, dir, { guard = false, log = false, env = {}, timeoutMs = 8000 } = {}) {
  const childEnv = cleanEnv(dir, env);
  if (guard) childEnv.NODE_OPTIONS = `--require=${GUARD}`;
  if (log) childEnv.REVIEW_LOG = path.join(dir, 'guard-events.log');
  return spawnSync(process.execPath, [VL, ...args], {
    env: childEnv, encoding: 'utf8', timeout: timeoutMs,
  });
}

function guardEvents(dir) {
  const log = path.join(dir, 'guard-events.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ============================================================================

console.log('cross-harness readiness — AC4 cache-only mode is zero-I/O');

test('cache-only: injected live sources and traycer runner are never invoked', async () => {
  const dir = scratch();
  seedAll(dir);
  let traycerReads = 0;
  let traycerRuns = 0;
  let liveReads = 0;
  const s = await snap(dir, {
    callerContext: CALLER_CTX,
    io: {
      env: TRAYCER_ENV,
      readTraycer: async () => { traycerReads += 1; return {}; },
      traycerRun: async () => { traycerRuns += 1; return {}; },
      liveReads: [{ key: 'spy', read: async () => { liveReads += 1; return {}; } }],
    },
  });
  assert.strictEqual(s.requestedRefresh, false);
  assert.strictEqual(traycerReads, 0, 'refresh:false must not touch the traycer read');
  assert.strictEqual(traycerRuns, 0, 'refresh:false must not spawn');
  assert.strictEqual(liveReads, 0, 'refresh:false must not invoke liveReads');
});

test('cache-only result is byte-identical with and without live io injected', async () => {
  const dir = scratch();
  seedAll(dir);
  const a = await snap(dir, { callerContext: CALLER_CTX });
  const b = await snap(dir, {
    callerContext: CALLER_CTX,
    io: {
      env: TRAYCER_ENV,
      traycerRun: async () => { throw new Error('must not be called'); },
      liveReads: [{ key: 'spy', read: async () => { throw new Error('must not be called'); } }],
    },
  });
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b), 'cache-only output must not depend on live io');
});

test('CLI cache-only under guard: zero guard events, zero filesystem writes', () => {
  const dir = scratch();
  seedAll(dir);
  const before = listTree(dir);
  const r = runCli(['snapshot', '--json'], dir, { guard: true, log: true });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.requestedRefresh, false);
  assert.deepStrictEqual(guardEvents(dir), [], 'guard observed forbidden activity');
  assert.deepStrictEqual(
    listTree(dir).filter((p) => p !== 'guard-events.log'), before,
    'cache-only snapshot must not create or modify files under dataDir',
  );
});

test('CLI --refresh without Traycer identity: live-reads-unavailable, still zero activity', () => {
  const dir = scratch();
  seedAll(dir);
  const r = runCli(['snapshot', '--json', '--refresh'], dir, { guard: true, log: true });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const doc = JSON.parse(r.stdout);
  assert.strictEqual(doc.requestedRefresh, true);
  assert.ok(doc.diagnostics.some((d) => d.code === 'live-reads-unavailable'));
  assert.deepStrictEqual(guardEvents(dir), [], 'refresh without identity must not spawn or write');
});

console.log('\ncross-harness readiness — AC4 live mode: bounded, partial, siblings survive');

test('live mode: bounded concurrency, merged rows, one failing + one malformed source degrade scoped', async () => {
  const dir = scratch();
  seedAll(dir);
  const { fake, promise } = liveSnap(dir, {
    liveReads: [
      {
        key: 'extra-source',
        read: async () => ({
          sessions: [{ key: { host: 'h-remote', ade: 'traycer', epicId: 'e-9', agentId: 'agent-remote-1' } }],
        }),
      },
      { key: 'failing-source', read: async () => { throw new Error('simulated source failure'); } },
      { key: 'malformed-source', read: async () => 42 },
    ],
  });
  const s = await promise;
  assert.strictEqual(s.requestedRefresh, true);

  const codes = diagCodes(s);
  assert.ok(codes.includes('live-source-failed@live:failing-source'), JSON.stringify(s.diagnostics));
  assert.ok(codes.includes('live-source-malformed@live:malformed-source'), JSON.stringify(s.diagnostics));

  // Sibling sources survive: the injected good source AND the authoritative
  // traycer read AND the cached rows all contribute.
  const ids = s.sessions.map((r) => r.key.agentId).sort();
  assert.ok(ids.includes('agent-remote-1'), 'injected live source row must survive');
  assert.ok(ids.includes(SELF_ID), 'traycer live row must survive');
  assert.ok(ids.includes('agent-claude-A'), 'cache-only sibling row must survive');

  // Bounded reads: every CLI command ran at most once and never more than
  // MAX_CONCURRENT (2) subprocesses in flight.
  assert.ok(fake.maxInflight() <= 2, `concurrency ${fake.maxInflight()} exceeds the bound`);
  const serial = fake.calls.map((c) => JSON.stringify(c));
  assert.strictEqual(new Set(serial).size, serial.length, 'identical commands must coalesce to one invocation');
});

test('live mode: upstream timeout degrades to traycer-read-timeout per profile scope', async () => {
  const dir = scratch();
  seedAll(dir);
  const { promise } = liveSnap(dir);
  const s = await promise;
  const codes = diagCodes(s);
  assert.ok(codes.includes('traycer-read-timeout@rate-limits:claude:ambient'), JSON.stringify(s.diagnostics));
  assert.ok(codes.includes('traycer-read-timeout@rate-limits:opencode:ambient'), JSON.stringify(s.diagnostics));
  // Timed-out sections stay unknown rather than fabricated; siblings survive.
  const claudeProfile = s.profiles.find((p) => p.key.provider === 'claude-code');
  assert.ok(claudeProfile, 'profile row survives a timed-out rate-limit read');
  assert.strictEqual(claudeProfile.nativeRateLimits === undefined ||
    claudeProfile.nativeRateLimits.provenance === 'unknown', true,
    'timed-out read must not fabricate nativeRateLimits');
  assert.ok(s.sessions.length >= 2, 'session siblings survive the timeout');
  assert.ok(s.harnesses.length >= 3, 'harness catalog survives the timeout');
});

console.log('\ncross-harness readiness — AC4 malformed/partial sources');

test('malformed status entry degrades scoped; sibling routes keep full evidence', async () => {
  const dir = scratch();
  seedAll(dir);
  const s = await snap(dir, { callerContext: CALLER_CTX });
  assert.ok(diagCodes(s).includes('status-entry-malformed@routes'));
  const byId = Object.fromEntries(s.routes.map((r) => [r.id, r]));
  const glm = byId['glm-coding-plan'];
  assert.strictEqual(glm.resource.state.provenance, 'unknown');
  assert.strictEqual(glm.configured, true, 'configured identity survives a malformed cache entry');
  assert.ok(!JSON.stringify(glm).includes('malformed-entry-payload'), 'malformed payload must not leak');
  // Sibling evidence untouched.
  assert.strictEqual(byId['kimi-code-plan'].resource.state.value, 'constrained');
  assert.strictEqual(byId['openrouter-main'].resource.state.value, 'healthy');
  // The orphan cache row still renders with observed evidence.
  const orphan = byId['phantom-orphan'];
  assert.strictEqual(orphan.configured, false);
  assert.strictEqual(orphan.resource.state.value, 'healthy');
});

console.log('\ncross-harness readiness — AC4 multiple windows + precise balances');

test('one route carries rolling-5h AND weekly windows verbatim', async () => {
  const dir = scratch();
  seedAll(dir);
  const s = await snap(dir, { callerContext: CALLER_CTX });
  const kimi = s.routes.find((r) => r.id === 'kimi-code-plan');
  assert.deepStrictEqual(kimi.resource.windows, [
    { type: 'rolling-5h', remaining: 63.5, limit: 100 },
    { type: 'weekly', remaining: 41.09375, limit: 100 },
  ], 'every quota window on the route must be preserved in order');
});

test('precise balances survive verbatim — number and string types both pinned', async () => {
  const dir = scratch();
  seedAll(dir);
  const s = await snap(dir, { callerContext: CALLER_CTX });
  const byId = Object.fromEntries(s.routes.map((r) => [r.id, r]));
  assert.strictEqual(byId['minimax-token-plan'].resource.balance.available, 8.27);
  // High-precision float survives unchanged (16+ significant digits).
  assert.strictEqual(byId['openrouter-main'].resource.balance.available, 4.6689968640000075);
  // Adapter-dependent mixed type pinned: deepseek emits a string, openrouter a
  // number. The snapshot must carry both verbatim — no coercion.
  assert.strictEqual(byId['deepseek-direct'].resource.balance.available, '2.08');
  assert.strictEqual(typeof byId['deepseek-direct'].resource.balance.available, 'string');
  assert.strictEqual(typeof byId['openrouter-main'].resource.balance.available, 'number');
});

console.log('\ncross-harness readiness — AC4 cross-session isolation');

test('two sessions on the SAME harness stay separate rows; no arbitrary effective model', async () => {
  const dir = scratch();
  seedAll(dir);
  const s = await snap(dir, { callerContext: CALLER_CTX });
  const claudeSessions = s.sessions.filter((r) => r.harness && r.harness.value === 'claude');
  assert.strictEqual(claudeSessions.length, 2, 'multiple agents on one harness remain separate rows');
  assert.deepStrictEqual(claudeSessions.map((r) => r.key.agentId).sort(), ['agent-claude-A', 'agent-claude-B']);
  // An idle harness has no single effective model — nothing may promote one
  // session's model to a harness- or caller-level effectiveModel.
  assert.strictEqual(s.caller.effectiveModel.provenance, 'unknown');
  assert.strictEqual(s.caller.effectiveModel.reason, 'caller-fact-absent');
});

console.log('\ncross-harness readiness — AC2 third-party backend without inferred family');

test('opencode harness + third-party configured model: separate facts, no inferred family', async () => {
  const dir = scratch();
  seedAll(dir);
  const { promise } = liveSnap(dir);
  const s = await promise;
  // Harness identity and model identity are distinct caller facts.
  assert.strictEqual(s.caller.harness.value, 'opencode');
  assert.strictEqual(s.caller.harness.source, 'traycer-cli');
  assert.deepStrictEqual(s.caller.configuredModel.value, { kind: 'concrete', slug: 'minimax-coding-plan:MiniMax-M3' });
  assert.strictEqual(s.caller.configuredModel.provenance, 'observed');
  // No model family is inferred anywhere in the document.
  assert.ok(!JSON.stringify(s).includes('"family"'), 'no inferred model family may appear');
  // effective/default are unobservable → unknown with reasons, and
  // differsFromDefault stays unknown rather than guessing.
  assert.strictEqual(s.caller.effectiveModel.provenance, 'unknown');
  assert.strictEqual(s.caller.defaultModel.provenance, 'unknown');
  assert.strictEqual(s.caller.differsFromDefault.reason, 'model-comparison-unavailable');
});

test('configuredModel placeholder slug "default" is carried verbatim, never promoted to defaultModel', async () => {
  const dir = scratch();
  seedAll(dir);
  const fake = makeRun([
    [['agent', 'list', '--json'], ok0({
      caller: { agentId: SELF_ID },
      agents: [{
        id: SELF_ID, hostId: HOST_ID, isLocal: true, surface: 'gui', harnessId: 'claude',
        isSelf: true, active: true, folderPaths: [], isWorktree: false,
        runConfig: { model: { kind: 'concrete', slug: 'default' } },
      }],
    })],
    [['agent', 'list-harnesses', '--json'], ok0({ harnesses: [] })],
    [['agent', 'list-profiles', 'claude', '--json'], ok0({ providerId: 'claude-code', profiles: [] })],
    [['agent', 'list-profiles', 'codex', '--json'], ok0({ providerId: 'codex', profiles: [] })],
    [['agent', 'list-profiles', 'opencode', '--json'], ok0({ providerId: 'opencode', profiles: [] })],
  ]);
  const s = await getRuntimeSnapshot({
    refresh: true, now: frozen, dataDir: dir,
    callerContext: CALLER_CTX,
    io: { env: TRAYCER_ENV, traycerRun: fake.run },
  });
  assert.deepStrictEqual(s.caller.configuredModel.value, { kind: 'concrete', slug: 'default' },
    'upstream placeholder evidence is carried verbatim');
  assert.strictEqual(s.caller.defaultModel.provenance, 'unknown',
    'a placeholder slug must never be promoted into defaultModel');
  assert.strictEqual(s.caller.effectiveModel.provenance, 'unknown');
  assert.strictEqual(s.caller.differsFromDefault.reason, 'model-comparison-unavailable');
});

console.log('\ncross-harness readiness — AC3 profile selection vs last-used');

test('selectedProfile stays unknown without a session binding; isEffectiveLastUsed is separate', async () => {
  const dir = scratch();
  seedAll(dir);
  const { promise } = liveSnap(dir);
  const s = await promise;
  // Last-used is reported on the profile row…
  const lastUsed = s.profiles.filter((p) => p.isEffectiveLastUsed && p.isEffectiveLastUsed.value === true);
  assert.ok(lastUsed.length >= 1, 'isEffectiveLastUsed must be reported on profile rows');
  // …but it is a separate fact: it must never fill the caller's selection.
  assert.strictEqual(s.caller.selectedProfile.provenance, 'unknown');
  assert.strictEqual(s.caller.selectedProfile.reason, 'caller-fact-absent');
  assert.strictEqual(s.caller.selectedAccount.provenance, 'unknown');
});

test('availabilityPending three-case matrix: pending → unknown, never the raw boolean', async () => {
  const dir = scratch();
  const { promise } = liveSnap(dir);
  const s = await promise;
  const byHarness = Object.fromEntries(s.harnesses.map((h) => [h.key.harness, h]));
  // {available:false, availabilityPending:true} → unknown, NOT false.
  const claude = byHarness['claude'];
  assert.strictEqual(claude.available.value, null);
  assert.strictEqual(claude.available.provenance, 'unknown');
  assert.strictEqual(claude.available.reason, 'availability-pending');
  // {available:true, availabilityPending:false} → observed true.
  assert.strictEqual(byHarness['codex'].available.value, true);
  assert.strictEqual(byHarness['codex'].available.provenance, 'observed');
  // {available:false, availabilityPending:false} → observed false.
  assert.strictEqual(byHarness['opencode'].available.value, false);
  assert.strictEqual(byHarness['opencode'].available.provenance, 'observed');
});

console.log('\ncross-harness readiness — surface/host semantics');

test('cache-only surface is the invocation context; live surface is the authoritative agent surface', async () => {
  const dir = scratch();
  seedAll(dir);
  // Cache-only: callerContext describes how `vl` was invoked (a CLI child).
  const cacheOnly = await snap(dir, { callerContext: CALLER_CTX });
  assert.strictEqual(cacheOnly.caller.surface.value, 'cli');
  assert.strictEqual(cacheOnly.caller.surface.source, 'callerContext');
  assert.strictEqual(cacheOnly.caller.host.value, 'MacBookPro.localdomain');
  // Live: the verified caller row's surface is authoritative for the agent —
  // the overlay replaces the invocation-context value with its own source.
  const { promise } = liveSnap(dir);
  const live = await promise;
  assert.strictEqual(live.caller.surface.value, 'gui');
  assert.strictEqual(live.caller.surface.source, 'traycer-cli');
  // The two semantics never silently equate: distinct sources on each mode.
  assert.notStrictEqual(cacheOnly.caller.surface.source, live.caller.surface.source);
});

console.log('\ncross-harness readiness — renderer is a faithful reduction');

test('vl report renders the snapshot without inference: unknowns stay visible, no family', () => {
  const dir = scratch();
  // Renderer path needs a stored credential — file vault with a test key.
  writeJson(dir, 'config.json', {
    vault: { backend: 'file', service: 'test' },
    routes: [
      { id: 'minimax-token-plan', provider: 'minimax', account: 'token-plan', match: { model: 'minimax' }, ttlSeconds: 180 },
      { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 },
      { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 180 },
      { id: 'deepseek-direct', provider: 'deepseek', account: 'personal', match: { model: 'deepseek' }, ttlSeconds: 120 },
      { id: 'openrouter-main', provider: 'openrouter', account: 'main', match: { model: 'openrouter', harness: 'openrouter' }, ttlSeconds: 120 },
    ],
  });
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'cross-harness-test-key';
  try {
    require('../lib/vault').set('openrouter-main', 'test-token');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }
  // Timestamps must be live-relative: the CLI runs on the real clock.
  const now = Date.now();
  writeJson(dir, 'status.json', {
    updatedAt: new Date(now).toISOString(),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date(now - 60_000).toISOString(),
        freshUntil: new Date(now + 300_000).toISOString(), source: 'kimi',
        status: {
          state: 'constrained',
          windows: [
            { type: 'rolling-5h', remaining: 63.5, limit: 100 },
            { type: 'weekly', remaining: 41.09375, limit: 100 },
          ],
          balance: null, resetAt: null,
        },
      },
      'openrouter-main': {
        routeId: 'openrouter-main', observedAt: new Date(now - 30_000).toISOString(),
        freshUntil: new Date(now + 90_000).toISOString(), source: 'openrouter',
        status: { state: 'healthy', windows: [], balance: { currency: 'USD', available: 4.6689968640000075 }, resetAt: null },
      },
      'deepseek-direct': {
        routeId: 'deepseek-direct', observedAt: new Date(now - 45_000).toISOString(),
        freshUntil: new Date(now + 75_000).toISOString(), source: 'deepseek',
        status: { state: 'healthy', windows: [], balance: { currency: 'USD', available: '2.08' }, resetAt: null },
      },
      'minimax-token-plan': {
        routeId: 'minimax-token-plan', observedAt: new Date(now - 15_000).toISOString(),
        freshUntil: new Date(now + 165_000).toISOString(), source: 'minimax',
        status: { state: 'healthy', windows: [], balance: { currency: 'USD', available: 8.27 }, resetAt: null },
      },
    },
  });
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: new Date(now).toISOString(),
    sessions: [
      { key: { host: HOST_ID, ade: 'traycer', epicId: EPIC_ID, agentId: 'agent-claude-A' },
        harness: { value: 'claude', provenance: 'observed' }, surface: { value: 'gui', provenance: 'observed' },
        active: { value: true, provenance: 'observed' } },
      { key: { host: HOST_ID, ade: 'traycer', epicId: EPIC_ID, agentId: 'agent-claude-B' },
        harness: { value: 'claude', provenance: 'observed' }, surface: { value: 'gui', provenance: 'observed' },
        active: { value: false, provenance: 'observed' } },
    ],
    harnesses: [
      { key: { host: HOST_ID, harness: 'claude', surface: 'gui' },
        available: { value: null, provenance: 'unknown', reason: 'availability-pending' },
        availabilityPending: { value: true, provenance: 'observed' } },
    ],
    profiles: [
      { key: { host: HOST_ID, provider: 'claude-code', profileId: 'ambient' },
        isEffectiveLastUsed: { value: true, provenance: 'observed' },
        authStatus: { value: 'authenticated', provenance: 'observed' } },
    ],
  });

  const r = runCli(['report'], dir, { env: { VIEW_LIMITS_MASTER_KEY: 'cross-harness-test-key' } });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const out = r.stdout;
  // Unknowns render as unknown — never smoothed over.
  assert.match(out, /models: configured unknown · default unknown · effective unknown/);
  // Both sessions on the same harness render as separate rows.
  assert.match(out, /session agent-claude-A @ host-uuid-1/);
  assert.match(out, /session agent-claude-B @ host-uuid-1/);
  // Pending availability renders as unknown, never "unavailable".
  assert.match(out, /claude \(gui\) @ host-uuid-1: availability unknown — availability-pending/);
  assert.ok(!/claude \(gui\).*unavailable/.test(out), 'pending must not render as unavailable');
  // Multiple windows render on one route; precise balances render via
  // formatMoney; no model family is inferred anywhere.
  assert.match(out, /kimi-code-plan: constrained · rolling-5h 64% · weekly 41%/);
  assert.match(out, /openrouter-main: healthy · balance 4\.67 USD/);
  assert.match(out, /deepseek-direct: healthy · balance 2\.08 USD/);
  assert.match(out, /minimax-token-plan: healthy · balance 8\.27 USD/);
  assert.match(out, /profile claude-code\/ambient @ host-uuid-1/);
  assert.ok(!/family/i.test(out), 'renderer must not infer a model family');
});

// ============================================================================

Promise.all(pendingTests).then(() => {
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall cross-harness-readiness tests passed');
});
