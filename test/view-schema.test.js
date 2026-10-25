'use strict';
// Unit coverage for the Issue #59 view schema (lib/view-model.js): the
// versioned structured schema, its two approved text formats, and the #88
// text-boundary escaping.
//
// No network, no I/O: every input is a hand-built snapshot. The expected text
// is the owner's approved example from Issue #59 (2026-10-20) — byte for byte.
//
// The rules under test (owner rulings + lead corrections):
//   * the cached status.state is the ONLY state source — the view never
//     derives a state from a measurement (C1)
//   * a route whose freshness is not 'fresh' is serialized as unknown with
//     reasonCode 'stale-observation' — stale is never healthy (C2)
//   * the quota eligibility follows the gate's own decision (C3)
//   * missing/invalid facts never become zero, false or healthy

const assert = require('assert');
const vm = require('../lib/view-model');

function observed(value, extra = {}) {
  return { value, provenance: 'observed', source: 'status.json', observedAt: null, freshUntil: null, reason: null, ...extra };
}
function configured(value) {
  return { value, provenance: 'configured', source: 'config', observedAt: null, freshUntil: null, reason: null };
}
function unknown(reason = 'absent') {
  return { value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason };
}

// One snapshot route row, shaped like lib/runtime-snapshot.js emits it.
function route(id, provider, account, resource, extra = {}) {
  return {
    id,
    configured: extra.configured !== false,
    provider: configured(provider),
    account: configured(account),
    pool: configured({ provider, account }),
    boundBy: extra.boundBy || [],
    resource: {
      state: observed('healthy'),
      windows: [],
      balance: null,
      error: null,
      basis: unknown('cached-field-absent'),
      periodEnd: unknown('cached-field-absent'),
      resetAt: unknown('cached-field-absent'),
      observedAt: observed('2026-10-13T09:45:00Z'),
      // A CURRENT deadline: the freshness predicate is positive evidence
      // only, so the fixture must carry one (the tests for the unproven and
      // the expired cases build their own).
      freshUntil: observed('2099-01-01T00:00:00Z'),
      freshness: 'fresh',
      source: observed('adapter'),
      ...resource,
    },
  };
}

// The gate context the view consults: the raw cache entry + the configured
// route, exactly what bin/vl.js hands it.
function gateContext(entries, routes, now) {
  return { entries, routes, now };
}

const NOW = Date.parse('2026-10-13T09:46:00Z');
const TZ = 'America/Los_Angeles';

// ---- the three surfaces list the SAME routes -------------------------------

{
  // A healthy route, an unknown route with counts, a route with NO
  // measurement at all and a stale route: every one of them must appear in
  // the expanded text, in the condensed text and in the JSON.
  const snapshot = {
    generatedAt: '2026-10-13T09:46:00Z',
    routes: [
      route('minimax-token-plan', 'minimax', 'token-plan', {
        state: observed('healthy'),
        windows: [{ type: 'rolling-5h', remaining: 72, limit: 100 }],
      }),
      route('xiaomi-token-plan', 'xiaomi', 'token-plan', {
        state: observed('unknown'),
        basis: observed('token-count'),
        windows: [{ type: 'tokens', remaining: 12000000, limit: 20000000 }],
      }),
      route('alibaba-coding-plan', 'alibaba-coding-plan', 'personal', {
        state: observed('unknown'),
      }),
      route('glm-coding-plan', 'glm', 'coding-plan', {
        state: observed('exhausted'),
        observedAt: observed('2026-10-13T09:40:00Z'),
        // An EXPIRED deadline: the freshness predicate is positive evidence
        // only, so a stale observation is proven by its deadline.
        freshUntil: observed('2026-10-13T09:45:00Z'),
        windows: [{ type: 'credit', remaining: 0, limit: 100 }],
      }),
    ],
  };
  const schema = vm.buildViewSchema(snapshot, {
    recipeOf: { 'alibaba-coding-plan': 'alibaba-coding-plan' },
  });
  const expanded = vm.renderViewText(schema, { now: NOW, timeZone: TZ });
  const condensed = vm.renderViewText(schema, { now: NOW, timeZone: TZ, condensed: true });

  // The expanded route header lines: <label> <STATE> <FRESHNESS>.
  const expandedLabels = expanded
    .filter((l) => /^(.*?)\s{2,}(HEALTHY|CONSTRAINED|EXHAUSTED|UNKNOWN)\s{2,}(FRESH|STALE|UNKNOWN)$/.test(l))
    .map((l) => l.match(/^(.*?)\s{2,}(HEALTHY|CONSTRAINED|EXHAUSTED|UNKNOWN)\s{2,}(FRESH|STALE|UNKNOWN)$/)[1]);
  // The condensed provider column: the non-empty entries are the routes
  // (the continuation rows leave it empty).
  const condensedLabels = condensed
    .filter((l) => l.trim() && !l.startsWith('VIEW-LIMITS') && !l.startsWith('PROVIDER'))
    .map((l) => l.split(/\s{2,}/)[0])
    .filter((label) => label !== '');

  assert.strictEqual(expandedLabels.length, 4, 'the expanded view lists every route');
  assert.strictEqual(condensedLabels.length, 4, 'the condensed view lists every route');
  assert.deepStrictEqual(condensedLabels, expandedLabels, 'the condensed view lists the same routes');
  assert.deepStrictEqual(schema.routes.map((r) => r.label), expandedLabels, 'the JSON lists the same routes');

  // The route with no measurement at all is still listed, with its state.
  assert.ok(condensed.some((l) => l.includes('Alibaba Cloud') && l.includes('UNKNOWN')),
    'a route with no measurement still appears in the condensed view');
  assert.ok(expanded.some((l) => l.includes('Alibaba Cloud')), 'and in the expanded view');
  assert.ok(condensed.some((l) => l.includes('Xiaomi MiMo') && l.includes('UNKNOWN')),
    'an unknown route with counts appears in the condensed view');
  assert.ok(condensed.some((l) => l.includes('Z.ai / GLM') && l.includes('UNKNOWN')),
    'a stale route appears in the condensed view');
}

// ---- the approved example (Issue #59, owner-approved 2026-10-20) -----------

