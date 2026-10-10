'use strict';
// Unit coverage for lib/view-model.js — the transport-neutral rendering layer
// that bin/vl.js now consumes for `vl report`. Asserts both the structured
// view object (the contract for future JSON / HTML consumers) and the
// pre-formatted text lines (the byte-identical contract for the existing CLI
// text). No network, no I/O: every input is a hand-built snapshot.

const assert = require('assert');
const vm = require('../lib/view-model');

function fact(value, provenance = 'observed', extra = {}) {
  return { value, provenance, source: extra.source || 'test', observedAt: extra.observedAt || null, freshUntil: extra.freshUntil || null, reason: extra.reason || null };
}

function observed(value, extra = {}) { return fact(value, 'observed', extra); }
function configured(value, extra = {}) { return fact(value, 'configured', extra); }
function unknown(reason = 'absent') { return { value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason }; }

function line(text) { return text; }

// ---- primitive helpers --------------------------------------------------------

// sub-cent money uses the "<0.01" sentinel
assert.strictEqual(vm.formatMoney(0.004, 'USD'), '<0.01 USD');
assert.strictEqual(vm.formatMoney(0.01, 'USD'), '0.01 USD');
assert.strictEqual(vm.formatMoney(0, 'USD'), '0.00 USD');
assert.strictEqual(vm.formatMoney(-0.005, 'USD'), '-0.0050 USD');
assert.strictEqual(vm.formatMoney(20, 'USD'), '20.00 USD');
assert.strictEqual(vm.formatMoney(20.5, 'USD'), '20.50 USD');
assert.strictEqual(vm.formatMoney(NaN, 'USD'), null);
assert.strictEqual(vm.formatMoney('not-a-number', 'USD'), null);
assert.strictEqual(vm.formatMoney(null, 'USD'), null);
assert.strictEqual(vm.formatMoney(undefined, 'USD'), null);
assert.strictEqual(vm.formatMoney('', 'USD'), null);
assert.strictEqual(vm.formatMoney(' 20.5 ', 'USD'), '20.50 USD');
assert.strictEqual(vm.formatMoney(5, ''), '5.00');

// finiteNumber + factValue / factText
assert.strictEqual(vm.finiteNumber(0.004), 0.004);
assert.strictEqual(vm.finiteNumber('20.5'), 20.5);
assert.strictEqual(vm.finiteNumber(' 20.5 '), 20.5);
assert.strictEqual(vm.finiteNumber('not-a-number'), null);
assert.strictEqual(vm.finiteNumber(''), null);
assert.strictEqual(vm.finiteNumber(NaN), null);
assert.strictEqual(vm.finiteNumber(Infinity), null);

assert.strictEqual(vm.factValue(observed('openrouter')), 'openrouter');
assert.strictEqual(vm.factValue(unknown()), null);
assert.strictEqual(vm.factValue(observed(null)), null);
assert.strictEqual(vm.factValue(observed(undefined)), null);
assert.strictEqual(vm.factValue(null), null);
assert.strictEqual(vm.factText(observed('openrouter')), 'openrouter');
assert.strictEqual(vm.factText(unknown()), 'unknown');
assert.strictEqual(vm.factText(observed(0)), '0');

// renderableRoute — orphan filter
assert.strictEqual(vm.renderableRoute({ id: 'r', configured: true, resource: {} }), true);
assert.strictEqual(vm.renderableRoute({ id: 'r', configured: false, resource: {} }), false);
assert.strictEqual(vm.renderableRoute({ id: 'r', configured: false, resource: { state: observed('healthy') } }), true);
assert.strictEqual(vm.renderableRoute({ id: 'r', configured: false, resource: { windows: [{ type: 'weekly', limit: 100, remaining: 50 }] } }), true);
assert.strictEqual(vm.renderableRoute({ id: 'r', configured: false, resource: { balance: { available: 1 } } }), true);
assert.strictEqual(vm.renderableRoute({ id: 'r', configured: false, resource: { usage: { weekly: 1 } } }), true);
assert.strictEqual(vm.renderableRoute(null), false);
assert.strictEqual(vm.renderableRoute(undefined), false);

