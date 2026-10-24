'use strict';
// Unit coverage for the shared live collector (lib/collector.js) — Issue #60.
//
// No network, no real credentials: the adapter, the vault and the Xiaomi
// session are injected fakes, and the cache is a scratch directory. The
// cases are the ones #60 names: an external failure, a native failure, a
// partial failure, lock contention, reset/recovery freshness, and the
// built-in / Xiaomi compatibility rules.
//
// The truthfulness rules under test:
//   * a failed route keeps its PRIOR entry verbatim — same observedAt, same
//     freshUntil, same facts — and never gets a fresh timestamp
//   * a failed route with NO prior entry still publishes the classified
//     unknown status (an unknown state carrying the error)
//   * a successful sibling publishes independently of a failed one
//   * the configRevision is attached ONLY to the routes observed this round,
//     so a retained entry keeps the revision it was observed under and the
//     gate still sees it as obsolete after its route's configuration changed
//   * the lock has ONE owner: the loser observes nothing and publishes
//     nothing

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const collector = require('../lib/collector');
const cache = require('../lib/cache');
const { decide } = require('../lib/gate');
const { configRevision } = require('../lib/monitor-schema');

const FIXED_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const PRIOR_AT = '2026-10-24T09:00:00.000Z';
const PRIOR_UNTIL = '2026-10-24T09:03:00.000Z';

let failures = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('use the async form');
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

// A scratch data dir: the REAL cache functions (writeCache/readCache) write
// there, so the collector's publish path is the production one.
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-collector-'));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return dir;
}

const HEALTHY = { state: 'healthy', windows: [], balance: null, resetAt: null, detail: {} };

// The injected world: a fake adapter per route, a fake vault, a fake Xiaomi
// session and a fixed clock. Nothing here touches a network or a keychain.
function world({ adapters = {}, vault = { has: () => true, get: () => 'fake-token' }, xiaomi = null } = {}) {
  const calls = { adapters: [], xiaomi: 0, vault: [] };
  const io = {
    getAdapter: (provider, route) => {
      calls.adapters.push(route.id);
      const fn = adapters[route.id] || adapters[provider];
      return {
        fetchStatus: async () => (typeof fn === 'function' ? fn(route) : HEALTHY),
      };
    },
    vault: {
      has: (id) => { calls.vault.push(id); return vault.has(id); },
      get: (id) => vault.get(id),
    },
    xiaomi: Object.assign({
      XIAOMI_ROUTE_ID: 'xiaomi-token-plan',
      DEFAULT_ERROR: 'console status unavailable',
      isXiaomiRoute: (route) => !!(route && route.provider === 'xiaomi'),
      fetchStatus: async () => { calls.xiaomi += 1; return HEALTHY; },
      errorStatus: (text) => ({ state: 'unknown', windows: [], balance: null, resetAt: null, detail: { error: text } }),
      pendingStatus: () => ({ state: 'unknown', windows: [], balance: null, resetAt: null, detail: { error: 'pending', pending: true } }),
    }, xiaomi || {}),
    now: () => FIXED_NOW,
  };
  return { io, calls };
}

const CFG = {
  providers: { minimax: { baseUrl: 'https://api.minimax.test' }, deepseek: { baseUrl: 'https://api.deepseek.test' } },
  gate: { mode: 'deny', constrainedThreshold: 0.2 },
};

function route(id, provider, extra = {}) {
  return Object.assign({ id, provider, account: 'acct', match: { model: provider }, ttlSeconds: 180 }, extra);
}

function priorEntry(id, extra = {}) {
  return Object.assign({
    routeId: id,
    observedAt: PRIOR_AT,
    freshUntil: PRIOR_UNTIL,
    source: 'adapter',
    status: { state: 'healthy', windows: [{ type: 'rolling-5h', remaining: 10, limit: 100 }], balance: null, resetAt: null },
  }, extra);
}

// ---- the happy path ---------------------------------------------------------

(async () => {

await testAsync('a successful collection publishes a fresh entry per observed route', async () => {
  const dir = scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io, calls } = world();
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED);
  assert.strictEqual(result.published, true);
  assert.deepStrictEqual(calls.adapters, ['minimax-token-plan']);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  const entry = doc.routes['minimax-token-plan'];
  assert.strictEqual(entry.observedAt, new Date(FIXED_NOW).toISOString());
  assert.strictEqual(entry.freshUntil, new Date(FIXED_NOW + 180000).toISOString());
  assert.strictEqual(entry.status.state, 'healthy');
});

// ---- an external failure -----------------------------------------------------

