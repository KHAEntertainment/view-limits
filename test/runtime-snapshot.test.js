'use strict';
// Library-level tests for lib/runtime-snapshot.js getRuntimeSnapshot().
// Every test injects an isolated scratch dataDir and a frozen clock — no
// network, credentials, subprocesses, or real provider data.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getRuntimeSnapshot, SNAPSHOT_SCHEMA_VERSION } = require('../lib/runtime-snapshot');
const { parseStrictIsoTimestamp } = require('../lib/gate');

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

const NOW = Date.parse('2026-09-19T00:00:00Z');
const frozen = () => NOW;
const iso = (deltaMs) => new Date(NOW + deltaMs).toISOString();

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-snap-'));
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

const ENVELOPE_KEYS = [
  'schemaVersion', 'generatedAt', 'requestedRefresh', 'completeness',
  'diagnostics', 'caller', 'sessions', 'harnesses', 'profiles', 'routes',
];

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

console.log('runtime snapshot — envelope and schema');

test('envelope keys, schemaVersion 1, requestedRefresh false, strict-ISO generatedAt', async () => {
  const dir = scratch();
  const s = await snap(dir);
  assert.deepStrictEqual(new Set(Object.keys(s)), new Set(ENVELOPE_KEYS));
  assert.strictEqual(s.schemaVersion, 1);
  assert.strictEqual(SNAPSHOT_SCHEMA_VERSION, 1);
  assert.strictEqual(s.requestedRefresh, false);
  assert.strictEqual(parseStrictIsoTimestamp(s.generatedAt), NOW, 'generatedAt must round-trip the strict parser');
  assert.ok(['complete', 'partial', 'empty'].includes(s.completeness));
  assert.ok(Array.isArray(s.diagnostics));
  for (const section of ['sessions', 'harnesses', 'profiles', 'routes']) {
    assert.ok(Array.isArray(s[section]), `${section} must be an array`);
  }
});

console.log('\nruntime snapshot — truthful unknowns');

test('empty dataDir + null callerContext → completeness empty, caller-context-absent, all unknowns carry reasons', async () => {
  const dir = scratch();
  const s = await snap(dir, { callerContext: null });
  assert.strictEqual(s.completeness, 'empty');
  assert.ok(diagCodes(s).includes('caller-context-absent@caller'));
  for (const [field, f] of Object.entries(s.caller)) {
    assert.strictEqual(f.value, null, `caller.${field} must be null`);
    assert.strictEqual(f.provenance, 'unknown', `caller.${field} provenance`);
    assert.ok(typeof f.reason === 'string' && f.reason.length > 0, `caller.${field} needs a reason`);
  }
  assert.strictEqual(s.caller.differsFromDefault.reason, 'model-comparison-unavailable');
  assert.deepStrictEqual(s.sessions, []);
  assert.deepStrictEqual(s.harnesses, []);
  assert.deepStrictEqual(s.profiles, []);
  // No fact may silently be false / 0 / 'exhausted' / 'unavailable'.
  for (const f of collectFacts(s)) {
    if (f.provenance === 'unknown') continue;
    assert.ok(f.value !== false && f.value !== 0 && f.value !== 'exhausted' && f.value !== 'unavailable',
      `known fact must not carry a sentinel-looking value: ${JSON.stringify(f)}`);
    assert.notStrictEqual(f.value, null, 'non-unknown fact must have a value');
  }
  // Route resource fields are all unknown; configured identity remains known.
  for (const r of s.routes) {
    assert.strictEqual(r.resource.state.provenance, 'unknown');
    assert.strictEqual(r.resource.state.reason, 'no-cached-observation');
    assert.strictEqual(r.provider.provenance, 'configured');
  }
});

test('unknown is never false/0/exhausted — value null + reason only', async () => {
  const dir = scratch();
  const s = await snap(dir);
  for (const f of collectFacts(s)) {
    if (f.provenance !== 'unknown') continue;
    assert.strictEqual(f.value, null);
    assert.ok(f.reason, 'unknown fact needs a reason code');
  }
});

console.log('\nruntime snapshot — distinct model facts and differsFromDefault');

