'use strict';
// Pure-function tests for lib/monitor-schema.js — the route.monitor validation,
// label/slug collision guard, pool-identity dedup and configRevision. These
// functions are total and pure (no FS, no clock) so the tests exercise every
// branch directly.

const assert = require('assert');
const {
  validateMonitor,
  validateLabel,
  configRevision,
  poolIdentity,
  classifyCapability,
  ALLOWED_MONITOR_FIELDS,
  SECRET_FIELD_NAMES,
} = require('../lib/monitor-schema');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('validateMonitor — accept / reject');

test('absent monitor → ok:true, monitor:null', () => {
  const r = validateMonitor({ id: 'kimi-code-plan', provider: 'kimi' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.monitor, null);
});

test('well-formed monitor → ok:true, monitor shape preserved', () => {
  const m = { endpoint: 'https://api.example.com', model: 'gpt-x', recipe: 'openai-compat',
                account: 'team-a', profile: 'p1', region: 'us' };
  const r = validateMonitor({ id: 'custom-x', provider: 'openai-compat', monitor: m });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.monitor, m);
});

test('recipeOptions allowed object → ok', () => {
  const m = { endpoint: 'https://api.example.com', recipe: 'openai-compat', recipeOptions: { foo: 'bar' } };
  const r = validateMonitor({ id: 'x', provider: 'openai-compat', monitor: m });
  assert.strictEqual(r.ok, true);
});

test('non-object route → ok:false', () => {
  assert.strictEqual(validateMonitor(null).ok, false);
  assert.strictEqual(validateMonitor('route').ok, false);
  assert.strictEqual(validateMonitor([]).ok, false);
});

test('non-object monitor → ok:false', () => {
  assert.strictEqual(validateMonitor({ monitor: 'oops' }).ok, false);
  assert.strictEqual(validateMonitor({ monitor: [] }).ok, false);
  assert.strictEqual(validateMonitor({ monitor: 5 }).ok, false);
});

