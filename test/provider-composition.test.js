'use strict';
// Issue #8 — provider-route composition + runtime inventory renderer.
// Library tests inject isolated scratch dataDirs, a frozen clock and stubbed
// live sources; CLI tests spawn bin/vl.js against a file-vault fixture dir.
// No network, real credentials, or Traycer CLI are touched.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { getRuntimeSnapshot } = require('../lib/runtime-snapshot');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VL = path.join(PLUGIN_ROOT, 'bin', 'vl.js');

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

const NOW = Date.parse('2026-09-22T00:00:00Z');
const frozen = () => NOW;
const iso = (deltaMs) => new Date(NOW + deltaMs).toISOString();
const wallIso = (deltaMs) => new Date(Date.now() + deltaMs).toISOString();

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-compose-'));
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

const FIVE_ROUTES = [
  { id: 'minimax-token-plan', provider: 'minimax', account: 'token-plan', match: { model: 'minimax' }, ttlSeconds: 180 },
  { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 },
  { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 180 },
  { id: 'deepseek-direct', provider: 'deepseek', account: 'personal', match: { model: 'deepseek' }, ttlSeconds: 120 },
  { id: 'openrouter-main', provider: 'openrouter', account: 'main', match: { model: 'openrouter', harness: 'openrouter' }, ttlSeconds: 120 },
];

// A full five-route fixture: MiniMax carries observed model evidence and raw
// provider leftovers that must never leak, Kimi is exhausted with a reset,
// GLM/DeepSeek show healthy vs never-observed, OpenRouter carries a precise
// balance plus usage evidence.
function fullInventoryDir() {
  const dir = scratch();
  writeJson(dir, 'config.json', { routes: FIVE_ROUTES });
  writeJson(dir, 'status.json', {
    updatedAt: iso(-30_000),
    routes: {
      'minimax-token-plan': {
        routeId: 'minimax-token-plan', observedAt: iso(-60_000), freshUntil: iso(120_000), source: 'minimax',
        status: {
          state: 'constrained',
          windows: [
            { type: 'rolling-5h', remaining: 18, limit: 100, resetAt: iso(18_000_000) },
            { type: 'weekly', remaining: 62, limit: 100 },
          ],
          balance: null,
          resetAt: iso(18_000_000),
          detail: {
            model: 'general',
            models: [{ name: 'general', interval_pct: 18 }, { name: 'M2-hermes', interval_pct: 90 }],
            raw: { leaked: 'SENTINEL-RAW-BODY' },
          },
        },
      },
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: iso(-90_000), freshUntil: iso(60_000), source: 'kimi',
        status: {
          state: 'exhausted',
          windows: [{ type: 'weekly', remaining: 0, limit: 100 }],
          balance: null, resetAt: iso(86_400_000),
          detail: { membership: 'code' },
        },
      },
      'glm-coding-plan': {
        routeId: 'glm-coding-plan', observedAt: iso(-45_000), freshUntil: iso(90_000), source: 'glm',
        status: { state: 'healthy', windows: [{ type: 'monthly', remaining: 400, limit: 500 }], balance: null, resetAt: null },
      },
      'openrouter-main': {
        routeId: 'openrouter-main', observedAt: iso(-20_000), freshUntil: iso(100_000), source: 'openrouter',
        status: {
          state: 'healthy', windows: [], resetAt: null,
          balance: { currency: 'USD', available: 12.3456, spent: { daily: 0.004, weekly: 1.2 }, limit: { amount: 50, reset: 'monthly' } },
          detail: { usage: { currency: 'USD', weekly: 1.2 } },
        },
      },
      // deepseek-direct deliberately has no cache entry.
    },
  });
  return dir;
}

console.log('provider composition — route evidence contract (AC1)');

