'use strict';
// Fixture tests for lib/traycer-adapter.js and its wiring into
// getRuntimeSnapshot({ refresh: true }). Every test injects a fake `run`
// (the subprocess boundary) and a fake env — no real Traycer install, network,
// or subprocess is involved.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getRuntimeSnapshot } = require('../lib/runtime-snapshot');
const { readTraycerRuntime, parseTerminalResult, traycerEnvCallerContext } = require('../lib/traycer-adapter');

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

const NOW = Date.parse('2026-09-22T08:00:00Z');
const frozen = () => NOW;
const TS_PROGRESS = '2026-09-22T07:59:58.000Z';
const TS_RESULT = '2026-09-22T08:00:05.000Z';
const AGENT_ID = 'agent-self-1';
const EPIC_ID = 'epic-1';
const HOST_ID = 'host-uuid-1';
const USAGE_MS = 1790066211806;
const USAGE_ISO = new Date(USAGE_MS).toISOString();

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-traycer-'));
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

// ---- NDJSON fixtures ---------------------------------------------------------

function ndjson(events) {
  return events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n';
}

function progress(message, timestamp = TS_PROGRESS) {
  return { type: 'progress', message, timestamp };
}

function resultOk(data, timestamp = TS_RESULT) {
  return { type: 'result', status: 'ok', data, timestamp };
}

function resultErr(code = 'E_UNEXPECTED', message = 'stub error') {
  return { type: 'result', status: 'error', error: { code, message, details: null }, timestamp: TS_RESULT };
}

const AGENTS_DATA = {
  caller: { agentId: AGENT_ID, canSendMessages: true },
  scope: 'user',
  agents: [
    {
      id: AGENT_ID, parentId: 'parent-1', hostId: HOST_ID, isLocal: true,
      surface: 'gui', harnessId: 'devin', isSelf: true, title: 'Worker',
      capabilities: { readTranscript: true, sendMessage: true }, active: true,
      folderPaths: ['/wt/x'], isWorktree: true,
      runConfig: { model: { kind: 'concrete', slug: 'swe-2-high' }, reasoningEffort: 'high', fastMode: false },
    },
    {
      id: 'agent-tui', parentId: null, hostId: HOST_ID, isLocal: true,
      surface: 'tui', harnessId: 'claude', isSelf: false, title: 'Terminal',
      capabilities: { readTranscript: false, sendMessage: false }, active: false,
      folderPaths: [], isWorktree: false,
      runConfig: { model: { kind: 'provider-default' }, reasoningEffort: null, fastMode: null },
    },
    {
      id: 'agent-remote', parentId: null, hostId: 'host-remote', isLocal: false,
      surface: 'gui', harnessId: 'claude', isSelf: false, title: null,
      capabilities: { readTranscript: false, sendMessage: false }, active: false,
      folderPaths: [], isWorktree: false, runConfig: null,
    },
  ],
};

const HARNESSES_DATA = {
  harnesses: [
    { id: 'claude', label: 'Claude Code', available: true, availabilityPending: false, error: null },
    { id: 'devin', label: 'Devin', available: false, availabilityPending: true, error: null },
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
    {
      selection: { kind: 'profile', profileId: 'prof-team' }, label: 'Team',
      authStatus: 'authenticated', rateLimitStatus: 'unknown',
      usageUpdatedAt: null, isEffectiveLastUsed: false,
    },
  ],
};