const approvedSnapshot = {
  generatedAt: '2026-10-13T09:46:00Z',
  routes: [
    route('minimax-token-plan', 'minimax', 'token-plan', {
      windows: [
        { type: 'rolling-5h', remaining: 72, limit: 100, resetAt: '2026-10-13T12:00:00Z' },
        { type: 'weekly', remaining: 90, limit: 100, resetAt: '2026-10-15T07:00:00Z' },
      ],
    }),
    route('kimi-code-plan', 'kimi', 'code-plan', {
      state: observed('constrained'),
      windows: [
        { type: 'rolling-5h', remaining: 12, limit: 100, resetAt: '2026-10-13T10:24:00Z' },
        { type: 'weekly', remaining: 55, limit: 100, resetAt: '2026-10-16T07:00:00Z' },
      ],
    }),
    route('xiaomi-token-plan', 'xiaomi', 'token-plan', {
      state: observed('unknown'),
      basis: observed('token-count'),
      windows: [{ type: 'tokens', remaining: 12000000, limit: 20000000 }],
    }),
    route('glm-coding-plan', 'glm', 'coding-plan', {
      state: observed('exhausted'),
      windows: [{ type: 'credit', remaining: 0, limit: 100, resetAt: '2026-10-13T10:52:00Z' }],
    }),
    route('deepseek-direct', 'deepseek', 'personal', {
      balance: { available: 8.42, currency: 'USD' },
    }),
    route('openrouter-main', 'openrouter', 'main', {
      balance: { available: 24.18, currency: 'USD', spent: { daily: 1.32, weekly: 6.84 } },
    }),
  ],
};

const APPROVED_EXPANDED = [
  '+---------------------------+',
  '|        View-Limits        |',
  '+---------------------------+',
  '',
  'QUOTA REMAINING',
  '',
  'MiniMax                                          HEALTHY      FRESH',
  '  5-hour   [##############------]   72% left',
  '  Weekly   [##################--]   90% left',
  '  Reset    5-hour: in 2h 14m | Weekly: Oct 15, 00:00 PDT',
  '',
  'Kimi                                             CONSTRAINED  FRESH',
  '  5-hour   [##------------------]   12% left',
  '  Weekly   [###########---------]   55% left',
  '  Reset    5-hour: in 38m | Weekly: Oct 16, 00:00 PDT',
  '',
  'Xiaomi MiMo                                      UNKNOWN      FRESH',
  '  Counts   12.0M / 20.0M tokens remaining',
  '  Note     Token counts available; availability undetermined.',
  '',
  'Z.ai / GLM                                       EXHAUSTED    FRESH',
  '  Quota    [--------------------]    0% left',
  '  Reset    in 1h 06m',
  '',
  'DeepSeek                                         HEALTHY      FRESH',
  '  Balance  8.42 USD',
  '',
  'OpenRouter                                       HEALTHY      FRESH',
  '  Balance  24.18 USD',
  '  Spent    Today: 1.32 USD | This week: 6.84 USD',
  '',
  '======================================================================',
  '',
  '3 healthy | 1 constrained | 1 exhausted | 1 unknown',
].join('\n');

const APPROVED_CONDENSED = [
  'VIEW-LIMITS | QUOTA REMAINING',
  '',
  'PROVIDER       WINDOW   REMAINING                LEFT  STATE',
  'MiniMax        5-hour   [##############------]    72%  HEALTHY',
  '               Weekly   [##################--]    90%',
  'Kimi           5-hour   [##------------------]    12%  CONSTRAINED',
  '               Weekly   [###########---------]    55%',
  'Xiaomi MiMo    Tokens   12.0M / 20.0M                  UNKNOWN',
  'Z.ai / GLM     Quota    [--------------------]     0%  EXHAUSTED',
  'DeepSeek       Balance  8.42 USD                       HEALTHY',
  'OpenRouter     Balance  24.18 USD                      HEALTHY',
].join('\n');

{
  // The same clock as the renderer: the example's own timestamps are relative
  // to NOW, and the freshness predicate reads the same clock.
  const schema = vm.buildViewSchema(approvedSnapshot, { now: NOW });
  assert.strictEqual(schema.schemaVersion, 1, 'schema version is 1');
  assert.strictEqual(schema.schemaVersion, vm.VIEW_SCHEMA_VERSION);
  assert.strictEqual(schema.status, 'ok');
  assert.strictEqual(schema.routes.length, 6);
  assert.strictEqual(vm.renderViewText(schema, { now: NOW, timeZone: TZ }).join('\n'), APPROVED_EXPANDED,
    'the expanded text is the owner-approved example, byte for byte');
  assert.strictEqual(vm.renderViewText(schema, { now: NOW, timeZone: TZ, condensed: true }).join('\n'), APPROVED_CONDENSED,
    'the condensed text is the owner-approved example, byte for byte');
}

// ---- the schema contract ----------------------------------------------------

{
  const schema = vm.buildViewSchema(approvedSnapshot);
  const byId = Object.fromEntries(schema.routes.map((r) => [r.id, r]));

  assert.strictEqual(byId['minimax-token-plan'].provider, 'minimax');
  assert.strictEqual(byId['minimax-token-plan'].accountId, 'token-plan');
  assert.strictEqual(byId['minimax-token-plan'].poolId, 'minimax:token-plan');
  assert.strictEqual(byId['minimax-token-plan'].state, 'healthy');
  assert.strictEqual(byId['minimax-token-plan'].freshness, 'fresh');
  assert.strictEqual(byId['minimax-token-plan'].observedAt, '2026-10-13T09:45:00Z');
  assert.strictEqual(byId['minimax-token-plan'].freshUntil, '2099-01-01T00:00:00Z');
  assert.strictEqual(byId['minimax-token-plan'].balance, null, 'no balance is invented');
  assert.strictEqual(byId['minimax-token-plan'].reauth, null);
  assert.deepStrictEqual(byId['minimax-token-plan'].windows.map((w) => w.type), ['rolling-5h', 'weekly']);
  assert.strictEqual(byId['minimax-token-plan'].windows[0].remaining, 72);
  assert.strictEqual(byId['minimax-token-plan'].windows[0].limit, 100);
  assert.strictEqual(byId['minimax-token-plan'].windows[0].remainingRatio, 0.72);
  assert.strictEqual(byId['minimax-token-plan'].windows[0].resetAt, '2026-10-13T12:00:00Z');
  assert.strictEqual(byId['minimax-token-plan'].basis, 'quota-window', 'the basis is derived from the evidence');
  assert.strictEqual(byId['deepseek-direct'].balance.amount, 8.42);
  assert.strictEqual(byId['deepseek-direct'].balance.currency, 'USD');
  assert.strictEqual(byId['deepseek-direct'].basis, 'balance');
  assert.strictEqual(byId['openrouter-main'].balance.spent.daily, 1.32);
  assert.strictEqual(byId['openrouter-main'].balance.spent.weekly, 6.84);
}

