'use strict';
// Unit coverage for lib/provider-lifecycle.js (Issue #58): id allocation and
// collision, draft validation, probe classification, the retention gate, the
// persistence order and every partial-write recovery branch, plus the
// mutation lock. Fake io throughout — no filesystem, no vault, no provider —
// except for the lock tests, which exercise the real O_EXCL implementation.
//
// Every fake records what it was asked to do, so an assertion fails when the
// service writes the wrong thing, in the wrong order, or at all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('../lib/provider-lifecycle');
const { configRevision } = require('../lib/monitor-schema');
const { STATUS, PROBE_OUTCOME, RETENTION } = lifecycle;

let failures = 0;
// Tests run one at a time through this queue so an async test's result prints
// under its own section header and the summary runs after everything settles.
let queue = Promise.resolve();
function test(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures += 1;
      console.log(`  ✗ ${name}\n    ${(e && e.message) || e}`);
    }
  });
  return queue;
}
function section(name) {
  queue = queue.then(() => console.log(name));
}

const COMPAT_ROUTE = Object.freeze({
  label: 'acme-plan',
  recipe: 'openai-compat',
  endpoint: 'https://acme.example.com',
  recipeOptions: Object.freeze({ path: '/v1/models', scope: 'account' }),
  key: 'sk-TEST-acme-0001',
});

function healthyStatus() {
  return { state: 'healthy', windows: [], balance: null, resetAt: null, detail: { monitorable: true } };
}
function unknownStatus(reason) {
  return { state: 'unknown', windows: [], balance: null, resetAt: null, detail: { reason, monitorable: true } };
}

// Fake io with a recorded journal. `fail` names a stage that should throw.
function makeIo(options = {}) {
  const journal = [];
  const vaultStore = new Map(Object.entries(options.secrets || {}));
  let userDoc = options.userDoc ? JSON.parse(JSON.stringify(options.userDoc)) : {};
  let cache = options.cache
    ? JSON.parse(JSON.stringify(options.cache))
    : { updatedAt: null, routes: {} };
  const baseRoutes = options.routes || [];
  const io = {
    journal,
    get userDoc() { return userDoc; },
    get cache() { return cache; },
    vaultStore,
    probeCalls: [],
    lockCalls: 0,
    effectiveRoutes: () => (Array.isArray(userDoc.routes) ? userDoc.routes : baseRoutes),
    readUserConfig: () => JSON.parse(JSON.stringify(userDoc)),
    saveConfig: (doc) => {
      journal.push('config');
      if (options.fail === 'config') throw new Error('EACCES: permission denied');
      userDoc = JSON.parse(JSON.stringify(doc));
    },
    vault: {
      assertWritable: () => {
        if (options.fail === 'vault-preflight') throw new Error('vault unavailable');
      },
      get: (id) => (vaultStore.has(id) ? vaultStore.get(id) : null),
      set: (id, secret) => {
        journal.push(`vault-set:${id}`);
        if (options.fail === 'vault') throw new Error('keychain write refused');
        if (options.fail === 'vault-rollback' && vaultStore.has(id)) throw new Error('rollback refused');
        vaultStore.set(id, secret);
      },
      remove: (id) => {
        journal.push(`vault-remove:${id}`);
        if (options.fail === 'vault-rollback') throw new Error('rollback refused');
        if (options.fail === 'vault-remove') throw new Error('keychain delete refused');
        return vaultStore.delete(id);
      },
    },
    readCache: () => JSON.parse(JSON.stringify(cache)),
    writeCache: (routes, opts) => {
      journal.push('cache');
      if (options.fail === 'cache') throw new Error('ENOSPC');
      io.lastWriteCacheOptions = opts;
      cache = { updatedAt: new Date().toISOString(), routes: JSON.parse(JSON.stringify(routes)) };
      return cache;
    },
    lock: () => {
      io.lockCalls += 1;
      if (options.fail === 'lock') return { ok: false, error: 'held' };
      return { ok: true, release: () => journal.push('lock-release') };
    },
    probe: async (route, token) => {
      io.probeCalls.push({ route: JSON.parse(JSON.stringify(route)), token });
      journal.push('probe');
      if (options.probeThrows) throw new Error('probe exploded');
      if (typeof options.probe === 'function') return options.probe(route, token);
      return { status: healthyStatus(), capability: { monitorable: true, reason: 'recipe:openai-compat' } };
    },
    now: () => 1_700_000_000_000,
  };
  return io;
}

