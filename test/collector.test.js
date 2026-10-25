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
function world({ adapters = {}, vault = { has: () => true, get: () => 'fake-token' }, xiaomi = null, native = null } = {}) {
  const calls = { adapters: [], xiaomi: 0, vault: [], native: 0 };
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
    // The bounded native observation, hermetic by default: never touch the
    // real runtime snapshot machinery or a real traycer CLI in the unit
    // tests. `native` may be a snapshot to return, an Error to throw, or a
    // function.
    getRuntimeSnapshot: async (opts) => {
      calls.native += 1;
      // Like the real service, run the live source (the collector wraps it to
      // record this run's rows). The fake source returns the rows `native`
      // carries, so a snapshot with profiles is a snapshot whose live read
      // produced them.
      if (opts && opts.io && typeof opts.io.readTraycer === 'function') await opts.io.readTraycer({});
      if (typeof native === 'function') return native(opts);
      if (native instanceof Error) throw native;
      return native || { generatedAt: new Date(FIXED_NOW).toISOString(), profiles: [], sessions: [], harnesses: [], routes: [], diagnostics: [] };
    },
    readTraycer: async () => {
      const snap = native && typeof native === 'object' && !(native instanceof Error) && typeof native !== 'function' ? native : {};
      return { sessions: snap.sessions || [], harnesses: snap.harnesses || [], profiles: snap.profiles || [] };
    },
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
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'failed', error: 'HTTP 502', retained: true }]);

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
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'pending', error: null, retained: false }]);
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
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'skipped', error: null, retained: false }]);
  assert.strictEqual(fs.existsSync(path.join(dir, 'status.json')), false, 'no cache is written');
});

await testAsync('a credential store that cannot be read is a failure, never "no credentials"', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ vault: { has: () => { throw new Error('keychain locked'); }, get: () => null } });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  assert.strictEqual(result.reason, collector.REASON.VAULT_UNREADABLE);
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'failed', error: 'credential store could not be read', retained: false }]);
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

// ---- Issue #60 fix batch 2 (B1 / B3 / A1) -----------------------------------

// B1 — the REAL lenient-false vault: a corrupt encrypted blob makes
// `vault.has` return false (it never throws). The route is skipped, but its
// prior entry must survive a sibling's publish.
await testAsync('B1: a skipped route (corrupt credential) keeps its prior entry; the gate still denies', async () => {
  const dir = scratch();
  process.env.VIEW_LIMITS_MASTER_KEY = 'b1-test-master-key';
  // The REAL vault reads its backend from the on-disk configuration.
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [],
    gate: { mode: 'deny', constrainedThreshold: 0.2 },
    vault: { backend: 'file', service: 'com.kha.view-limits' },
  }));
  const vault = require('../lib/vault');
  vault.set('minimax-token-plan', 'good-secret');
  vault.set('deepseek-direct', 'good-secret');
  // Corrupt the MiniMax blob: present by probe, undecryptable by get.
  const blobPath = path.join(dir, 'secrets', 'minimax-token-plan.enc');
  fs.writeFileSync(blobPath, 'not-a-blob');
  assert.strictEqual(vault.probe('minimax-token-plan'), 'present');
  assert.strictEqual(vault.has('minimax-token-plan'), false, 'the lenient vault reports absent');

  const cfg = Object.assign({}, CFG, {
    routes: [route('minimax-token-plan', 'minimax'), route('deepseek-direct', 'deepseek')],
  });
  const { io } = world({ adapters: { deepseek: () => HEALTHY }, native: {} });
  delete io.vault; // the REAL vault
  // A fresh exhaustion for MiniMax: while it stands, the gate denies.
  const priorExhausted = {
    routeId: 'minimax-token-plan',
    observedAt: '2026-10-24T11:58:00.000Z',
    freshUntil: '2099-01-01T00:00:00.000Z',
    source: 'minimax',
    status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
  };
  cache.writeCache({ 'minimax-token-plan': priorExhausted });
  const before = fs.readFileSync(path.join(dir, 'status.json'), 'utf8');

  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED, 'DeepSeek succeeded; MiniMax was skipped, not failed');
  assert.deepStrictEqual(
    result.routes.map((r) => [r.id, r.outcome]),
    [['minimax-token-plan', 'skipped'], ['deepseek-direct', 'completed']],
  );
  assert.strictEqual(result.routes[0].retained, true, 'the skipped route retained its prior entry');

  const after = cache.readCache();
  assert.deepStrictEqual(after.routes['minimax-token-plan'], priorExhausted,
    'the skipped route prior entry is byte-identical');
  assert.strictEqual(after.routes['minimax-token-plan'].observedAt, '2026-10-24T11:58:00.000Z', 'age unchanged');
  assert.ok(after.routes['deepseek-direct'], 'the sibling published');

  // The gate still sees the exhaustion and still denies.
  const decision = decide({
    route: cfg.routes[0],
    entry: after.routes['minimax-token-plan'],
    now: FIXED_NOW,
    config: { gate: { mode: 'deny', injectContext: false } },
  });
  assert.strictEqual(decision.action, 'deny', 'a skipped route must never lose a denial');
  assert.notStrictEqual(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'), before,
    'the publish did rewrite the document (sibling) — but kept the skipped entry');
  delete process.env.VIEW_LIMITS_MASTER_KEY;
});

