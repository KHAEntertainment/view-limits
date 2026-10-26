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
  validateRecipeOptions,
  httpsEndpointError,
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
  // #55: openai-compat now requires recipeOptions.path (declared shape).
  const m = { endpoint: 'https://api.example.com', model: 'gpt-x', recipe: 'openai-compat',
                account: 'team-a', profile: 'p1', region: 'us', recipeOptions: { path: '/v1/models' } };
  const r = validateMonitor({ id: 'custom-x', provider: 'openai-compat', monitor: m });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.monitor, m);
});

// #55 (QA M-R1): recipeOptions are validated against the recipe's declared
// shape. Before #55 any object was accepted (`{ foo: 'bar' }` passed).
test('recipeOptions matching the recipe declaration → ok', () => {
  const m = { endpoint: 'https://api.example.com', recipe: 'openai-compat', recipeOptions: { path: '/v1/models', scope: 'account' } };
  const r = validateMonitor({ id: 'x', provider: 'openai-compat', monitor: m });
  assert.strictEqual(r.ok, true);
});

test('recipeOptions with an undeclared key → rejected (M-R1)', () => {
  const m = { endpoint: 'https://api.example.com', recipe: 'openai-compat', recipeOptions: { path: '/v1/models', foo: 'bar' } };
  const r = validateMonitor({ id: 'x', provider: 'openai-compat', monitor: m });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /recipeOptions\.foo is not an option/);
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

test('ftp: (and other non-https) endpoint → rejected', () => {
  const r = validateMonitor({ id: 'x', monitor: { endpoint: 'ftp://api.example.com' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /https/);
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

console.log('Issue #113 — built-in region/endpoint refusals');

test('built-in kimi route with monitor.endpoint → refused with a stable code', () => {
  const r = validateMonitor({ id: 'kimi-code-plan', provider: 'kimi', monitor: { recipe: 'built-in', endpoint: 'https://api.example.com' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'built-in-endpoint-refused');
  assert.match(r.error, /endpoint is not allowed/);
});

test('built-in glm route with an unknown region → refused with a stable code', () => {
  const r = validateMonitor({ id: 'glm-coding-plan', provider: 'glm', monitor: { recipe: 'built-in', region: 'europe' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'unknown-region');
  assert.match(r.error, /"europe" is not one of: international, china/);
});

test('built-in region accepts case/whitespace variants of a known region', () => {
  const upper = validateMonitor({ id: 'kimi-code-plan', provider: 'kimi', monitor: { recipe: 'built-in', region: ' GLOBAL ' } });
  assert.strictEqual(upper.ok, true);
  const cased = validateMonitor({ id: 'kimi-code-plan', provider: 'kimi', monitor: { recipe: 'built-in', region: 'China' } });
  assert.strictEqual(cased.ok, true);
});

test('custom/compat route keeps its own endpoint and region (no built-in refusal)', () => {
  const r = validateMonitor({ id: 'custom-x', provider: 'kimi', monitor: { recipe: 'stepfun-plan', region: 'europe' } });
  assert.strictEqual(r.ok, true);
  const e = validateMonitor({ id: 'custom-y', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://api.example.com', region: 'us', recipeOptions: { path: '/v1/models' } } });
  assert.strictEqual(e.ok, true);
});

test('built-in region rules do not fire on a non-region built-in provider', () => {
  const r = validateMonitor({ id: 'minimax-token-plan', provider: 'minimax', monitor: { recipe: 'built-in', region: 'europe' } });
  assert.strictEqual(r.ok, true);
});

console.log('endpoint — https-only (F2)');

test('http: endpoint is rejected (https-only — F2)', () => {
  const r = validateMonitor({ id: 'x', monitor: { endpoint: 'http://api.example.com' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /https/);
});

test('https: endpoint → accepted', () => {
  const r = validateMonitor({ id: 'x', monitor: { endpoint: 'https://api.example.com', recipe: 'openai-compat', recipeOptions: { path: '/v1/models' } } });
  assert.strictEqual(r.ok, true);
});

console.log('monitor:null — normalized to absent at the boundary (F3)');

test('route.monitor = null → ok:true, monitor:null (consistent with absent)', () => {
  const r = validateMonitor({ id: 'kimi-code-plan', provider: 'kimi', monitor: null });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.monitor, null);
});

test('all four functions agree that monitor:null means no monitor', () => {
  const r = { id: 'custom-a', provider: 'openai-compat', monitor: null };
  // validateMonitor: ok:true
  assert.strictEqual(validateMonitor(r).ok, true);
  // poolIdentity: null
  assert.strictEqual(poolIdentity(r), null);
  // configRevision: still deterministic; differs from {monitor: undefined} only
  // when the structural fields differ. monitor=null and monitor=undefined
  // produce the same revision because normalizedMonitor skips both.
  const rUndef = { id: 'custom-a', provider: 'openai-compat' };
  assert.strictEqual(configRevision(r), configRevision(rUndef));
});

test('poolIdentity stays null on invalid-monitor branch', () => {
  // route.monitor = 'oops' is invalid — poolIdentity must still return null
  // so the resolver's invalid-monitor branch classifies consistently.
  assert.strictEqual(poolIdentity({ id: 'r', monitor: 'oops' }), null);
});

// #55 (QA M-R2): before #55 configRevision ignored ALL recipeOptions. Now
// only options a recipe declares revision-bearing are hashed; ephemeral ones
// still rotate without cache churn.
console.log('configRevision hashes revision-bearing recipeOptions only (M-R2)');

const compatRoute = (opts) => ({ id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a.example', recipe: 'openai-compat', recipeOptions: opts } });

test('configRevision is unchanged when only an ephemeral option rotates', () => {
  assert.strictEqual(
    configRevision(compatRoute({ path: '/v1/models', timeoutMs: 2000 })),
    configRevision(compatRoute({ path: '/v1/models', timeoutMs: 9000 })),
    'timeoutMs is ephemeral: rotation must not bump configRevision');
});

test('configRevision bumps when a revision-bearing option changes', () => {
  const base = configRevision(compatRoute({ path: '/v1/models' }));
  assert.notStrictEqual(base, configRevision(compatRoute({ path: '/v1/limits' })), 'path');
  assert.notStrictEqual(base, configRevision(compatRoute({ path: '/v1/models', scope: 'account' })), 'scope');
  assert.notStrictEqual(base, configRevision(compatRoute({ path: '/v1/models', resetEncoding: 'rfc3339' })), 'resetEncoding');
});

test('configRevision treats an omitted option and its explicit default alike', () => {
  assert.strictEqual(
    configRevision(compatRoute({ path: '/v1/models' })),
    configRevision(compatRoute({ path: '/v1/models', scope: 'diagnostic', resetEncoding: 'duration' })));
});

test('configRevision for a built-in route is unchanged by #55', () => {
  // Same hash input as #54: no recipeOptions key when nothing is revision-bearing.
  const route = { id: 'kimi-code-plan', provider: 'kimi', monitor: { recipe: 'built-in', account: 'a' } };
  const expected = require('crypto').createHash('sha1')
    .update(JSON.stringify({ id: 'kimi-code-plan', provider: 'kimi', monitor: { recipe: 'built-in', account: 'a' } }))
    .digest('hex');
  assert.strictEqual(configRevision(route), expected);
});

test('configRevision still bumps on structural field changes (sanity)', () => {
  const r1 = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat' } };
  const r2 = { id: 'custom-a', provider: 'openai-compat', monitor: { endpoint: 'https://a', recipe: 'openai-compat', region: 'us' } };
  assert.notStrictEqual(configRevision(r1), configRevision(r2));
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

console.log('validateRecipeOptions — credential-shaped names/values are non-persistable (M-R1)');

test('credential-shaped option names → rejected for known and unknown recipes', () => {
  for (const recipe of ['openai-compat', 'anthropic-compat', 'built-in', 'not-a-recipe']) {
    for (const name of ['token', 'apiKey', 'api_key', 'x-api-key', 'authHeader', 'sessionCookie', 'clientSecret', 'Password']) {
      const r = validateRecipeOptions(recipe, { [name]: 'v' });
      assert.strictEqual(r.ok, false, `${recipe}.${name}`);
      assert.match(r.error, /credential-shaped/, `${recipe}.${name}`);
    }
  }
});

test('credential-shaped option values → rejected', () => {
  for (const v of ['sk-abcdef1234567890', 'sk_live_abcdef123', 'Bearer abc', 'basic dXNlcjpwYXNz', 'eyJhbGciOi.eyJzdWIiOi.sig', 'ghp_abcdefgh', 'AKIAABCDEFGHIJKL']) {
    const r = validateRecipeOptions('not-a-recipe', { label: v });
    assert.strictEqual(r.ok, false, v);
    assert.match(r.error, /credential-shaped value/, v);
  }
});

test('nested option values → rejected (flat primitives only)', () => {
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: '/v1', scope: { x: 1 } }).ok, false);
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: ['/v1'] }).ok, false);
});

test('path must be absolute, query-free, traversal-free and secret-free', () => {
  for (const p of ['v1/models', '//evil.example/x', '/v1/../admin', '/v1/./x', '/v1?api_key=1', '/v1#frag', '/v1 models', '/v1/sk-abcdef1234567890', 'https://x/y']) {
    assert.strictEqual(validateRecipeOptions('openai-compat', { path: p }).ok, false, p);
  }
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: '/api/v1/models' }).ok, true);
});

// F-1: the previous {6,} floor let short `sk-` fragments slip past
// `looksLikeSecretValue` and through `pathError`, so a 3-char fragment inside
// `recipeOptions.path` would have been written to config.json. After the
// relaxation, a synthetic fragment is rejected just like a realistic key.
test('path with a short sk- fragment is rejected (F-1)', () => {
  const r = validateMonitor({
    id: 'r', provider: 'openai-compat',
    monitor: { endpoint: 'https://oa.example.com', recipe: 'openai-compat', recipeOptions: { path: '/v1/sk-AAA/models' } },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /credential-shaped segment|credential-shaped value/);
});

test('declared shape: required path, enum values, integer bounds', () => {
  assert.match(validateRecipeOptions('openai-compat', {}).error, /path is required/);
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: '/m', scope: 'everything' }).ok, false);
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: '/m', resetEncoding: 'epoch-ms' }).ok, false);
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: '/m', timeoutMs: 999 }).ok, false);
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: '/m', timeoutMs: 15001 }).ok, false);
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: '/m', timeoutMs: 1500.5 }).ok, false);
  assert.strictEqual(validateRecipeOptions('openai-compat', { path: '/m', timeoutMs: 15000 }).ok, true);
});