test('configured/default/effective are three distinct facts', async () => {
  const dir = scratch();
  const s = await snap(dir, {
    callerContext: {
      configuredModel: { value: 'cfg-x', provenance: 'configured' },
      defaultModel: { value: 'def-y', provenance: 'configured' },
      effectiveModel: { value: 'eff-z', provenance: 'observed' },
    },
  });
  assert.strictEqual(s.caller.configuredModel.value, 'cfg-x');
  assert.strictEqual(s.caller.configuredModel.provenance, 'configured');
  assert.strictEqual(s.caller.defaultModel.value, 'def-y');
  assert.strictEqual(s.caller.effectiveModel.value, 'eff-z');
  assert.strictEqual(s.caller.effectiveModel.provenance, 'observed');
  assert.strictEqual(s.caller.differsFromDefault.value, true);
  assert.strictEqual(s.caller.differsFromDefault.provenance, 'observed');
});

test('differsFromDefault matrix — null unless BOTH models known', async () => {
  const dir = scratch();
  for (const ctx of [
    { effectiveModel: 'eff-z' },
    { defaultModel: 'def-y' },
    {},
  ]) {
    const s = await snap(dir, { callerContext: ctx });
    const d = s.caller.differsFromDefault;
    assert.strictEqual(d.value, null, JSON.stringify(ctx));
    assert.strictEqual(d.provenance, 'unknown');
    assert.strictEqual(d.reason, 'model-comparison-unavailable');
  }
  const eq = await snap(dir, { callerContext: { effectiveModel: 'm', defaultModel: 'm' } });
  assert.strictEqual(eq.caller.differsFromDefault.value, false);
  assert.strictEqual(eq.caller.differsFromDefault.provenance, 'observed');
  const neq = await snap(dir, { callerContext: { effectiveModel: 'a', defaultModel: 'b' } });
  assert.strictEqual(neq.caller.differsFromDefault.value, true);
});

test('a callerContext-supplied differsFromDefault is recomputed, never trusted', async () => {
  const dir = scratch();
  const s = await snap(dir, { callerContext: { differsFromDefault: false } });
  assert.strictEqual(s.caller.differsFromDefault.provenance, 'unknown');
  assert.strictEqual(s.caller.differsFromDefault.reason, 'model-comparison-unavailable');
});

console.log('\nruntime snapshot — caller assembly');

test('primitive callerContext fields wrap as observed facts from callerContext', async () => {
  const dir = scratch();
  const s = await snap(dir, { callerContext: { agentId: 'agent-1', harness: 'claude' } });
  assert.strictEqual(s.caller.agentId.value, 'agent-1');
  assert.strictEqual(s.caller.agentId.provenance, 'observed');
  assert.strictEqual(s.caller.agentId.source, 'callerContext');
  assert.strictEqual(s.caller.harness.value, 'claude');
});

test('callerContext {} → no absent-diagnostic but fields still unknown', async () => {
  const dir = scratch();
  const s = await snap(dir, { callerContext: {} });
  assert.ok(!diagCodes(s).includes('caller-context-absent@caller'));
  assert.strictEqual(s.caller.agentId.reason, 'caller-fact-absent');
});

test('caller assembled at request time — second call cannot inherit the first identity', async () => {
  const dir = scratch();
  const first = await snap(dir, { callerContext: { agentId: 'agent-A', epicId: 'epic-1' } });
  const second = await snap(dir, { callerContext: { agentId: 'agent-B' } });
  assert.strictEqual(first.caller.agentId.value, 'agent-A');
  assert.strictEqual(second.caller.agentId.value, 'agent-B');
  assert.strictEqual(second.caller.epicId.value, null, 'epicId from first call must not leak');
  assert.strictEqual(second.caller.epicId.reason, 'caller-fact-absent');
});

test('selectedProfile comes only from callerContext — sidecar profiles never fill it', async () => {
  const dir = scratch();
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: iso(0),
    profiles: [
      { key: { host: 'h', provider: 'p', profileId: 'p-default' },
        isDefault: { value: true, provenance: 'configured' },
        isLastUsed: { value: true, provenance: 'observed' } },
    ],
  });
  const withSel = await snap(dir, { callerContext: { selectedProfile: 'p-a' } });
  assert.strictEqual(withSel.caller.selectedProfile.value, 'p-a');
  const without = await snap(dir, { callerContext: {} });
  assert.strictEqual(without.caller.selectedProfile.value, null);
  assert.strictEqual(without.caller.selectedProfile.reason, 'caller-fact-absent');
  assert.strictEqual(without.profiles.length, 1, 'profile row still present');
});

console.log('\nruntime snapshot — sidecar version degrade');