// Only CONFIGURED routes appear; a cache orphan does not.
{
  const snapshot = {
    routes: [
      route('configured-route', 'minimax', 'token-plan', {}),
      route('orphan-route', 'kimi', 'code-plan', {}, { configured: false }),
    ],
  };
  const schema = vm.buildViewSchema(snapshot);
  assert.deepStrictEqual(schema.routes.map((r) => r.id), ['configured-route']);
}

// The always-valid empty envelope (no configured routes).
{
  const schema = vm.buildViewSchema({ routes: [] }, { generatedAt: '2026-10-13T09:46:00Z' });
  assert.strictEqual(schema.schemaVersion, 1);
  assert.strictEqual(schema.status, 'empty');
  assert.deepStrictEqual(schema.reasonCodes, ['no-routes-configured']);
  assert.deepStrictEqual(schema.routes, []);
  assert.strictEqual(schema.generatedAt, '2026-10-13T09:46:00Z');
}

// The always-valid pending envelope (routes configured, nothing observed).
{
  const snapshot = {
    routes: [route('r', 'minimax', 'token-plan', {
      state: unknown('no-cached-observation'),
      observedAt: unknown('no-cached-observation'),
      freshUntil: unknown('no-cached-observation'),
      freshness: 'unknown',
    })],
  };
  const schema = vm.buildViewSchema(snapshot);
  assert.strictEqual(schema.status, 'pending');
  assert.deepStrictEqual(schema.reasonCodes, ['no-observed-state']);
  assert.strictEqual(schema.routes.length, 1);
  assert.strictEqual(schema.routes[0].state, 'unknown');
  assert.ok(schema.routes[0].reasonCodes.includes('no-cached-observation'));
}

// ---- never fabricate --------------------------------------------------------

{
  // A missing state is unknown — never healthy, never zero.
  const snapshot = { routes: [route('r', 'minimax', 'token-plan', { state: unknown('no-cached-observation') })] };
  const r = vm.buildViewSchema(snapshot).routes[0];
  assert.strictEqual(r.state, 'unknown');
  assert.strictEqual(r.freshness, 'fresh');
  assert.strictEqual(r.balance, null);
  assert.strictEqual(r.quotaEligibility, 'unresolved');
  assert.ok(r.reasonCodes.includes('no-fresh-observation'));

  // A window with no usable counts keeps them null; the ratio is never
  // invented.
  const snapshot2 = { routes: [route('r2', 'minimax', 'token-plan', { windows: [{ type: 'weekly' }] })] };
  const r2 = vm.buildViewSchema(snapshot2).routes[0];
  assert.strictEqual(r2.windows[0].remaining, null);
  assert.strictEqual(r2.windows[0].limit, null);
  assert.strictEqual(r2.windows[0].remainingRatio, null);

  // A balance is never inferred from windows.
  const snapshot3 = { routes: [route('r3', 'minimax', 'token-plan', { windows: [{ type: 'weekly', remaining: 5, limit: 10 }] })] };
  assert.strictEqual(vm.buildViewSchema(snapshot3).routes[0].balance, null);

  // A zero balance is a real fact (0.00), not a missing one.
  const snapshot4 = { routes: [route('r4', 'deepseek', 'personal', { balance: { available: 0, currency: 'USD' } })] };
  const r4 = vm.buildViewSchema(snapshot4).routes[0];
  assert.strictEqual(r4.balance.amount, 0);
  assert.ok(vm.renderViewText(vm.buildViewSchema(snapshot4)).join('\n').includes('Balance  0.00 USD'));
}

// ---- bar boundaries ---------------------------------------------------------

{
  // A full window, an over-full window (a provider that reports more than
  // the limit) and a negative one: the bar never overflows its 20 cells.
  const bar = (remaining, limit) => {
    const snapshot = { routes: [route('r', 'minimax', 'token-plan', {
      state: observed('healthy'),
      windows: [{ type: 'weekly', remaining, limit }],
    })] };
    const line = vm.renderViewText(vm.buildViewSchema(snapshot)).join('\n').split('\n').find((l) => l.includes('[#') || l.includes('[-'));
    return line;
  };
  assert.ok(bar(100, 100).includes('[####################]'), 'a full window is all filled');
  assert.ok(bar(150, 100).includes('[####################]'), 'a ratio above 1 is clamped');
  assert.ok(bar(-5, 100).includes('[--------------------]'), 'a negative ratio is clamped');
  assert.ok(bar(0, 100).includes('[--------------------]'), 'an empty window is all empty');
  assert.ok(bar(0, 100).includes('0% left'), 'a zero percent renders as 0%');
}

// ---- the unit is never guessed: it is null unless the source declares one,
// the basis is token-count (which defines the measurement).
{
  const snapshot = { routes: [route('r', 'minimax', 'token-plan', { windows: [{ type: 'weekly', remaining: 5, limit: 10 }] })] };
  const r = vm.buildViewSchema(snapshot).routes[0];
  assert.strictEqual(r.windows[0].unit, null);
  assert.ok(r.reasonCodes.includes('window-unit-unavailable'));

  const tokenSnapshot = { routes: [route('t', 'xiaomi', 'token-plan', { basis: observed('token-count'), windows: [{ type: 'tokens', remaining: 5, limit: 10 }] })] };
  const t = vm.buildViewSchema(tokenSnapshot).routes[0];
  assert.strictEqual(t.windows[0].unit, 'tokens');

  const declared = { routes: [route('d', 'minimax', 'token-plan', { windows: [{ type: 'weekly', unit: 'credits', remaining: 5, limit: 10 }] })] };
  assert.strictEqual(vm.buildViewSchema(declared).routes[0].windows[0].unit, 'credits');
}

// ---- C1: no state derivation in the view ------------------------------------

{
  // An unknown route with valid counts stays unknown: the adapter's own
  // classification is the only state source.
  const snapshot = { routes: [route('r', 'xiaomi', 'token-plan', {
    state: observed('unknown'),
    basis: observed('token-count'),
    windows: [{ type: 'tokens', remaining: 1400000, limit: 20000000 }],
  })] };
  const r = vm.buildViewSchema(snapshot).routes[0];
  assert.strictEqual(r.state, 'unknown', 'the view never derives a state from a measurement');
  const text = vm.renderViewText(vm.buildViewSchema(snapshot)).join('\n');
  assert.ok(text.includes('Counts   1.4M / 20.0M tokens remaining'), 'the counts are still shown');
  assert.ok(!text.includes('['), 'an unknown route draws no bar');
}

