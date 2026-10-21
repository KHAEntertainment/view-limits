'use strict';
// Unit coverage for lib/provider-lifecycle.js (Issue #58): id allocation and
// collision, draft validation, probe classification, the retention gate, the
// persistence order and every partial-write recovery branch, plus the
// mutation lock. Fake io throughout — no filesystem, no vault, no provider —
// except for the lock tests, which exercise the real ticket protocol.
//
// Every fake records what it was asked to do, so an assertion fails when the
// service writes the wrong thing, in the wrong order, or at all.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lifecycle = require('../lib/provider-lifecycle');
const { configRevision } = require('../lib/monitor-schema');
const { attachRevisions } = require('../lib/cache');
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
    readUserConfigStrict: () => (options.configUnreadable
      ? { ok: false, reason: options.configUnreadable }
      : { ok: true, doc: JSON.parse(JSON.stringify(userDoc)) }),
    saveConfig: (doc) => {
      journal.push('config');
      if (options.fail === 'config') throw new Error('EACCES: permission denied');
      userDoc = JSON.parse(JSON.stringify(doc));
    },
    vault: {
      assertWritable: () => {
        if (options.fail === 'vault-preflight') throw new Error('vault unavailable');
      },
      get: (id) => {
        // An unreadable vault answers exactly like an empty one — that is the
        // whole hazard. A locked Keychain, a missing master key and a blob that
        // will not decrypt all return null here, same as "no such secret".
        if (options.vaultUnreadable) return null;
        return vaultStore.has(id) ? vaultStore.get(id) : null;
      },
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
        // The production backends SWALLOW their errors and return false, so a
        // fake that only throws would never exercise the real contract.
        // `vaultDeleteNoops: true` reproduces it: the call reports false and
        // the secret stays put.
        if (options.vaultDeleteNoops) return false;
        if (options.vaultUnreadable) return false;
        return vaultStore.delete(id);
      },
      // The real three-way contract (lib/vault.js `probe`): presence WITHOUT
      // reading the secret, and a third answer for "could not look".
      // `vaultUnreadable: true` is the case production must survive — a secret
      // still on disk whose get() is null and whose remove() is false.
      probe: (id) => {
        if (options.vaultUnreadable) return 'unreadable';
        return vaultStore.has(id) ? 'present' : 'absent';
      },
    },
    readCache: () => JSON.parse(JSON.stringify(cache)),
    writeCache: (routes, opts) => {
      journal.push('cache');
      if (options.fail === 'cache') throw new Error('ENOSPC');
      io.lastWriteCacheOptions = opts;
      // Run the REAL attachRevisions: passing `options.routes` re-stamps every
      // row's configRevision from the current config, which is exactly the
      // behaviour a lifecycle write must not trigger. A fake that skipped this
      // could not see the difference.
      const enriched = attachRevisions(JSON.parse(JSON.stringify(routes)), opts);
      cache = { updatedAt: new Date().toISOString(), routes: enriched };
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

test('a stale cache row for a reused id is dropped by the add', async () => {
  const io = makeIo({ cache: { updatedAt: null, routes: { 'custom-acme-plan': { routeId: 'custom-acme-plan', status: { state: 'exhausted' } }, other: { routeId: 'other' } } } });
  await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(io.cache.routes['custom-acme-plan'], undefined);
  assert.ok(io.cache.routes.other, 'an unrelated row must survive');
});

test('a lifecycle write does NOT re-stamp a surviving row it never observed', async () => {
  // Route B is time-fresh, exhausted, and stamped for a config it no longer
  // has, so the gate correctly stops trusting it. Adding an unrelated route
  // must not make that observation look current again: nothing re-observed B.
  const staleRouteB = {
    id: 'custom-b', provider: 'openai-compat',
    monitor: { recipe: 'openai-compat', endpoint: 'https://b-old.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } },
  };
  const editedRouteB = {
    ...staleRouteB,
    monitor: { ...staleRouteB.monitor, endpoint: 'https://b-new.example.com' },
  };
  const obsoleteStamp = configRevision(staleRouteB);
  const io = makeIo({
    userDoc: { routes: [editedRouteB] },
    secrets: { 'custom-b': 'sk-B' },
    cache: {
      updatedAt: null,
      routes: { 'custom-b': { routeId: 'custom-b', configRevision: obsoleteStamp, status: { state: 'exhausted' } } },
    },
  });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(io.cache.routes['custom-b'].configRevision, obsoleteStamp,
    "an unobserved sibling's revision was rewritten, making a stale exhaustion deny again");
  assert.notStrictEqual(io.cache.routes['custom-b'].configRevision, configRevision(editedRouteB));
  assert.strictEqual(io.lastWriteCacheOptions, undefined,
    'a lifecycle cache write must not pass options.routes (that is refresh\'s job)');
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

test('an UNREADABLE credential is a failed delete, never an absent one', async () => {
  // The hole this closes: get() returns null both for "no such secret" and for
  // a secret it could not read, and remove() returns false both for "nothing
  // there" and for a delete that failed. A read-back of those two therefore
  // CANNOT prove absence — it is byte-for-byte what an unreadable, still
  // present secret looks like. Announcing it gone and then deleting the route
  // orphans a live credential, which is the data-integrity failure.
  const io = updateIo({ vaultUnreadable: true });
  const r = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'vault');
  assert.strictEqual(r.removed.credential, false,
    'an unreadable vault was reported as a successful credential removal');
  assert.strictEqual(io.userDoc.routes.length, 1,
    'the route was deleted while its credential may still be stored');
  assert.match(r.recovery, /still stored/);
});

test('a vault that cannot prove absence never reports a credential removed', async () => {
  // Fail closed on an interface that predates the probe: no proof is not
  // proof. Production always supplies it (bin/vl.js lifecycleIo), so this
  // pins the default rather than a reachable user-facing path.
  const io = updateIo({});
  delete io.vault.probe;
  const r = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'vault');
});

section('malformed config.json is never overwritten');

// A lifecycle write replaces config.json wholesale, so starting from `{}`
// because the existing document would not parse silently discards every
// setting in it. Refuse instead — before the probe, before the vault.
test('an add refuses when config.json exists but will not parse', async () => {
  const io = makeIo({ configUnreadable: 'malformed' });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'config-unreadable');
  assert.deepStrictEqual(r.persisted, { credential: false, config: false, cache: false });
  assert.strictEqual(io.journal.includes('config'), false, 'config must not be written');
  assert.strictEqual(io.journal.some((j) => j.startsWith('vault-set')), false, 'no credential may be stored');
  assert.strictEqual(io.journal.includes('probe'), false, 'the guard runs before the probe');
  assert.match(r.recovery, /discard every setting/);
});

test('an update refuses on the same condition', async () => {
  const io = updateIo({ configUnreadable: 'malformed' });
  const r = await lifecycle.updateProvider({ routeId: 'custom-acme-plan', key: 'sk-NEW-0002' }, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'config-unreadable');
  assert.strictEqual(io.vaultStore.get('custom-acme-plan'), 'sk-OLD-0001', 'the stored key must be untouched');
  assert.strictEqual(io.journal.includes('config'), false);
});

test('a non-object config document is refused too', async () => {
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, makeIo({ configUnreadable: 'not-an-object' }));
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'config-unreadable');
});