await testAsync('a failed fetch keeps the prior entry VERBATIM — same age, same facts', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ adapters: { minimax: () => { throw new Error('HTTP 502'); } } });
  // A prior observation exists: it is what the route keeps.
  cache.writeCache({ 'minimax-token-plan': priorEntry('minimax-token-plan') });
  const before = cache.readCache().routes['minimax-token-plan'];

  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED, 'the only route failed');
  assert.strictEqual(result.published, true);
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'failed', error: 'HTTP 502' }]);

  const after = cache.readCache().routes['minimax-token-plan'];
  assert.deepStrictEqual(after, before, 'the prior entry is kept byte-for-byte');
  assert.strictEqual(after.observedAt, PRIOR_AT, 'the age is unchanged');
  assert.strictEqual(after.freshUntil, PRIOR_UNTIL, 'the age is unchanged');
  assert.strictEqual(after.status.state, 'healthy', 'the prior facts are still the facts');
});

await testAsync('a failed fetch NEVER writes a fresh timestamp over old facts', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ adapters: { minimax: () => { throw new Error('boom'); } } });
  cache.writeCache({ 'minimax-token-plan': priorEntry('minimax-token-plan') });
  await collector.collect({ cfg, io });
  const entry = cache.readCache().routes['minimax-token-plan'];
  assert.notStrictEqual(entry.observedAt, new Date(FIXED_NOW).toISOString(),
    'the observation time is the PRIOR one, not now');
});

await testAsync('a failed route with NO prior entry publishes the classified unknown status', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ adapters: { minimax: () => { throw new Error('first failure'); } } });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  const entry = cache.readCache().routes['minimax-token-plan'];
  assert.strictEqual(entry.status.state, 'unknown');
  assert.strictEqual(entry.status.detail.error, 'first failure');
  assert.strictEqual(entry.observedAt, new Date(FIXED_NOW).toISOString(),
    'a first-time failure is published with its own observation time');
});

await testAsync('a route whose credential store throws keeps its prior entry — a sibling cannot drop it', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, {
    routes: [route('minimax-token-plan', 'minimax'), route('deepseek-direct', 'deepseek')],
  });
  // Route A's credential store throws; route B is a healthy sibling.
  const { io } = world({
    vault: {
      has: (id) => { if (id === 'minimax-token-plan') throw new Error('keychain locked'); return true; },
      get: () => 'fake-test-key',
    },
  });
  // A's prior observation is a FRESH exhaustion: while it stands, the gate
  // denies dispatch to that account.
  const prior = {
    routeId: 'minimax-token-plan',
    observedAt: '2026-10-24T11:58:00.000Z',
    freshUntil: '2026-10-24T12:03:00.000Z',
    source: 'minimax',
    status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
  };
  cache.writeCache({ 'minimax-token-plan': prior });
  const before = cache.readCache().routes['minimax-token-plan'];

  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.PARTIAL);
  assert.deepStrictEqual(
    result.routes.map((r) => [r.id, r.outcome]),
    [['minimax-token-plan', 'failed'], ['deepseek-direct', 'completed']],
  );

  const after = cache.readCache().routes['minimax-token-plan'];
  assert.deepStrictEqual(after, before, "the failed route's entry is byte-identical");
  assert.strictEqual(after.observedAt, '2026-10-24T11:58:00.000Z', 'the age is unchanged');

  // The gate still sees the exhaustion and still denies.
  const decision = decide({
    route: cfg.routes[0],
    entry: after,
    now: FIXED_NOW,
    config: { gate: { mode: 'deny', injectContext: false } },
  });
  assert.strictEqual(decision.action, 'deny', 'a sibling success must not drop a denial');
});

await testAsync('a route whose credential store throws keeps its prior entry even when it is the ONLY route', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io, calls } = world({
    vault: { has: () => { throw new Error('keychain locked'); }, get: () => null },
  });
  const prior = priorEntry('minimax-token-plan');
  cache.writeCache({ 'minimax-token-plan': prior });
  const before = cache.readCache().routes['minimax-token-plan'];
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  assert.strictEqual(result.reason, collector.REASON.VAULT_UNREADABLE);
  assert.deepStrictEqual(calls.adapters, [], 'no provider is called');
  assert.deepStrictEqual(cache.readCache().routes['minimax-token-plan'], before,
    'the prior entry survives');
});

await testAsync('a partial failure publishes the successful sibling independently', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, {
    routes: [route('minimax-token-plan', 'minimax'), route('deepseek-direct', 'deepseek')],
  });
  const { io } = world({ adapters: { minimax: () => { throw new Error('minimax down'); } } });
  cache.writeCache({
    'minimax-token-plan': priorEntry('minimax-token-plan'),
    'deepseek-direct': priorEntry('deepseek-direct'),
  });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.PARTIAL);
  const entries = cache.readCache().routes;
  assert.strictEqual(entries['minimax-token-plan'].observedAt, PRIOR_AT, 'the failed route kept its age');
  assert.strictEqual(entries['deepseek-direct'].observedAt, new Date(FIXED_NOW).toISOString(),
    'the successful sibling published its own observation');
  assert.deepStrictEqual(
    result.routes.map((r) => [r.id, r.outcome]),
    [['minimax-token-plan', 'failed'], ['deepseek-direct', 'completed']],
  );
});

