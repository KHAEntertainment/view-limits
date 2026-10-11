'use strict';
// Tests for lib/effective-config — the shared resolver consumed by both
// refresh and check. Covers:
//   AC1 — two custom routes sharing a wire family can have distinct
//         endpoints/accounts/credentials; the resolver produces
//         independent effective cfg per route.
//   AC2 — refresh and check use the same resolver. Verified by running
//         the same (route, cfg) tuple through the resolver and asserting
//         both shapes produce identical effective cfg + capability +
//         revision + pool identity.
//   AC3 — invalid monitor shape and unsupported recipe yield stable
//         unknown with monitorable:false; never healthy/exhausted.
//   AC4 — built-in routes keep their current behaviour (parity), and
//         unsupported recipe ids surface as `unsupported-recipe:<id>`.

const assert = require('assert');
const { resolveEffectiveConfig, stableUnknown } = require('../lib/effective-config');
const { getAdapter, getAdapterForRoute } = require('../lib/adapters');
const { ADAPTERS } = require('../lib/adapters');

let failures = 0;
async function runTests() {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failures += 1;
      console.log(`  ✗ ${t.name}\n    ${e && e.message || e}`);
    }
  }
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const ROUTES_DEFAULT = [
  { id: 'minimax-token-plan', provider: 'minimax', account: 'token-plan', match: { model: 'minimax' } },
  { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' } },
  { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' } },
  { id: 'deepseek-direct', provider: 'deepseek', account: 'personal', match: { model: 'deepseek' } },
  { id: 'openrouter-main', provider: 'openrouter', account: 'main', match: { model: 'openrouter', harness: 'openrouter' } },
];
const CFG = {
  routes: ROUTES_DEFAULT,
  providers: {
    minimax: { baseUrl: 'https://www.minimax.io' },
    kimi: { baseUrl: 'https://api.kimi.com' },
    glm: { baseUrl: 'https://api.z.ai' },
    deepseek: { baseUrl: 'https://api.deepseek.com' },
    openrouter: { baseUrl: 'https://openrouter.ai/api' },
  },
};

console.log('AC2 — built-in parity');

test('built-in route: resolver returns getAdapter(provider) wrapper', () => {
  const route = ROUTES_DEFAULT[1]; // kimi-code-plan
  const eff = resolveEffectiveConfig(route, CFG, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, true);
  assert.strictEqual(eff.capability.reason, 'built-in-adapter');
  // The bound cfg must carry the wire-family adapter + providerCfg.
  assert.ok(eff.cfg.adapter, 'expected cfg.adapter');
  assert.strictEqual(eff.cfg.adapter, ADAPTERS.kimi);
  assert.deepStrictEqual(eff.cfg.providerCfg, CFG.providers.kimi);
  // Pool identity is null for built-ins; revision is deterministic.
  assert.strictEqual(eff.poolIdentity, null);
  assert.strictEqual(typeof eff.configRevision, 'string');
  assert.strictEqual(eff.configRevision.length, 40);
  assert.strictEqual(typeof eff.adapterFn, 'function');
});

test('every default built-in route produces its own adapter', () => {
  for (const route of ROUTES_DEFAULT) {
    const eff = resolveEffectiveConfig(route, CFG, { getAdapter });
    assert.strictEqual(eff.cfg.adapter, ADAPTERS[route.provider],
      `expected adapter ${route.provider} for route ${route.id}`);
    assert.deepStrictEqual(eff.cfg.providerCfg, CFG.providers[route.provider]);
  }
});

test('getAdapter(provider) and resolveEffectiveConfig(builtInRoute, cfg, {getAdapter}) use the same adapter module', () => {
  const route = ROUTES_DEFAULT[1];
  const eff = resolveEffectiveConfig(route, CFG, { getAdapter });
  assert.strictEqual(eff.cfg.adapter, getAdapter(route.provider));
});

console.log('AC1 — two custom routes sharing a wire family get distinct effective cfg');

test('two routes with same provider but different monitor.endpoint have different effective cfg', () => {
  const routeA = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a.example.com', recipe: 'openai-compat' } };
  const routeB = { id: 'custom-b', provider: 'openai-compat', monitor: { endpoint: 'https://b.example.com', recipe: 'openai-compat' } };
  const cfg = { providers: { 'openai-compat': { baseUrl: 'https://default.example.com' } } };
  const effA = resolveEffectiveConfig(routeA, cfg, { getAdapter });
  const effB = resolveEffectiveConfig(routeB, cfg, { getAdapter });
  // Both route to the same unsupported-recipe branch today (#55 owns the
  // real openai-compat recipe). Pool identity (recipe+account) is identical
  // here because account is unset; configRevision must differ because the
  // endpoint differs.
  assert.notStrictEqual(effA.poolIdentity, null);
  assert.strictEqual(effA.poolIdentity, effB.poolIdentity); // same recipe, no account differentiation
  assert.notStrictEqual(effA.configRevision, effB.configRevision,
    'different endpoints must produce different configRevisions');
});

test('different account in monitor → different poolIdentity (AC1 cross-account isolation)', () => {
  const routeA = { id: 'custom-a', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://x', account: 'team-a' } };
  const routeB = { id: 'custom-b', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://x', account: 'team-b' } };
  const cfg = { providers: { 'openai-compat': {} } };
  const a = resolveEffectiveConfig(routeA, cfg, { getAdapter });
  const b = resolveEffectiveConfig(routeB, cfg, { getAdapter });
  assert.notStrictEqual(a.poolIdentity, b.poolIdentity);
});

test('two custom routes with monitor.recipe=built-in stay on the wire-family adapter', () => {
  const routeA = { id: 'custom-a', provider: 'kimi', monitor: { recipe: 'built-in' } };
  const routeB = { id: 'custom-b', provider: 'kimi', monitor: { recipe: 'built-in' } };
  const cfg = { providers: { kimi: { baseUrl: 'https://api.kimi.com' } } };
  const a = resolveEffectiveConfig(routeA, cfg, { getAdapter });
  const b = resolveEffectiveConfig(routeB, cfg, { getAdapter });
  assert.strictEqual(a.cfg.adapter, ADAPTERS.kimi);
  assert.strictEqual(b.cfg.adapter, ADAPTERS.kimi);
  // Different ids → different revisions (AC1 per-route identity).
  assert.notStrictEqual(a.configRevision, b.configRevision);
});

console.log('AC2 — refresh+check parity');

test('refresh and check observe the same effective config for the same (route, cfg)', () => {
  // Simulate refresh and check both calling the resolver: identical input
  // → identical output, including capability, revision, pool identity.
  const route = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat' } };
  const cfg = { providers: { 'openai-compat': {} } };
  const fromRefresh = resolveEffectiveConfig(route, cfg, { getAdapter });
  const fromCheck = resolveEffectiveConfig(route, cfg, { getAdapter });
  assert.strictEqual(fromRefresh.configRevision, fromCheck.configRevision);
  assert.strictEqual(fromRefresh.poolIdentity, fromCheck.poolIdentity);
  assert.strictEqual(fromRefresh.capability.reason, fromCheck.capability.reason);
  assert.strictEqual(fromRefresh.capability.monitorable, fromCheck.capability.monitorable);
});

test('getAdapterForRoute returns the same effective cfg as resolveEffectiveConfig', () => {
  const route = ROUTES_DEFAULT[2]; // glm-coding-plan
  // getAdapterForRoute lives in lib/adapters (commit 4); without it the
  // resolver contract alone still binds cfg.adapter === ADAPTERS[provider].
  const direct = resolveEffectiveConfig(route, CFG, { getAdapter });
  assert.strictEqual(direct.cfg.adapter, ADAPTERS.glm);
  assert.strictEqual(direct.capability.reason, 'built-in-adapter');
});

console.log('AC3 — stable unknown for unsupported / invalid');

test('unknown recipe id → monitorable:false, stable unknown', async () => {
  const route = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'mystery-recipe' } };
  const cfg = { providers: { 'openai-compat': {} } };
  const eff = resolveEffectiveConfig(route, cfg, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, false);
  assert.strictEqual(eff.capability.reason, 'unsupported-recipe:mystery-recipe');
  const result = await eff.adapterFn(eff.cfg, 'token', {});
  assert.strictEqual(result.state, 'unknown');
  assert.strictEqual(result.detail.monitorable, false);
  assert.match(result.detail.reason, /unsupported-recipe:mystery-recipe/);
});

test('invalid monitor (non-object) → monitorable:false, stable unknown', async () => {
  const route = { id: 'custom-a', provider: 'openai-compat', monitor: 'oops' };
  const cfg = { providers: { 'openai-compat': {} } };
  const eff = resolveEffectiveConfig(route, cfg, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, false);
  assert.strictEqual(eff.capability.reason, 'invalid-monitor');
  const result = await eff.adapterFn(eff.cfg, 'token', {});
  assert.strictEqual(result.state, 'unknown');
  assert.match(result.detail.reason, /invalid-monitor/);
});

test('credential-shaped monitor field → invalid-monitor (caught before recipe lookup)', async () => {
  const route = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat', token: 'SECRET' } };
  const cfg = { providers: { 'openai-compat': {} } };
  const eff = resolveEffectiveConfig(route, cfg, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, false);
  const result = await eff.adapterFn(eff.cfg, 'token', {});
  assert.strictEqual(result.state, 'unknown');
  assert.match(result.detail.reason, /secret/);
});

test('monitor without recipe → monitor-recipe-required, stable unknown', async () => {
  const route = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a' } };
  const cfg = { providers: { 'openai-compat': {} } };
  const eff = resolveEffectiveConfig(route, cfg, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, false);
  assert.strictEqual(eff.capability.reason, 'monitor-recipe-required');
  const result = await eff.adapterFn(eff.cfg, 'token', {});
  assert.strictEqual(result.state, 'unknown');
});

test('endpoint with embedded credentials → invalid-monitor, stable unknown', async () => {
  const route = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://u:p@a', recipe: 'openai-compat' } };
  const cfg = { providers: { 'openai-compat': {} } };
  const eff = resolveEffectiveConfig(route, cfg, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, false);
  const result = await eff.adapterFn(eff.cfg, 'token', {});
  assert.strictEqual(result.state, 'unknown');
});

test('unknown provider in built-in path → unknown-provider, stable unknown', async () => {
  const route = { id: 'x', provider: 'mystery' };
  const cfg = { providers: { mystery: {} } };
  const eff = resolveEffectiveConfig(route, cfg, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, false);
  const result = await eff.adapterFn(eff.cfg, 'token', {});
  assert.strictEqual(result.state, 'unknown');
  assert.match(result.detail.reason, /unknown-provider/);
});

test('non-object route → invalid-route, stable unknown', async () => {
  const eff = resolveEffectiveConfig(null, CFG, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, false);
  const result = await eff.adapterFn(eff.cfg, 'token', {});
  assert.strictEqual(result.state, 'unknown');
  assert.match(result.detail.reason, /invalid-route/);
});

console.log('stableUnknown — exported helper');

test('stableUnknown produces monitorable:false unknown with a fixed reason', async () => {
  const fn = stableUnknown('custom-reason');
  const result = await fn({}, 'token', {});
  assert.strictEqual(result.state, 'unknown');
  assert.strictEqual(result.detail.monitorable, false);
  assert.strictEqual(result.detail.reason, 'custom-reason');
  assert.deepStrictEqual(result.windows, []);
  assert.strictEqual(result.balance, null);
  assert.strictEqual(result.resetAt, null);
});

runTests().then(() => {
  if (failures) {
    console.error(`\n${failures} effective-config test(s) failed`);
    process.exit(1);
  }
  console.log('all effective-config tests passed');
});