// reauthNote carries the dashboard URL and profile tail
assert.strictEqual(vm.reauthNote(null), 'session unavailable — open https://platform.xiaomimimo.com/ in Chrome and log in if needed; next refresh checks for new cookies');
assert.strictEqual(vm.reauthNote({}), 'session unavailable — open https://platform.xiaomimimo.com/ in Chrome and log in if needed; next refresh checks for new cookies');
assert.strictEqual(vm.reauthNote({ profile: 'Default' }), 'session unavailable — open https://platform.xiaomimimo.com/ in Chrome (profile Default) and log in if needed; next refresh checks for new cookies');
assert.strictEqual(vm.reauthNote({ url: 'https://other.example/' }), 'session unavailable — open https://other.example/ in Chrome and log in if needed; next refresh checks for new cookies');

// ---- empty snapshot ---------------------------------------------------------

{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'empty',
    caller: {}, harnesses: [], sessions: [], profiles: [], routes: [], diagnostics: [],
  }, null);
  assert.strictEqual(v.schemaVersion, vm.VIEW_MODEL_SCHEMA_VERSION);
  assert.strictEqual(v.cacheUpdatedAt, null);
  assert.strictEqual(v.requester.who, '');
  assert.strictEqual(v.requester.where, '');
  assert.strictEqual(v.requester.models.differsFromDefault, false);
  assert.strictEqual(v.requester.selection.present, false);
  assert.strictEqual(v.requester.selection.line, null);
  assert.strictEqual(v.harnessPool.empty, true);
  assert.strictEqual(v.harnessPool.poolReason, null);
  assert.deepStrictEqual(v.routes, []);
  assert.deepStrictEqual(v.counts, { healthy: 0, constrained: 0, exhausted: 0, unavailable: 0, unknown: 0 });
  assert.strictEqual(v.staleCount, 0);
  assert.strictEqual(v.unobservedCount, 0);
  assert.strictEqual(v.unobservedLine, null);
  assert.deepStrictEqual(v.diagnostics, []);

  const text = v.lines.join('\n');
  const expected = [
    'view-limits runtime inventory — generated 2026-01-01T00:00:00.000Z · completeness empty',
    '  requester: unknown',
    '    models: configured unknown · default unknown · effective unknown',
    '  harness pool:',
    '    (no runtime harness/session/profile facts)',
    '  external routes:',
    '    (no configured routes)',
    '',
    '  0 healthy · 0 constrained · 0 exhausted · 0 unknown',
    '  cache updated never',
  ].join('\n');
  assert.strictEqual(text, expected, 'empty snapshot text output');
}

// ---- full snapshot with every section + every quota kind --------------------

