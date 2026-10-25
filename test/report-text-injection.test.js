'use strict';
// Every-leaf injection test over the LEGACY report/status text path.
//
// #88 escaped the VIEW SCHEMA path (`vl view`, renderViewText). The legacy
// report path was never covered: bin/vl.js renderInventory is exactly
// `buildViewModel(snap, updatedAt).lines.join('\n')`, and buildViewModel drives
// the four legacy renderers - renderRouteText, renderHarnessText,
// renderSessionText, renderProfileText. A provider- or config-derived string
// carrying a newline reached stdout raw, so `vl report` / `vl status` could
// print a forged line (a fake healthy route row) to the agent that reads it
// before dispatching.
//
// This is the same every-leaf injection as test/view-schema.test.js:
// `FORGED${ch}FORGED` for \n \r ESC ENQ CSI into EVERY string leaf of a rich
// fixture, then the rendered text must keep its line count and must never
// contain the raw control character.
//
// If this test fails, a raw control character reached a rendered line. That is
// a real injection in production code, not a test bug.
//
// The fixtures cover every branch of the legacy text: the balance, usage and
// window quota branches; the xiaomi reauth, provider-error and state-reason
// notes; the stale suffix; a populated and an empty runtime pool; and a
// diagnostic notice.

const assert = require('assert');
const vm = require('../lib/view-model');

// The control characters the issue names: a newline, a carriage return, ESC,
// ENQ and the CSI introducer.
const CONTROLS = ['\n', '\r', '\x1b', '\x05', '\x1b['];
const UPDATED_AT = '2026-10-13T09:46:00Z';

// A fact, as lib/runtime-snapshot.js emits it.
const observed = (value, extra = {}) => ({
  value, provenance: 'observed', source: 'status.json', observedAt: null, freshUntil: null, reason: null, ...extra,
});
const configured = (value) => ({
  value, provenance: 'configured', source: 'config', observedAt: null, freshUntil: null, reason: null,
});
const unknown = (reason) => ({
  value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason,
});

// Every string leaf of the fixture, by path.
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

// The caller facts - every one of them reaches the requester / models /
// selection lines.
const CALLER = {
  ade: configured('traycer'),
  agentId: configured('agent-1'),
  epicId: configured('epic-1'),
  harness: configured('claude'),
  surface: configured('cli'),
  host: configured('host.local'),
  configuredModel: configured('model-a'),
  defaultModel: configured('model-b'),
  effectiveModel: configured('model-c'),
  differsFromDefault: configured(true),
  selectedProfile: configured('profile-a'),
  selectedAccount: configured('account-a'),
};

// One route per branch of the legacy route text.
const ROUTES = [
  {
    // balance + spending cap + a binding + models + the plan period.
    id: 'minimax-token-plan',
    configured: true,
    provider: configured('minimax'),
    account: configured('token-plan'),
    boundBy: [{ harness: 'claude', host: 'host.local', surface: 'cli' }],
    models: configured(['model-a', 'model-b']),
    resource: {
      state: observed('healthy'),
      windows: [{ type: 'rolling-5h', remaining: 72, limit: 100, resetAt: '2026-10-13T12:00:00Z' }],
      balance: {
        available: 8.42,
        currency: 'USD',
        spent: { daily: 1.32, weekly: 6.84 },
        limit: { amount: 20, period: 'monthly' },
      },
      error: null,
      reauth: null,
      basis: observed('quota-window'),
      periodEnd: observed('2026-11-07 23:59:59'),
      resetAt: observed('2026-10-13T12:00:00Z'),
      observedAt: observed('2026-10-13T09:45:00Z'),
      freshUntil: observed('2099-01-01T00:00:00Z'),
      freshness: 'fresh',
      source: observed('adapter'),
    },
  },
  {
    // the usage branch (no balance): the usage currency reaches the text.
    id: 'kimi-code-plan',
    configured: true,
    provider: configured('kimi'),
    resource: {
      state: observed('constrained'),
      usage: { daily: 1.5, weekly: 3.5, monthly: 7.25, currency: 'USD' },
      error: null,
      reauth: null,
      freshness: 'fresh',
    },
  },
  {
    // the window branch: both the percent form and the raw counts form.
    id: 'deepseek-token-plan',
    configured: true,
    provider: configured('deepseek'),
    resource: {
      state: observed('healthy'),
      windows: [
        { type: 'rolling-5h', remaining: 72, limit: 100, resetAt: '2026-10-13T12:00:00Z' },
        { type: 'weekly', remaining: 3, limit: 0, resetAt: '2026-10-13T12:00:00Z' },
      ],
      error: null,
      reauth: null,
      freshness: 'fresh',
    },
  },
  {
    // the xiaomi reauth branch (the reauth note wins over the error note).
    id: 'xiaomi-token-plan',
    configured: true,
    provider: configured('xiaomi'),
    resource: {
      state: unknown('the state reason'),
      reauth: { reason: 'auth-expired', url: 'https://platform.xiaomimimo.com/', profile: 'Default' },
      error: 'provider error',
      freshness: 'fresh',
    },
  },
  {
    // the provider-error branch: the error text and the rotate hint.
    id: 'openrouter-token-plan',
    configured: true,
    provider: configured('openrouter'),
    resource: {
      state: unknown('the reason'),
      error: 'provider error',
      reauth: null,
      freshness: 'fresh',
    },
  },
  {
    // the state-reason branch (no error, no reauth).
    id: 'glm-token-plan',
    configured: true,
    provider: configured('glm'),
    resource: {
      state: unknown('the reason'),
      error: null,
      reauth: null,
      freshness: 'fresh',
    },
  },
  {
    // a stale route: the stale suffix and the stale count.
    id: 'stale-token-plan',
    configured: true,
    provider: configured('minimax'),
    resource: {
      state: observed('unknown'),
      windows: [{ type: 'monthly', remaining: 1, limit: 10 }],
      error: null,
      reauth: null,
      freshness: 'stale',
    },
  },
];