test('unknown field → ok:false with field name in error', () => {
  const r = validateMonitor({ id: 'x', monitor: { unexpected: 1 } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unexpected/);
});

test('every credential-shaped field name is rejected as a reserved secret', () => {
  for (const name of SECRET_FIELD_NAMES) {
    const r = validateMonitor({ id: 'x', monitor: { [name]: 'secret-value' } });
    assert.strictEqual(r.ok, false, `expected ${name} to be rejected`);
    assert.match(r.error, /reserved secret/);
  }
});

test('ALLOWED_MONITOR_FIELDS is the structural allow-list (no credentials)', () => {
  for (const name of SECRET_FIELD_NAMES) {
    assert.ok(!ALLOWED_MONITOR_FIELDS.includes(name), `${name} must not be in ALLOWED_MONITOR_FIELDS`);
  }
});

test('endpoint with embedded credentials → rejected', () => {
  const r = validateMonitor({ id: 'x', monitor: { endpoint: 'https://user:pass@api.example.com' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /credentials/);
});

test('non-http(s) endpoint → rejected', () => {
  const r = validateMonitor({ id: 'x', monitor: { endpoint: 'ftp://api.example.com' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /http\(s\)/);
});

test('malformed endpoint URL → rejected', () => {
  const r = validateMonitor({ id: 'x', monitor: { endpoint: 'not a url' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /URL/);
});

test('empty endpoint → rejected', () => {
  assert.strictEqual(validateMonitor({ id: 'x', monitor: { endpoint: '' } }).ok, false);
});

test('non-string model → rejected', () => {
  assert.strictEqual(validateMonitor({ id: 'x', monitor: { model: 5 } }).ok, false);
});

test('non-string recipe → rejected', () => {
  assert.strictEqual(validateMonitor({ id: 'x', monitor: { recipe: 5 } }).ok, false);
});

test('non-string account/profile/region → rejected', () => {
  for (const k of ['account', 'profile', 'region']) {
    assert.strictEqual(validateMonitor({ id: 'x', monitor: { [k]: 5 } }).ok, false);
    assert.strictEqual(validateMonitor({ id: 'x', monitor: { [k]: '' } }).ok, false);
  }
});

test('non-object recipeOptions → rejected', () => {
  assert.strictEqual(validateMonitor({ id: 'x', monitor: { recipeOptions: 'nope' } }).ok, false);
  assert.strictEqual(validateMonitor({ id: 'x', monitor: { recipeOptions: [] } }).ok, false);
});

console.log('validateLabel — accept / collision-reject');

test('slug-regex label → slug', () => {
  const r = validateLabel('my-team');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.slug, 'my-team');
});

test('underscores and dots in label are normalized to dashes in the slug', () => {
  const r = validateLabel('team.alpha_beta-1');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.slug, 'team-alpha-beta-1');
});

test('mixed-case is lowercased', () => {
  assert.strictEqual(validateLabel('MyTeam').slug, 'myteam');
});

test('leading/trailing space is trimmed', () => {
  assert.strictEqual(validateLabel('  my-team  ').slug, 'my-team');
});

test('empty / non-string → rejected', () => {
  assert.strictEqual(validateLabel('').ok, false);
  assert.strictEqual(validateLabel('   ').ok, false);
  assert.strictEqual(validateLabel(null).ok, false);
  assert.strictEqual(validateLabel(7).ok, false);
});

test('oversized label → rejected', () => {
  const long = 'a'.repeat(70);
  assert.strictEqual(validateLabel(long).ok, false);
});

test('leading or trailing dot/dash/underscore → rejected', () => {
  for (const bad of ['.team', '-team', '_team', 'team.', 'team-', 'team_']) {
    assert.strictEqual(validateLabel(bad).ok, false, `expected reject: ${bad}`);
  }
});

test('character classes outside [A-Za-z0-9._-] → rejected', () => {
  for (const bad of ['team@a', 'team/b', 'team*b', 'team!b', 'team$1']) {
    assert.strictEqual(validateLabel(bad).ok, false, `expected reject: ${bad}`);
  }
});

test('reserved family prefixes are collision-rejected', () => {
  for (const prefix of ['minimax-', 'kimi-', 'glm-', 'openrouter-', 'xiaomi-', 'alibaba-', 'stepfun-', 'openai-compat-', 'anthropic-compat-']) {
    assert.strictEqual(validateLabel(prefix + 'team').ok, false, `expected reject for ${prefix}`);
  }
});

test('identical labels produce identical slugs (collision check is a setup-time comparison)', () => {
  const c = validateLabel('my-team');
  const d = validateLabel('my-team');
  assert.strictEqual(c.slug, d.slug, 'identical labels must produce identical slugs');
});

test('different labels produce different slugs when characters differ', () => {
  const a = validateLabel('my-team');
  const b = validateLabel('myteam');
  assert.strictEqual(a.ok, true);
  assert.strictEqual(b.ok, true);
  assert.notStrictEqual(a.slug, b.slug);
});

console.log('configRevision — deterministic, sensitive, secret-free');

test('configRevision is deterministic for the same route', () => {
  const route = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat', region: 'us' } };
  assert.strictEqual(configRevision(route), configRevision(route));
});

test('configRevision differs when route.id differs', () => {
  const a = { id: 'r-a', provider: 'kimi', monitor: null };
  const b = { id: 'r-b', provider: 'kimi', monitor: null };
  assert.notStrictEqual(configRevision(a), configRevision(b));
});

test('configRevision differs when route.provider differs', () => {
  const a = { id: 'r', provider: 'kimi', monitor: null };
  const b = { id: 'r', provider: 'glm', monitor: null };
  assert.notStrictEqual(configRevision(a), configRevision(b));
});

test('configRevision differs when monitor changes', () => {
  const base = { id: 'r', provider: 'openai-compat' };
  const r1 = Object.assign({}, base, { monitor: { endpoint: 'https://a', recipe: 'openai-compat' } });
  const r2 = Object.assign({}, base, { monitor: { endpoint: 'https://b', recipe: 'openai-compat' } });
  assert.notStrictEqual(configRevision(r1), configRevision(r2));
});

test('configRevision is stable across JSON key insertion order', () => {
  const r1 = { id: 'r', provider: 'openai-compat', monitor: { endpoint: 'https://a', model: 'gpt', recipe: 'openai-compat' } };
  const r2 = { id: 'r', provider: 'openai-compat', monitor: { recipe: 'openai-compat', model: 'gpt', endpoint: 'https://a' } };
  assert.strictEqual(configRevision(r1), configRevision(r2));
});

test('configRevision ignores non-allow-listed fields (defense-in-depth)', () => {
  // Even if a secret-shaped key somehow slipped through, the normalization
  // strips it before hashing.
  const r1 = { id: 'r', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat' } };
  const r2 = { id: 'r', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat', token: 'SECRET' } };
  assert.strictEqual(configRevision(r1), configRevision(r2));
});

console.log('poolIdentity — recipe+account+profile+region identity, model excluded');

test('poolIdentity is null when route has no monitor', () => {
  assert.strictEqual(poolIdentity({ id: 'r', provider: 'kimi' }), null);
});

test('poolIdentity is null when monitor has no recipe', () => {
  assert.strictEqual(poolIdentity({ id: 'r', monitor: { endpoint: 'https://a' } }), null);
});

test('two routes with same recipe+account+profile+region → same poolIdentity', () => {
  const a = { id: 'route-a', monitor: { recipe: 'openai-compat', account: 'team-a', region: 'us' } };
  const b = { id: 'route-b', monitor: { recipe: 'openai-compat', account: 'team-a', region: 'us' } };
  assert.strictEqual(poolIdentity(a), poolIdentity(b));
});

test('different account → different poolIdentity (AC1 cross-account isolation)', () => {
  const a = { id: 'r', monitor: { recipe: 'openai-compat', account: 'team-a', region: 'us' } };
  const b = { id: 'r', monitor: { recipe: 'openai-compat', account: 'team-b', region: 'us' } };
  assert.notStrictEqual(poolIdentity(a), poolIdentity(b));
});

test('different region → different poolIdentity', () => {
  const a = { id: 'r', monitor: { recipe: 'openai-compat', account: 'team-a', region: 'us' } };
  const b = { id: 'r', monitor: { recipe: 'openai-compat', account: 'team-a', region: 'eu' } };
  assert.notStrictEqual(poolIdentity(a), poolIdentity(b));
});

test('model alone does NOT prove two routes share a pool (design rule)', () => {
  const a = { id: 'r', monitor: { recipe: 'openai-compat', account: 'team-a', model: 'gpt-x' } };
  const b = { id: 'r', monitor: { recipe: 'openai-compat', account: 'team-b', model: 'gpt-x' } };
  assert.notStrictEqual(poolIdentity(a), poolIdentity(b));
});

test('built-in routes have no synthetic pool identity', () => {
  assert.strictEqual(poolIdentity({ id: 'kimi-code-plan', provider: 'kimi', monitor: null }), null);
});

console.log('classifyCapability — stable reasons');

test('absent monitor → monitorable built-in-adapter', () => {
  assert.deepStrictEqual(classifyCapability(null, new Set(['built-in', 'openai-compat'])),
    { monitorable: true, reason: 'built-in-adapter' });
});

test('monitor without recipe → not monitorable, monitor-recipe-required', () => {
  assert.deepStrictEqual(classifyCapability({ endpoint: 'https://a' }, new Set(['built-in'])),
    { monitorable: false, reason: 'monitor-recipe-required' });
});

test('unknown recipe → not monitorable, unsupported-recipe:<id>', () => {
  assert.deepStrictEqual(classifyCapability({ recipe: 'mystery-recipe' }, new Set(['built-in'])),
    { monitorable: false, reason: 'unsupported-recipe:mystery-recipe' });
});

test('known recipe → monitorable, recipe:<id>', () => {
  assert.deepStrictEqual(classifyCapability({ recipe: 'built-in' }, new Set(['built-in'])),
    { monitorable: true, reason: 'recipe:built-in' });
});

test('non-Set registry → invalid-known-recipes (defensive)', () => {
  assert.deepStrictEqual(classifyCapability({ recipe: 'openai-compat' }, null),
    { monitorable: false, reason: 'invalid-known-recipes' });
  assert.deepStrictEqual(classifyCapability({ recipe: 'openai-compat' }, ['built-in']),
    { monitorable: false, reason: 'invalid-known-recipes' });
});

if (failures) {
  console.error(`\n${failures} monitor-schema test(s) failed`);
  process.exit(1);
}
console.log('all monitor-schema tests passed');