test('every route emits stable id, provider/account, pool identity, models, resource evidence', async () => {
  const dir = fullInventoryDir();
  const s = await snap(dir);
  assert.strictEqual(s.routes.length, 5, 'one row per configured route');
  const byId = Object.fromEntries(s.routes.map((r) => [r.id, r]));

  for (const cfg of FIVE_ROUTES) {
    const row = byId[cfg.id];
    assert.ok(row, `route ${cfg.id} present`);
    assert.strictEqual(row.id, cfg.id);
    assert.strictEqual(row.kind, 'external-provider');
    assert.strictEqual(row.provider.value, cfg.provider);
    assert.strictEqual(row.provider.provenance, 'configured');
    assert.strictEqual(row.account.value, cfg.account);
    assert.deepStrictEqual(row.pool.value, { provider: cfg.provider, account: cfg.account },
      `${cfg.id} pool identity = configured provider+account`);
    assert.strictEqual(row.pool.provenance, 'configured');
    assert.strictEqual(row.pool.source, 'config');
    assert.strictEqual(row.configured, true);
    assert.ok(Array.isArray(row.boundBy));
  }

  const mm = byId['minimax-token-plan'];
  assert.strictEqual(mm.resource.state.value, 'constrained');
  assert.strictEqual(mm.resource.freshness, 'fresh');
  assert.strictEqual(mm.resource.observedAt.value, iso(-60_000));
  assert.strictEqual(mm.resource.freshUntil.value, iso(120_000));
  assert.strictEqual(mm.resource.source.value, 'minimax');
  assert.strictEqual(mm.resource.resetAt.value, iso(18_000_000));
  assert.deepStrictEqual(mm.resource.windows[0], { type: 'rolling-5h', remaining: 18, limit: 100, resetAt: iso(18_000_000) });
  // Models evidenced by the cached observation, verbatim and deduped.
  assert.deepStrictEqual(mm.models.value, ['general', 'M2-hermes']);
  assert.strictEqual(mm.models.provenance, 'observed');
  assert.strictEqual(mm.models.source, 'status.json');
  // match.model remains a binding hint — never model evidence.
  assert.strictEqual(mm.modelBinding.value, 'minimax');
  assert.strictEqual(mm.modelBinding.provenance, 'configured');
  // Raw provider payloads inside detail never reach the snapshot.
  assert.ok(!JSON.stringify(s).includes('SENTINEL-RAW-BODY'), 'detail.raw leaked into the snapshot');

  const or = byId['openrouter-main'];
  assert.strictEqual(or.resource.balance.available, 12.3456, 'balance carried at full precision');
  assert.deepStrictEqual(or.resource.balance.spent, { daily: 0.004, weekly: 1.2 });
  assert.deepStrictEqual(or.resource.balance.limit, { amount: 50, reset: 'monthly' });
  assert.deepStrictEqual(or.resource.usage, { currency: 'USD', weekly: 1.2 });
  assert.strictEqual(or.models.provenance, 'unknown');
  assert.strictEqual(or.models.reason, 'model-evidence-absent');

  const kimi = byId['kimi-code-plan'];
  assert.strictEqual(kimi.resource.state.value, 'exhausted');
  assert.strictEqual(kimi.resource.resetAt.value, iso(86_400_000), 'reset time preserved verbatim');

  const ds = byId['deepseek-direct'];
  assert.strictEqual(ds.resource.state.provenance, 'unknown');
  assert.strictEqual(ds.resource.state.reason, 'no-cached-observation');
  assert.strictEqual(ds.models.reason, 'no-cached-observation');
  assert.deepStrictEqual(ds.pool.value, { provider: 'deepseek', account: 'personal' },
    'configured pool identity survives a missing observation');
});

console.log('\nprovider composition — sibling survival on adapter failure (AC2)');

test('malformed and partial cache entries degrade alone; valid siblings keep full evidence', async () => {
  const dir = scratch();
  writeJson(dir, 'config.json', { routes: FIVE_ROUTES });
  writeJson(dir, 'status.json', {
    updatedAt: iso(0),
    routes: {
      'minimax-token-plan': {
        routeId: 'minimax-token-plan', observedAt: iso(-10_000), freshUntil: iso(60_000), source: 'minimax',
        status: { state: 'healthy', windows: [{ type: 'weekly', remaining: 80, limit: 100 }], balance: null, resetAt: null },
      },
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: iso(-10_000), freshUntil: iso(60_000), source: 'kimi',
        status: 'totally-malformed-payload',
      },
      'glm-coding-plan': 42, // entry itself is not an object
      'openrouter-main': {
        routeId: 'openrouter-main', observedAt: iso(-10_000), freshUntil: iso(60_000), source: 'openrouter',
        status: { state: 'unknown', windows: [], balance: null, resetAt: null, detail: { error: 'HTTP 401' } },
      },
    },
  });
  const s = await snap(dir);
  assert.ok(diagCodes(s).includes('status-entry-malformed@routes'));
  const byId = Object.fromEntries(s.routes.map((r) => [r.id, r]));
  // Siblings fully intact.
  assert.strictEqual(byId['minimax-token-plan'].resource.state.value, 'healthy');
  assert.deepStrictEqual(byId['minimax-token-plan'].resource.windows, [{ type: 'weekly', remaining: 80, limit: 100 }]);
  // Partially-known entry keeps what is known.
  assert.strictEqual(byId['openrouter-main'].resource.error, 'HTTP 401');
  assert.strictEqual(byId['openrouter-main'].resource.freshness, 'fresh');
  // Malformed entries emit rows with scoped unknowns — attributable, never fabricated.
  for (const id of ['kimi-code-plan', 'glm-coding-plan']) {
    const row = byId[id];
    assert.strictEqual(row.resource.state.provenance, 'unknown', id);
    assert.strictEqual(row.resource.freshness, 'unknown', id);
    assert.strictEqual(row.models.provenance, 'unknown', id);
    assert.strictEqual(row.provider.value, FIVE_ROUTES.find((r) => r.id === id).provider,
      'configured identity survives the malformed observation');
  }
  assert.ok(!JSON.stringify(s).includes('totally-malformed-payload'));
});