test('anthropicVersion outside the documented enum → stable unsupported-anthropic-version code', () => {
  const r = validateRecipeOptions('anthropic-compat', { path: '/v1/models', anthropicVersion: '2099-01-01' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'unsupported-anthropic-version');
  assert.strictEqual(validateRecipeOptions('anthropic-compat', { path: '/v1/models', anthropicVersion: '2023-06-01' }).ok, true);
});

test('built-in declares no options → any recipeOptions key rejected', () => {
  assert.strictEqual(validateRecipeOptions('built-in', { path: '/x' }).ok, false);
  assert.strictEqual(validateRecipeOptions('built-in', {}).ok, true);
});

test('validateMonitor surfaces recipeOptions failures (setup writer cannot persist them)', () => {
  const r = validateMonitor({ id: 'x', provider: 'openai-compat', monitor: { endpoint: 'https://a.example', recipe: 'openai-compat', recipeOptions: { path: '/m', token: 'x' } } });
  assert.strictEqual(r.ok, false);
});

test('httpsEndpointError is the single URL policy (http, creds, garbage)', () => {
  assert.strictEqual(httpsEndpointError('https://api.example.com/v1'), null);
  assert.strictEqual(httpsEndpointError('http://api.example.com'), 'must be https');
  assert.strictEqual(httpsEndpointError('https://u:p@api.example.com'), 'must not embed credentials');
  assert.strictEqual(httpsEndpointError('not a url'), 'is not a valid URL');
  assert.strictEqual(httpsEndpointError(''), 'must be a non-empty string');
});

// CR-1: align monitor endpoint validation with the sourceUrl policy. A user
// cannot smuggle a key via `?api_key=…` or pin a stale fragment for a future
// relay to interpret; the validator refuses both shapes up-front so they
// never reach the bounded transport.
test('httpsEndpointError rejects a query string (CR-1)', () => {
  assert.strictEqual(
    httpsEndpointError('https://api.example.com/v1/models?key=value'),
    'must not contain a query string');
});

test('httpsEndpointError rejects a fragment (CR-1)', () => {
  assert.strictEqual(
    httpsEndpointError('https://api.example.com/v1/models#frag'),
    'must not contain a fragment');
});

test('httpsEndpointError accepts a clean https URL (CR-1 regression)', () => {
  assert.strictEqual(
    httpsEndpointError('https://api.example.com/v1/models'),
    null);
});

test('httpsEndpointError credential check still wins over query (CR-1 regression)', () => {
  // Both checks would fire; the credentials one surfaces first so callers
  // get the more actionable reason.
  assert.strictEqual(
    httpsEndpointError('https://user:pass@api.example.com/v1/models'),
    'must not embed credentials');
});

if (failures) {
  console.error(`\n${failures} monitor-schema test(s) failed`);
  process.exit(1);
}
console.log('all monitor-schema tests passed');