// ---- the config revision (the #58 obsolete-config guard) --------------------

await testAsync('a retained entry keeps its OLD configRevision, so the gate still calls it obsolete', async () => {
  scratch();
  const oldRoute = {
    id: 'custom-oa',
    provider: 'openai-compat',
    match: { model: 'gpt-4' },
    ttlSeconds: 300,
    monitor: { recipe: 'openai-compat', endpoint: 'https://old.example.com/quota', recipeOptions: { path: '/v1/usage' } },
  };
  // The route's configuration changed after the observation was made.
  const newRoute = Object.assign({}, oldRoute, {
    monitor: { recipe: 'openai-compat', endpoint: 'https://new.example.com/quota', recipeOptions: { path: '/v1/usage' } },
  });
  const oldRevision = configRevision(oldRoute);
  assert.notStrictEqual(oldRevision, configRevision(newRoute), 'the fixture really changed the revision');

  const cfg = Object.assign({}, CFG, { routes: [newRoute] });
  const { io } = world({ adapters: { 'custom-oa': () => { throw new Error('provider unreachable'); } } });
  cache.writeCache({
    'custom-oa': priorEntry('custom-oa', { configRevision: oldRevision, status: { state: 'exhausted', windows: [], balance: null, resetAt: null } }),
  });

  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  const entry = cache.readCache().routes['custom-oa'];
  assert.strictEqual(entry.configRevision, oldRevision,
    'the retained entry keeps the revision it was observed under');
  assert.notStrictEqual(entry.configRevision, configRevision(newRoute),
    'it is NOT relabelled with the current revision');

  // The gate's own decision on the retained entry: obsolete → fail open.
  const decision = decide({
    route: newRoute,
    entry,
    now: FIXED_NOW,
    config: { gate: { mode: 'deny', injectContext: false } },
  });
  assert.strictEqual(decision.action, 'allow', 'an obsolete entry never denies');
  assert.strictEqual(decision.refresh, true, 'the gate asks for a refresh instead');
});

await testAsync('an OBSERVED route is relabelled with the current configRevision', async () => {
  scratch();
  const cfgRoute = {
    id: 'custom-oa',
    provider: 'openai-compat',
    match: { model: 'gpt-4' },
    ttlSeconds: 300,
    monitor: { recipe: 'openai-compat', endpoint: 'https://new.example.com/quota', recipeOptions: { path: '/v1/usage' } },
  };
  const cfg = Object.assign({}, CFG, { routes: [cfgRoute] });
  const { io } = world();
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED);
  const entry = cache.readCache().routes['custom-oa'];
  assert.strictEqual(entry.configRevision, configRevision(cfgRoute),
    'an observed entry carries the revision it was observed under');
});

// ---- the lock ---------------------------------------------------------------

await testAsync('the lock has one owner: the loser observes nothing and publishes nothing', async () => {
  const dir = scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io, calls } = world();
  cache.writeCache({ 'minimax-token-plan': priorEntry('minimax-token-plan') });
  const before = fs.readFileSync(path.join(dir, 'status.json'), 'utf8');

  // Another worker holds the ownership ticket.
  const held = await cache.acquireWorker({ ownerToken: 'another-worker' });
  assert.strictEqual(held.acquired, true);

  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.IN_PROGRESS);
  assert.strictEqual(result.published, false);
  assert.deepStrictEqual(calls.adapters, [], 'the loser calls no provider');
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'pending', error: null }]);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'), before,
    'the loser publishes nothing');

  cache.releaseWorker(held);
});

await testAsync('a lock that cannot be taken at all is a classified failure, not a silent pass', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io, calls } = world();
  io.acquireWorker = async () => ({ acquired: false, reason: 'storage-error', error: 'EACCES' });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  assert.strictEqual(result.reason, collector.REASON.LOCK_UNAVAILABLE);
  assert.strictEqual(result.error, 'EACCES');
  assert.deepStrictEqual(calls.adapters, [], 'no provider is called');
});

await testAsync('a publish that fails leaves the cache untouched and reports why', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world();
  io.writeCache = () => { throw new Error('EACCES: read-only file system'); };
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  assert.strictEqual(result.reason, collector.REASON.PUBLISH_FAILED);
  assert.match(result.error, /read-only file system/);
});