section('allocateRouteId');

test('derives custom-<slug> from a validated label', () => {
  const r = lifecycle.allocateRouteId('Acme.Plan_2', []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, 'custom-acme-plan-2');
});

test('refuses a colliding id without overwriting', () => {
  const r = lifecycle.allocateRouteId('acme-plan', ['custom-acme-plan']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, STATUS.ID_COLLISION);
  assert.strictEqual(r.id, 'custom-acme-plan');
});

test('refuses a label that impersonates a built-in family', () => {
  const r = lifecycle.allocateRouteId('kimi-mine', []);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, STATUS.INVALID_ROUTE);
  assert.match(r.error, /reserved prefix/);
});

section('buildRouteDraft');

test('defaults provider to the recipe wire family', () => {
  const r = lifecycle.buildRouteDraft({ id: 'custom-a', recipe: 'anthropic-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.route.provider, 'anthropic-compat');
});

test('refuses a provider that contradicts the recipe family', () => {
  const r = lifecycle.buildRouteDraft({ id: 'custom-a', provider: 'openai-compat', recipe: 'anthropic-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /serves only provider "anthropic-compat"/);
});

test('an unknown recipe is unsupported-recipe, not invalid-route', () => {
  const r = lifecycle.buildRouteDraft({ id: 'custom-a', provider: 'x-y', recipe: 'totally-made-up' });
  assert.strictEqual(r.status, STATUS.UNSUPPORTED_RECIPE);
});

test('a monitor without a recipe is refused up front', () => {
  const r = lifecycle.buildRouteDraft({ id: 'custom-a', provider: 'x-y', endpoint: 'https://a.example.com' });
  assert.strictEqual(r.status, STATUS.INVALID_ROUTE);
  assert.match(r.error, /explicit monitor recipe/);
});

test('the monitor schema still owns credential rejection (name and value)', () => {
  const byName = lifecycle.buildRouteDraft({ id: 'custom-a', recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models', apiKey: 'x' } });
  assert.strictEqual(byName.ok, false);
  assert.match(byName.error, /credential-shaped/);
  const byValue = lifecycle.buildRouteDraft({ id: 'custom-a', recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/sk-AAA/models' } });
  assert.strictEqual(byValue.ok, false);
  assert.match(byValue.error, /credential-shaped segment/);
});

test('an http endpoint is refused (https-only)', () => {
  const r = lifecycle.buildRouteDraft({ id: 'custom-a', recipe: 'openai-compat', endpoint: 'http://a.example.com', recipeOptions: { path: '/v1/models' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /must be https/);
});

test('needsCredential follows the recipe capability, not the recipe id', () => {
  const compat = lifecycle.buildRouteDraft({ id: 'custom-a', recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models' } });
  assert.strictEqual(compat.needsCredential, true);
  const cliAuth = lifecycle.buildRouteDraft({ id: 'custom-b', provider: 'alibaba-cloud', recipe: 'alibaba-coding-plan', region: 'cn-beijing' });
  assert.strictEqual(cliAuth.needsCredential, false);
  const unmonitored = lifecycle.buildRouteDraft({ id: 'custom-c', provider: 'stepplan', recipe: 'stepfun-plan' });
  assert.strictEqual(unmonitored.needsCredential, false);
});

test('retention is route-level and does NOT change configRevision', () => {
  const plain = lifecycle.buildRouteDraft({ id: 'custom-a', recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models' } });
  const kept = lifecycle.buildRouteDraft({ id: 'custom-a', recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models' }, retention: RETENTION.KEEP });
  assert.strictEqual(kept.route.retention, RETENTION.KEEP);
  assert.strictEqual(kept.route.monitor.retention, undefined, 'retention must never leak into monitor');
  assert.strictEqual(configRevision(kept.route), configRevision(plain.route),
    'a retention choice must not invalidate cached observations');
});

section('classifyProbe');

test('a capacity state is monitored', () => {
  for (const state of ['healthy', 'constrained', 'exhausted']) {
    const r = lifecycle.classifyProbe({ status: { state }, capability: { monitorable: true } });
    assert.strictEqual(r.outcome, PROBE_OUTCOME.MONITORED, state);
    assert.strictEqual(r.state, state);
  }
});

test('a recipe that declares no quota source is unmonitored, with its own reason', () => {
  const r = lifecycle.classifyProbe({ status: unknownStatus('x'), capability: { monitorable: false, reason: 'unmonitored:stepfun-plan' } });
  assert.strictEqual(r.outcome, PROBE_OUTCOME.UNMONITORED);
  assert.strictEqual(r.reason, 'unmonitored:stepfun-plan');
});

test('unknown is NEVER promoted into capacity; it is no-signal with the stable reason', () => {
  const r = lifecycle.classifyProbe({ status: unknownStatus('diagnostic-scope'), capability: { monitorable: true } });
  assert.strictEqual(r.outcome, PROBE_OUTCOME.NO_SIGNAL);
  assert.strictEqual(r.reason, 'diagnostic-scope');
});

test('a malformed probe result is failed, never monitorable', () => {
  for (const bad of [null, undefined, 42, [], 'nope', {}, { status: null }, { status: [] }]) {
    const r = lifecycle.classifyProbe(bad);
    assert.notStrictEqual(r.outcome, PROBE_OUTCOME.MONITORED, JSON.stringify(bad));
  }
});

section('setupProvider — ordering and the retention gate');

test('a monitored probe persists vault → config → cache, in that order', async () => {
  const io = makeIo();
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.deepStrictEqual(r.persisted, { credential: true, config: true, cache: true });
  assert.deepStrictEqual(io.journal, ['probe', 'vault-set:custom-acme-plan', 'config', 'cache', 'lock-release']);
  assert.strictEqual(io.vaultStore.get('custom-acme-plan'), COMPAT_ROUTE.key);
  assert.strictEqual(io.userDoc.routes.length, 1);
  assert.strictEqual(r.configRevision, configRevision(io.userDoc.routes[0]));
});

test('the probe runs BEFORE any write and receives the in-memory key, not a vault read', async () => {
  const io = makeIo();
  await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(io.journal.indexOf('probe') < io.journal.indexOf('vault-set:custom-acme-plan'), true);
  assert.strictEqual(io.probeCalls.length, 1);
  assert.strictEqual(io.probeCalls[0].token, COMPAT_ROUTE.key);
});

test('a non-monitorable probe with no retention flag persists NOTHING', async () => {
  const io = makeIo({ probe: async () => ({ status: unknownStatus('diagnostic-scope'), capability: { monitorable: true } }) });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.RETENTION_CHOICE_REQUIRED);
  assert.deepStrictEqual(r.persisted, { credential: false, config: false, cache: false });
  assert.strictEqual(io.journal.includes('config'), false);
  assert.strictEqual(io.journal.includes('vault-set:custom-acme-plan'), false);
  assert.strictEqual(io.vaultStore.size, 0);
  assert.deepStrictEqual(io.userDoc, {});
});

test('--keep-unmonitored persists the route with the route-level retention flag', async () => {
  const io = makeIo({ probe: async () => ({ status: unknownStatus('diagnostic-scope'), capability: { monitorable: true } }) });
  const r = await lifecycle.setupProvider({ ...COMPAT_ROUTE, retention: RETENTION.KEEP }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(io.userDoc.routes[0].retention, RETENTION.KEEP);
  assert.strictEqual(r.probe.outcome, PROBE_OUTCOME.NO_SIGNAL);
});

test('--clear-credential stores nothing and creates no route', async () => {
  const io = makeIo({ probe: async () => ({ status: unknownStatus('auth-rejected'), capability: { monitorable: true } }) });
  const r = await lifecycle.setupProvider({ ...COMPAT_ROUTE, retention: RETENTION.CLEAR }, io);
  assert.strictEqual(r.status, STATUS.OK);
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(io.vaultStore.size, 0);
  assert.deepStrictEqual(io.userDoc, {});
});

test('a probe that throws is failed, and still persists nothing', async () => {
  const io = makeIo({ probeThrows: true });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.RETENTION_CHOICE_REQUIRED);
  assert.strictEqual(r.probe.outcome, PROBE_OUTCOME.FAILED);
  assert.strictEqual(io.vaultStore.size, 0);
});

test('a failed probe leaves an existing working route untouched', async () => {
  const existing = { id: 'custom-keeper', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://keep.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } } };
  const io = makeIo({ userDoc: { routes: [existing] }, secrets: { 'custom-keeper': 'sk-KEEP' }, probeThrows: true });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(io.userDoc.routes, [existing]);
  assert.strictEqual(io.vaultStore.get('custom-keeper'), 'sk-KEEP');
});

test('a credential-free recipe refuses a key, and a credentialed recipe demands one', async () => {
  const noKey = await lifecycle.setupProvider({ label: 'acme-plan', recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models' } }, makeIo());
  assert.strictEqual(noKey.status, STATUS.INVALID_ROUTE);
  assert.match(noKey.error, /needs a credential/);
  const extraKey = await lifecycle.setupProvider({ label: 'stepplan-main', provider: 'stepplan', recipe: 'stepfun-plan', key: 'sk-nope' }, makeIo());
  assert.strictEqual(extraKey.status, STATUS.INVALID_ROUTE);
  assert.match(extraKey.error, /stores no credential/);
});

test('an unwritable vault is reported before the probe runs', async () => {
  const io = makeIo({ fail: 'vault-preflight' });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.VAULT_UNAVAILABLE);
  assert.strictEqual(io.journal.includes('probe'), false);
});

test('a busy lock is reported and nothing is read or written', async () => {
  const io = makeIo({ fail: 'lock' });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.LOCK_BUSY);
  assert.deepStrictEqual(io.journal, []);
});

test('the lock is released even when the operation fails', async () => {
  const io = makeIo({ fail: 'config' });
  await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(io.journal[io.journal.length - 1], 'lock-release');
});

section('setupProvider — partial-write recovery');

test('a vault failure aborts before config and cache are touched', async () => {
  const io = makeIo({ fail: 'vault' });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'vault');
  assert.deepStrictEqual(r.persisted, { credential: false, config: false, cache: false });
  assert.strictEqual(io.journal.includes('config'), false);
  assert.strictEqual(io.journal.includes('cache'), false);
});

test('a config failure rolls the new credential back and reports it truthfully', async () => {
  const io = makeIo({ fail: 'config' });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'config');
  assert.strictEqual(r.rollback, 'credential-removed');
  assert.strictEqual(r.persisted.credential, false, 'a rolled-back credential must not report as persisted');
  assert.strictEqual(io.vaultStore.has('custom-acme-plan'), false);
});

test('a config failure whose rollback also fails says so and names the cleanup', async () => {
  const io = makeIo({ fail: 'config' });
  io.vault.remove = () => { throw new Error('keychain locked'); };
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.rollback, 'failed');
  assert.strictEqual(r.persisted.credential, true, 'an un-rolled-back credential must stay reported');
  assert.match(r.recovery, /vl\.js remove custom-acme-plan/);
});

test('a cache-only failure is a warning: route and credential stand', async () => {
  const io = makeIo({ fail: 'cache' });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, STATUS.CACHE_STALE_WARNING);
  assert.strictEqual(lifecycle.exitCodeFor(r.status), 0);
  assert.deepStrictEqual(r.persisted, { credential: true, config: true, cache: false });
  assert.strictEqual(io.vaultStore.get('custom-acme-plan'), COMPAT_ROUTE.key);
  assert.strictEqual(io.userDoc.routes.length, 1);
});

test('persisting republishes revision metadata for the surviving routes', async () => {
  const io = makeIo();
  await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.ok(Array.isArray(io.lastWriteCacheOptions.routes), 'writeCache must receive the route list');
  assert.ok(io.lastWriteCacheOptions.routes.some((r) => r.id === 'custom-acme-plan'));
});

test('a stale cache row for a reused id is dropped by the add', async () => {
  const io = makeIo({ cache: { updatedAt: null, routes: { 'custom-acme-plan': { routeId: 'custom-acme-plan', status: { state: 'exhausted' } }, other: { routeId: 'other' } } } });
  await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(io.cache.routes['custom-acme-plan'], undefined);
  assert.ok(io.cache.routes.other, 'an unrelated row must survive');
});

section('updateProvider');

function updateIo(extra = {}) {
  const route = {
    id: 'custom-acme-plan',
    provider: 'openai-compat',
    match: { model: 'acme' },
    monitor: { recipe: 'openai-compat', endpoint: 'https://acme.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } },
  };
  return makeIo({ userDoc: { routes: [route] }, secrets: { 'custom-acme-plan': 'sk-OLD-0001' }, ...extra });
}

test('rotates the credential and keeps the route identity', async () => {
  const io = updateIo();
  const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', key: 'sk-NEW-0002' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(r.rotated, true);
  assert.strictEqual(io.vaultStore.get('custom-acme-plan'), 'sk-NEW-0002');
  assert.strictEqual(io.userDoc.routes.length, 1);
  assert.strictEqual(io.userDoc.routes[0].id, 'custom-acme-plan');
});

test('an endpoint change keeps the identity and changes the revision', async () => {
  const io = updateIo();
  const before = configRevision(io.userDoc.routes[0]);
  const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', endpoint: 'https://acme2.example.com' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(io.userDoc.routes[0].monitor.endpoint, 'https://acme2.example.com');
  assert.notStrictEqual(r.configRevision, before, 'a new source must produce a new revision');
});

test('without --key the probe reuses the stored credential and the vault is not rewritten', async () => {
  const io = updateIo();
  const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', model: 'acme-large' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(io.probeCalls[0].token, 'sk-OLD-0001');
  assert.strictEqual(io.journal.includes('vault-set:custom-acme-plan'), false);
});

test('provider and recipe are immutable', async () => {
  for (const change of [{ provider: 'anthropic-compat' }, { recipe: 'anthropic-compat' }]) {
    const io = updateIo();
    const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', ...change }, io);
    assert.strictEqual(r.status, STATUS.INVALID_ROUTE, JSON.stringify(change));
    assert.match(r.error, /immutable/);
    assert.strictEqual(io.journal.includes('config'), false);
  }
});

test('an unknown route is not-found', async () => {
  const r = await lifecycle.updateProvider({ routeId: 'custom-nope' }, updateIo());
  assert.strictEqual(r.status, STATUS.NOT_FOUND);
});

test('a built-in route is redirected to the credential path, not edited here', async () => {
  const io = makeIo({ userDoc: { routes: [{ id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan' }] } });
  const r = await lifecycle.updateProvider({ routeId: 'kimi-code-plan', key: 'sk-x' }, io);
  assert.strictEqual(r.status, STATUS.INVALID_ROUTE);
  assert.match(r.error, /vl\.js update kimi-code-plan/);
});

test('a failed rotation restores the PREVIOUS credential', async () => {
  const io = updateIo({ fail: 'config' });
  const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', key: 'sk-NEW-0002', endpoint: 'https://acme3.example.com' }, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.rollback, 'previous-credential-restored');
  assert.strictEqual(io.vaultStore.get('custom-acme-plan'), 'sk-OLD-0001');
  assert.strictEqual(io.userDoc.routes[0].monitor.endpoint, 'https://acme.example.com');
});

test('a rotation whose previous value is unreadable says it cannot be rolled back', async () => {
  const io = updateIo({ fail: 'config' });
  io.vault.get = () => null;
  const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', key: 'sk-NEW-0002' }, io);
  assert.strictEqual(r.rollback, 'not-possible');
  assert.match(r.recovery, /cannot be rolled back/);
});

test('--clear-credential on a route whose probe finds nothing removes the whole route', async () => {
  const io = updateIo({ probe: async () => ({ status: unknownStatus('auth-rejected'), capability: { monitorable: true } }) });
  const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', retention: RETENTION.CLEAR }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(r.cleared, true);
  assert.strictEqual(io.vaultStore.has('custom-acme-plan'), false);
  assert.deepStrictEqual(io.userDoc.routes, []);
});

test('--keep-unmonitored on update marks the existing route, keeping the credential', async () => {
  const io = updateIo({ probe: async () => ({ status: unknownStatus('diagnostic-scope'), capability: { monitorable: true } }) });
  const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', retention: RETENTION.KEEP }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(io.userDoc.routes[0].retention, RETENTION.KEEP);
  assert.strictEqual(io.vaultStore.get('custom-acme-plan'), 'sk-OLD-0001');
});

section('removeProvider');

test('clears route, credential and cache row for a custom route', async () => {
  const io = updateIo({ cache: { updatedAt: null, routes: { 'custom-acme-plan': { routeId: 'custom-acme-plan' }, 'kimi-code-plan': { routeId: 'kimi-code-plan' } } } });
  const r = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.deepStrictEqual(r.removed, { credential: true, config: true, cache: true, nativeLogout: false });
  assert.deepStrictEqual(io.userDoc.routes, []);
  assert.strictEqual(io.vaultStore.has('custom-acme-plan'), false);
  assert.strictEqual(io.cache.routes['custom-acme-plan'], undefined);
  assert.ok(io.cache.routes['kimi-code-plan'], 'an unrelated cache row must survive');
});

test('a built-in keeps its configured route: credential and cache row only', async () => {
  const builtIn = { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan' };
  const io = makeIo({
    userDoc: { routes: [builtIn] },
    secrets: { 'kimi-code-plan': 'sk-kimi-x' },
    cache: { updatedAt: null, routes: { 'kimi-code-plan': { routeId: 'kimi-code-plan' }, 'glm-coding-plan': { routeId: 'glm-coding-plan' } } },
  });
  const r = lifecycle.removeProvider({ routeId: 'kimi-code-plan' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(r.removed.credential, true);
  assert.strictEqual(r.removed.config, false, 'a built-in route must stay configured');
  assert.strictEqual(r.removed.cache, true);
  assert.deepStrictEqual(io.userDoc.routes, [builtIn]);
  assert.strictEqual(io.vaultStore.has('kimi-code-plan'), false);
  assert.strictEqual(io.cache.routes['kimi-code-plan'], undefined);
  assert.ok(io.cache.routes['glm-coding-plan'], 'another built-in row must not be touched');
});

test('a credential-free recipe never has its (nonexistent) vault key touched', async () => {
  const route = { id: 'custom-stepplan', provider: 'stepplan', monitor: { recipe: 'stepfun-plan' } };
  const io = makeIo({ userDoc: { routes: [route] } });
  const r = lifecycle.removeProvider({ routeId: 'custom-stepplan' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(io.journal.some((j) => j.startsWith('vault-remove')), false,
    'a vaultCredential:false recipe must not trigger a vault delete');
  assert.deepStrictEqual(io.userDoc.routes, []);
});

test('nothing to remove is not-found', async () => {
  const r = lifecycle.removeProvider({ routeId: 'custom-ghost' }, makeIo());
  assert.strictEqual(r.status, STATUS.NOT_FOUND);
});

test('removal is resumable: a config failure keeps the already-cleared credential reported', async () => {
  const io = updateIo({ fail: 'config' });
  const r = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.removed.credential, true);
  assert.strictEqual(r.removed.config, false);
  assert.match(r.recovery, /rerun the removal/);
  // Re-running finishes the job once the write works.
  const io2 = makeIo({ userDoc: io.userDoc, secrets: {} });
  const r2 = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io2);
  assert.strictEqual(r2.status, STATUS.OK, r2.error);
  assert.deepStrictEqual(io2.userDoc.routes, []);
});

test('a vault delete failure stops before the config is rewritten', async () => {
  const io = updateIo({ fail: 'vault-remove' });
  const r = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'vault');
  assert.strictEqual(io.userDoc.routes.length, 1, 'the route must survive a vault failure');
});

section('listProviders');

test('reports credential need, retention and revision agreement', async () => {
  const route = {
    id: 'custom-acme-plan', provider: 'openai-compat', retention: RETENTION.KEEP,
    monitor: { recipe: 'openai-compat', endpoint: 'https://acme.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } },
  };
  const io = makeIo({
    userDoc: { routes: [route] },
    secrets: { 'custom-acme-plan': 'sk-x' },
    cache: { updatedAt: null, routes: { 'custom-acme-plan': { routeId: 'custom-acme-plan', configRevision: configRevision(route) } } },
  });
  const row = lifecycle.listProviders(io).routes[0];
  assert.strictEqual(row.needsCredential, true);
  assert.strictEqual(row.hasCredential, true);
  assert.strictEqual(row.retention, RETENTION.KEEP);
  assert.strictEqual(row.configObsolete, false);
  assert.strictEqual(row.cachedRevision, row.configRevision);
});

test('flags a cached row that no longer matches the route config', async () => {
  const route = {
    id: 'custom-acme-plan', provider: 'openai-compat',
    monitor: { recipe: 'openai-compat', endpoint: 'https://acme.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } },
  };
  const io = makeIo({
    userDoc: { routes: [route] },
    cache: { updatedAt: null, routes: { 'custom-acme-plan': { routeId: 'custom-acme-plan', configRevision: 'deadbeef' } } },
  });
  const row = lifecycle.listProviders(io).routes[0];
  assert.strictEqual(row.configObsolete, true);
});

test('performs no probe, no write and no lock', async () => {
  const io = updateIo();
  lifecycle.listProviders(io);
  assert.deepStrictEqual(io.journal, []);
  assert.strictEqual(io.probeCalls.length, 0);
  assert.strictEqual(io.lockCalls, 0);
});

section('exit codes');

test('every status maps to a stable code, and 1 stays reserved for bad args', () => {
  assert.deepStrictEqual(
    Object.fromEntries(Object.values(STATUS).map((s) => [s, lifecycle.exitCodeFor(s)])),
    {
      ok: 0,
      'cache-stale-warning': 0,
      'retention-choice-required': 2,
      'id-collision': 3,
      'invalid-route': 4,
      'unsupported-recipe': 4,
      'vault-unavailable': 5,
      'persist-failed': 5,
      'lock-busy': 6,
      'not-found': 7,
    },
  );
  assert.strictEqual(lifecycle.exitCodeFor('something-unknown'), 1);
  assert.strictEqual(Object.values(lifecycle.EXIT_CODES).includes(1), false,
    'no lifecycle status may claim exit 1 (bad arguments)');
});

section('mutation lock (real fs)');

test('a second acquire is refused while the first is held, and works after release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-lock-'));
  const first = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(first.ok, true);
  const second = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'held');
  first.release();
  const third = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(third.ok, true);
  third.release();
  assert.strictEqual(fs.existsSync(path.join(dir, lifecycle.LOCK_FILE)), false);
});

test('a stale lock is taken over exactly once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-stale-'));
  const held = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(held.ok, true);
  // Pretend "now" is well past the staleness horizon.
  const later = lifecycle.acquireMutationLock(dir, { now: () => Date.now() + lifecycle.LOCK_STALE_MS + 1000 });
  assert.strictEqual(later.ok, true, 'a stale lock must be reclaimed');
  later.release();
});

test('the lock is created under the data dir, creating it when absent', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-mk-')), 'nested');
  const l = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(fs.existsSync(path.join(dir, lifecycle.LOCK_FILE)), true);
  l.release();
});

section('D1 — no discovery-time inference path exists (closed by decision)');

// Issue #58 deliberately does NOT implement the optional discovery-time
// inference probe: no recipe in the fixed registry has terms that clearly
// permit one (Alibaba's Coding Plan policy restricts inference to interactive
// coding tools, stepfun-plan documents no quota source, and the compat recipes
// point at user-supplied endpoints whose terms we cannot know). This scan is
// the tripwire: a later contributor who wires an inference or discovery path
// into the core trips it here rather than shipping it unnoticed.
function coreSourceFiles() {
  const roots = [path.resolve(__dirname, '../lib'), path.resolve(__dirname, '../bin')];
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(js|cjs|mjs)$/.test(name)) out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

// The ONE expected hit: the Jev recommendation transport, which is a separate,
// readiness-gated advisory feature (not provider quota discovery) and predates
// this issue. Pinned by name so a new exception cannot be slipped in silently.
const INFERENCE_EXCEPTIONS = Object.freeze(['lib/jev-openrouter.js']);

test('no inference endpoint is referenced outside the pinned Jev transport', () => {
  const INFERENCE_RE = /\/(chat\/)?completions|\/v1\/messages|\/v1\/responses|\/embeddings/;
  const offenders = [];
  for (const file of coreSourceFiles()) {
    const rel = path.relative(path.resolve(__dirname, '..'), file);
    if (INFERENCE_EXCEPTIONS.includes(rel)) continue;
    if (INFERENCE_RE.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [], `inference endpoint referenced in: ${offenders.join(', ')}`);
});

test('the exception list is exact: the Jev transport still matches, nothing else is exempted', () => {
  const INFERENCE_RE = /\/(chat\/)?completions|\/v1\/messages|\/v1\/responses|\/embeddings/;
  for (const rel of INFERENCE_EXCEPTIONS) {
    const body = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
    assert.ok(INFERENCE_RE.test(body),
      `${rel} no longer contains an inference endpoint — drop it from the exception list instead of keeping a dead exemption`);
  }
});

test('no discovery opt-in symbol exists in the core', () => {
  const SYMBOL_RE = /discoverViaInference|inferenceProbe|probeViaInference|allowInference|inferenceOptIn/i;
  const offenders = coreSourceFiles()
    .filter((f) => SYMBOL_RE.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(path.resolve(__dirname, '..'), f));
  assert.deepStrictEqual(offenders, [], `discovery-inference symbol found in: ${offenders.join(', ')}`);
});

test('every registered recipe still declares inference: false (or declares no inference at all)', () => {
  const { RECIPES } = require('../lib/recipes');
  for (const [id, recipe] of Object.entries(RECIPES)) {
    const caps = recipe.capabilities || {};
    if ('inference' in caps) {
      assert.strictEqual(caps.inference, false, `recipe ${id} must not declare inference capability`);
    }
  }
});

queue.then(() => {
  if (failures) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('\nall provider-lifecycle tests passed');
  }
});