// B3 — the bounded native observation is part of the shared operation.
await testAsync('B3: native success — the full view collection carries the refreshed snapshot', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const nativeSnap = { generatedAt: '2026-10-24T12:00:00Z', profiles: [{ key: { host: 'h', provider: 'p', profileId: 'a' } }], sessions: [], harnesses: [], routes: [], diagnostics: [] };
  const { io, calls } = world({ native: nativeSnap });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED);
  assert.strictEqual(calls.native, 1, 'the bounded native observation ran');
  assert.strictEqual(result.snapshot, nativeSnap, 'the snapshot is carried');
  assert.deepStrictEqual(result.native, { outcome: 'completed', codes: [], error: null });
});

await testAsync('B3: native-only — profiles observed, so it is NOT no-credentials', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io, calls } = world({
    vault: { has: () => false, get: () => null },
    native: { generatedAt: '2026-10-24T12:00:00Z', profiles: [{ key: { host: 'h', provider: 'p', profileId: 'a' } }], sessions: [], harnesses: [], routes: [], diagnostics: [] },
  });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED, 'native-only is a completed collection');
  assert.strictEqual(calls.native, 1);
  assert.strictEqual(result.published, false, 'nothing external was published');
  assert.deepStrictEqual(result.routes, [{ id: 'minimax-token-plan', outcome: 'skipped', error: null, retained: false }]);
});

await testAsync('B3: native-only with nothing observed is still no-credentials', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ vault: { has: () => false, get: () => null }, native: {} });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.NO_CREDENTIALS);
  assert.strictEqual(result.native.outcome, 'unknown', 'nothing observed and nothing failed is unknown');
});

await testAsync('B3: a native failure is classified and isolated from external siblings', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io, calls } = world({ native: new Error('traycer cli missing') });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.PARTIAL, 'an external success with a failed native read is partial');
  assert.strictEqual(calls.native, 1);
  assert.strictEqual(result.native.outcome, 'failed');
  assert.ok((result.native.codes || []).length > 0, 'the diagnostic codes are disclosed');
  assert.strictEqual(result.snapshot, null);
});

await testAsync('B3: a native-only setup whose native source fails is a classified failure', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ vault: { has: () => false, get: () => null }, native: new Error('boom') });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  assert.strictEqual(result.reason, collector.REASON.NATIVE_UNAVAILABLE);
});

// R2-1 — the REAL runtime snapshot service and the REAL Traycer adapter, with
// a fake RUNNER: the service degrades source failures into diagnostics, and
// the classification must read those diagnostics, not a throw.
const NATIVE_IDENTITY = {
  agentId: { value: 'agent-r2', provenance: 'observed', source: 'callerContext', observedAt: null, freshUntil: null, reason: null },
  epicId: { value: 'epic-r2', provenance: 'observed', source: 'callerContext', observedAt: null, freshUntil: null, reason: null },
};

function realViewIo(extra = {}) {
  return Object.assign({
    callerContext: NATIVE_IDENTITY,
  }, extra);
}

