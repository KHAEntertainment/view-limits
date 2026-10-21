'use strict';
// Issue #80 — Xiaomi measurements: four-state derivation surfaces, basis
// labels, reported (never reset) plan period end, and the gate matrix.
// Synthetic fixtures only: no network, no credentials, no Chrome. Run:
// node test/xiaomi-measure.test.js

const assert = require('assert');

const { fetchStatus } = require('../lib/adapters/xiaomi');
const { decide } = require('../lib/gate');
const { basisOf } = require('../lib/normalize');
const { getRuntimeSnapshot } = require('../lib/runtime-snapshot');
const { buildViewModel } = require('../lib/view-model');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const FRESH = '2026-10-20T00:05:00.000Z';
const STALE = '2026-10-19T23:00:00.000Z';
const PERIOD_END = '2026-11-07 23:59:59';
const LIMIT = 38000000000;

const CREDENTIALS = { usageCookie: 'u=1', detailCookie: 'u=1; d=2' };
const json = (body) => ({ outcome: 'json', httpStatus: 200, body });
const usageBody = (used) => ({
  code: 0,
  data: { usage: { items: [{ name: 'plan_total_token', used, limit: LIMIT }] } },
});
const detailBody = (extra = {}) => ({
  code: 0,
  data: { currentPeriodEnd: PERIOD_END, expired: false, ...extra },
});

function scripted(replies) {
  return async (kind) => replies[kind];
}

async function statusFor(used, detail = detailBody()) {
  return fetchStatus({}, CREDENTIALS, {
    consoleGet: scripted({ usage: json(usageBody(used)), detail: json(detail) }),
  });
}

function entry(status, freshUntil = FRESH) {
  return {
    routeId: 'xiaomi-token-plan',
    observedAt: '2026-10-20T00:00:00.000Z',
    freshUntil,
    source: 'xiaomi',
    status,
  };
}

const denyConfig = { gate: { mode: 'deny', injectContext: true } };
const route = { id: 'xiaomi-token-plan', provider: 'xiaomi', account: 'token-plan' };

// ---- basis labels -----------------------------------------------------------