test('removal is NOT blocked by it — it never rewrites an unreadable config', async () => {
  // With an unreadable config no custom route resolves, so removal takes its
  // no-route-entry branch: the credential and cache row go, saveConfig is
  // never called. `vl.js remove <built-in>` must keep working on a broken
  // config rather than being locked out by the guard.
  const io = makeIo({
    configUnreadable: 'malformed',
    routes: [{ id: 'kimi-code-plan', provider: 'kimi' }],
    secrets: { 'kimi-code-plan': 'sk-kimi-x' },
    cache: { updatedAt: null, routes: { 'kimi-code-plan': { routeId: 'kimi-code-plan' } } },
  });
  const r = lifecycle.removeProvider({ routeId: 'kimi-code-plan' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(r.removed.credential, true);
  assert.strictEqual(io.journal.includes('config'), false, 'removal must not rewrite a broken config');
});

test('an io without the strict reader behaves exactly as before', async () => {
  const io = makeIo();
  delete io.readUserConfigStrict;
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
});

section('credential never leaks through an error path');

// The keychain backend shells out to `security … -w <secret>`, and a failed
// execFileSync puts its entire argv — credential included — into
// `error.message`. Verified against the real binary: the message does contain
// the password. So a vault exception's text must never be repeated into a
// result that gets printed as JSON.
function leakyError(secret) {
  return new Error(`Command failed: security add-generic-password -U -a custom-acme-plan -s svc -w ${secret}`);
}

test('a vault WRITE failure never repeats the exception text (which holds the key)', async () => {
  const io = makeIo();
  io.vault.set = () => { throw leakyError(COMPAT_ROUTE.key); };
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'vault');
  const printed = JSON.stringify(r);
  assert.strictEqual(printed.includes(COMPAT_ROUTE.key), false,
    'the credential reached the reported result through the vault error message');
  assert.strictEqual(printed.includes('add-generic-password'), false,
    'the vault argv reached the reported result');
  assert.match(r.error, /credential store refused the write/);
});

test('a vault DELETE failure never repeats the exception text', async () => {
  const io = updateIo();
  io.vault.remove = () => { throw leakyError('sk-OLD-0001'); };
  const r = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  const printed = JSON.stringify(r);
  assert.strictEqual(printed.includes('sk-OLD-0001'), false,
    'the credential reached the reported result through the vault error message');
  assert.match(r.error, /credential store refused the delete/);
});

test('a rollback failure after a leaky vault error also stays clean', async () => {
  const io = makeIo({ fail: 'config' });
  io.vault.remove = () => { throw leakyError(COMPAT_ROUTE.key); };
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.rollback, 'failed');
  assert.strictEqual(JSON.stringify(r).includes(COMPAT_ROUTE.key), false);
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
      'migration-pending': 8,
    },
  );
  assert.strictEqual(lifecycle.exitCodeFor('something-unknown'), 1);
  assert.strictEqual(Object.values(lifecycle.EXIT_CODES).includes(1), false,
    'no lifecycle status may claim exit 1 (bad arguments)');
});