test('unsupported versions degrade to unknown', async () => {
  for (const doc of [
    { version: 2, sessions: [{ key: { host: 'h', ade: 'a', epicId: 'e', agentId: 'g' } }] },
    { updatedAt: iso(0), sessions: [] },           // version field absent
    { version: 0, sessions: [] },
    { version: '1', sessions: [] },
  ]) {
    const dir = scratch();
    writeJson(dir, 'runtime.json', doc);
    const s = await snap(dir);
    assert.ok(diagCodes(s).includes('runtime-sidecar-unsupported@sidecar'), JSON.stringify(doc));
    assert.deepStrictEqual(s.sessions, []);
    assert.deepStrictEqual(s.harnesses, []);
    assert.deepStrictEqual(s.profiles, []);
  }
});

test('corrupt sidecar roots degrade to unknown', async () => {
  for (const raw of ['{garbage', 'null', '[]', '"x"', '42']) {
    const dir = scratch();
    writeJson(dir, 'runtime.json', raw);
    const s = await snap(dir);
    assert.ok(diagCodes(s).includes('runtime-sidecar-corrupt@sidecar'), raw);
    assert.deepStrictEqual(s.sessions, []);
  }
});

test('absent sidecar is not an error — sections empty, no diagnostic', async () => {
  const dir = scratch();
  const s = await snap(dir);
  assert.deepStrictEqual(s.sessions, []);
  assert.ok(!diagCodes(s).some((c) => c.startsWith('runtime-sidecar')));
});

console.log('\nruntime snapshot — sidecar section validation');

test('malformed section degrades alone; valid siblings survive; no duplicate (code,scope)', async () => {
  const dir = scratch();
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: iso(0),
    sessions: { not: 'an-array' },
    profiles: [{ key: { host: 'h', provider: 'p', profileId: 'prof-1' } }],
  });
  const s = await snap(dir);
  assert.ok(diagCodes(s).includes('runtime-sidecar-section-invalid@sessions'));
  assert.strictEqual(s.profiles.length, 1);
  assert.strictEqual(s.profiles[0].key.profileId, 'prof-1');
  const pairs = s.diagnostics.map((d) => `${d.code}|${d.scope}`);
  assert.strictEqual(new Set(pairs).size, pairs.length, 'no duplicate (code,scope) diagnostics');
});

test('rows missing key fields dropped; duplicate keys keep first occurrence', async () => {
  const dir = scratch();
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: iso(0),
    sessions: [
      { key: { host: 'h', ade: 'a', epicId: 'e', agentId: 'g1' }, note: { value: 'first', provenance: 'observed' } },
      { key: { host: 'h', ade: 'a', epicId: 'e' }, note: { value: 'no-agent', provenance: 'observed' } },
      { key: { host: 'h', ade: 'a', epicId: 'e', agentId: 'g1' }, note: { value: 'dup', provenance: 'observed' } },
      { note: { value: 'no-key', provenance: 'observed' } },
    ],
  });
  const s = await snap(dir);
  assert.strictEqual(s.sessions.length, 1);
  assert.strictEqual(s.sessions[0].note.value, 'first', 'first occurrence retained');
  assert.ok(diagCodes(s).includes('runtime-sidecar-section-invalid@sessions'));
});

console.log('\nruntime snapshot — cross-session isolation');

test('two agents on one harness stay distinct rows; caller reflects only injected context', async () => {
  const dir = scratch();
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: iso(0),
    sessions: [
      { key: { host: 'h', ade: 'traycer', epicId: 'e1', agentId: 'agent-A' },
        activity: { value: 'editing', provenance: 'observed' } },
      { key: { host: 'h', ade: 'traycer', epicId: 'e1', agentId: 'agent-B' },
        activity: { value: 'idle', provenance: 'observed' } },
    ],
  });
  const s = await snap(dir, { callerContext: { agentId: 'agent-A', ade: 'traycer', epicId: 'e1' } });
  assert.strictEqual(s.sessions.length, 2);
  const ids = s.sessions.map((r) => r.key.agentId).sort();
  assert.deepStrictEqual(ids, ['agent-A', 'agent-B']);
  assert.strictEqual(s.caller.agentId.value, 'agent-A', 'caller is the injected identity');
  // The sidecar's agent-B row must not bleed into the caller section.
  assert.ok(!JSON.stringify(s.caller).includes('agent-B'));
});

console.log('\nruntime snapshot — routes resource state and freshness');