test('a throwing live source degrades scoped; sibling live + cached facts survive', async () => {
  const dir = fullInventoryDir();
  const harnessRow = {
    key: { host: 'h', harness: 'claude', surface: 'gui' },
    available: { value: true, provenance: 'observed' },
  };
  const s = await snap(dir, {
    refresh: true,
    callerContext: {},
    io: {
      env: {},
      readTraycer: async () => ({ caller: null, sessions: [], harnesses: [], profiles: [], diagnostics: [{ code: 'live-reads-unavailable', scope: 'envelope' }] }),
      liveReads: [
        { key: 'native-catalog', read: async () => ({ harnesses: [harnessRow] }) },
        { key: 'broken-source', read: async () => { throw new Error('adapter exploded'); } },
      ],
    },
  });
  assert.strictEqual(s.requestedRefresh, true);
  assert.ok(diagCodes(s).includes('live-source-failed@live:broken-source'), JSON.stringify(s.diagnostics));
  assert.ok(diagCodes(s).includes('live-reads-unavailable@envelope'), 'traycer diagnostics pass through');
  assert.strictEqual(s.harnesses.length, 1, 'sibling live source rows survive the failure');
  assert.strictEqual(s.harnesses[0].key.harness, 'claude');
  const mm = s.routes.find((r) => r.id === 'minimax-token-plan');
  assert.strictEqual(mm.resource.state.value, 'constrained', 'cached route evidence survives');
  assert.deepStrictEqual(mm.models.value, ['general', 'M2-hermes']);
});

test('a malformed live result contributes nothing but a scoped diagnostic', async () => {
  const dir = fullInventoryDir();
  const s = await snap(dir, {
    refresh: true,
    callerContext: {},
    io: {
      env: {},
      readTraycer: async () => ({ diagnostics: [] }),
      liveReads: [
        { key: 'junk', read: async () => 'not-an-object' },
        {
          key: 'partial', read: async () => ({
            sessions: 'oops-not-an-array',
            harnesses: [{ key: { host: 'h', harness: 'codex', surface: 'cli' } }],
          }),
        },
      ],
    },
  });
  assert.ok(diagCodes(s).includes('live-source-malformed@live:junk'));
  assert.ok(diagCodes(s).includes('live-source-malformed@live:partial'),
    'a non-array section marks the source malformed once');
  assert.strictEqual(s.harnesses.length, 1, 'the conforming section of a partial result still merges');
  assert.strictEqual(s.harnesses[0].key.harness, 'codex');
  assert.strictEqual(s.routes.length, 5, 'cached routes untouched');
});

console.log('\nprovider composition — no merge without proven binding (AC3)');

test('native harness resource sharing a provider NAME never binds to a route', async () => {
  const dir = fullInventoryDir();
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: iso(0),
    harnesses: [
      { key: { host: 'h', harness: 'kimi', surface: 'gui' },
        installed: { value: true, provenance: 'observed' },
        resourceRefs: [{ note: 'native-quota-bucket' }] },
      { key: { host: 'h', harness: 'claude', surface: 'gui' },
        resourceRefs: [{ provider: 'kimi' }] }, // incomplete pool identity — no binding
    ],
  });
  const s = await snap(dir);
  const kimi = s.routes.find((r) => r.id === 'kimi-code-plan');
  assert.deepStrictEqual(kimi.boundBy, [], 'name similarity and partial refs never bind');
  assert.strictEqual(kimi.resource.state.value, 'exhausted', 'route keeps its own cached evidence');
  assert.strictEqual(s.harnesses.length, 2, 'native harness rows remain their own section');
  assert.ok(s.harnesses.every((h) => h.key.harness !== 'external-provider'));
});