await testAsync('R2-1: a missing CLI is unavailable, NOT a failure; native-only stays no-credentials', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const io = realViewIo({
    getAdapter: () => ({ fetchStatus: async () => HEALTHY }),
    vault: { has: () => false, get: () => null }, // no external credentials
    traycerRun: async () => ({ error: { code: 'ENOENT' } }), // CLI missing
  });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.NO_CREDENTIALS, 'native-only with no CLI stays no-credentials');
  assert.strictEqual(result.native.outcome, 'unavailable');
  assert.deepStrictEqual(result.native.codes, ['traycer-cli-missing']);
});

await testAsync('R2-1: a completed external collection with a failed native read is partial, with codes', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const io = realViewIo({
    getAdapter: () => ({ fetchStatus: async () => HEALTHY }),
    vault: { has: () => true, get: () => 'fake-test-key' },
    traycerRun: async () => ({ error: new Error('runner exploded') }), // read failed
  });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.PARTIAL);
  assert.strictEqual(result.native.outcome, 'failed');
  assert.ok(result.native.codes.includes('traycer-read-failed'), `codes: ${result.native.codes}`);
  assert.strictEqual(result.routes[0].outcome, 'completed', 'the external success survived');
});

await testAsync('R2-1: a native-only setup whose native read fails is a classified failure', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const io = realViewIo({
    vault: { has: () => false, get: () => null },
    traycerRun: async () => ({ timedOut: true }),
  });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  assert.strictEqual(result.reason, collector.REASON.NATIVE_UNAVAILABLE);
  assert.ok(result.native.codes.includes('traycer-read-timeout'), `codes: ${result.native.codes}`);
});

await testAsync('R2-1: missing launch identity is unknown, and the runner is never invoked', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  let runnerCalls = 0;
  const io = realViewIo({
    callerContext: null, // no launch identity
    env: {}, // and no Traycer launch env
    vault: { has: () => false, get: () => null },
    traycerRun: async () => { runnerCalls += 1; return { error: { code: 'ENOENT' } }; },
  });
  const result = await collector.collectView({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.NO_CREDENTIALS);
  assert.strictEqual(result.native.outcome, 'unknown');
  assert.strictEqual(runnerCalls, 0, 'the native runner is not invoked without a launch identity');
});

await testAsync('R2-3: collect() itself never runs the native observation (refresh stays external-only)', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io, calls } = world({ vault: { has: () => false, get: () => null } });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.NO_CREDENTIALS);
  assert.strictEqual(calls.native, 0, 'refresh/collect never invokes the native runner');
  assert.strictEqual(result.snapshot, null);
  assert.strictEqual(result.native, null);
});

// CR5 — "observed" is what THIS run's live sources returned. The merged
// snapshot also carries cached sidecar rows, which are not an observation
// made now. These run the REAL runtime snapshot service with injected live
// sources and an injected sidecar.
const LIVE_EMPTY = { caller: null, sessions: [], harnesses: [], profiles: [], diagnostics: [] };
const profileRow = (id) => ({ key: { host: 'h', provider: 'p', profileId: id } });
const sidecarWith = (profiles) => () => ({ doc: { sessions: [], harnesses: [], profiles }, degradations: [] });
const NO_CREDS = { has: () => false, get: () => null };
const MINIMAX_CFG = () => Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });

await testAsync('CR5: a sidecar profile with an empty live read is unknown, and stays no-credentials', async () => {
  scratch();
  const result = await collector.collectView({
    cfg: MINIMAX_CFG(),
    io: realViewIo({
      vault: NO_CREDS,
      readSidecar: sidecarWith([profileRow('cached')]),
      readTraycer: async () => LIVE_EMPTY,
    }),
  });
  assert.strictEqual(result.snapshot.profiles.length, 1, 'the cached sidecar profile is in the snapshot');
  assert.strictEqual(result.native.outcome, 'unknown', 'a cached row is not an observation made now');
  assert.strictEqual(result.outcome, collector.OUTCOME.NO_CREDENTIALS, 'not promoted to completed');
});

await testAsync('CR5: a live profile is observed — native-only completes', async () => {
  scratch();
  const result = await collector.collectView({
    cfg: MINIMAX_CFG(),
    io: realViewIo({
      vault: NO_CREDS,
      readSidecar: sidecarWith([]),
      readTraycer: async () => Object.assign({}, LIVE_EMPTY, { profiles: [profileRow('live')] }),
    }),
  });
  assert.strictEqual(result.native.outcome, 'completed');
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED);
});

