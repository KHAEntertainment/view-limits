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
      freshUntil: observed('2026-10-13T09:48:00Z'),
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
  const schema = vm.buildViewSchema(approvedSnapshot);
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
  assert.strictEqual(byId['minimax-token-plan'].freshUntil, '2026-10-13T09:48:00Z');
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
  assert.ok(r.reasonCodes.includes('state-unknown'));

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
  const stale = '2020-01-01T00:00:00Z';

  const eligible = vm.buildViewSchema({ routes: [healthy] }, {
    gate: gateContext({ r: entry('healthy', fresh) }, { r: cfgRoute }, NOW),
  }).routes[0];
  assert.strictEqual(eligible.quotaEligibility, 'eligible');

  const ineligible = vm.buildViewSchema({ routes: [exhausted] }, {
    gate: gateContext({ r: entry('exhausted', fresh) }, { r: cfgRoute }, NOW),
  }).routes[0];
  assert.strictEqual(ineligible.quotaEligibility, 'ineligible');
  assert.ok(ineligible.reasonCodes.includes('fresh-exhausted'));

  const unresolved = vm.buildViewSchema({ routes: [unknownState] }, {
    gate: gateContext({ r: entry('unknown', fresh) }, { r: cfgRoute }, NOW),
  }).routes[0];
  assert.strictEqual(unresolved.quotaEligibility, 'unresolved');

  // A stale entry is never eligible — the gate would not act on it.
  const staleEntry = route('r', 'minimax', 'token-plan', { state: observed('healthy'), freshness: 'stale' });
  const notFresh = vm.buildViewSchema({ routes: [staleEntry] }, {
    gate: gateContext({ r: entry('healthy', stale) }, { r: cfgRoute }, NOW),
  }).routes[0];
  assert.strictEqual(notFresh.quotaEligibility, 'unresolved');
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
  assert.strictEqual(escape('plain text'), 'plain text', 'a value without control characters is untouched');
  assert.strictEqual(escape('say "hi"'), 'say "hi"', 'quotes are not escaped: the text stays byte-identical');
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

console.log('view-schema: PASS');