const CODEX_PROFILES = {
  providerId: 'codex',
  profiles: [
    {
      selection: { kind: 'ambient' }, label: 'Terminal account',
      authStatus: 'unknown', rateLimitStatus: 'unknown',
      usageUpdatedAt: null, isEffectiveLastUsed: true,
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

const RATE_LIMITS_CLAUDE = {
  rateLimits: {
    provider: 'claude-code', available: true, subscriptionType: 'max',
    fiveHour: { usedPercent: 36, resetsAt: 1790067599749, durationMinutes: 300 },
  },
  usageUpdatedAt: USAGE_MS,
};

const RATE_LIMITS_NULL = {
  rateLimits: { provider: 'codex', available: false, reason: 'unsupported_provider' },
  usageUpdatedAt: null,
};

// ---- fake runner --------------------------------------------------------------

// handlers: [[argsArray, result|fn]] — exact argv match. Unmatched commands
// return a terminal error result (like the real CLI's exit-0 error record).
function makeRun(handlers = []) {
  const calls = [];
  const envs = [];
  let inflight = 0;
  let maxInflight = 0;
  const run = async (args, opts) => {
    calls.push(args);
    envs.push(opts && opts.env);
    inflight += 1;
    if (inflight > maxInflight) maxInflight = inflight;
    try {
      for (const [want, result] of handlers) {
        if (args.join('') === want.join('')) {
          return typeof result === 'function' ? result(args, opts) : result;
        }
      }
      return { code: 0, stdout: ndjson([resultErr('E_UNEXPECTED', `no stub for ${args.join(' ')}`)]), stderr: '' };
    } finally {
      inflight -= 1;
    }
  };
  const ok = (data, extra = []) => ({ code: 0, stdout: ndjson([...extra, resultOk(data)]), stderr: '' });
  return { run, calls, envs, maxInflight: () => maxInflight, ok };
}

function fullRun(overrides = {}) {
  const table = [
    [['agent', 'list', '--json'], ok0(AGENTS_DATA)],
    [['agent', 'list-harnesses', '--json'], ok0(HARNESSES_DATA)],
    [['agent', 'list-profiles', 'claude', '--json'], ok0(CLAUDE_PROFILES)],
    [['agent', 'list-profiles', 'codex', '--json'], ok0(CODEX_PROFILES)],
    [['agent', 'list-profiles', 'opencode', '--json'], ok0(OPENCODE_PROFILES)],
    [['agent', 'profile-rate-limits', 'claude', '--profile', 'ambient', '--json'], ok0(RATE_LIMITS_CLAUDE)],
    [['agent', 'profile-rate-limits', 'codex', '--profile', 'ambient', '--json'], ok0(RATE_LIMITS_NULL)],
    [['agent', 'profile-rate-limits', 'opencode', '--profile', 'ambient', '--json'], ok0(RATE_LIMITS_NULL)],
  ];
  function ok0(data) { return { code: 0, stdout: ndjson([resultOk(data)]), stderr: '' }; }
  for (const [k, v] of Object.entries(overrides)) {
    const args = k.split(' ');
    const idx = table.findIndex(([a]) => a.join('') === args.join(''));
    if (idx >= 0) table[idx][1] = v; else table.push([args, v]);
  }
  return makeRun(table);
}

const CTX = { host: 'test-host', surface: 'cli', agentId: AGENT_ID, epicId: EPIC_ID, ade: 'traycer' };
// Launch-environment identity — the common path (vl.js seeds these into
// callerContext). Epic ids are verified only via this env evidence.
const ENV = { TRAYCER_AGENT_ID: AGENT_ID, TRAYCER_EPIC_ID: EPIC_ID };
const NOENV = {};

function diagList(out) {
  return out.diagnostics.map((d) => `${d.code}@${d.scope}`);
}

console.log('traycer adapter — NDJSON terminal-result contract');

test('progress + terminal result: terminal record wins; its timestamp is retrieval time', async () => {
  const r = parseTerminalResult(ndjson([
    progress('starting', TS_PROGRESS),
    progress('halfway', '2026-09-22T07:59:59.000Z'),
    resultOk({ marker: 'yes' }, TS_RESULT),
  ]));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.marker, 'yes');
  assert.strictEqual(r.retrievedAt, TS_RESULT);
});

test('progress timestamps never become observation freshness', async () => {
  const fake = fullRun({
    'agent list --json': { code: 0, stdout: ndjson([progress('p1', '2026-09-22T06:00:00.000Z'), resultOk(AGENTS_DATA, TS_RESULT)]), stderr: '' },
  });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  assert.strictEqual(out.sessions[0].active.observedAt, TS_RESULT, 'session facts stamp the terminal timestamp');
  assert.ok(!JSON.stringify(out).includes('T06:00:00'), 'progress timestamp must not appear as freshness');
});

test('no terminal result → malformed; two terminal results → malformed; non-JSON line → malformed', async () => {
  for (const stdout of [
    ndjson([progress('a'), progress('b')]),
    ndjson([resultOk({}), resultOk({})]),
    ndjson([resultOk({}), 'not-json-at-all']),
    'garbage\n',
  ]) {
    const r = parseTerminalResult(stdout);
    assert.strictEqual(r.failure, 'malformed', JSON.stringify(stdout).slice(0, 60));
  }
  assert.strictEqual(parseTerminalResult(ndjson([resultErr()])).failure, 'failed');
});

console.log('\ntraycer adapter — caller resolution');

test('matching supplied agent/epic identity → authoritative caller overlay only', async () => {
  const fake = fullRun();
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  assert.deepStrictEqual(diagList(out), []);
  const c = out.caller;
  assert.ok(c, 'caller overlay emitted');
  assert.strictEqual(c.ade.value, 'traycer');
  assert.strictEqual(c.agentId.value, AGENT_ID);
  assert.strictEqual(c.agentId.source, 'traycer-cli');
  assert.strictEqual(c.agentId.observedAt, TS_RESULT);
  // epicId is never a CLI observation — the CLI output carries no epic id;
  // launch env is the only honest source and gets no CLI observedAt.
  assert.strictEqual(c.epicId.value, EPIC_ID);
  assert.strictEqual(c.epicId.source, 'traycer-env');
  assert.strictEqual(c.epicId.observedAt, null);
  assert.strictEqual(c.surface.value, 'gui', 'GUI surface preserved');
  assert.strictEqual(c.harness.value, 'devin');
  assert.deepStrictEqual(c.configuredModel.value, { kind: 'concrete', slug: 'swe-2-high' });
  // No session-bound source exists for these — the adapter must not emit them.
  for (const f of ['effectiveModel', 'defaultModel', 'selectedProfile', 'selectedAccount', 'sessionId', 'host']) {
    assert.ok(!(f in c), `overlay must not emit ${f}`);
  }
  // Supplied IDs were injected into the subprocess env.
  assert.strictEqual(fake.envs[0].TRAYCER_AGENT_ID, AGENT_ID);
  assert.strictEqual(fake.envs[0].TRAYCER_EPIC_ID, EPIC_ID);
});

test('supplied agentId mismatch vs CLI caller → mismatch diag, overlay withheld, sessions survive', async () => {
  const fake = fullRun();
  const out = await readTraycerRuntime({
    callerContext: { ...CTX, agentId: 'agent-WRONG' },
    env: ENV,
    run: fake.run,
  });
  assert.ok(diagList(out).includes('traycer-caller-mismatch@caller'));
  assert.strictEqual(out.caller, null, 'authoritative caller facts withheld on mismatch');
  assert.strictEqual(out.sessions.length, 3, 'session rows are still valid observations');
  // A foreign isSelf row can never be borrowed for a mismatched identity: the
  // only isSelf:true row is the real caller's, and it produced no overlay.
  const selfRows = out.sessions.filter((s) => s.isSelf.value === true);
  assert.deepStrictEqual(selfRows.map((s) => s.key.agentId), [AGENT_ID]);
  assert.strictEqual(out.caller, null);
});

test('supplied-vs-env identity conflict → mismatch before reads; rows keyed by env epic', async () => {
  const fake = fullRun();
  const out = await readTraycerRuntime({
    callerContext: { agentId: 'agent-other-claim', epicId: 'epic-other', host: 'h', surface: 'cli' },
    env: { TRAYCER_AGENT_ID: AGENT_ID, TRAYCER_EPIC_ID: EPIC_ID },
    run: fake.run,
  });
  assert.ok(diagList(out).includes('traycer-caller-mismatch@caller'));
  assert.strictEqual(out.caller, null);
  assert.ok(out.sessions.every((s) => s.key.epicId === EPIC_ID), 'rows stay keyed to the env-scoped query epic');
});

test('verified caller with no self row → identity-only overlay + row-absent diag', async () => {
  const data = { ...AGENTS_DATA, agents: AGENTS_DATA.agents.filter((a) => a.id !== AGENT_ID) };
  const fake = fullRun({ 'agent list --json': { code: 0, stdout: ndjson([resultOk(data)]), stderr: '' } });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  assert.ok(diagList(out).includes('traycer-caller-row-absent@caller'));
  assert.ok(out.caller, 'identity overlay still emitted');
  assert.strictEqual(out.caller.agentId.value, AGENT_ID);
  assert.ok(!('surface' in out.caller), 'no surface without a row');
});

console.log('\ntraycer adapter — failure containment');

test('missing CLI (ENOENT) → traycer-cli-missing per read; all sections empty; caller null', async () => {
  const fake = makeRun([]);
  fake.run = async () => ({ error: Object.assign(new Error('spawn traycer ENOENT'), { code: 'ENOENT' }) });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const codes = diagList(out);
  for (const scope of ['sessions', 'harnesses', 'profiles:claude', 'profiles:codex', 'profiles:opencode']) {
    assert.ok(codes.includes(`traycer-cli-missing@${scope}`), `missing diag for ${scope}: ${codes}`);
  }
  assert.strictEqual(out.caller, null);
  assert.deepStrictEqual(out.sessions, []);
  assert.deepStrictEqual(out.harnesses, []);
  assert.deepStrictEqual(out.profiles, []);
});

test('timeout → traycer-read-timeout scoped to the failed read; siblings survive', async () => {
  const fake = fullRun({
    'agent list-profiles codex --json': { timedOut: true },
    'agent profile-rate-limits codex --profile ambient --json': { timedOut: true },
  });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const codes = diagList(out);
  assert.ok(codes.includes('traycer-read-timeout@profiles:codex'));
  assert.ok(!codes.includes('traycer-read-timeout@sessions'));
  assert.strictEqual(out.sessions.length, 3);
  assert.ok(out.profiles.some((p) => p.key.provider === 'claude-code'), 'sibling profile facts survive');
});

test('malformed agents output → sessions diag only; profiles/harnesses unaffected', async () => {
  const fake = fullRun({
    'agent list --json': { code: 0, stdout: ndjson([progress('x'), 'this is not json']), stderr: '' },
  });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const codes = diagList(out);
  assert.ok(codes.includes('traycer-output-malformed@sessions'));
  assert.strictEqual(out.caller, null);
  assert.deepStrictEqual(out.sessions, []);
  assert.ok(out.harnesses.length >= 2);
  assert.ok(out.profiles.length >= 3);
});

test('terminal error result → traycer-read-failed; nonzero exit → traycer-read-failed', async () => {
  const fake = fullRun({
    'agent list-harnesses --json': { code: 0, stdout: ndjson([resultErr('E_PERMISSION', 'denied')]), stderr: '' },
  });
  let out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  assert.ok(diagList(out).includes('traycer-read-failed@harnesses'));

  const fake2 = fullRun({
    'agent list-harnesses --json': { code: 2, stdout: '', stderr: 'boom' },
  });
  out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake2.run });
  assert.ok(diagList(out).includes('traycer-read-failed@harnesses'));
});