// ---- C2: stale is never healthy --------------------------------------------

{
  const stale = route('r', 'minimax', 'token-plan', {
    state: observed('healthy'),
    freshness: 'stale',
    observedAt: observed('2026-10-13T09:40:00Z'),
    freshUntil: observed('2026-10-13T09:45:00Z'),
    windows: [{ type: 'weekly', remaining: 72, limit: 100 }],
  });
  const schema = vm.buildViewSchema({ routes: [stale] });
  const r = schema.routes[0];
  assert.strictEqual(r.state, 'unknown', 'a stale observation is never healthy');
  assert.strictEqual(r.freshness, 'stale');
  assert.ok(r.reasonCodes.includes('stale-observation'));
  assert.strictEqual(r.quotaEligibility, 'unresolved');
  const text = vm.renderViewText(schema, { now: NOW, timeZone: TZ }).join('\n');
  assert.ok(text.includes('UNKNOWN'), 'the text shows the serialized state');
  assert.ok(text.includes('STALE'), 'the text shows the freshness');
  assert.ok(!text.includes('['), 'a stale route draws no bar');
  assert.ok(text.includes('(last seen Oct 13, 02:40 PDT)'), 'the last observation is disclosed');
}

// ---- C3: the quota eligibility follows the gate ----------------------------

{
  const cfgRoute = { id: 'r', provider: 'minimax', account: 'token-plan' };
  const entry = (state, freshUntil) => ({ routeId: 'r', freshUntil, status: { state } });

  const healthy = route('r', 'minimax', 'token-plan', { state: observed('healthy') });
  const exhausted = route('r', 'minimax', 'token-plan', { state: observed('exhausted') });
  const unknownState = route('r', 'minimax', 'token-plan', { state: observed('unknown') });
  const fresh = '2099-01-01T00:00:00Z';

  const eligible = vm.buildViewSchema({ routes: [healthy] }, {
    gate: gateContext({ r: entry('healthy', fresh) }, { r: cfgRoute }, NOW),
  }, { now: NOW }).routes[0];
  assert.strictEqual(eligible.quotaEligibility, 'eligible');

  const ineligible = vm.buildViewSchema({ routes: [exhausted] }, {
    gate: gateContext({ r: entry('exhausted', fresh) }, { r: cfgRoute }, NOW),
  }, { now: NOW }).routes[0];
  assert.strictEqual(ineligible.quotaEligibility, 'ineligible');
  assert.ok(ineligible.reasonCodes.includes('fresh-exhausted'));

  // The gate ALLOWS an unknown but current, non-exhausted entry - it fails
  // open - but a fail-open allow proves nothing about the quota, so the
  // eligibility stays unresolved.
  const allowed = vm.buildViewSchema({ routes: [unknownState] }, {
    gate: gateContext({ r: entry('unknown', fresh) }, { r: cfgRoute }, NOW),
  }, { now: NOW }).routes[0];
  assert.strictEqual(allowed.quotaEligibility, 'unresolved');
  assert.ok(allowed.reasonCodes.includes('state-unknown'));

  // A route whose observation is not current is never eligible - the gate
  // would not act on it either.
  const staleEntry = route('r', 'minimax', 'token-plan', {
    state: observed('healthy'),
    freshUntil: observed('2020-01-01T00:00:00Z'),
  });
  const notFresh = vm.buildViewSchema({ routes: [staleEntry] }, {
    gate: gateContext({ r: entry('healthy', '2020-01-01T00:00:00Z') }, { r: cfgRoute }, NOW),
  }, { now: NOW }).routes[0];
  assert.strictEqual(notFresh.quotaEligibility, 'unresolved');
  assert.strictEqual(notFresh.state, 'unknown');
}

// ---- unknown is never eligible: the DISPLAYED state counts too --------------

{
  // The busy view shows a pending Xiaomi projection (displayed state unknown)
  // beside the raw entry the gate still reads as healthy and fresh.
  const cfgRoute = { id: 'r', provider: 'minimax', account: 'token-plan' };
  const entry = (state) => ({ routeId: 'r', freshUntil: '2099-01-01T00:00:00Z', status: { state } });
  const build = (displayed, rawState) => vm.buildViewSchema({
    routes: [route('r', 'minimax', 'token-plan', { state: observed(displayed) })],
  }, { gate: gateContext({ r: entry(rawState) }, { r: cfgRoute }, NOW) }, { now: NOW }).routes[0];

  const pending = build('unknown', 'healthy');
  assert.strictEqual(pending.state, 'unknown');
  assert.strictEqual(pending.freshness, 'fresh');
  assert.strictEqual(pending.quotaEligibility, 'unresolved',
    'a row that displays no known capacity is never eligible, whatever the raw entry says');
  assert.ok(pending.reasonCodes.includes('state-unknown'));

  // The deny wins: the gate's refusal is never loosened by what is displayed.
  const denied = build('unknown', 'exhausted');
  assert.strictEqual(denied.quotaEligibility, 'ineligible');
  assert.ok(denied.reasonCodes.includes('fresh-exhausted'));

  // And a displayed healthy/constrained row over a healthy raw entry is
  // still eligible.
  assert.strictEqual(build('healthy', 'healthy').quotaEligibility, 'eligible');
  assert.strictEqual(build('constrained', 'constrained').quotaEligibility, 'eligible');
}

// ---- the route eligibility IS the gate's decision ------------------------