const VARIANTS = [
  {
    name: 'a populated runtime pool',
    fixture: {
      generatedAt: '2026-10-13T09:46:00Z',
      completeness: 'complete',
      caller: CALLER,
      harnesses: [
        {
          key: { harness: 'claude', surface: 'cli', host: 'host.local' },
          available: observed(true),
          sessionRefs: ['s1'],
          resourceRefs: ['r1'],
          defaults: { model: configured('model-a') },
        },
        {
          // availability unknown: the reason reaches the harness line.
          key: { harness: 'codex', surface: 'tui', host: 'host.local' },
          available: unknown('no runtime snapshot'),
          sessionRefs: [],
          resourceRefs: [],
          defaults: {},
        },
      ],
      sessions: [{
        key: { agentId: 'agent-1', host: 'host.local' },
        harness: observed('claude'),
        surface: observed('cli'),
        title: observed('a session title'),
        active: observed(true),
        isSelf: observed(false),
      }],
      profiles: [{
        key: { provider: 'minimax', profileId: 'profile-a', host: 'host.local' },
        authStatus: observed('ok'),
        rateLimitStatus: observed('constrained'),
        usageUpdatedAt: observed('2026-10-13T09:45:00Z'),
        nativeRateLimits: observed(true),
      }],
      routes: ROUTES,
      diagnostics: [{ scope: 'runtime-pool', code: 'cache-stale', summary: 'a diagnostic summary' }],
    },
  },
  {
    // The empty pool: the pool-reason summary is the only diagnostic text.
    name: 'an empty runtime pool',
    fixture: {
      generatedAt: '2026-10-13T09:46:00Z',
      completeness: 'partial',
      caller: CALLER,
      harnesses: [],
      sessions: [],
      profiles: [],
      routes: ROUTES,
      diagnostics: [{
        scope: 'runtime-pool',
        code: 'runtime-pool-cache-empty',
        summary: 'no runtime pool facts were cached',
      }],
    },
  },
];

// The four legacy renderers, reached through the view model. renderInventory
// (bin/vl.js) is exactly `buildViewModel(...).lines.join('\n')`.
function renderedLines(model) {
  return [
    ...model.harnessPool.harnesses.map((h) => h.line),
    ...model.harnessPool.sessions.map((s) => s.line),
    ...model.harnessPool.profiles.map((p) => p.line),
    ...model.routes.map((r) => r.line),
  ];
}

const leafCounts = [];
let totalLeaves = 0;

// The minimum count is over the leaves that REACH the rendered text, not
// over every string leaf of the fixture: many leaves of a fact (its
// provenance, its source) never reach a line, so a floor over all of them
// would keep the test green even if a renderer stopped rendering leaves
// altogether. The floors sit just under the counts the fixtures reach today
// (65 and 45), so a renderer that drops leaves trips the assert.
const MIN_REACHED = { 'a populated runtime pool': 60, 'an empty runtime pool': 40 };