test('explicit routeId and provider+account refs are proven bindings', async () => {
  const dir = fullInventoryDir();
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: iso(0),
    harnesses: [
      { key: { host: 'h', harness: 'claude', surface: 'gui' },
        resourceRefs: [{ routeId: 'kimi-code-plan' }] },
      { key: { host: 'h', harness: 'codex', surface: 'cli' },
        resourceRefs: [{ provider: 'openrouter', account: 'main' }] },
      { key: { host: 'h', harness: 'opencode', surface: 'tui' },
        resourceRefs: [{ provider: 'openrouter', account: 'other-pool' }] }, // same provider, different pool → no bind
    ],
  });
  const s = await snap(dir);
  const byId = Object.fromEntries(s.routes.map((r) => [r.id, r]));
  assert.deepStrictEqual(byId['kimi-code-plan'].boundBy, [{ host: 'h', harness: 'claude', surface: 'gui' }]);
  assert.deepStrictEqual(byId['openrouter-main'].boundBy, [{ host: 'h', harness: 'codex', surface: 'cli' }],
    'a ref carrying the configured pool identity binds');
  assert.deepStrictEqual(byId['minimax-token-plan'].boundBy, []);
  assert.deepStrictEqual(byId['glm-coding-plan'].boundBy, []);
});

console.log('\nprovider composition — bounded concurrent coalesced refresh (AC4)');

test('independent live sources run concurrently; identical requests coalesce', async () => {
  const dir = scratch();
  const events = [];
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  const sharedRead = async () => {
    events.push('shared');
    return { sessions: [] };
  };
  await snap(dir, {
    refresh: true,
    callerContext: {},
    io: {
      env: {},
      readTraycer: async () => ({ diagnostics: [] }),
      liveReads: [
        { key: 'a', read: async () => { events.push('a-start'); await gateA; events.push('a-end'); return {}; } },
        { key: 'b', read: async () => { events.push('b-start'); releaseA(); await new Promise((r) => setTimeout(r, 15)); events.push('b-end'); return {}; } },
        { key: 'b', read: async () => { events.push('b-duplicate'); return {}; } },
        { key: 'c', read: sharedRead },
        { key: 'd', read: sharedRead },
      ],
    },
  });
  assert.ok(events.indexOf('b-start') < events.indexOf('a-end'),
    `sources must overlap — b started before a finished: ${events.join(',')}`);
  assert.ok(!events.includes('b-duplicate'), 'identical source key must coalesce to one invocation');
  assert.strictEqual(events.filter((e) => e === 'shared').length, 1,
    'identical read function must coalesce to one invocation');
});

test('refresh:false performs zero live-source invocations', async () => {
  const dir = scratch();
  let calls = 0;
  const s = await snap(dir, {
    callerContext: {},
    io: {
      env: {},
      readTraycer: async () => { calls += 1; return {}; },
      liveReads: [{ key: 'x', read: async () => { calls += 1; return {}; } }],
    },
  });
  assert.strictEqual(calls, 0, 'cache-only snapshot must not invoke any live source');
  assert.strictEqual(s.requestedRefresh, false);
  assert.ok(!diagCodes(s).some((c) => c.startsWith('live-source') || c.startsWith('traycer')),
    'no live diagnostics on a cache-only read');
});

console.log('\nprovider composition — runtime inventory renderer (AC5)');