// ---- no credentials ---------------------------------------------------------

await testAsync('nothing eligible means no-credentials, and nothing is published', async () => {
  const dir = scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io, calls } = world({ vault: { has: () => false, get: () => null } });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.NO_CREDENTIALS);
  assert.strictEqual(result.published, false);
  assert.deepStrictEqual(calls.adapters, []);
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'skipped', error: null }]);
  assert.strictEqual(fs.existsSync(path.join(dir, 'status.json')), false, 'no cache is written');
});

await testAsync('a credential store that cannot be read is a failure, never "no credentials"', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ vault: { has: () => { throw new Error('keychain locked'); }, get: () => null } });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  assert.strictEqual(result.reason, collector.REASON.VAULT_UNREADABLE);
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'failed', error: 'credential store could not be read' }]);
});

// ---- Xiaomi -----------------------------------------------------------------

await testAsync('Xiaomi: exactly ONE session call for every alias, and ttlSeconds 0 in the cache', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, {
    routes: [
      route('xiaomi-token-plan', 'xiaomi', { ttlSeconds: 0 }),
      route('xiaomi-other', 'xiaomi', { ttlSeconds: 0 }),
    ],
  });
  const { io, calls } = world();
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED);
  assert.strictEqual(calls.xiaomi, 1, 'one Chrome read + one usage/detail pair for the whole collection');
  const entries = cache.readCache().routes;
  assert.strictEqual(entries['xiaomi-token-plan'].freshUntil, new Date(FIXED_NOW).toISOString(),
    'the cached Xiaomi row expires immediately: the gate never trusts it');
  assert.strictEqual(entries['xiaomi-other'].status.state, 'healthy',
    'the single session status is projected onto every alias');
});

await testAsync('Xiaomi: a session that throws keeps the prior row instead of replacing it', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('xiaomi-token-plan', 'xiaomi', { ttlSeconds: 0 })] });
  const { io } = world({
    xiaomi: { fetchStatus: async () => { throw new Error('session exploded'); } },
  });
  cache.writeCache({ 'xiaomi-token-plan': priorEntry('xiaomi-token-plan') });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  const entry = cache.readCache().routes['xiaomi-token-plan'];
  assert.strictEqual(entry.observedAt, PRIOR_AT, 'the prior row is kept, with its age');
});

// ---- reset / recovery freshness --------------------------------------------

await testAsync('a custom route\'s exhaustion expires by its known recovery, not only by TTL', async () => {
  scratch();
  const resetAt = '2026-10-24T12:00:30.000Z';
  const cfgRoute = {
    id: 'custom-oa',
    provider: 'openai-compat',
    match: { model: 'gpt-4' },
    ttlSeconds: 300,
    monitor: { recipe: 'openai-compat', endpoint: 'https://new.example.com/quota', recipeOptions: { path: '/v1/usage' } },
  };
  const cfg = Object.assign({}, CFG, { routes: [cfgRoute] });
  const { io } = world({
    adapters: {
      'custom-oa': () => ({ state: 'exhausted', windows: [], balance: null, resetAt, detail: {} }),
    },
  });
  await collector.collect({ cfg, io });
  const entry = cache.readCache().routes['custom-oa'];
  assert.strictEqual(entry.freshUntil, resetAt,
    'a deny-eligible observation must not outlive the recovery the provider reported');
});

await testAsync('a retained route keeps its own expiry — the collection never renews it', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ adapters: { minimax: () => { throw new Error('down'); } } });
  cache.writeCache({ 'minimax-token-plan': priorEntry('minimax-token-plan') });
  await collector.collect({ cfg, io });
  const entry = cache.readCache().routes['minimax-token-plan'];
  assert.strictEqual(entry.freshUntil, PRIOR_UNTIL, 'the expiry is the prior one');
  assert.ok(Date.parse(entry.freshUntil) < FIXED_NOW,
    'a retained observation is not made fresh by the collection');
});

// ---- the vocabulary ---------------------------------------------------------

test('the collector and the view model agree on the collection vocabulary', () => {
  const vm = require('../lib/view-model');
  for (const outcome of Object.values(collector.OUTCOME)) {
    assert.ok(vm.COLLECTION_OUTCOMES.includes(outcome), `collection outcome ${outcome}`);
  }
  for (const outcome of Object.values(collector.ROUTE_OUTCOME)) {
    assert.ok(vm.ROUTE_COLLECTION_OUTCOMES.includes(outcome), `route outcome ${outcome}`);
  }
});

if (failures) {
  console.error(`\n${failures} collector test(s) failed`);
  process.exit(1);
}
console.log('\nall collector tests passed');

})().catch((e) => { console.error(e); process.exit(1); });