test('fresh exhausted / stale exhausted / unknown freshness — state always verbatim', async () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: iso(0),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: iso(-60_000), freshUntil: iso(300_000),
        source: 'kimi',
        status: { state: 'exhausted', windows: [{ type: 'weekly', remaining: 0, limit: 100 }], balance: null, resetAt: null },
      },
      'openrouter-main': {
        routeId: 'openrouter-main', observedAt: iso(-3_600_000), freshUntil: iso(-3_000_000),
        source: 'openrouter',
        status: { state: 'exhausted', windows: [], balance: { available: 0, currency: 'USD' }, resetAt: null },
      },
      'glm-coding-plan': {
        routeId: 'glm-coding-plan', observedAt: null, freshUntil: 'not-a-date',
        source: 'glm',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const s = await snap(dir);
  const byId = Object.fromEntries(s.routes.map((r) => [r.id, r]));

  const kimi = byId['kimi-code-plan'];
  assert.strictEqual(kimi.resource.freshness, 'fresh');
  assert.strictEqual(kimi.resource.state.value, 'exhausted');
  assert.strictEqual(kimi.resource.state.provenance, 'observed');
  assert.strictEqual(kimi.resource.observedAt.value, iso(-60_000), 'observedAt preserved verbatim');
  assert.strictEqual(kimi.resource.source.value, 'kimi');
  assert.deepStrictEqual(kimi.resource.windows, [{ type: 'weekly', remaining: 0, limit: 100 }]);

  const or = byId['openrouter-main'];
  assert.strictEqual(or.resource.freshness, 'stale', 'past freshUntil is stale, not fresh');
  assert.strictEqual(or.resource.state.value, 'exhausted', 'state verbatim even when stale — snapshot never claims exhausted-without-fresh');
  assert.deepStrictEqual(or.resource.balance, { available: 0, currency: 'USD' });

  const glm = byId['glm-coding-plan'];
  assert.strictEqual(glm.resource.freshness, 'unknown');
  assert.strictEqual(glm.resource.state.value, 'healthy');
  assert.strictEqual(glm.resource.observedAt.provenance, 'unknown');
  assert.strictEqual(glm.resource.observedAt.reason, 'cached-field-absent');

  const ds = byId['deepseek-direct'];
  assert.strictEqual(ds.resource.state.reason, 'no-cached-observation');
  assert.strictEqual(ds.resource.freshness, 'unknown');

  // None of these may emit a route diagnostic — only malformed entries do.
  assert.ok(!diagCodes(s).includes('status-entry-malformed@routes'));
  assert.ok(!diagCodes(s).includes('status-cache-corrupt@routes'));
});

test('freshness boundary: freshUntil == now is fresh', async () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: iso(0),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: iso(-1000), freshUntil: iso(0),
        source: 'kimi', status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const s = await snap(dir);
  assert.strictEqual(s.routes.find((r) => r.id === 'kimi-code-plan').resource.freshness, 'fresh');
});

test('orphan cache route → configured:false, identity unknown', async () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: iso(0),
    routes: {
      'phantom-route': {
        routeId: 'phantom-route', observedAt: iso(-100), freshUntil: iso(60_000),
        source: 'kimi', status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const s = await snap(dir);
  const orphan = s.routes.find((r) => r.id === 'phantom-route');
  assert.ok(orphan, 'orphan cache route must still be emitted');
  assert.strictEqual(orphan.configured, false);
  for (const field of ['provider', 'account', 'modelBinding', 'harnessBinding']) {
    assert.strictEqual(orphan[field].provenance, 'unknown', field);
    assert.strictEqual(orphan[field].reason, 'route-not-configured', field);
  }
  assert.strictEqual(orphan.resource.state.value, 'healthy', 'cached evidence still carried');
});

test('malformed status entry → status-entry-malformed, all resource facts unknown, nothing carried', async () => {
  const dir = scratch();
  writeJson(dir, 'status.json', {
    updatedAt: iso(0),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: iso(-100), freshUntil: iso(60_000), source: 'kimi',
        status: 'not-an-object-status',
      },
    },
  });
  const s = await snap(dir);
  assert.ok(diagCodes(s).includes('status-entry-malformed@routes'));
  const row = s.routes.find((r) => r.id === 'kimi-code-plan');
  assert.strictEqual(row.resource.state.provenance, 'unknown');
  assert.strictEqual(row.resource.observedAt.provenance, 'unknown');
  assert.strictEqual(row.resource.freshness, 'unknown');
  assert.deepStrictEqual(row.resource.windows, []);
  assert.strictEqual(row.resource.balance, null);
  assert.ok(!JSON.stringify(row).includes('not-an-object-status'), 'malformed payload must not leak');
});