{
  const caller = {
    ade: observed('Traycer'),
    agentId: observed('abc-123'),
    epicId: observed('epic-1'),
    harness: observed('traycer'),
    surface: observed('gui'),
    host: observed('host.local'),
    configuredModel: observed('claude-sonnet'),
    defaultModel: observed('claude-sonnet'),
    effectiveModel: observed('claude-opus'),
    differsFromDefault: observed(true),
    selectedProfile: observed('ambient'),
    selectedAccount: observed('default'),
  };
  const harnesses = [{
    key: { harness: 'traycer', surface: 'gui', host: 'host.local' },
    available: observed(true),
    sessionRefs: [{}, {}],
    resourceRefs: [{}],
    defaults: { model: observed('claude-opus') },
  }];
  const sessions = [{
    key: { agentId: 'abc-123', host: 'host.local' },
    harness: observed('traycer'),
    surface: observed('gui'),
    title: observed('Issue #35'),
    active: observed(true),
    isSelf: observed(true),
  }];
  const profiles = [{
    key: { provider: 'openrouter', profileId: 'ambient', host: 'host.local' },
    authStatus: observed('ok'),
    rateLimitStatus: observed('healthy'),
    usageUpdatedAt: observed('2026-09-21T00:00:00.000Z'),
    nativeRateLimits: observed({}),
  }];
  const routes = [
    // 1. configured + healthy + balance + cap + spend
    {
      id: 'openrouter-main', configured: true,
      provider: configured('openrouter'), account: configured('main'),
      modelBinding: configured('openrouter'), harnessBinding: configured('claude'),
      models: observed(['claude-sonnet']),
      boundBy: [],
      resource: {
        state: observed('healthy'),
        windows: [],
        balance: { currency: 'USD', available: 0.004, spent: { weekly: 0.004 }, limit: { amount: 20, reset: 'monthly' } },
        usage: null, error: null, reauth: null,
        resetAt: observed('2026-10-01T00:00:00.000Z'),
        observedAt: observed('2026-09-21T00:00:00.000Z'),
        freshUntil: observed('2026-09-21T00:02:00.000Z'),
        freshness: 'stale',
        source: observed('openrouter'),
      },
    },
    // 2. configured + unknown via usage-only (no balance)
    {
      id: 'openrouter-usage-only', configured: true,
      provider: configured('openrouter'), account: configured('secondary'),
      modelBinding: configured('usage-only'), harnessBinding: configured('usage-only'),
      models: unknown('model-evidence-absent'),
      boundBy: [{ harness: 'traycer', host: 'host.local', surface: 'gui' }],
      resource: {
        state: unknown('cached-state-absent'),
        windows: [], balance: null,
        usage: { currency: 'USD', daily: 1.5, weekly: 2.5, monthly: 10 },
        error: null, reauth: null,
        resetAt: unknown('cached-field-absent'),
        observedAt: observed('2026-09-21T00:00:00.000Z'),
        freshUntil: observed('2026-09-21T00:02:00.000Z'),
        freshness: 'stale',
        source: observed('openrouter'),
      },
    },
    // 3. configured + unknown xiaomi reauth
    {
      id: 'xiaomi-token-plan', configured: true,
      provider: configured('xiaomi'), account: configured('token-plan'),
      modelBinding: configured('mimo'), harnessBinding: configured('mimo'),
      models: unknown('model-evidence-absent'),
      boundBy: [],
      resource: {
        state: unknown('cached-state-absent'),
        windows: [], balance: null, usage: null,
        error: null,
        reauth: { reason: 'auth-expired', url: 'https://platform.xiaomimimo.com/', profile: 'Profile 7' },
        resetAt: unknown('cached-field-absent'),
        observedAt: unknown('cached-field-absent'),
        freshUntil: unknown('cached-field-absent'),
        freshness: 'unknown',
        source: unknown('cached-field-absent'),
      },
    },
    // 4. configured + windows path (constrained)
    {
      id: 'kimi-code-plan', configured: true,
      provider: configured('kimi'), account: configured('code-plan'),
      modelBinding: configured('kimi'), harnessBinding: configured('kimi'),
      models: unknown('model-evidence-absent'),
      boundBy: [],
      resource: {
        state: observed('constrained'),
        windows: [{ type: 'weekly', limit: 100, remaining: 25, resetAt: null }],
        balance: null, usage: null, error: null, reauth: null,
        resetAt: unknown('cached-field-absent'),
        observedAt: observed('2026-09-21T00:00:00.000Z'),
        freshUntil: observed('2026-09-21T00:02:00.000Z'),
        freshness: 'fresh',
        source: observed('kimi'),
      },
    },
    // 5. orphan (cache-only) with stale evidence — should render
    {
      id: 'orphan-row', configured: false,
      provider: unknown('route-not-configured'),
      account: unknown('route-not-configured'),
      modelBinding: unknown('route-not-configured'),
      harnessBinding: unknown('route-not-configured'),
      models: unknown('no-cached-observation'),
      boundBy: [],
      resource: {
        state: observed('exhausted'),
        windows: [], balance: null, usage: null, error: null, reauth: null,
        resetAt: unknown('cached-field-absent'),
        observedAt: observed('2026-09-20T00:00:00.000Z'),
        freshUntil: observed('2026-09-20T00:01:00.000Z'),
        freshness: 'stale',
        source: observed('kimi'),
      },
    },
    // 6. orphan without any evidence — should be dropped
    {
      id: 'orphan-empty', configured: false,
      provider: unknown('route-not-configured'),
      account: unknown('route-not-configured'),
      modelBinding: unknown('route-not-configured'),
      harnessBinding: unknown('route-not-configured'),
      models: unknown('no-cached-observation'),
      boundBy: [],
      resource: {
        state: unknown('cached-state-absent'),
        windows: [], balance: null, usage: null, error: null, reauth: null,
        resetAt: unknown('cached-field-absent'),
        observedAt: unknown('cached-field-absent'),
        freshUntil: unknown('cached-field-absent'),
        freshness: 'unknown',
        source: unknown('cached-field-absent'),
      },
    },
    // 7. configured but no cached observation → unobserved count
    {
      id: 'fresh-route', configured: true,
      provider: configured('glm'), account: configured('coding'),
      modelBinding: configured('glm'), harnessBinding: configured('glm'),
      models: unknown('no-cached-observation'),
      boundBy: [],
      resource: {
        state: unknown('no-cached-observation'),
        windows: [], balance: null, usage: null, error: null, reauth: null,
        resetAt: unknown('no-cached-observation'),
        observedAt: unknown('no-cached-observation'),
        freshUntil: unknown('no-cached-observation'),
        freshness: 'unknown',
        source: unknown('no-cached-observation'),
      },
    },
  ];
  const diagnostics = [
    { code: 'runtime-pool-cache-empty', scope: 'harness-pool', summary: 'no pool facts' },
    { code: 'status-cache-corrupt', scope: 'routes', summary: 'status.json is unreadable' },
  ];
  const v = vm.buildViewModel({
    generatedAt: '2026-09-21T00:00:00.000Z',
    completeness: 'partial',
    caller, harnesses, sessions, profiles, routes, diagnostics,
  }, '2026-09-21T00:00:00.000Z');

  // structured sections
  assert.strictEqual(v.completeness, 'partial');
  assert.strictEqual(v.cacheUpdatedAt, '2026-09-21T00:00:00.000Z');
  assert.strictEqual(v.requester.who, 'Traycer · agent abc-123 · epic epic-1');
  assert.strictEqual(v.requester.where, 'traycer · gui · host.local');
  assert.strictEqual(v.requester.models.differsFromDefault, true);
  assert.strictEqual(v.requester.selection.present, true);
  assert.strictEqual(v.requester.selection.line, '    selection: profile ambient · account default');
  assert.strictEqual(v.harnessPool.empty, false);
  assert.strictEqual(v.harnessPool.harnesses.length, 1);
  assert.strictEqual(v.harnessPool.harnesses[0].line.startsWith('    traycer (gui) @ host.local: available'), true);
  assert.strictEqual(v.harnessPool.sessions[0].line.includes('this requester'), true);
  assert.strictEqual(v.harnessPool.profiles[0].line.startsWith('    profile openrouter/ambient @ host.local:'), true);
  assert.strictEqual(v.harnessPool.poolReason.code, 'runtime-pool-cache-empty');
  // routes sorted alphabetically; orphan-empty dropped; 6 rows survive
  assert.strictEqual(v.routes.length, 6);
  assert.deepStrictEqual(v.routes.map((r) => r.id), [
    'fresh-route', 'kimi-code-plan', 'openrouter-main', 'openrouter-usage-only', 'orphan-row', 'xiaomi-token-plan',
  ]);
  // counts: healthy=1, constrained=1, exhausted=1, unknown=3 (openrouter-usage-only, xiaomi-token-plan, fresh-route)
  assert.deepStrictEqual(v.counts, { healthy: 1, constrained: 1, exhausted: 1, unavailable: 0, unknown: 3 });
  assert.strictEqual(v.staleCount, 3); // openrouter-main, openrouter-usage-only, orphan-row
  assert.strictEqual(v.unobservedCount, 1); // fresh-route
  // diagnostics: pool reason filtered out
  assert.strictEqual(v.diagnostics.length, 1);
  assert.strictEqual(v.diagnostics[0].code, 'status-cache-corrupt');

  // text lines — exercised end-to-end
  const text = v.lines.join('\n');
  assert.match(text, /^view-limits runtime inventory — generated 2026-09-21T00:00:00\.000Z · completeness partial$/m);
  assert.match(text, /^  requester: Traycer · agent abc-123 · epic epic-1 — traycer · gui · host\.local$/m);
  assert.match(text, /^    models: configured claude-sonnet · default claude-sonnet · effective claude-opus \(differs from default\)$/m);
  assert.match(text, /^    selection: profile ambient · account default$/m);
  assert.match(text, /^  harness pool:$/m);
  assert.match(text, /^    traycer \(gui\) @ host\.local: available · 2 session\(s\) · 1 resource ref\(s\) · defaults: model=claude-opus$/m);
  assert.match(text, /^    session abc-123 @ host\.local: harness traycer · gui · "Issue #35" · active · this requester$/m);
  assert.match(text, /^    profile openrouter\/ambient @ host\.local: auth ok · rate limits healthy · usage observed 2026-09-21T00:00:00\.000Z · native rate limits observed$/m);
  assert.match(text, /^  external routes:$/m);
  assert.match(text, /^    fresh-route: unknown — no-cached-observation$/m);
  assert.match(text, /^    kimi-code-plan: constrained · weekly 25%$/m);
  assert.match(text, /^    openrouter-main: healthy · balance <0\.01 USD · spent <0\.01 USD week · 20\.00 USD monthly cap · resets .* · models claude-sonnet \(stale\)$/m);
  assert.match(text, /^    openrouter-usage-only: unknown · spent 1\.50 USD today \/ 2\.50 USD week \/ 10\.00 USD month — cached-state-absent · bound to traycer@host\.local \(stale\)$/m);
  assert.match(text, /^    orphan-row: exhausted \(stale\)$/m);
  assert.match(text, /^    xiaomi-token-plan: unknown — session unavailable — open https:\/\/platform\.xiaomimimo\.com\/ in Chrome \(profile Profile 7\) and log in if needed; next refresh checks for new cookies$/m);
  assert.match(text, /^  1 healthy · 1 constrained · 1 exhausted · 3 unknown · 3 stale$/m);
  assert.match(text, /^  1 configured route\(s\) have no cached observation/m);
  assert.match(text, /^  notice \[routes\] status-cache-corrupt — status\.json is unreadable$/m);
  assert.match(text, /^  cache updated 2026-09-21T00:00:00\.000Z$/m);
}