section('a silent vault delete is never reported as success');

// Both production backends swallow their delete error and return false
// (lib/vault.js keychainDelete / fileDelete), so the return value alone cannot
// support a claim that a secret is gone. These cases use that exact contract:
// the call reports false and the secret stays put.
test('a rollback whose delete silently no-ops is reported as FAILED, not removed', async () => {
  const io = makeIo({ fail: 'config', vaultDeleteNoops: true });
  const r = await lifecycle.setupProvider(COMPAT_ROUTE, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.rollback, 'failed',
    'a delete that silently did nothing must not be reported as a successful rollback');
  assert.strictEqual(r.persisted.credential, true, 'the credential is still stored, so say so');
  assert.strictEqual(io.vaultStore.get('custom-acme-plan'), COMPAT_ROUTE.key);
  assert.match(r.recovery, /still stored/);
});

test('a removal whose delete silently no-ops does NOT go on to delete the route', async () => {
  const io = updateIo({ vaultDeleteNoops: true });
  const r = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io);
  assert.strictEqual(r.status, STATUS.PERSIST_FAILED);
  assert.strictEqual(r.stage, 'vault');
  assert.strictEqual(io.userDoc.routes.length, 1,
    'removing the route while its credential is still stored would orphan the secret');
  assert.strictEqual(io.vaultStore.get('custom-acme-plan'), 'sk-OLD-0001');
});