test('no Traycer identity → live-reads-unavailable, zero subprocess invocations', async () => {
  const fake = fullRun();
  for (const ctx of [null, {}, { host: 'h', surface: 'cli' }, { agentId: 'only-agent' }]) {
    const out = await readTraycerRuntime({ callerContext: ctx, env: NOENV, run: fake.run });
    assert.deepStrictEqual(diagList(out), ['live-reads-unavailable@envelope'], JSON.stringify(ctx));
  }
  assert.strictEqual(fake.calls.length, 0, 'no identity must mean zero Traycer invocations');
});

console.log('\ntraycer adapter — profile catalog + native rate limits');

test('profile rows keyed host+provider+profileId; last-used never claims selection', async () => {
  const fake = fullRun();
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const claude = out.profiles.filter((p) => p.key.provider === 'claude-code');
  assert.strictEqual(claude.length, 2);
  const ambient = claude.find((p) => p.key.profileId === 'ambient');
  const team = claude.find((p) => p.key.profileId === 'prof-team');
  assert.strictEqual(ambient.isEffectiveLastUsed.value, true);
  assert.strictEqual(team.isEffectiveLastUsed.value, false);
  assert.strictEqual(ambient.authStatus.value, 'authenticated');
  assert.deepStrictEqual(ambient.selection.value, { kind: 'ambient' });
  // Overlay never carries selectedProfile — catalog default is not a binding.
  assert.ok(!('selectedProfile' in (out.caller || {})));
});