// ---- non-xiaomi unknown-state error gets rotated + truncated when >80 -------

{
  const longErr = 'a'.repeat(120);
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: {}, harnesses: [], sessions: [], profiles: [],
    routes: [{
      id: 'glm-coding', configured: true,
      provider: configured('glm'), account: configured('coding'),
      modelBinding: configured('glm'), harnessBinding: configured('glm'),
      models: unknown('no-cached-observation'),
      boundBy: [],
      resource: {
        state: unknown('cached-state-absent'),
        windows: [], balance: null, usage: null,
        error: longErr, reauth: null,
        resetAt: unknown('cached-field-absent'),
        observedAt: unknown('cached-field-absent'),
        freshUntil: unknown('cached-field-absent'),
        freshness: 'unknown',
        source: unknown('cached-field-absent'),
      },
    }],
    diagnostics: [],
  }, null);
  assert.match(v.lines.join('\n'), /    glm-coding: unknown — a{80}… \(rotate via \/view-limits:update glm-coding\)$/m);
}

// ---- non-xiaomi unknown with state.reason (no error) -------------------

{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: {}, harnesses: [], sessions: [], profiles: [],
    routes: [{
      id: 'deepseek', configured: true,
      provider: configured('deepseek'), account: configured('main'),
      modelBinding: configured('deepseek'), harnessBinding: configured('deepseek'),
      models: unknown('model-evidence-absent'),
      boundBy: [],
      resource: {
        state: unknown('cached-field-absent'),
        windows: [], balance: null, usage: null, error: null, reauth: null,
        resetAt: unknown('cached-field-absent'),
        observedAt: unknown('cached-field-absent'),
        freshUntil: unknown('cached-field-absent'),
        freshness: 'unknown',
        source: unknown('cached-field-absent'),
      },
    }],
    diagnostics: [],
  }, null);
  assert.match(v.lines.join('\n'), /    deepseek: unknown — cached-field-absent$/m);
}