test('status.json corrupt → routes still listed, resources unknown, status-cache-corrupt', async () => {
  const dir = scratch();
  writeJson(dir, 'status.json', '{corrupt');
  const s = await snap(dir);
  assert.ok(diagCodes(s).includes('status-cache-corrupt@routes'));
  assert.ok(s.routes.length >= 5, 'configured routes still listed');
  for (const r of s.routes) assert.strictEqual(r.resource.state.reason, 'no-cached-observation');
});

test('config.json corrupt → defaults in effect + config-corrupt diagnostic', async () => {
  const dir = scratch();
  writeJson(dir, 'config.json', '{bad');
  const s = await snap(dir);
  assert.ok(diagCodes(s).includes('config-corrupt@routes'));
  assert.ok(s.routes.some((r) => r.id === 'kimi-code-plan'), 'defaults still applied');
});

console.log('\nruntime snapshot — diagnostic safety (sentinel)');

test('sentinel in corrupt runtime.json and malformed status never reaches output', async () => {
  const SENTINEL = 'SENTINEL-LEAK-XYZ-7f3c';
  const dir = scratch();
  writeJson(dir, 'runtime.json', `{"version":1,"sessions":[${SENTINEL}`);
  writeJson(dir, 'status.json', {
    updatedAt: iso(0),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: iso(-100), freshUntil: iso(60_000), source: 'kimi',
        status: `the status field contains ${SENTINEL} inline`,
      },
    },
  });
  const s = await snap(dir);
  const text = JSON.stringify(s);
  assert.ok(!text.includes(SENTINEL), 'sentinel leaked into snapshot JSON');
  for (const d of s.diagnostics) {
    assert.ok(!d.summary.includes(SENTINEL));
    assert.ok(/^[a-z-]+$/.test(d.code), `code ${d.code} must be a stable slug`);
  }
});

console.log('\nruntime snapshot — completeness ladder');

test('complete requires zero unknown facts and zero diagnostics', async () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'only-route', provider: 'kimi', account: 'main', match: { model: 'kimi', harness: 'cli' } }],
  });
  writeJson(dir, 'status.json', {
    updatedAt: iso(0),
    routes: {
      'only-route': {
        routeId: 'only-route', observedAt: iso(-100), freshUntil: iso(60_000), source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: iso(3_600_000) },
      },
    },
  });
  const fullCtx = {
    ade: 'traycer', host: 'h', surface: 'tui', harness: 'claude',
    epicId: 'e', sessionId: 's', agentId: 'a',
    configuredModel: 'm', defaultModel: 'm', effectiveModel: 'm',
    selectedProfile: 'p', selectedAccount: 'acc',
  };
  const s = await snap(dir, { callerContext: fullCtx });
  assert.strictEqual(s.diagnostics.length, 0, JSON.stringify(s.diagnostics));
  const unknowns = collectFacts(s).filter((f) => f.provenance === 'unknown');
  assert.strictEqual(unknowns.length, 0, `unknown facts remain: ${JSON.stringify(unknowns[0])}`);
  assert.strictEqual(s.completeness, 'complete');
});

test('partial when some facts observed and some unknown', async () => {
  const dir = scratch();
  const s = await snap(dir, { callerContext: { agentId: 'a' } });
  assert.strictEqual(s.completeness, 'partial');
});

console.log('\nruntime snapshot — purity');

test('two calls, identical injected args + frozen clock → byte-identical output', async () => {
  const dir = scratch();
  writeJson(dir, 'runtime.json', { version: 1, sessions: [{ key: { host: 'h', ade: 'a', epicId: 'e', agentId: 'g' } }] });
  const a = await snap(dir, { callerContext: { agentId: 'g' } });
  const b = await snap(dir, { callerContext: { agentId: 'g' } });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test('no lingering handles or resources after calls', async () => {
  const dir = scratch();
  const before = {
    handles: process._getActiveHandles().length,
    resources: process._getActiveResources ? process._getActiveResources().length : 0,
  };
  await snap(dir, { callerContext: {} });
  await snap(dir, { callerContext: {} });
  const after = {
    handles: process._getActiveHandles().length,
    resources: process._getActiveResources ? process._getActiveResources().length : 0,
  };
  assert.deepStrictEqual(after, before, 'snapshot must not leave timers/sockets/handles');
});

Promise.all(pendingTests).then(() => {
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall runtime-snapshot tests passed');
});