test('an absent credential is not a failed delete', async () => {
  // remove() returns false here too, but nothing was there — that is success.
  const route = { id: 'custom-acme-plan', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } } };
  const io = makeIo({ userDoc: { routes: [route] }, secrets: {} });
  const r = lifecycle.removeProvider({ routeId: 'custom-acme-plan' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(r.removed.credential, false);
  assert.strictEqual(r.removed.config, true);
});

section('removal snapshots under the lock');

test('a route added between the call and the lock is not deleted by the removal', async () => {
  // The remover must read the route list under the lock. If it snapshots
  // first, it writes a list that predates a concurrent add and silently drops
  // that route — while leaving its credential behind.
  const routeA = { id: 'custom-a', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } } };
  const routeB = { id: 'custom-b', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://b.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } } };
  const io = makeIo({ userDoc: { routes: [routeA] }, secrets: { 'custom-a': 'sk-A', 'custom-b': 'sk-B' } });
  const realLock = io.lock;
  io.lock = () => {
    // A competing mutation commits route B while we are acquiring.
    io.saveConfig({ ...io.readUserConfig(), routes: [routeA, routeB] });
    io.lock = realLock;
    return realLock();
  };
  const r = lifecycle.removeProvider({ routeId: 'custom-a' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.deepStrictEqual(io.userDoc.routes.map((x) => x.id), ['custom-b'],
    'the concurrently added route must survive the removal');
});

section('a shipped built-in route is never deletable');

test('an explicit built-in monitor does not make a shipped route removable', async () => {
  // The resolver supports `monitor: { recipe: 'built-in' }` as a wire-family
  // pass-through, so monitor presence alone is not ownership evidence.
  const builtIn = { id: 'kimi-code-plan', provider: 'kimi', monitor: { recipe: 'built-in' } };
  const io = makeIo({
    userDoc: { routes: [builtIn] },
    secrets: { 'kimi-code-plan': 'sk-kimi-x' },
    cache: { updatedAt: null, routes: { 'kimi-code-plan': { routeId: 'kimi-code-plan' } } },
  });
  const r = lifecycle.removeProvider({ routeId: 'kimi-code-plan' }, io);
  assert.strictEqual(r.status, STATUS.OK, r.error);
  assert.strictEqual(r.removed.config, false, 'a shipped route must stay in config.json');
  assert.deepStrictEqual(io.userDoc.routes, [builtIn]);
  assert.strictEqual(r.removed.credential, true, 'its credential still goes');
  assert.strictEqual(io.cache.routes['kimi-code-plan'], undefined, 'and its cache row still goes');
});

test('a shipped id is protected even carrying a real custom recipe', async () => {
  const masquerading = {
    id: 'glm-coding-plan', provider: 'openai-compat',
    monitor: { recipe: 'openai-compat', endpoint: 'https://x.example.com', recipeOptions: { path: '/v1/models', scope: 'account' } },
  };
  const io = makeIo({ userDoc: { routes: [masquerading] }, secrets: { 'glm-coding-plan': 'sk-x' } });
  const r = lifecycle.removeProvider({ routeId: 'glm-coding-plan' }, io);
  assert.strictEqual(r.removed.config, false);
  assert.deepStrictEqual(io.userDoc.routes, [masquerading]);
});

section('a probe exception never reaches the result');

test('the text of a thrown probe is dropped, not reported', async () => {
  const io = makeIo();
  io.probe = async () => {
    // A probe runs with the credential in hand; a thrown error can quote the
    // request it was making, header and all.
    throw new Error(`connect ETIMEDOUT https://acme.example.com (Authorization: Bearer ${COMPAT_ROUTE.key})`);
  };
  const r = await lifecycle.setupProvider({ ...COMPAT_ROUTE, retention: RETENTION.KEEP }, io);
  const printed = JSON.stringify(r);
  assert.strictEqual(printed.includes(COMPAT_ROUTE.key), false,
    'the credential reached the result through the probe exception');
  assert.strictEqual(printed.includes('Authorization'), false);
  assert.strictEqual(r.probe.outcome, PROBE_OUTCOME.FAILED);
  assert.strictEqual(r.probe.reason, 'probe-threw');
  assert.strictEqual(r.probe.detail, undefined);
});

section('config.json is published atomically');

// saveConfig used writeFileSync directly on config.json, which truncates
// first: a failure after truncation left an empty or partial document, and a
// malformed config silently falls back to DEFAULTS on the next read — so every
// route and setting in it would be gone while the lifecycle reported "nothing
// was persisted". A chmod-based test cannot catch this (it fails before the
// truncation), so this one fails the write itself.
test('a write that fails mid-publication leaves the previous document intact', () => {
  const { saveConfig } = require('../lib/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-atomic-cfg-'));
  const prevDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  const target = path.join(dir, 'config.json');
  const original = JSON.stringify({ routes: [{ id: 'my-route', provider: 'kimi' }], vault: { backend: 'file' } }, null, 1);
  fs.writeFileSync(target, original);
  // Every publish runs under the provider mutation lock (Issue #81), so the
  // fixture holds the real one — taken before the fault is injected, since the
  // lock writes its own ticket. The property under test is unchanged.
  const lock = lifecycle.acquireMutationLock(dir);
  assert.ok(lock.ok, 'premise: the test holds the mutation lock');
  const realWrite = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, ...rest) => {
      // Let the temp file be created, then fail as a full disk would.
      if (String(file) !== target) {
        realWrite(file, ...rest);
        const e = new Error('ENOSPC: no space left on device');
        e.code = 'ENOSPC';
        throw e;
      }
      return realWrite(file, ...rest);
    };
    assert.throws(() => saveConfig({ routes: [], vault: {} }), /ENOSPC/);
  } finally {
    fs.writeFileSync = realWrite;
    lock.release();
    if (prevDataDir === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevDataDir;
  }
  assert.strictEqual(fs.readFileSync(target, 'utf8'), original,
    'config.json was damaged by a failed write');
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter((f) => f.startsWith('config.json.tmp')), [],
    'a failed write left its temp file behind',
  );
});