// ---- xiaomi unknown with error (no reauth) ----------------------------

{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: {}, harnesses: [], sessions: [], profiles: [],
    routes: [{
      id: 'xiaomi-token-plan', configured: true,
      provider: configured('xiaomi'), account: configured('token-plan'),
      modelBinding: configured('mimo'), harnessBinding: configured('mimo'),
      models: unknown('model-evidence-absent'),
      boundBy: [],
      resource: {
        state: unknown('cached-state-absent'),
        windows: [], balance: null, usage: null,
        error: 'console status unavailable', reauth: null,
        resetAt: unknown('cached-field-absent'),
        observedAt: unknown('cached-field-absent'),
        freshUntil: unknown('cached-field-absent'),
        freshness: 'unknown',
        source: unknown('cached-field-absent'),
      },
    }],
    diagnostics: [],
  }, null);
  assert.match(v.lines.join('\n'), /    xiaomi-token-plan: unknown — console status unavailable$/m);
}

// ---- selection section only appears when at least one field is known -------

{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: { selectedProfile: observed('ambient'), selectedAccount: unknown('absent') },
    harnesses: [], sessions: [], profiles: [], routes: [], diagnostics: [],
  }, null);
  assert.strictEqual(v.requester.selection.present, true);
  assert.strictEqual(v.requester.selection.line, '    selection: profile ambient · account unknown');
  assert.ok(v.lines.includes('    selection: profile ambient · account unknown'));
}

