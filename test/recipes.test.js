'use strict';
// Tests for lib/recipes — the fixed read-only recipe registry. Only
// `built-in` is registered today; future Phase 2 recipes (#55, #56, #57)
// register their own. The registry must be safe to enumerate, immutable,
// and the built-in pass-through must mirror the existing wire-family
// adapter contract.

const assert = require('assert');
const { RECIPES, getRecipe, knownRecipes, routeNeedsVaultCredential } = require('../lib/recipes');

// Async-aware runner: collects tests then awaits each Promise-returning fn
// so a rejected async assert becomes a counted failure (not an unhandled
// crash that would have falsely printed ✓). Same pattern as
// test/effective-config.test.js:22-32.
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

console.log('registry shape + immutability');

// #55 registers openai-compat + anthropic-compat; #56 registers
// alibaba-coding-plan; #57 registers the documentation-based unmonitored
// stepfun-plan recipe (was: only `built-in`). The registry must be safe to
// enumerate, immutable, and the built-in pass-through must mirror the existing
// wire-family adapter contract.
test('registry holds built-in + the two #55 compat recipes + #56 alibaba + stepfun-plan', () => {
  assert.deepStrictEqual([...knownRecipes()].sort(),
    ['alibaba-coding-plan', 'anthropic-compat', 'built-in', 'openai-compat', 'stepfun-plan']);
});

test('compat recipes declare family, options and inference:false', () => {
  for (const id of ['openai-compat', 'anthropic-compat']) {
    const r = getRecipe(id);
    assert.strictEqual(r.family, id);
    assert.strictEqual(r.capabilities.inference, false);
    assert.strictEqual(r.capabilities.signal, 'throughput');
    assert.ok(r.options && r.options.path && r.options.path.required, `${id} path required`);
    assert.strictEqual(typeof r.fetch, 'function');
  }
});

test('alibaba-coding-plan declares a null family so the family check is skipped', () => {
  const r = getRecipe('alibaba-coding-plan');
  assert.strictEqual(r.family, null, 'no wire family: the CLI owns its own auth');
  assert.strictEqual(r.capabilities.signal, 'quota');
  assert.strictEqual(r.capabilities.credential, 'cli-managed-auth');
  assert.strictEqual(r.capabilities.inference, false);
  assert.ok(r.options && r.options.site && r.options.binary && r.options.timeoutMs, 'declares its options');
  assert.strictEqual(typeof r.fetch, 'function');
});

test('every recipe declares whether it needs a vault credential', () => {
  for (const id of knownRecipes()) {
    assert.strictEqual(
      typeof getRecipe(id).capabilities.vaultCredential, 'boolean',
      `${id} must declare vaultCredential`,
    );
  }
  // Only the CLI-managed-auth and local-only-unmonitored recipes opt out;
  // every other recipe keeps the pre-#56 behaviour of requiring a credential
  // under route.id.
  assert.strictEqual(getRecipe('alibaba-coding-plan').capabilities.vaultCredential, false);
  assert.strictEqual(getRecipe('stepfun-plan').capabilities.vaultCredential, false);
  for (const id of ['built-in', 'openai-compat', 'anthropic-compat']) {
    assert.strictEqual(getRecipe(id).capabilities.vaultCredential, true, id);
  }
});

test('routeNeedsVaultCredential is capability-driven, not id-driven', () => {
  assert.strictEqual(routeNeedsVaultCredential({ monitor: { recipe: 'alibaba-coding-plan' } }), false);
  // #57: the unmonitored recipe also declares vaultCredential:false, so the
  // same capability-driven predicate exempts it without naming the id.
  assert.strictEqual(routeNeedsVaultCredential({ monitor: { recipe: 'stepfun-plan' } }), false);
  // Anything that is not an explicitly-flagged registered recipe still needs a
  // credential — including a future id nobody has implemented yet.
  for (const recipe of ['openai-compat', 'anthropic-compat', 'built-in', 'stepfun-pending', undefined]) {
    assert.strictEqual(routeNeedsVaultCredential({ monitor: { recipe } }), true, String(recipe));
  }
  assert.strictEqual(routeNeedsVaultCredential({}), true, 'no monitor');
  assert.strictEqual(routeNeedsVaultCredential(null), true, 'not a route');
  assert.strictEqual(routeNeedsVaultCredential({ monitor: 'nope' }), true, 'monitor is not an object');
});

test('getRecipe ignores prototype keys', () => {
  assert.strictEqual(getRecipe('toString'), null);
  assert.strictEqual(getRecipe('__proto__'), null);
});

test('RECIPES is frozen (no late additions)', () => {
  assert.ok(Object.isFrozen(RECIPES));
});

test('every recipe object is frozen', () => {
  for (const r of Object.values(RECIPES)) {
    assert.ok(Object.isFrozen(r), `recipe "${r.id}" should be frozen`);
    assert.ok(Object.isFrozen(r.capabilities), `recipe "${r.id}" capabilities should be frozen`);
  }
});

test('getRecipe returns null for unknown ids, never throws', () => {
  assert.strictEqual(getRecipe('nope'), null);
  assert.strictEqual(getRecipe(null), null);
  assert.strictEqual(getRecipe(undefined), null);
  assert.strictEqual(getRecipe(''), null);
  assert.strictEqual(getRecipe(5), null);
  assert.strictEqual(getRecipe([]), null);
});

test('getRecipe returns the built-in recipe', () => {
  const r = getRecipe('built-in');
  assert.ok(r);
  assert.strictEqual(r.id, 'built-in');
  assert.strictEqual(typeof r.fetch, 'function');
  assert.strictEqual(r.kind, 'adapter');
  assert.strictEqual(r.capabilities.monitorable, true);
});

console.log('built-in fetch — pass-through to wire-family adapter');

test('built-in fetch delegates cfg.adapter.fetchStatus(cfg.providerCfg, token, ctx)', async () => {
  const recipe = getRecipe('built-in');
  const calls = [];
  const fakeAdapter = {
    fetchStatus: async (providerCfg, token, ctx) => {
      calls.push({ providerCfg, token, ctx });
      return { state: 'healthy', windows: [], balance: null, resetAt: null, detail: null };
    },
  };
  const providerCfg = { baseUrl: 'https://api.example.com' };
  const cfg = { adapter: fakeAdapter, providerCfg };
  const result = await recipe.fetch(cfg, 'token-x', { threshold: 0.2 });
  assert.strictEqual(result.state, 'healthy');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].providerCfg, providerCfg);
  assert.strictEqual(calls[0].token, 'token-x');
  assert.deepStrictEqual(calls[0].ctx, { threshold: 0.2 });
});

test('built-in fetch returns monitorable:false unknown when adapter is missing', async () => {
  const recipe = getRecipe('built-in');
  const result = await recipe.fetch({}, 'token', {});
  assert.strictEqual(result.state, 'unknown');
  assert.strictEqual(result.detail && result.detail.monitorable, false);
  assert.match(result.detail && result.detail.reason || '', /built-in-recipe-missing-adapter/);
});

test('knownRecipes() returns a fresh Set (no registry mutation possible)', () => {
  const a = knownRecipes();
  a.add('should-not-persist');
  const b = knownRecipes();
  assert.ok(!b.has('should-not-persist'));
});

runTests().then(() => {
  if (failures) {
    console.error(`\n${failures} recipes test(s) failed`);
    process.exit(1);
  }
  console.log('all recipes tests passed');
});