section('mutation lock (real fs)');

// A pid nothing is using, confirmed absent rather than assumed.
function absentPid() {
  for (let pid = 60000; pid < 65000; pid += 7) {
    try { process.kill(pid, 0); } catch (e) {
      if (e && e.code === 'ESRCH') return pid;
    }
  }
  return null;
}

// Plant one contender's ticket by hand. `hex` keeps the name unique, exactly
// as a real contender's random suffix does.
function plantTicket(dir, { pid, number, hex, raw }) {
  const root = path.join(dir, lifecycle.LOCK_DIR);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, `${pid}-${hex}.json`);
  fs.writeFileSync(file, raw !== undefined
    ? raw
    : JSON.stringify({ pid, owner: `planted-${hex.slice(0, 6)}`, number }));
  return file;
}

function ticketsIn(dir) {
  try { return fs.readdirSync(path.join(dir, lifecycle.LOCK_DIR)).sort(); } catch { return []; }
}

test('a second acquire is refused while the first is held, and works after release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-lock-'));
  const first = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(first.ok, true);
  const second = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.error, 'held');
  assert.strictEqual(first.release(), true);
  const third = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(third.ok, true);
  assert.strictEqual(third.release(), true);
  assert.deepStrictEqual(ticketsIn(dir), [],
    'a refused contender or a released holder left its ticket behind');
});