test('usageUpdatedAt preserved as ISO source time; null never becomes fresh capacity', async () => {
  const fake = fullRun();
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const claude = out.profiles.find((p) => p.key.provider === 'claude-code' && p.key.profileId === 'ambient');
  assert.strictEqual(claude.usageUpdatedAt.value, USAGE_ISO, 'epoch ms → ISO preserved');
  assert.strictEqual(claude.usageUpdatedAt.observedAt, USAGE_ISO);
  assert.strictEqual(claude.nativeRateLimits.provenance, 'observed');
  assert.strictEqual(claude.nativeRateLimits.observedAt, USAGE_ISO, 'native capacity observedAt = source usageUpdatedAt');
  assert.strictEqual(claude.nativeRateLimits.value.fiveHour.usedPercent, 36);

  const codex = out.profiles.find((p) => p.key.provider === 'codex');
  assert.strictEqual(codex.usageUpdatedAt.provenance, 'unknown');
  assert.strictEqual(codex.usageUpdatedAt.reason, 'native-usage-unobserved');
  assert.strictEqual(codex.nativeRateLimits.observedAt, null, 'null usageUpdatedAt → no observation time claimed');
  assert.strictEqual(codex.nativeRateLimits.freshUntil, null, 'null never becomes fresh');
  assert.strictEqual(codex.nativeRateLimits.value.available, false, 'provider false answer is a valid observation, not malformed');
});