await testAsync('CR5: a sidecar profile plus a live profile is observed', async () => {
  scratch();
  const result = await collector.collectView({
    cfg: MINIMAX_CFG(),
    io: realViewIo({
      vault: NO_CREDS,
      readSidecar: sidecarWith([profileRow('cached')]),
      readTraycer: async () => Object.assign({}, LIVE_EMPTY, { profiles: [profileRow('live')] }),
    }),
  });
  assert.strictEqual(result.snapshot.profiles.length, 2, 'cached and live rows are both in the snapshot');
  assert.strictEqual(result.native.outcome, 'completed');
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED);
});

await testAsync('CR5: a live source in io.liveReads counts as this run\'s observation', async () => {
  scratch();
  const result = await collector.collectView({
    cfg: MINIMAX_CFG(),
    io: realViewIo({
      vault: NO_CREDS,
      readSidecar: sidecarWith([]),
      readTraycer: async () => LIVE_EMPTY,
      liveReads: [{ key: 'extra', read: async () => ({ sessions: [{ key: { host: 'h', agentId: 'a' } }] }) }],
    }),
  });
  assert.strictEqual(result.native.outcome, 'completed');
});

await testAsync('CR5: a throwing live source is still failed with the same codes (the wrapper re-throws)', async () => {
  scratch();
  const failing = (extra) => collector.collectView({
    cfg: MINIMAX_CFG(),
    io: realViewIo(Object.assign({
      getAdapter: () => ({ fetchStatus: async () => HEALTHY }),
      vault: { has: () => true, get: () => 'fake-test-key' },
      readSidecar: sidecarWith([profileRow('cached')]),
    }, extra)),
  });
  const viaTraycer = await failing({ readTraycer: async () => { throw new Error('boom'); } });
  assert.strictEqual(viaTraycer.native.outcome, 'failed');
  assert.deepStrictEqual(viaTraycer.native.codes, ['traycer-read-failed']);
  assert.strictEqual(viaTraycer.outcome, collector.OUTCOME.PARTIAL);

  const viaExtra = await failing({
    readTraycer: async () => LIVE_EMPTY,
    liveReads: [{ key: 'extra', read: async () => { throw new Error('boom'); } }],
  });
  assert.strictEqual(viaExtra.native.outcome, 'failed');
  assert.deepStrictEqual(viaExtra.native.codes, ['live-source-failed']);

  // A failed source records nothing even when a sibling observed rows: the
  // failure code still wins, as before.
  const mixed = await failing({
    readTraycer: async () => Object.assign({}, LIVE_EMPTY, { profiles: [profileRow('live')] }),
    liveReads: [{ key: 'extra', read: async () => { throw new Error('boom'); } }],
  });
  assert.strictEqual(mixed.native.outcome, 'failed');
});

await testAsync('CR5: every live source runs exactly ONCE per view — keys and coalescing are preserved', async () => {
  scratch();
  const counts = { traycer: 0, a: 0, shared: 0, dupKey: 0 };
  const shared = async () => { counts.shared += 1; return LIVE_EMPTY; };
  await collector.collectView({
    cfg: MINIMAX_CFG(),
    io: realViewIo({
      vault: NO_CREDS,
      readSidecar: sidecarWith([]),
      readTraycer: async () => { counts.traycer += 1; return LIVE_EMPTY; },
      liveReads: [
        { key: 'a', read: async () => { counts.a += 1; return LIVE_EMPTY; } },
        // one read function under two keys: the service coalesces it to one run
        { key: 'shared-1', read: shared },
        { key: 'shared-2', read: shared },
        // one key under two functions: the first wins, the second never runs
        { key: 'dup', read: async () => { counts.dupKey += 1; return LIVE_EMPTY; } },
        { key: 'dup', read: async () => { counts.dupKey += 100; return LIVE_EMPTY; } },
        // an entry the service ignores must not shift positional keys
        null,
        { read: 'not a function' },
      ],
    }),
  });
  assert.deepStrictEqual(counts, { traycer: 1, a: 1, shared: 1, dupKey: 1 });
});