test('a LIVE holder is never taken over, and no age horizon exists to try it', () => {
  // The Alibaba recipe allows timeoutMs up to 30000 for each of two sequential
  // reads, so a perfectly healthy probe can hold the lock for a minute. There
  // is no clock in this protocol at all: liveness is the only question asked,
  // so there is nothing for a long-running holder to age out of.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-live-'));
  const held = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(held.ok, true);
  for (let i = 0; i < 3; i += 1) {
    const later = lifecycle.acquireMutationLock(dir);
    assert.strictEqual(later.ok, false, 'a live owner was stolen from');
    assert.strictEqual(later.error, 'held');
  }
  assert.strictEqual(held.release(), true);
});

test('a provably dead holder is reclaimed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-dead-'));
  const pid = absentPid();
  assert.ok(pid, 'could not find an absent pid to test with');
  const ghost = plantTicket(dir, { pid, number: 1, hex: 'a'.repeat(32) });
  const taken = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(taken.ok, true, "a dead holder's ticket must not block every future mutation");
  assert.strictEqual(fs.existsSync(ghost), false, "the dead contender's ticket was left to rot");
  assert.strictEqual(taken.release(), true);
});

test('after a dead-holder reclaim, a later contender is refused and never unlinks the winner', () => {
  // Sequential, so this is NOT the race itself (that is the multi-process test
  // below). It pins the two properties the old single-file lock lacked: the
  // dead ticket is reaped by name, and a refused contender removes only its
  // own claim — never the winner's live ticket.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-reclaim-'));
  const pid = absentPid();
  assert.ok(pid, 'could not find an absent pid to test with');
  plantTicket(dir, { pid, number: 1, hex: 'b'.repeat(32) });
  const a = lifecycle.acquireMutationLock(dir);
  const b = lifecycle.acquireMutationLock(dir);
  const winners = [a, b].filter((l) => l.ok);
  assert.strictEqual(winners.length, 1,
    'two contenders both acquired the lock after reclaiming one dead holder');
  assert.strictEqual(fs.existsSync(winners[0].path), true,
    "the losing contender deleted the winner's ticket");
  assert.strictEqual(winners[0].release(), true);
  assert.deepStrictEqual(ticketsIn(dir), []);
});

test('real processes racing for the lock, over a dead holder, never hold it together', async () => {
  // The interleaving the sequential test cannot reach: several OS processes
  // released at once by a barrier, each repeatedly trying to acquire, holding
  // briefly, and releasing. Every holder journals `start`/`end`; two `start`s
  // without an `end` between them is two concurrent writers of config.json.
  const { spawn } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-race-'));
  const pid = absentPid();
  assert.ok(pid, 'could not find an absent pid to test with');
  plantTicket(dir, { pid, number: 1, hex: 'e'.repeat(32) });
  const barrier = path.join(dir, 'barrier');
  const journal = path.join(dir, 'journal');
  const script = `
    const fs = require('fs');
    const lifecycle = require(${JSON.stringify(path.resolve(__dirname, '../lib/provider-lifecycle'))});
    const [dir, barrier, journal] = process.argv.slice(1);
    const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    while (!fs.existsSync(barrier)) nap(1);
    const until = Date.now() + 400;
    while (Date.now() < until) {
      const lock = lifecycle.acquireMutationLock(dir);
      if (!lock.ok) { nap(1); continue; }
      fs.appendFileSync(journal, 'start ' + process.pid + '\\n');
      nap(30);
      fs.appendFileSync(journal, 'end ' + process.pid + '\\n');
      if (!lock.release()) { fs.appendFileSync(journal, 'release-failed ' + process.pid + '\\n'); }
    }
  `;
  const children = Array.from({ length: 6 }, () =>
    spawn(process.execPath, ['-e', script, dir, barrier, journal], { stdio: ['ignore', 'ignore', 'pipe'] }));
  const stderr = children.map(() => '');
  children.forEach((c, i) => c.stderr.on('data', (d) => { stderr[i] += d; }));
  await new Promise((res) => setTimeout(res, 200));
  fs.writeFileSync(barrier, 'go');
  const codes = await Promise.all(children.map((c) => new Promise((res) => c.on('exit', res))));
  assert.deepStrictEqual(codes, codes.map(() => 0), `a contender crashed: ${stderr.join('\n')}`);
  const lines = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean) : [];
  let holder = null;
  for (const line of lines) {
    const [event, who] = line.split(' ');
    assert.notStrictEqual(event, 'release-failed', `a holder could not release its own ticket: ${line}`);
    if (event === 'start') {
      assert.strictEqual(holder, null, `${who} acquired while ${holder} still held the lock`);
      holder = who;
    } else {
      assert.strictEqual(holder, who, `unbalanced journal at "${line}"`);
      holder = null;
    }
  }
  assert.ok(lines.some((l) => l.startsWith('start ')), 'premise: nobody ever acquired, so nothing was raced');
  assert.strictEqual(holder, null, 'a holder never finished');
  assert.deepStrictEqual(ticketsIn(dir), [], 'tickets were left behind, including the dead holder');
});