{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: { selectedProfile: unknown('absent'), selectedAccount: unknown('absent') },
    harnesses: [], sessions: [], profiles: [], routes: [], diagnostics: [],
  }, null);
  assert.strictEqual(v.requester.selection.present, false);
  assert.strictEqual(v.requester.selection.line, null);
  assert.ok(!v.lines.some((l) => l.startsWith('    selection:')));
}

// ---- counterexample sweep on null / empty / odd inputs --------------------

// Non-object snapshot: every section degrades cleanly, no throw.
{
  const v = vm.buildViewModel(null, null);
  assert.strictEqual(v.requester.who, '');
  assert.strictEqual(v.harnessPool.empty, true);
  assert.deepStrictEqual(v.routes, []);
  assert.strictEqual(v.counts.unknown, 0);
}

// Empty diagnostics + array-typed caller facts still assemble.
{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: { ade: ['nope', 'array'], agentId: 42 },
    harnesses: 'not-an-array',
    sessions: null,
    profiles: undefined,
    routes: [{ id: 'r', configured: true, resource: { state: observed('healthy'), balance: { available: 1, currency: 'USD' } } }],
    diagnostics: 'not-an-array',
  }, '');
  // Arrays fall through factValue (not an object), so the caller fact is unknown.
  assert.strictEqual(v.requester.ade, null);
  // Non-array harness pool degrades to empty.
  assert.strictEqual(v.harnessPool.empty, true);
  // Routes still render — single healthy route.
  assert.strictEqual(v.routes.length, 1);
  assert.match(v.lines.join('\n'), /    r: healthy · balance 1\.00 USD$/m);
  // updatedAt falsy → 'never'
  assert.match(v.lines.join('\n'), /  cache updated never$/m);
}

// Malformed route row (string id) still must not crash.
{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: {}, harnesses: [], sessions: [], profiles: [],
    routes: [
      null,
      'not-an-object',
      { id: 7, configured: true, resource: { state: observed('healthy'), balance: { available: 1, currency: 'USD' } } },
    ],
    diagnostics: [],
  }, null);
  // id=7 still sorts by string
  assert.strictEqual(v.routes.length, 1);
  assert.strictEqual(v.routes[0].id, 7);
  assert.match(v.lines.join('\n'), /^    7: healthy · balance 1\.00 USD$/m);
}

// Very long strings pass through without truncation in non-route lines.
{
  const longHost = 'h'.repeat(4000);
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: { harness: observed(longHost) },
    harnesses: [], sessions: [], profiles: [], routes: [], diagnostics: [],
  }, null);
  assert.ok(v.requester.where.includes(longHost));
  assert.ok(v.lines.some((l) => l.includes(longHost)));
}

// updatedAt may be empty string; cacheUpdatedAt still falsy → 'never'.
{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: {}, harnesses: [], sessions: [], profiles: [], routes: [], diagnostics: [],
  }, '');
  // '' is treated as "never" — the field is normalized to null for JSON consumers.
  assert.strictEqual(v.cacheUpdatedAt, null);
  assert.match(v.lines.join('\n'), /  cache updated never$/m);
}

// JSON-serializable — every consumer (text / JSON / HTML) needs to serialize.
{
  const v = vm.buildViewModel({
    generatedAt: '2026-01-01T00:00:00.000Z',
    completeness: 'partial',
    caller: { ade: observed('readme'), harness: observed('traycer') },
    harnesses: [{ key: { harness: 'traycer', surface: 'gui', host: 'h' }, available: observed(true) }],
    sessions: [], profiles: [],
    routes: [{
      id: 'r', configured: true, provider: configured('openrouter'), account: configured('main'),
      boundBy: [],
      resource: { state: observed('healthy'), balance: { available: 1, currency: 'USD' }, windows: [] },
    }],
    diagnostics: [{ code: 'x', scope: 'routes', summary: 'y' }],
  }, '2026-01-01T00:00:00.000Z');
  // Throws on functions / circular refs; round-trips through JSON unchanged.
  const round = JSON.parse(JSON.stringify(v));
  assert.strictEqual(round.requester.who, 'readme');
  assert.strictEqual(round.routes[0].state, 'healthy');
  assert.strictEqual(round.lines.length, v.lines.length);
}

console.log('view-model: PASS');