test('vl report renders requester, harness pool and routes with visible unknown/stale', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [
      { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 120 },
      { id: 'openrouter-main', provider: 'openrouter', account: 'main', match: { model: 'openrouter' }, ttlSeconds: 120 },
      { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 120 },
    ],
    vault: { backend: 'file', service: 'test-inventory' },
  });
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'inventory-test-key';
  require('../lib/vault').set('kimi-code-plan', 'k');
  writeJson(dir, 'runtime.json', {
    version: 1, updatedAt: wallIso(0),
    sessions: [
      { key: { host: 'testhost', ade: 'traycer', epicId: 'e1', agentId: 'agent-1' },
        harness: { value: 'claude', provenance: 'observed' },
        active: { value: true, provenance: 'observed' } },
    ],
    harnesses: [
      { key: { host: 'testhost', harness: 'claude', surface: 'gui' },
        available: { value: true, provenance: 'observed' },
        sessionRefs: [{ host: 'testhost', ade: 'traycer', epicId: 'e1', agentId: 'agent-1' }] },
      { key: { host: 'testhost', harness: 'kimi', surface: 'cli' },
        available: { value: null, provenance: 'unknown', reason: 'harness-catalog-absent' } },
    ],
    profiles: [
      { key: { host: 'testhost', provider: 'anthropic', profileId: 'p-1' },
        authStatus: { value: 'ok', provenance: 'observed' } },
    ],
  });
  writeJson(dir, 'status.json', {
    updatedAt: '2026-09-21T00:00:00.000Z',
    routes: {
      'openrouter-main': {
        routeId: 'openrouter-main', observedAt: wallIso(-1000), freshUntil: wallIso(300_000), source: 'openrouter',
        status: { state: 'healthy', windows: [], balance: { available: 9.99, currency: 'USD' }, resetAt: null },
      },
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: wallIso(-7_200_000), freshUntil: wallIso(-3_600_000), source: 'kimi',
        status: { state: 'exhausted', windows: [{ type: 'weekly', remaining: 0, limit: 100 }], balance: null, resetAt: wallIso(86_400_000) },
      },
      'garbage-orphan': null,
    },
  });
  const env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dir,
    VIEW_LIMITS_MASTER_KEY: 'inventory-test-key',
  };
  for (const k of Object.keys(env)) if (k.startsWith('TRAYCER_')) delete env[k];
  const r = spawnSync(process.execPath, [VL, 'report'], { env, encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, r.stderr || String(r.error));
  const out = r.stdout;
  assert.match(out, /runtime inventory/, 'header');
  assert.match(out, /requester:/, 'requester section');
  assert.match(out, /models: configured unknown · default unknown · effective unknown/,
    'models render unknown — never inferred');
  assert.match(out, /harness pool:/);
  assert.match(out, /claude \(gui\) @ testhost: available · 1 session\(s\)/, 'harness row with session ref');
  assert.match(out, /kimi \(cli\) @ testhost: availability unknown — harness-catalog-absent/,
    'unknown availability is explicit');
  assert.match(out, /session agent-1 @ testhost: harness claude · active/);
  assert.match(out, /profile anthropic\/p-1 @ testhost: auth ok · usage unobserved/);
  assert.match(out, /external routes:/);
  assert.match(out, /openrouter-main: healthy · balance 9\.99 USD/, 'fresh healthy route');
  assert.match(out, /kimi-code-plan: exhausted · weekly 0% · resets .* \(stale\)/,
    'stale exhausted route stays exhausted AND marked stale');
  assert.match(out, /glm-coding-plan: unknown — no-cached-observation/,
    'never-observed route is explicitly unknown with its reason');
  assert.doesNotMatch(out, /garbage-orphan/, 'malformed orphan cache entry never prints');
  assert.match(out, /notice \[routes\] status-entry-malformed/, 'degradation surfaces as a notice');
  assert.doesNotMatch(out, /bound to/, 'no proven binding → no merge shown');
  assert.match(out, /cache updated 2026-09-21/);
});

test('vl report --json keeps the raw cache document (v1 JSON compatibility)', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 120 }],
    vault: { backend: 'file', service: 'test-inventory-json' },
  });
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'inventory-test-key';
  require('../lib/vault').set('kimi-code-plan', 'k');
  const cacheDoc = {
    updatedAt: '2026-09-21T00:00:00.000Z',
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: '2026-09-21T00:00:00.000Z', freshUntil: '2026-09-21T00:02:00.000Z',
        source: 'kimi', status: { state: 'healthy', windows: [], balance: { available: 0.0042, currency: 'USD' }, resetAt: null },
      },
    },
  };
  writeJson(dir, 'status.json', cacheDoc);
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dir, VIEW_LIMITS_MASTER_KEY: 'inventory-test-key' };
  const r = spawnSync(process.execPath, [VL, 'report', '--json'], { env, encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.status, 0, r.stderr || String(r.error));
  const parsed = JSON.parse(r.stdout);
  assert.deepStrictEqual(parsed, cacheDoc, 'report --json is the raw status.json document — full precision');
  assert.ok(!('caller' in parsed) && !('schemaVersion' in parsed), 'not the snapshot envelope');
});

console.log('\nprovider composition — v1 compatibility (AC6)');

test('route row field additions are additive — id/kind/bindings/identity contract unchanged', async () => {
  const dir = fullInventoryDir();
  const s = await snap(dir);
  for (const row of s.routes) {
    assert.ok(typeof row.id === 'string' && row.id.length > 0);
    assert.strictEqual(row.kind, 'external-provider');
    assert.ok(['observed', 'configured', 'unknown'].includes(row.provider.provenance));
    assert.ok(['fresh', 'stale', 'unknown'].includes(row.resource.freshness));
  }
  // Determinism: same inputs → byte-identical snapshot.
  const again = await snap(dir);
  assert.strictEqual(JSON.stringify(s), JSON.stringify(again));
});

Promise.all(pendingTests).then(() => {
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall provider-composition tests passed');
});