{
  const { decide } = require('../lib/gate');
  const { configRevision } = require('../lib/monitor-schema');
  const cfgRoute = { id: 'r', provider: 'minimax', account: 'token-plan' };
  const current = configRevision(cfgRoute);
  const CASES = [
    { name: 'a current entry', observedAt: '2026-10-13T09:45:00Z', freshUntil: '2026-10-13T09:48:00Z', state: 'healthy' },
    { name: 'an expired entry', observedAt: '2026-10-13T09:40:00Z', freshUntil: '2026-10-13T09:45:00Z', state: 'healthy' },
    { name: 'a null expiry', observedAt: '2026-10-13T09:45:00Z', freshUntil: null, state: 'healthy' },
    { name: 'a malformed expiry', observedAt: '2026-10-13T09:45:00Z', freshUntil: 'bad-date', state: 'healthy' },
    { name: 'the deadline equal to now', observedAt: '2026-10-13T09:45:00Z', freshUntil: '2026-10-13T09:46:00Z', state: 'exhausted' },
    { name: 'a 2020 observation without an expiry', observedAt: '2020-01-01T00:00:00Z', freshUntil: null, state: 'healthy' },
    { name: 'a null observation time', observedAt: null, freshUntil: '2026-10-13T09:48:00Z', state: 'healthy' },
    { name: 'a malformed observation time', observedAt: 'bad-date', freshUntil: '2026-10-13T09:48:00Z', state: 'healthy' },
    { name: 'an obsolete revision', observedAt: '2026-10-13T09:45:00Z', freshUntil: '2026-10-13T09:48:00Z', state: 'healthy', configRevision: 'an-older-revision' },
    { name: 'a matching revision', observedAt: '2026-10-13T09:45:00Z', freshUntil: '2026-10-13T09:48:00Z', state: 'healthy', configRevision: current },
    { name: 'a fresh unknown state', observedAt: '2026-10-13T09:45:00Z', freshUntil: '2026-10-13T09:48:00Z', state: 'unknown' },
    { name: 'a fresh state outside the enum', observedAt: '2026-10-13T09:45:00Z', freshUntil: '2026-10-13T09:48:00Z', state: 'bogus' },
    { name: 'a fresh constrained state', observedAt: '2026-10-13T09:45:00Z', freshUntil: '2026-10-13T09:48:00Z', state: 'constrained' },
  ];
  for (const c of CASES) {
    const entry = { routeId: 'r', observedAt: c.observedAt, freshUntil: c.freshUntil, status: { state: c.state } };
    if (c.configRevision) entry.configRevision = c.configRevision;
    // The gate is CALLED, never copied: the expectation is what the gate
    // decides, and the view must match it.
    const decision = decide({ route: cfgRoute, entry, now: NOW, config: { gate: { mode: 'deny' } } });
    // The gate is CALLED, never copied. A plain allow is the gate failing
    // open: it proves nothing about the quota, so only a state the gate
    // could read as capacity makes the route eligible.
    assert.strictEqual(typeof decision.action, 'string', `the gate decided: ${c.name}`);
    const view = vm.buildViewSchema({
      routes: [route('r', 'minimax', 'token-plan', {
        state: observed(c.state),
        observedAt: c.observedAt === null ? unknown('no-cached-observation') : observed(c.observedAt),
        freshUntil: c.freshUntil === null ? unknown('no-cached-observation') : observed(c.freshUntil),
      })],
    }, { gate: gateContext({ r: entry }, { r: cfgRoute }, NOW), now: NOW }).routes[0];
    const expected = decision.action === 'deny'
      ? 'ineligible'
      : (decision.refresh === true
        ? 'unresolved'
        : (['healthy', 'constrained'].includes(entry.status.state) && view.freshness === 'fresh'
          ? 'eligible'
          : 'unresolved'));
    assert.strictEqual(view.quotaEligibility, expected,
      `the eligibility follows the gate's decision: ${c.name} (gate: ${decision.action}${decision.refresh ? '+refresh' : ''})`);
    if (view.state === 'unknown') {
      assert.notStrictEqual(view.quotaEligibility, 'eligible',
        `an unknown state is never eligible: ${c.name}`);
    }
  }
}

// ---- ONE freshness predicate, ONE state rule: routes and profiles alike ---

{
  // The same cases, run through the route path and the profile path. The two
  // paths must answer identically: a missing, null or malformed deadline is
  // UNPROVEN, never "fresh until further notice", and a non-current
  // observation never carries a state.
  const CASES = [
    {
      name: 'a current deadline',
      observedAt: '2026-10-13T09:45:00Z', freshUntil: '2099-01-01T00:00:00Z',
      freshness: 'fresh', state: 'healthy', reason: null,
    },
    {
      name: 'an expired deadline',
      observedAt: '2026-10-13T09:40:00Z', freshUntil: '2026-10-13T09:45:00Z',
      freshness: 'stale', state: 'unknown', reason: 'stale-observation',
    },
    {
      name: 'a missing deadline',
      observedAt: '2026-10-13T09:45:00Z', freshUntil: null,
      freshness: 'unknown', state: 'unknown', reason: 'freshness-unproven',
    },
    {
      name: 'a malformed deadline',
      observedAt: '2026-10-13T09:45:00Z', freshUntil: 'bad-date',
      freshness: 'unknown', state: 'unknown', reason: 'freshness-unproven',
    },
    {
      name: 'a 2020 observation without a deadline',
      observedAt: '2020-01-01T00:00:00Z', freshUntil: null,
      freshness: 'unknown', state: 'unknown', reason: 'freshness-unproven',
    },
    {
      name: 'a missing observation time',
      observedAt: null, freshUntil: '2099-01-01T00:00:00Z',
      freshness: 'unknown', state: 'unknown', reason: 'freshness-unproven',
    },
  ];
  for (const c of CASES) {
    const routeSchema = vm.buildViewSchema({
      routes: [route('r', 'minimax', 'token-plan', {
        state: observed('healthy'),
        observedAt: c.observedAt === null ? unknown('no-cached-observation') : observed(c.observedAt),
        freshUntil: c.freshUntil === null ? unknown('no-cached-observation') : observed(c.freshUntil),
      })],
    }, { now: NOW }).routes[0];
    const profileSchema = vm.buildViewSchema({
      routes: [],
      profiles: [{
        key: { host: 'mac', provider: 'claude-code', profileId: 'ambient' },
        nativeRateLimits: {
          value: { provider: 'claude-code', available: true, fiveHour: { usedPercent: 36 } },
          provenance: 'observed',
          observedAt: c.observedAt,
          freshUntil: c.freshUntil,
        },
      }],
    }, { now: NOW }).profiles[0];
    assert.strictEqual(routeSchema.freshness, c.freshness, `route freshness: ${c.name}`);
    assert.strictEqual(profileSchema.freshness, c.freshness, `profile freshness: ${c.name}`);
    assert.strictEqual(routeSchema.state, c.state, `route state: ${c.name}`);
    assert.strictEqual(profileSchema.state, c.state, `profile state: ${c.name}`);
    if (c.reason) {
      assert.ok(routeSchema.reasonCodes.includes(c.reason), `route reason: ${c.name}`);
      assert.ok(profileSchema.reasonCodes.includes(c.reason), `profile reason: ${c.name}`);
    }
  }
}

// ---- reauth is structured and validated ------------------------------------