await testAsync('CR5: the default Traycer source runs ONCE per view when no readTraycer is injected', async () => {
  scratch();
  const traycerAdapter = require('../lib/traycer-adapter');
  const real = traycerAdapter.readTraycerRuntime;
  let calls = 0;
  traycerAdapter.readTraycerRuntime = async () => { calls += 1; return LIVE_EMPTY; };
  try {
    const result = await collector.collectView({
      cfg: MINIMAX_CFG(),
      io: realViewIo({ vault: NO_CREDS, readSidecar: sidecarWith([]) }),
    });
    assert.strictEqual(calls, 1, 'the default source ran exactly once');
    assert.strictEqual(result.native.outcome, 'unknown');
  } finally {
    traycerAdapter.readTraycerRuntime = real;
  }
});

await testAsync('CR5: a fake getRuntimeSnapshot that runs no live source observes nothing (unknown)', async () => {
  scratch();
  const { io } = world({ vault: NO_CREDS });
  io.getRuntimeSnapshot = async () => ({ generatedAt: '2026-10-24T12:00:00Z', profiles: [profileRow('x')], sessions: [], harnesses: [], routes: [], diagnostics: [] });
  const result = await collector.collectView({ cfg: MINIMAX_CFG(), io });
  assert.strictEqual(result.native.outcome, 'unknown', 'rows the snapshot merely carries are not this run\'s observation');
});

// Drift guard: the collector must wrap EVERY live source runtime-snapshot runs
// by default. runtime-snapshot exports no list of them, so pin the io members
// collectLiveSources reads against the collector's own list. A new default
// source (a new io.<member>, or another sources.push) fails here until the
// collector wraps it.
await testAsync('CR5: the collector wraps every live source runtime-snapshot runs by default', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'runtime-snapshot.js'), 'utf8');
  const m = /function collectLiveSources\(io\) \{([\s\S]*?)\n\}\n/.exec(src);
  assert.ok(m, 'lib/runtime-snapshot.js#collectLiveSources was not found — update this guard and the collector together');
  const members = [...new Set([...m[1].matchAll(/\bio\.(\w+)/g)].map((x) => x[1]))].sort();
  assert.deepStrictEqual(members, [...collector.LIVE_SOURCE_IO_MEMBERS].sort(),
    'collectLiveSources reads a live-source io member the collector does not wrap');
  assert.strictEqual((m[1].match(/sources\.push\(/g) || []).length, 2,
    'collectLiveSources gained (or lost) a source.push — wrap the new source in lib/collector.js recordLiveSources');
  assert.strictEqual((src.match(/collectLiveSources\(/g) || []).length, 2,
    'collectLiveSources is the single place live sources are chosen (definition + one use in runLiveSources)');
});

// A1 — the worker lock is released after every outcome, and a publish throw
// leaves the prior cache byte-identical.
async function assertLockReleased(io) {
  const handle = await cache.acquireWorker({ ownerToken: 'post-collection' });
  assert.strictEqual(handle.acquired, true, 'the lock was released by the collection');
  await cache.releaseWorker(handle);
}

await testAsync('A1: the lock is released after a successful collection', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world();
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.COMPLETED);
  await assertLockReleased(io);
});

await testAsync('A1: the lock is released after a failed fetch', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world({ adapters: { minimax: () => { throw new Error('boom'); } } });
  cache.writeCache({ 'minimax-token-plan': priorEntry('minimax-token-plan') });
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  await assertLockReleased(io);
});

await testAsync('A1: a publish throw releases the lock and leaves the prior cache byte-identical', async () => {
  scratch();
  const cfg = Object.assign({}, CFG, { routes: [route('minimax-token-plan', 'minimax')] });
  const { io } = world();
  cache.writeCache({ 'minimax-token-plan': priorEntry('minimax-token-plan') });
  const beforeBytes = fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_DATA, 'status.json'), 'utf8');
  io.writeCache = () => { throw new Error('EACCES: read-only file system'); };
  const result = await collector.collect({ cfg, io });
  assert.strictEqual(result.outcome, collector.OUTCOME.FAILED);
  assert.strictEqual(result.reason, collector.REASON.PUBLISH_FAILED);
  assert.strictEqual(fs.readFileSync(path.join(process.env.CLAUDE_PLUGIN_DATA, 'status.json'), 'utf8'), beforeBytes,
    'the prior cache is byte-identical');
  await assertLockReleased(io);
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