test('profile-rate-limits runs only for isEffectiveLastUsed profiles', async () => {
  const fake = fullRun();
  await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const rl = fake.calls.filter((a) => a[1] === 'profile-rate-limits');
  assert.strictEqual(rl.length, 3, 'one detailed read per harness');
  assert.ok(rl.every((a) => a.includes('ambient')), 'each read targets the last-used ambient selection');
});

test('detailed read failure is scoped; catalog row survives', async () => {
  const fake = fullRun({
    'agent profile-rate-limits claude --profile ambient --json': { timedOut: true },
  });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  assert.ok(diagList(out).includes('traycer-read-timeout@rate-limits:claude:ambient'));
  const claude = out.profiles.find((p) => p.key.provider === 'claude-code' && p.key.profileId === 'ambient');
  assert.strictEqual(claude.authStatus.value, 'authenticated', 'catalog facts survive a failed detailed read');
  assert.ok(!('nativeRateLimits' in claude));
});

test('identical command keys coalesce to one subprocess', async () => {
  const dupProfiles = {
    providerId: 'codex',
    profiles: [
      { selection: { kind: 'ambient' }, label: 'A', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: null, isEffectiveLastUsed: true },
      { selection: { kind: 'ambient' }, label: 'B', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: null, isEffectiveLastUsed: true },
    ],
  };
  const fake = fullRun({
    'agent list-profiles codex --json': { code: 0, stdout: ndjson([resultOk(dupProfiles)]), stderr: '' },
  });
  await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const rlCalls = fake.calls.filter((a) => a.join(' ') === 'agent profile-rate-limits codex --profile ambient --json');
  assert.strictEqual(rlCalls.length, 1, 'duplicate profile selections coalesce');
});

test('at most MAX_CONCURRENT Traycer subprocesses at once', async () => {
  const fake = fullRun();
  await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  assert.ok(fake.maxInflight() <= 2, `max concurrency ${fake.maxInflight()} exceeds 2`);
  assert.ok(fake.calls.length >= 5, 'all wave-1 reads ran');
});

console.log('\ntraycer adapter — harness rows and surface separation');

test('catalog rows keyed by caller surface; pending availability is unknown; usage rows merge', async () => {
  const fake = fullRun();
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const devin = out.harnesses.find((h) => h.key.harness === 'devin');
  assert.ok(devin, 'catalog row for devin');
  assert.strictEqual(devin.key.surface, 'gui', 'catalog keyed by resolved caller surface');
  assert.strictEqual(devin.available.provenance, 'unknown');
  assert.strictEqual(devin.available.reason, 'availability-pending', 'pending catalog → unknown, not false');
  assert.strictEqual(devin.availabilityPending.value, true);
  assert.deepStrictEqual(devin.sessionRefs, [{ host: HOST_ID, ade: 'traycer', epicId: EPIC_ID, agentId: AGENT_ID }]);
  const claudeTui = out.harnesses.find((h) => h.key.harness === 'claude' && h.key.surface === 'tui');
  assert.ok(claudeTui, 'TUI usage row emitted');
  assert.strictEqual(claudeTui.available.reason, 'harness-catalog-absent', 'GUI catalog does not prove TUI install');
  const claudeGui = out.harnesses.find((h) => h.key.harness === 'claude' && h.key.surface === 'gui');
  assert.strictEqual(claudeGui.available.value, true);
});

console.log('\ntraycer adapter — sentinel containment');