{
  assert.deepStrictEqual(vm.validateReauthUrl('https://platform.xiaomimimo.com/'),
    { value: 'https://platform.xiaomimimo.com/', reasonCodes: [] });
  assert.strictEqual(vm.validateReauthUrl('http://platform.xiaomimimo.com/').value, null, 'https only');
  assert.strictEqual(vm.validateReauthUrl('https://user:pw@platform.xiaomimimo.com/').value, null, 'no userinfo');
  assert.strictEqual(vm.validateReauthUrl('https://platform.xiaomimimo.com/?token=secret').value, null, 'no query');
  assert.strictEqual(vm.validateReauthUrl('not a url').value, null);
  assert.strictEqual(vm.validateReauthUrl('').value, null);
  assert.strictEqual(vm.validateReauthUrl(null).value, null);
  assert.deepStrictEqual(vm.validateReauthUrl('http://x.example/').reasonCodes, ['reauth-url-invalid']);

  // A URL that carries a control character or whitespace is refused: the URL
  // parser strips tab and newline silently, so it would otherwise parse
  // cleanly and then reach the route line as a second one.
  assert.strictEqual(vm.validateReauthUrl('https://host.example/\n    evil-route: healthy').value, null);
  assert.strictEqual(vm.validateReauthUrl('https://host.example/\tlogin').value, null);
  assert.strictEqual(vm.validateReauthUrl('https://host.example/\u009blogin').value, null);
  assert.strictEqual(vm.validateReauthUrl('https://host.example\\login').value, null);
  assert.strictEqual(vm.validateReauthUrl('https://host.example/a b').value, null);

  const snapshot = { routes: [route('r', 'xiaomi', 'token-plan', {
    state: observed('unknown'),
    reauth: { reason: 'auth-expired', url: 'http://insecure.example/login' },
  })] };
  const r = vm.buildViewSchema(snapshot).routes[0];
  assert.strictEqual(r.reauth.required, true);
  assert.strictEqual(r.reauth.reason, 'auth-expired');
  assert.strictEqual(r.reauth.url, null, 'an invalid URL is never displayed');
  assert.ok(r.reasonCodes.includes('reauth-url-invalid'));
  assert.ok(r.reasonCodes.includes('reauth-required'));

  // A reauth URL that carries a newline cannot become a second route line.
  const hostile = { routes: [route('r2', 'xiaomi', 'token-plan', {
    state: observed('unknown'),
    reauth: { reason: 'auth-expired', url: 'https://host.example/\n    evil-route: healthy' },
  })] };
  const hostileRoute = vm.buildViewSchema(hostile).routes[0];
  assert.strictEqual(hostileRoute.reauth.url, null, 'a URL with a newline is refused');
  assert.ok(hostileRoute.reasonCodes.includes('reauth-url-invalid'));
  const hostileLines = vm.renderViewText(vm.buildViewSchema(hostile)).join('\n').split('\n');
  assert.ok(!hostileLines.some((l) => /^\s*evil-route/.test(l)), 'no fabricated route line');
}

// ---- the reported period end is disclosed, never a reset --------------------

{
  const snapshot = { routes: [route('r', 'xiaomi', 'token-plan', {
    periodEnd: observed('2026-11-07 23:59:59'),
    windows: [{ type: 'tokens', remaining: 12000000, limit: 20000000 }],
  })] };
  const text = vm.renderViewText(vm.buildViewSchema(snapshot)).join('\n');
  assert.ok(text.includes('Period   ends 2026-11-07 23:59:59 (reported)'), 'the period end is disclosed');
  assert.ok(!text.includes('Reset'), 'a period end is not a reset');
}

// ---- #88: control characters cannot fabricate a route line -----------------

{
  const hostile = 'boom\n    evil-route: healthy · fake';
  const escape = vm.escapeControlChars;
  assert.strictEqual(escape(hostile), 'boom\\n    evil-route: healthy · fake');
  assert.strictEqual(escape('a\rb'), 'a\\rb');
  assert.strictEqual(escape('a\tb'), 'a\\tb');
  assert.strictEqual(escape('a\u001bb'), 'a\\u001bb');
  assert.strictEqual(escape('a\u0000b'), 'a\\u0000b');
  // The C1 range reaches the terminal too: NEL and CSI among them.
  assert.strictEqual(escape('a\u009bb'), 'a\\u009bb');
  assert.strictEqual(escape('a\u0085b'), 'a\\u0085b');
  assert.strictEqual(escape('a\u007fb'), 'a\\u007fb');
  assert.strictEqual(escape('plain text'), 'plain text', 'a value without control characters is untouched');
  assert.strictEqual(escape('say "hi"'), 'say "hi"', 'quotes are not escaped: the text stays byte-identical');
  assert.strictEqual(escape('café'), 'café', 'a non-ASCII value is untouched');
  assert.strictEqual(escape(null), '');

  // A provider error may not fabricate a route line.
  const snapshot = { routes: [route('r', 'minimax', 'token-plan', {
    state: observed('unknown'),
    error: hostile,
  })] };
  const lines = vm.renderViewText(vm.buildViewSchema(snapshot)).join('\n').split('\n');
  assert.ok(!lines.some((l) => /^\s*evil-route/.test(l)), 'no fabricated route line');
  assert.ok(lines.some((l) => l.includes('boom\\n    evil-route')), 'the newline is escaped, not dropped');

  // The structured JSON keeps the ORIGINAL value.
  const r = vm.buildViewSchema(snapshot).routes[0];
  assert.strictEqual(r.error, hostile, 'the JSON carries the raw value');
}

// ---- #88: the report text paths stay byte-identical for clean values -------

{
  // The reauth note, the error note and the binding strings are unchanged for
  // values that carry no control characters.
  assert.strictEqual(vm.reauthNote({ profile: 'Default' }),
    'session unavailable — open https://platform.xiaomimimo.com/ in Chrome (profile Default) and log in if needed; next refresh checks for new cookies');
  assert.strictEqual(vm.reauthNote({ url: 'https://other.example/' }),
    'session unavailable — open https://other.example/ in Chrome and log in if needed; next refresh checks for new cookies');

  const snapshot = { routes: [route('r', 'minimax', 'token-plan', {
    state: observed('unknown'),
    error: 'provider said no',
    boundBy: [{ harness: 'claude', host: 'mac' }],
  })] };
  const text = vm.renderViewText(vm.buildViewSchema(snapshot)).join('\n');
  assert.ok(text.includes('provider said no'));
}

// ---- R1: no raw template interpolation of model fields ---------------------
//
// The field list is DERIVED from the fixture, so a string field added to the
// fixture later is covered here without touching this test. Every provider-
// or config-derived string that reaches a rendered line must go through the
// one sanitizer: a control character in any of them may not add a line nor
// appear raw in the output.