test("reclaiming a dead holder never removes a LIVE contender's ticket", () => {
  // Reaping is by filename pid and must touch nothing else: a live peer in the
  // same directory keeps its claim, and still wins the election.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-mixed-'));
  const pid = absentPid();
  assert.ok(pid, 'could not find an absent pid to test with');
  const ghost = plantTicket(dir, { pid, number: 1, hex: 'c'.repeat(32) });
  const live = plantTicket(dir, { pid: process.pid, number: 1, hex: 'd'.repeat(32) });
  const mine = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(mine.ok, false, 'a live contender holding a lower number was ignored');
  assert.strictEqual(mine.error, 'held');
  assert.strictEqual(fs.existsSync(ghost), false, 'the dead ticket was not reaped');
  assert.strictEqual(fs.existsSync(live), true, "a live contender's ticket was deleted");
  fs.unlinkSync(live);
});

test('release refuses once the ticket on disk is no longer ours', () => {
  // Nothing else can occupy our unique name, but a rewritten or corrupted
  // ticket is not ours to delete — the same ownership rule as
  // lib/refresh-owner.js releaseWorker.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-own-'));
  const held = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(held.ok, true);
  fs.writeFileSync(held.path, JSON.stringify({ pid: process.pid, owner: 'someone-else', number: 1 }));
  assert.strictEqual(held.release(), false, 'release must refuse when the token no longer matches');
  assert.strictEqual(fs.existsSync(held.path), true, 'release deleted a ticket it does not own');
});

test('a malformed ticket yields while its contender lives, and never deadlocks once it dies', () => {
  // An unparseable LIVE record is indeterminate — never permission to proceed.
  // It needs no age escape hatch: once its process is gone it is reaped by
  // liveness, so a corrupt ticket cannot block mutations forever.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-corrupt-'));
  const liveGarbage = plantTicket(dir, { pid: process.pid, hex: 'e'.repeat(32), raw: 'not json at all' });
  const refused = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(refused.ok, false, 'a live contender mid-write was overruled');
  assert.strictEqual(refused.error, 'held');
  fs.unlinkSync(liveGarbage);

  const pid = absentPid();
  assert.ok(pid, 'could not find an absent pid to test with');
  const deadGarbage = plantTicket(dir, { pid, hex: 'f'.repeat(32), raw: '{ truncated' });
  const taken = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(taken.ok, true, 'a corrupt ticket from a dead contender deadlocked the lock');
  assert.strictEqual(fs.existsSync(deadGarbage), false);
  assert.strictEqual(taken.release(), true);
});

test('the lock directory is created under the data dir, creating it when absent', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-mk-')), 'nested');
  const l = lifecycle.acquireMutationLock(dir);
  assert.strictEqual(l.ok, true);
  assert.strictEqual(fs.existsSync(path.join(dir, lifecycle.LOCK_DIR)), true);
  assert.strictEqual(path.dirname(l.path), path.join(dir, lifecycle.LOCK_DIR));
  assert.strictEqual(l.release(), true);
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