for (const variant of VARIANTS) {
  const leaves = stringLeaves(variant.fixture);
  totalLeaves += leaves.length;
  assert.ok(leaves.length >= 60,
    `${variant.name}: the fixture carries enough string fields to be meaningful (${leaves.length})`);

  const clean = vm.buildViewModel(cloneNode(variant.fixture), UPDATED_AT);
  const cleanText = clean.lines.join('\n');
  assert.ok(clean.lines.length > 0, `${variant.name}: the renderer produced text to check`);
  assert.strictEqual(cleanText.split('\n').length, clean.lines.length,
    `${variant.name}: the clean report holds no forged line`);

  // The four renderers are driven by buildViewModel: each of their lines is
  // one line of the report.
  for (const line of renderedLines(clean)) {
    assert.ok(cleanText.includes(line),
      `${variant.name}: a rendered line is missing from the report: ${line}`);
    assert.strictEqual(line.split('\n').length, 1,
      `${variant.name}: a rendered line carries a newline: ${line}`);
  }

  const reaching = new Set();

  for (const { path } of leaves) {
    for (const ch of CONTROLS) {
      const dirtyFixture = cloneNode(variant.fixture);
      setAt(dirtyFixture, path, `FORGED${ch}FORGED`);
      const dirty = vm.buildViewModel(dirtyFixture, UPDATED_AT);
      const dirtyText = dirty.lines.join('\n');
      const where = `${variant.name}: ${path.join('.')}`;
      if (dirtyText !== cleanText) reaching.add(path.join('.'));
      assert.strictEqual(dirty.lines.length, clean.lines.length,
        `${where}: the report gained or lost a line`);
      assert.strictEqual(dirtyText.split('\n').length, cleanText.split('\n').length,
        `${where}: the report gained or lost a line`);
      assert.ok(dirty.lines.every((l) => !l.includes(ch)),
        `${where}: the raw control character reached the report`);
      for (const line of renderedLines(dirty)) {
        assert.ok(!line.includes(ch),
          `${where}: the raw control character reached a rendered line`);
        assert.strictEqual(line.split('\n').length, 1,
          `${where}: a rendered line carries a newline`);
      }
    }
  }

  // The sweep must not become vacuous: the leaves that DO reach the text
  // must be many enough to cover every renderer.
  assert.ok(reaching.size >= MIN_REACHED[variant.name],
    `${variant.name}: too few leaves reach the rendered text (${reaching.size}, floor ${MIN_REACHED[variant.name]})`);
  leafCounts.push(`${variant.name}: ${leaves.length} leaves, ${reaching.size} reach the text`);
}

// ---- the hostile value is ESCAPED, not dropped ------------------------------
//
// The every-leaf sweep above proves that no raw control character reaches the
// text. This proves the other half: the value still reaches it, in its
// escaped form. A renderer that dropped the field would pass the sweep.

{
  const marker = `FORGED${CONTROLS[0]}FORGED`;
  const escaped = vm.escapeControlChars(marker);
  // One field per renderer, plus the fields that carry a provider's own
  // words: each must still reach the text, in its escaped form.
  const FIELDS = [
    ['generatedAt'],
    ['caller', 'agentId', 'value'],
    ['harnesses', 0, 'key', 'harness'],
    ['harnesses', 1, 'available', 'reason'],
    ['sessions', 0, 'title', 'value'],
    ['profiles', 0, 'key', 'provider'],
    ['profiles', 0, 'authStatus', 'value'],
    ['routes', 0, 'id'],
    ['routes', 0, 'resource', 'balance', 'currency'],
    ['routes', 0, 'resource', 'balance', 'limit', 'period'],
    ['routes', 2, 'resource', 'windows', 0, 'type'],
    ['routes', 0, 'models', 'value', 0],
    ['routes', 4, 'resource', 'error'],
  ];
  const cleanCount = vm.buildViewModel(cloneNode(VARIANTS[0].fixture), UPDATED_AT)
    .lines.join('\n').split('\n').length;
  for (const path of FIELDS) {
    const fixture = cloneNode(VARIANTS[0].fixture);
    setAt(fixture, path, marker);
    const text = vm.buildViewModel(fixture, UPDATED_AT).lines.join('\n');
    const where = path.join('.');
    assert.ok(text.includes(escaped),
      `${where}: the escaped value is missing from the report`);
    assert.ok(!text.includes(marker),
      `${where}: the raw value reached the report`);
    assert.strictEqual(text.split('\n').length, cleanCount,
      `${where}: the escaped value forged a line`);
  }
}

console.log(`report-text-injection: PASS (${VARIANTS.length} variants, ${totalLeaves} string leaves [${leafCounts.join(', ')}], ${CONTROLS.length} controls)`);

// The fixtures are exported so the byte-identical proof can render the SAME
// snapshot through the pre-fix and the post-fix view model and compare the
// two texts byte for byte.
module.exports = { VARIANTS, CALLER, ROUTES };