function stringLeaves(node, path = [], out = []) {
  if (typeof node === 'string') { out.push({ path, value: node }); return out; }
  if (Array.isArray(node)) { node.forEach((v, i) => stringLeaves(v, path.concat(i), out)); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) stringLeaves(v, path.concat(k), out);
  }
  return out;
}

function cloneNode(node) { return JSON.parse(JSON.stringify(node)); }

function setAt(node, path, value) {
  let cur = node;
  for (let i = 0; i < path.length - 1; i += 1) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
}

{
  // A route with EVERY string field populated: the provider, the account,
  // the window type, the currency, the reset, the error, the reauth URL and
  // profile, the period end, the state reason, the bindings.
  //
  // The variants are the MUTUALLY EXCLUSIVE branches of the note: the reauth
  // branch takes priority over the error branch, which takes priority over
  // the state reason. A variant per branch, or a branch stays masked and the
  // enumeration alone would not prove it.
  const VARIANTS = [
    {
      name: 'the reauth branch',
      resource: {
        state: observed('unknown'),
        reauth: { reason: 'auth-expired', url: 'https://platform.xiaomimimo.com/', profile: 'Default' },
        error: 'provider error',
      },
    },
    {
      name: 'the error branch',
      resource: {
        state: observed('unknown'),
        reauth: null,
        error: 'provider error',
      },
    },
    {
      name: 'the state-reason branch',
      resource: {
        state: unknown('the reason'),
        reauth: null,
        error: null,
      },
    },
    {
      name: 'a known state (no note at all)',
      resource: {
        state: observed('healthy'),
        reauth: null,
        error: null,
      },
    },
  ];

  const base = (resource) => ({
    generatedAt: '2026-10-13T09:46:00Z',
    routes: [{
      id: 'minimax-token-plan',
      configured: true,
      provider: configured('minimax'),
      account: configured('token-plan'),
      pool: configured({ provider: 'minimax', account: 'token-plan' }),
      boundBy: [{ harness: 'claude', host: 'mac', surface: 'cli' }],
      resource: {
        state: observed('healthy'),
        windows: [{ type: 'rolling-5h', remaining: 72, limit: 100, resetAt: '2026-10-13T12:00:00Z' }],
        balance: { available: 8.42, currency: 'USD', spent: { daily: 1.32, weekly: 6.84 } },
        error: null,
        reauth: null,
        basis: observed('quota-window'),
        periodEnd: observed('2026-11-07 23:59:59'),
        resetAt: observed('2026-10-13T12:00:00Z'),
        observedAt: observed('2026-10-13T09:45:00Z'),
        freshUntil: observed('2099-01-01T00:00:00Z'),
        freshness: 'fresh',
        source: observed('adapter'),
        ...resource,
      },
    }],
  });

  const controls = ['\n', '\r', '\x1b', '\u0085', '\u009b'];
  for (const variant of VARIANTS) {
    const fixture = base(variant.resource);
    const cleanSchema = vm.buildViewSchema(fixture);
    const cleanExpanded = vm.renderViewText(cleanSchema, { now: NOW, timeZone: TZ });
    const cleanCondensed = vm.renderViewText(cleanSchema, { now: NOW, timeZone: TZ, condensed: true });
    const fields = stringLeaves(fixture);
    assert.ok(fields.length >= 20, `${variant.name}: the fixture carries string fields (${fields.length})`);
    for (const { path } of fields) {
      for (const ch of controls) {
        const dirty = cloneNode(fixture);
        setAt(dirty, path, `FORGED${ch}FORGED`);
        const schema = vm.buildViewSchema(dirty);
        const expanded = vm.renderViewText(schema, { now: NOW, timeZone: TZ });
        const condensed = vm.renderViewText(schema, { now: NOW, timeZone: TZ, condensed: true });
        const where = `${variant.name}: ${path.join('.')}`;
        assert.strictEqual(expanded.length, cleanExpanded.length,
          `the expanded text gained or lost a line for ${where}`);
        assert.strictEqual(condensed.length, cleanCondensed.length,
          `the condensed text gained or lost a line for ${where}`);
        assert.ok(expanded.every((l) => !l.includes(ch)), `the raw control character reached the expanded text at ${where}`);
        assert.ok(condensed.every((l) => !l.includes(ch)), `the raw control character reached the condensed text at ${where}`);
      }
    }
  }
}

// ---- R2: a provider key never resolves to an inherited object member -------

{
  for (const key of ['constructor', '__proto__', 'toString', 'valueOf']) {
    const snapshot = { routes: [route('r', 'minimax', 'token-plan', { windows: [{ type: key, remaining: 5, limit: 10 }] })] };
    const schema = vm.buildViewSchema(snapshot);
    const expanded = vm.renderViewText(schema, { now: NOW, timeZone: TZ }).join('\n');
    const condensed = vm.renderViewText(schema, { now: NOW, timeZone: TZ, condensed: true }).join('\n');
    assert.ok(expanded.includes(key), `the unknown window type keeps its own name (${key})`);
    assert.ok(condensed.includes(key), `the unknown window type keeps its own name (${key})`);
    assert.ok(!expanded.includes('function Object'), 'no inherited member leaked into the text');
    assert.ok(!expanded.includes('[object'), 'no inherited member leaked into the text');

    // The same key as a provider id and as a recipe id.
    const asProvider = vm.buildViewSchema({ routes: [route('p', key, 'token-plan', {})] });
    assert.strictEqual(asProvider.routes[0].label, 'p', 'an unknown provider falls back to the route id');
    const asRecipe = vm.buildViewSchema({ routes: [route('q', 'minimax', 'token-plan', {})] }, { recipeOf: { q: key } });
    assert.strictEqual(asRecipe.routes[0].label, 'MiniMax', 'an unknown recipe falls back to the provider name');
  }
}

// ---- R4: a percent-only window is rendered in both layouts ------------------