test('junk fields on agent/profile rows never reach output', async () => {
  const SENTINEL = 'SENTINEL-TRAYCER-9x2q';
  const dirty = {
    caller: { agentId: AGENT_ID, smuggled: SENTINEL },
    agents: [
      { ...AGENTS_DATA.agents[0], credential: SENTINEL, nested: { leak: SENTINEL }, list: [SENTINEL] },
    ],
  };
  const fake = fullRun({ 'agent list --json': { code: 0, stdout: ndjson([resultOk(dirty)]), stderr: '' } });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  assert.ok(!JSON.stringify(out).includes(SENTINEL), 'raw CLI bytes must not leak into rows');
});

console.log('\nsnapshot wiring — refresh gates the adapter');

test('refresh:false performs ZERO Traycer invocations even with full identity', async () => {
  const fake = fullRun();
  let readTraycerCalls = 0;
  const dir = scratch();
  const s = await getRuntimeSnapshot({
    refresh: false,
    now: frozen,
    dataDir: dir,
    callerContext: CTX,
    io: {
      env: { TRAYCER_AGENT_ID: AGENT_ID, TRAYCER_EPIC_ID: EPIC_ID },
      traycerRun: fake.run,
      readTraycer: async (...a) => { readTraycerCalls += 1; return readTraycerRuntime(...a); },
    },
  });
  assert.strictEqual(readTraycerCalls, 0);
  assert.strictEqual(fake.calls.length, 0);
  assert.ok(!diagList(s).includes('live-reads-unavailable@envelope'), 'no refresh → no live-source diagnostic');
  assert.strictEqual(s.requestedRefresh, false);
});

test('refresh:true composes live rows, caller overlay, and cached siblings', async () => {
  const fake = fullRun();
  const dir = scratch();
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: new Date(NOW - 60_000).toISOString(),
    sessions: [
      { key: { host: HOST_ID, ade: 'traycer', epicId: EPIC_ID, agentId: AGENT_ID }, stale: { value: 'cached', provenance: 'observed' } },
      { key: { host: HOST_ID, ade: 'traycer', epicId: EPIC_ID, agentId: 'cached-only' }, note: { value: 'kept', provenance: 'observed' } },
    ],
  });
  const s = await getRuntimeSnapshot({
    refresh: true, now: frozen, dataDir: dir,
    callerContext: CTX,
    io: { env: ENV, traycerRun: fake.run },
  });
  assert.strictEqual(s.requestedRefresh, true);
  assert.strictEqual(s.caller.surface.value, 'gui', 'authoritative surface replaces cli claim');
  assert.strictEqual(s.caller.surface.source, 'traycer-cli');
  assert.strictEqual(s.caller.agentId.value, AGENT_ID);
  assert.deepStrictEqual(s.caller.configuredModel.value, { kind: 'concrete', slug: 'swe-2-high' });
  assert.strictEqual(s.caller.effectiveModel.provenance, 'unknown', 'no session-bound evidence');
  assert.strictEqual(s.caller.selectedProfile.provenance, 'unknown', 'catalog last-used is not a selection');
  // same-key cached row replaced by live row; cache-only row survives
  const self = s.sessions.find((r) => r.key.agentId === AGENT_ID);
  assert.ok(self && !('stale' in self), 'live row replaced the cached row for the same key');
  assert.ok(s.sessions.some((r) => r.key.agentId === 'cached-only' && r.note.value === 'kept'), 'cache-only sibling survives');
  assert.ok(s.harnesses.length >= 2);
  assert.ok(s.profiles.length >= 4);
  assert.strictEqual(s.completeness, 'partial');
});

test('refresh:true with no Traycer identity → live-reads-unavailable, cache-only, zero calls', async () => {
  const fake = fullRun();
  const dir = scratch();
  const s = await getRuntimeSnapshot({
    refresh: true, now: frozen, dataDir: dir,
    callerContext: { host: 'h', surface: 'cli' },
    io: { env: {}, traycerRun: fake.run },
  });
  assert.ok(diagList(s).includes('live-reads-unavailable@envelope'));
  assert.strictEqual(fake.calls.length, 0);
  assert.deepStrictEqual(s.sessions, []);
});