(async () => {
  console.log('xiaomi measurements — states, basis, period end, gate matrix');

  await test('basisOf: explicit basis wins; otherwise derived from evidence', () => {
    assert.strictEqual(basisOf({ basis: 'token-count', windows: [{ type: 'weekly' }] }), 'token-count');
    assert.strictEqual(basisOf({ balance: { available: 12 }, windows: [] }), 'balance');
    assert.strictEqual(basisOf({ windows: [{ type: 'tokens' }] }), 'token-count');
    assert.strictEqual(basisOf({ windows: [{ type: 'weekly' }] }), 'quota-window');
    assert.strictEqual(basisOf({ windows: [] }), 'none');
    assert.strictEqual(basisOf(null), 'none');
    assert.strictEqual(basisOf({ basis: 'not-a-basis' }), 'none');
  });

  // ---- view model text ------------------------------------------------------

  async function snapshotFor(statuses, extraRoutes = []) {
    const routes = [
      { id: 'xiaomi-token-plan', provider: 'xiaomi', account: 'token-plan' },
      ...extraRoutes,
    ];
    const cacheRoutes = {};
    for (const [id, st] of Object.entries(statuses)) cacheRoutes[id] = entry(st);
    return getRuntimeSnapshot({
      now: () => NOW,
      callerContext: { host: 'test' },
      io: {
        readConfig: () => ({ cfg: { routes }, corrupt: false }),
        readStatus: () => ({ doc: { routes: cacheRoutes }, corrupt: false, exists: true }),
        readSidecar: () => null,
      },
    });
  }

  await test('report text: constrained token window renders (token count) suffix', async () => {
    const st = await statusFor(LIMIT - 2660000000); // 7% remaining
    assert.strictEqual(st.state, 'constrained');
    const snap = await snapshotFor({ 'xiaomi-token-plan': st });
    const text = buildViewModel(snap, null).lines.join('\n');
    assert.match(text, /    xiaomi-token-plan: constrained · tokens 7% \(token count\)/);
  });

  await test('report text: healthy token window and >=20% boundary', async () => {
    const healthy = await statusFor(Math.round(LIMIT * 0.25));
    assert.strictEqual(healthy.state, 'healthy');
    const snap = await snapshotFor({ 'xiaomi-token-plan': healthy });
    assert.match(buildViewModel(snap, null).lines.join('\n'),
      /    xiaomi-token-plan: healthy · tokens 75% \(token count\)/);
  });

  await test('report text: exhausted token window renders exhausted with basis', async () => {
    const st = await statusFor(LIMIT);
    assert.strictEqual(st.state, 'exhausted');
    const snap = await snapshotFor({ 'xiaomi-token-plan': st });
    assert.match(buildViewModel(snap, null).lines.join('\n'),
      /    xiaomi-token-plan: exhausted · tokens 0% \(token count\)/);
  });

  await test('report text: plan period ends is disclosed and never a reset', async () => {
    const st = await statusFor(Math.round(LIMIT * 0.25));
    assert.strictEqual(st.resetAt, null, 'currentPeriodEnd never becomes resetAt');
    const snap = await snapshotFor({ 'xiaomi-token-plan': st });
    const text = buildViewModel(snap, null).lines.join('\n');
    assert.match(text, new RegExp(`plan period ends ${PERIOD_END} \\(reported\\)`));
    assert.doesNotMatch(text, /resets /, 'a reported period end is never rendered as a reset');
  });

  await test('report text: unrelated routes stay byte-identical (no basis suffix)', async () => {
    const kimi = { state: 'healthy', windows: [{ type: 'weekly', remaining: 74, limit: 100, resetAt: null }], balance: null, resetAt: null, detail: {} };
    const snap = await snapshotFor(
      {
        'xiaomi-token-plan': await statusFor(Math.round(LIMIT * 0.25)),
        'kimi-code-plan': kimi,
      },
      [{ id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan' }],
    );
    const text = buildViewModel(snap, null).lines.join('\n');
    assert.match(text, /    kimi-code-plan: healthy · weekly 74%/);
    assert.doesNotMatch(text, /weekly 74% \(/);
  });

  // ---- gate matrix ----------------------------------------------------------

  const exhausted = await statusFor(LIMIT);
  const constrained = await statusFor(LIMIT - 2660000000);
  const expired = await statusFor(0, detailBody({ expired: true }));
  const unrecognized = await fetchStatus({}, CREDENTIALS, {
    consoleGet: scripted({
      usage: json(usageBody(0)),
      detail: json({ code: 0, data: { expired: 'no' } }),
    }),
  });

  await test('gate matrix: token-count exhausted + fresh 0 window → deny (deny mode)', () => {
    assert.strictEqual(exhausted.state, 'exhausted');
    assert.strictEqual(exhausted.basis, 'token-count');
    const result = decide({ route, entry: entry(exhausted), now: NOW, config: denyConfig });
    assert.strictEqual(result.action, 'deny');
    assert.match(result.reason, /route "xiaomi-token-plan" is exhausted\. Dispatch blocked\./);
  });

  await test('gate matrix: deny reason shape matches any other exhausted provider', () => {
    const quotaWindow = { state: 'exhausted', windows: [{ type: 'weekly', remaining: 0, limit: 100 }], balance: null, resetAt: null, detail: {} };
    const xiaomiResult = decide({ route, entry: entry(exhausted), now: NOW, config: denyConfig });
    const kimiRoute = { id: 'kimi-code-plan', provider: 'kimi' };
    const kimiResult = decide({ route: kimiRoute, entry: entry(quotaWindow), now: NOW, config: denyConfig });
    assert.strictEqual(xiaomiResult.action, 'deny');
    assert.strictEqual(kimiResult.action, 'deny');
    assert.strictEqual(
      xiaomiResult.reason.replace('xiaomi-token-plan', '<route>'),
      kimiResult.reason.replace('kimi-code-plan', '<route>'),
      'same message shape, no basis-specific wording',
    );
  });

  await test('gate matrix: constrained token-count → allow', () => {
    assert.strictEqual(constrained.state, 'constrained');
    assert.strictEqual(decide({ route, entry: entry(constrained), now: NOW, config: denyConfig }).action, 'allow');
  });

  await test('gate matrix: expired → unknown → allow / fail open', () => {
    assert.strictEqual(expired.state, 'unknown');
    const result = decide({ route, entry: entry(expired), now: NOW, config: denyConfig });
    assert.strictEqual(result.action, 'allow');
    assert.strictEqual(result.reason, undefined);
  });

  await test('gate matrix: unrecognized/no-window → unknown → allow / fail open', () => {
    assert.strictEqual(unrecognized.state, 'unknown');
    assert.deepStrictEqual(unrecognized.windows, []);
    assert.strictEqual(decide({ route, entry: entry(unrecognized), now: NOW, config: denyConfig }).action, 'allow');
  });

  await test('gate matrix: stale exhausted token-count → allow with refresh (no deny)', () => {
    const result = decide({ route, entry: entry(exhausted, STALE), now: NOW, config: denyConfig });
    assert.strictEqual(result.action, 'allow');
    assert.strictEqual(result.refresh, true);
  });

  await test('gate matrix: no-basis exhausted entry behaves exactly as today (deny)', () => {
    const noBasis = { state: 'exhausted', windows: [{ type: 'tokens', remaining: 0, limit: 100 }], balance: null, resetAt: null, detail: {} };
    const result = decide({ route, entry: entry(noBasis), now: NOW, config: denyConfig });
    assert.strictEqual(result.action, 'deny', 'basis is never required to deny');
  });

  await test('gate matrix: advisory mode still allows an exhausted token-count route', () => {
    const result = decide({ route, entry: entry(exhausted), now: NOW, config: { gate: { mode: 'advisory' } } });
    assert.strictEqual(result.action, 'allow');
  });

  if (failures) {
    console.error(`\n${failures} xiaomi measurement test(s) failed`);
    process.exit(1);
  }
  console.log('\nall xiaomi measurement tests passed');
})();