{
  const snapshot = {
    routes: [
      route('a', 'minimax', 'token-plan', {
        state: observed('healthy'),
        windows: [{ type: 'rolling-5h', remaining: 72, limit: 100 }],
      }),
      route('b', 'kimi', 'code-plan', {
        state: observed('unknown'),
        windows: [{ type: 'weekly', percent: 50 }],
      }),
      route('c', 'xiaomi', 'token-plan', {
        state: observed('unknown'),
        basis: observed('token-count'),
        windows: [{ type: 'tokens', remaining: 120, limit: 200 }],
      }),
    ],
  };
  const schema = vm.buildViewSchema(snapshot);
  const expanded = vm.renderViewText(schema, { now: NOW, timeZone: TZ });
  const condensed = vm.renderViewText(schema, { now: NOW, timeZone: TZ, condensed: true });

  // The percentage-only window keeps its ratio and its null counts.
  const percentWindow = schema.routes.find((r) => r.id === 'b').windows[0];
  assert.strictEqual(percentWindow.remaining, null);
  assert.strictEqual(percentWindow.limit, null);
  assert.strictEqual(percentWindow.remainingRatio, 0.5);

  // It is rendered as the plain percentage, with no bar, in BOTH layouts.
  assert.ok(expanded.some((l) => l.includes('50% left')), 'the percentage is rendered in the expanded view');
  assert.ok(!expanded.some((l) => l.includes('50% left') && l.includes('[')), 'without a bar');
  assert.ok(condensed.some((l) => l.includes('Weekly') && l.includes('50%')), 'the percentage is rendered in the condensed view');

  // Window-level parity: every window the schema carries appears in both
  // text layouts.
  for (const route of schema.routes) {
    const known = route.state === 'healthy' || route.state === 'constrained' || route.state === 'exhausted';
    for (const w of route.windows) {
      // What the text shows for this window: the percentage for a barred
      // window, the counts when they are known, the percentage otherwise.
      let marker;
      if (known && w.remainingRatio !== null) marker = `${Math.round(w.remainingRatio * 100)}%`;
      else if (w.remaining !== null) marker = `${w.remaining} / ${w.limit}`;
      else marker = `${Math.round(w.remainingRatio * 100)}%`;
      assert.ok(expanded.some((l) => l.includes(marker)), `the expanded view shows ${marker}`);
      assert.ok(condensed.some((l) => l.includes(marker)), `the condensed view shows ${marker}`);
    }
  }
}

// ---- R5: a cached state or basis outside its enum is not a fact ------------

{
  const badState = vm.buildViewSchema({ routes: [route('s', 'minimax', 'token-plan', { state: observed('banana') })] });
  assert.strictEqual(badState.routes[0].state, 'unknown', 'an invalid state becomes unknown');
  assert.ok(badState.routes[0].reasonCodes.includes('invalid-state'));

  const badBasis = vm.buildViewSchema({ routes: [route('b', 'minimax', 'token-plan', { basis: observed('banana') })] });
  assert.ok(['quota-window', 'token-count', 'balance', 'none'].includes(badBasis.routes[0].basis),
    'an invalid basis is re-derived, never carried through');
  assert.notStrictEqual(badBasis.routes[0].basis, 'banana');
  assert.ok(badBasis.routes[0].reasonCodes.includes('invalid-basis'));
}

// ---- R3: the native profile projection --------------------------------------

{
  const snapshot = {
    generatedAt: '2026-10-13T09:46:00Z',
    routes: [],
    profiles: [{
      key: { host: 'mac', provider: 'claude-code', profileId: 'ambient' },
      harness: observed('claude'),
      authStatus: observed('ok'),
      rateLimitStatus: observed('healthy'),
      usageUpdatedAt: observed('2026-10-13T09:45:00Z'),
      nativeRateLimits: {
        value: {
          provider: 'claude-code',
          available: true,
          fiveHour: { usedPercent: 36, resetsAt: 1790067599749, durationMinutes: 300 },
        },
        provenance: 'observed',
        observedAt: '2026-10-13T09:45:00Z',
        // A CURRENT deadline: without one the fact's currency is unproven,
        // so the profile stays unknown (the table above pins both paths).
        freshUntil: '2099-01-01T00:00:00Z',
      },
    }],
  };
  const schema = vm.buildViewSchema(snapshot, { now: NOW });
  assert.strictEqual(schema.profiles.length, 1, 'the native profile is carried');
  const profile = schema.profiles[0];
  assert.deepStrictEqual(profile.identity, { host: 'mac', provider: 'claude-code', profileId: 'ambient' });
  assert.strictEqual(profile.harness, 'claude');
  assert.strictEqual(profile.state, 'healthy');
  assert.strictEqual(profile.freshness, 'fresh');
  assert.strictEqual(profile.observedAt, '2026-10-13T09:45:00Z');
  assert.strictEqual(profile.windows.length, 1);
  assert.strictEqual(profile.windows[0].type, 'rolling-5h');
  assert.strictEqual(profile.windows[0].remainingRatio, 0.64);
  assert.strictEqual(profile.windows[0].remaining, 64);
  assert.strictEqual(profile.windows[0].limit, 100);
  assert.deepStrictEqual(profile.reasonCodes, []);

  // A native fact with NO expiry is not fresh until further notice: its
  // currency is unproven, so the profile keeps its identity and its typed
  // windows but never claims a state.
  const unproven = vm.buildViewSchema({
    routes: [],
    profiles: [{
      key: { host: 'mac', provider: 'claude-code', profileId: 'ambient' },
      nativeRateLimits: {
        value: { provider: 'claude-code', available: true, fiveHour: { usedPercent: 36 } },
        provenance: 'observed',
        observedAt: '2026-10-13T09:45:00Z',
        freshUntil: null,
      },
    }],
  }, { now: NOW }).profiles[0];
  assert.strictEqual(unproven.state, 'unknown');
  assert.strictEqual(unproven.freshness, 'unknown');
  assert.ok(unproven.reasonCodes.includes('freshness-unproven'));
  assert.strictEqual(unproven.windows.length, 1, 'the typed windows are kept');
  assert.strictEqual(unproven.windows[0].remainingRatio, 0.64);

  // No native facts: the profile is kept, its state unknown, never promoted.
  const unknownNative = vm.buildViewSchema({
    routes: [],
    profiles: [{
      key: { host: 'mac', provider: 'codex', profileId: 'ambient' },
      nativeRateLimits: unknown('traycer-field-absent'),
    }],
  }, { now: NOW });
  assert.strictEqual(unknownNative.profiles.length, 1);
  assert.strictEqual(unknownNative.profiles[0].state, 'unknown');
  assert.strictEqual(unknownNative.profiles[0].freshness, 'unknown');
  assert.deepStrictEqual(unknownNative.profiles[0].windows, []);
  assert.ok(unknownNative.profiles[0].reasonCodes.includes('no-native-facts'));

  // No profiles at all: an empty array, still a valid document.
  assert.deepStrictEqual(vm.buildViewSchema({ routes: [] }).profiles, []);
}

console.log('view-schema: PASS');