test('refresh:true total adapter failure degrades sections, keeps routes+callerContext', async () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: new Date(NOW).toISOString(),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date(NOW - 60_000).toISOString(),
        freshUntil: new Date(NOW + 300_000).toISOString(), source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const fake = makeRun([]);
  fake.run = async () => ({ error: Object.assign(new Error('spawn traycer ENOENT'), { code: 'ENOENT' }) });
  const s = await getRuntimeSnapshot({
    refresh: true, now: frozen, dataDir: dir,
    callerContext: CTX,
    io: { env: {}, traycerRun: fake.run },
  });
  const codes = diagList(s);
  assert.ok(codes.includes('traycer-cli-missing@sessions'));
  const kimi = s.routes.find((r) => r.id === 'kimi-code-plan');
  assert.strictEqual(kimi.resource.state.value, 'healthy', 'external route facts survive a dead Traycer CLI');
  assert.strictEqual(s.caller.agentId.value, AGENT_ID, 'supplied caller identity still reported from callerContext');
});

test('env identity alone (no supplied caller ids) resolves the caller row', async () => {
  const fake = fullRun();
  const dir = scratch();
  const s = await getRuntimeSnapshot({
    refresh: true, now: frozen, dataDir: dir,
    callerContext: { host: 'h', surface: 'cli' },
    io: { env: { TRAYCER_AGENT_ID: AGENT_ID, TRAYCER_EPIC_ID: EPIC_ID }, traycerRun: fake.run },
  });
  assert.strictEqual(s.caller.agentId.value, AGENT_ID);
  assert.strictEqual(s.caller.agentId.source, 'traycer-cli');
  assert.strictEqual(s.caller.epicId.value, EPIC_ID);
  assert.strictEqual(s.caller.epicId.source, 'traycer-env', 'epicId is env evidence, not a CLI observation');
  assert.strictEqual(s.caller.epicId.observedAt, null);
  assert.strictEqual(s.caller.surface.value, 'gui');
  assert.strictEqual(s.sessions.length, 3);
});

console.log('\ntraycer adapter — env caller seed');

test('traycerEnvCallerContext emits only present IDs, sourced traycer-env', () => {
  const seed = traycerEnvCallerContext({ TRAYCER_AGENT_ID: 'a1', TRAYCER_EPIC_ID: 'e1' });
  assert.strictEqual(seed.ade.value, 'traycer');
  assert.strictEqual(seed.agentId.value, 'a1');
  assert.strictEqual(seed.agentId.source, 'traycer-env');
  assert.strictEqual(seed.epicId.value, 'e1');
  const none = traycerEnvCallerContext({});
  assert.deepStrictEqual(none, {});
  const partial = traycerEnvCallerContext({ TRAYCER_EPIC_ID: 'e1' });
  assert.ok(!('ade' in partial) && !('agentId' in partial));
  assert.strictEqual(partial.epicId.value, 'e1');
});

test('no lingering handles after a live refresh', async () => {
  const fake = fullRun();
  const before = process._getActiveHandles().length;
  const dir = scratch();
  await getRuntimeSnapshot({
    refresh: true, now: frozen, dataDir: dir,
    callerContext: CTX, io: { env: ENV, traycerRun: fake.run },
  });
  const after = process._getActiveHandles().length;
  assert.deepStrictEqual(after, before, 'live refresh must not leave handles');
});

console.log('\ntraycer adapter — epic verification');

test('supplied-only epic id (no env evidence) → session rows withheld, never keyed on the claim', async () => {
  const fake = fullRun();
  const out = await readTraycerRuntime({ callerContext: CTX, env: {}, run: fake.run });
  assert.ok(diagList(out).includes('traycer-epic-unverified@sessions'));
  assert.deepStrictEqual(out.sessions, [], 'unverified epic must not propagate into session row keys');
  // The caller row itself is still verified against the CLI caller.agentId.
  assert.ok(out.caller, 'caller overlay still emitted — agentId was CLI-verified');
  assert.strictEqual(out.caller.agentId.value, AGENT_ID);
  assert.ok(!('epicId' in out.caller), 'unverified epic is not overlaid');
  // Host-scoped sections are unaffected — their keys carry no epic id.
  assert.ok(out.harnesses.length >= 2);
  assert.ok(out.profiles.length >= 3);
  // And no sessionRef may leak the unverified epic either.
  for (const h of out.harnesses) assert.deepStrictEqual(h.sessionRefs, []);
});

console.log('\ntraycer adapter — diagnostic uniqueness and edge timestamps');

test('two failed rate-limit reads on one harness never duplicate (code,scope)', async () => {
  const twoLastUsed = {
    providerId: 'codex',
    profiles: [
      { selection: { kind: 'ambient' }, label: 'A', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: null, isEffectiveLastUsed: true },
      { selection: { kind: 'profile', profileId: 'prof-b' }, label: 'B', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: null, isEffectiveLastUsed: true },
    ],
  };
  const fake = fullRun({
    'agent list-profiles codex --json': { code: 0, stdout: ndjson([resultOk(twoLastUsed)]), stderr: '' },
    'agent profile-rate-limits codex --profile ambient --json': { timedOut: true },
    'agent profile-rate-limits codex --profile prof-b --json': { timedOut: true },
  });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const pairs = out.diagnostics.map((d) => `${d.code}|${d.scope}`);
  assert.strictEqual(new Set(pairs).size, pairs.length, `duplicate diagnostics: ${pairs.join(', ')}`);
  assert.ok(pairs.includes('traycer-read-timeout|rate-limits:codex:ambient'));
  assert.ok(pairs.includes('traycer-read-timeout|rate-limits:codex:prof-b'));
});

test('coalesced duplicate selections share one read AND one diagnostic', async () => {
  const dupSame = {
    providerId: 'codex',
    profiles: [
      { selection: { kind: 'ambient' }, label: 'A', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: null, isEffectiveLastUsed: true },
      { selection: { kind: 'ambient' }, label: 'B', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: null, isEffectiveLastUsed: true },
    ],
  };
  const fake = fullRun({
    'agent list-profiles codex --json': { code: 0, stdout: ndjson([resultOk(dupSame)]), stderr: '' },
    'agent profile-rate-limits codex --profile ambient --json': { timedOut: true },
  });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const rlCalls = fake.calls.filter((a) => a.join(' ') === 'agent profile-rate-limits codex --profile ambient --json');
  assert.strictEqual(rlCalls.length, 1);
  const pairs = out.diagnostics.map((d) => `${d.code}|${d.scope}`);
  assert.strictEqual(new Set(pairs).size, pairs.length, 'coalesced read must emit at most one diagnostic');
});

test('usageUpdatedAt: 0 (epoch) is a real timestamp, not null', async () => {
  const zeroUsage = {
    providerId: 'codex',
    profiles: [
      { selection: { kind: 'ambient' }, label: 'A', authStatus: 'unknown', rateLimitStatus: 'unknown', usageUpdatedAt: 0, isEffectiveLastUsed: true },
    ],
  };
  const zeroRate = { rateLimits: { provider: 'codex', available: true }, usageUpdatedAt: 0 };
  const fake = fullRun({
    'agent list-profiles codex --json': { code: 0, stdout: ndjson([resultOk(zeroUsage)]), stderr: '' },
    'agent profile-rate-limits codex --profile ambient --json': { code: 0, stdout: ndjson([resultOk(zeroRate)]), stderr: '' },
  });
  const out = await readTraycerRuntime({ callerContext: CTX, env: ENV, run: fake.run });
  const codex = out.profiles.find((p) => p.key.provider === 'codex');
  assert.strictEqual(codex.usageUpdatedAt.value, '1970-01-01T00:00:00.000Z');
  assert.strictEqual(codex.nativeRateLimits.observedAt, '1970-01-01T00:00:00.000Z');
});

console.log('\nsnapshot wiring — adapter failure boundaries');

test('a throwing adapter degrades to traycer-read-failed@traycer, not a rejection', async () => {
  const dir = scratch();
  const s = await getRuntimeSnapshot({
    refresh: true, now: frozen, dataDir: dir,
    callerContext: CTX,
    io: { env: ENV, readTraycer: async () => { throw new Error('adapter exploded'); } },
  });
  assert.ok(diagList(s).includes('traycer-read-failed@traycer'));
  assert.strictEqual(s.requestedRefresh, true);
  assert.strictEqual(s.caller.agentId.value, AGENT_ID, 'supplied caller context still reported');
});

test('refresh:true writes nothing to the data directory', async () => {
  const fake = fullRun();
  const dir = scratch();
  const before = fs.readdirSync(dir).sort();
  await getRuntimeSnapshot({
    refresh: true, now: frozen, dataDir: dir,
    callerContext: CTX, io: { env: ENV, traycerRun: fake.run },
  });
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'live refresh must not write');
  assert.ok(fake.calls.length > 0, 'live reads actually ran');
});

Promise.all(pendingTests).then(() => {
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall traycer-adapter tests passed');
});
