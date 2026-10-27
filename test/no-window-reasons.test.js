'use strict';
// Issue #139 — a COMPLETED fetch that yields no windows must say WHY.
//
// The live symptom: the owner's MiniMax token plan returned HTTP OK with
// `model_remains: []`, the collection outcome was `completed`, and the view
// said `state: unknown` with `reasonCodes: ["state-unknown"]` and nothing
// else — indistinguishable from "we could not read anything".
//
// Two fixed reason codes, owner ruling Q31-A (one name for "empty/unusable",
// NOT three):
//   `quota-list-empty`   — MiniMax answered with an empty `model_remains`, or
//                          with entries carrying no numeric percent.
//   `no-windows-reported` — the envelope's fallback for ANY completed fetch
//                          that yields no windows and no more specific reason.
//
// Both are additive under contract C-001 (C-003 keeps the same LAN
// vocabulary, which these codes join because the LAN allowlist IS
// VIEW_REASON_CODES). FAIL-OPEN is preserved: the state stays `unknown`,
// nothing is mapped to `exhausted`, and the gate still allows — this file
// asserts that through lib/gate.js itself.
//
// The funnel test runs the REAL adapter, the REAL snapshot projection (on the
// cache entry shape the collector publishes), the REAL view envelope and the
// REAL LAN projection. No network: `fetch` is stubbed.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const minimax = require('../lib/adapters/minimax');
const { getRuntimeSnapshot } = require('../lib/runtime-snapshot');
const vm = require('../lib/view-model');
const { redactForLan } = require('../lib/dashboard/lan-redact');
const { decide: gateDecision } = require('../lib/gate');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const NOW = Date.parse('2026-10-27T12:00:00Z');
const OBSERVED_AT = new Date(NOW - 10_000).toISOString();
const FRESH_UNTIL = new Date(NOW + 170_000).toISOString();
const ROUTE_ID = 'minimax-token-plan';
const ROUTE = { id: ROUTE_ID, provider: 'minimax', account: 'token-plan', match: { model: 'minimax' }, ttlSeconds: 180 };

// The two observed "no usable signal" shapes, exactly as the provider sent
// them, plus the healthy control.
const EMPTY_LIST = { model_remains: [], base_resp: { status_code: 0, status_msg: 'success' } };
const NO_PERCENTS = {
  model_remains: [{ model_name: 'general', current_interval_remaining_percent: null, current_weekly_remaining_percent: 'n/a' }],
  base_resp: { status_code: 0, status_msg: 'success' },
};
const HEALTHY = {
  model_remains: [{ model_name: 'general', current_interval_remaining_percent: 82, current_weekly_remaining_percent: 64 }],
  base_resp: { status_code: 0, status_msg: 'success' },
};

function stubFetch(body) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

async function adapterStatus(body) {
  stubFetch(body);
  return minimax.fetchStatus({ baseUrl: 'https://test.invalid' }, 'sk-test', { threshold: 0.2 });
}

// adapter status → the cache entry the collector publishes → snapshot → view
// → LAN. `collectionOutcome` defaults to the live case: the fetch completed.
async function funnel(body, { collectionOutcome = 'completed' } = {}) {
  const status = await adapterStatus(body);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-no-window-'));
  const entry = { observedAt: OBSERVED_AT, freshUntil: FRESH_UNTIL, source: 'minimax', status };
  try {
    const snap = await getRuntimeSnapshot({
      refresh: false,
      now: () => NOW,
      dataDir: dir,
      io: {
        readSidecar: () => null,
        readConfig: () => ({ cfg: { routes: [ROUTE] }, corrupt: false }),
        readStatus: () => ({ doc: { routes: { [ROUTE_ID]: entry } }, corrupt: false, exists: true }),
      },
    });
    const view = vm.buildViewSchema(snap, {
      now: NOW,
      gate: { entries: { [ROUTE_ID]: entry }, routes: { [ROUTE_ID]: ROUTE }, now: NOW },
      collection: {
        outcome: 'completed',
        published: true,
        routes: [{ id: ROUTE_ID, outcome: collectionOutcome, error: null }],
      },
    });
    const lan = redactForLan({
      schemaVersion: view.schemaVersion,
      status: 'ok',
      daemon: { intervalSeconds: 60 },
      collection: { state: 'idle', lastAttempt: { outcome: 'completed' } },
      view,
    });
    return { status, snap, view, lan, entry };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log('minimax — quota-list-empty names the unusable list');

  await testAsync('empty model_remains is unknown WITH the reason (never promoted to exhausted)', async () => {
    const status = await adapterStatus(EMPTY_LIST);
    assert.strictEqual(status.state, 'unknown');
    assert.deepStrictEqual(status.windows, []);
    assert.strictEqual(status.detail.reason, 'quota-list-empty');
    assert.deepStrictEqual(status.detail.model_remains, [], 'the raw answer stays for diagnosis');
  });

  await testAsync('entries WITHOUT a numeric percent get the SAME reason (one name, Q31-A)', async () => {
    const status = await adapterStatus(NO_PERCENTS);
    assert.strictEqual(status.state, 'unknown');
    assert.deepStrictEqual(status.windows, []);
    assert.strictEqual(status.detail.reason, 'quota-list-empty');
  });

  await testAsync('a percent-bearing answer carries NO such reason', async () => {
    const status = await adapterStatus(HEALTHY);
    assert.strictEqual(status.state, 'healthy');
    assert.strictEqual(status.windows.length, 2);
    assert.strictEqual(status.detail.reason, undefined, 'a measured answer is not an empty list');
  });

  await testAsync('a malformed body (not an object) is not reported as an empty list', async () => {
    stubFetch(null);
    const status = await minimax.fetchStatus({ baseUrl: 'https://test.invalid' }, 'sk-test', { threshold: 0.2 });
    // The adapter is total: no model row at all is the empty-list shape, and
    // the reason says so rather than inventing capacity.
    assert.strictEqual(status.state, 'unknown');
    assert.strictEqual(status.detail.reason, 'quota-list-empty');
  });

  // Boundary: the EXTERNAL DEPENDENCY failing is a different outcome from the
  // provider answering with an unusable list, and it must not be laundered
  // into `quota-list-empty`. A transport/parse failure reaches the collector
  // as a failed fetch, so no status — and therefore no reason code — exists.
  await testAsync('an HTTP failure or non-JSON body produces NO status (never quota-list-empty)', async () => {
    global.fetch = async () => ({
      ok: false, status: 500, json: async () => ({}), text: async () => 'boom',
    });
    await assert.rejects(() => minimax.fetchStatus({ baseUrl: 'https://test.invalid' }, 'sk-test', { threshold: 0.2 }));

    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
      text: async () => '<html>gateway</html>',
    });
    await assert.rejects(() => minimax.fetchStatus({ baseUrl: 'https://test.invalid' }, 'sk-test', { threshold: 0.2 }));
  });

  console.log('\nview envelope — the reason survives the whole funnel');

  await testAsync('adapter → cache entry → snapshot → view: reasonCodes carry quota-list-empty', async () => {
    const { view } = await funnel(EMPTY_LIST);
    const route = view.routes.find((r) => r.id === ROUTE_ID);
    assert.ok(route, 'the configured route is rendered');
    assert.strictEqual(route.state, 'unknown');
    assert.deepStrictEqual(route.windows, []);
    assert.ok(route.reasonCodes.includes('quota-list-empty'), `reasonCodes ${JSON.stringify(route.reasonCodes)}`);
    assert.ok(!route.reasonCodes.includes('no-windows-reported'), 'the specific reason suppresses the generic one');
    assert.strictEqual(route.quotaEligibility, 'unresolved', 'unknown is never eligible');
  });

  await testAsync('the LAN projection keeps the code (it is in VIEW_REASON_CODES)', async () => {
    const { lan } = await funnel(EMPTY_LIST);
    const row = lan.view.routes[0];
    assert.ok(row.reasonCodes.includes('quota-list-empty'), `LAN reasonCodes ${JSON.stringify(row.reasonCodes)}`);
    assert.ok(!JSON.stringify(lan).includes(ROUTE_ID), 'the LAN still carries no route ids');
  });

  await testAsync('a healthy answer gains neither code', async () => {
    const { view } = await funnel(HEALTHY);
    const route = view.routes.find((r) => r.id === ROUTE_ID);
    assert.strictEqual(route.state, 'healthy');
    assert.ok(!route.reasonCodes.includes('quota-list-empty'));
    assert.ok(!route.reasonCodes.includes('no-windows-reported'));
  });

  console.log('\nno-windows-reported — the fallback, and its precedence');

  // A hand-built snapshot route row, shaped like lib/runtime-snapshot.js
  // emits it: enough to pin the ENVELOPE rule on its own.
  const observed = (value, extra = {}) => ({
    value, provenance: 'observed', source: 'status.json', observedAt: null, freshUntil: null, reason: null, ...extra,
  });
  const unknownFact = (reason) => ({
    value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason,
  });
  // `reason` lands on the state FACT (code-authored by the snapshot);
  // `adapterReason` lands on the RESOURCE (`detail.reason` after the snapshot's
  // whitelisted carry) — the provider-controlled path.
  function row(reason, adapterReason = null) {
    return {
      id: ROUTE_ID,
      configured: true,
      provider: observed('minimax'),
      account: observed('token-plan'),
      pool: observed({ provider: 'minimax', account: 'token-plan' }),
      boundBy: [],
      resource: {
        state: observed('unknown', { reason }),
        windows: [],
        balance: null,
        error: null,
        reason: adapterReason,
        basis: unknownFact('cached-field-absent'),
        periodEnd: unknownFact('cached-field-absent'),
        resetAt: unknownFact('cached-field-absent'),
        observedAt: observed(OBSERVED_AT),
        freshUntil: observed(FRESH_UNTIL),
        freshness: 'fresh',
        source: observed('minimax'),
      },
    };
  }
  const collection = (outcome) => ({ outcome: 'completed', routes: [{ id: ROUTE_ID, outcome, error: null }] });

  test('zero windows with NO declared reason gets no-windows-reported', () => {
    const view = vm.buildViewSchema({ routes: [row(null)] }, { now: NOW, collection: collection('completed') });
    const r = view.routes[0];
    assert.strictEqual(r.state, 'unknown');
    assert.ok(r.reasonCodes.includes('no-windows-reported'), JSON.stringify(r.reasonCodes));
  });

  test('a declared reason suppresses the generic one', () => {
    const view = vm.buildViewSchema({ routes: [row('quota-list-empty')] }, { now: NOW, collection: collection('completed') });
    const r = view.routes[0];
    assert.ok(r.reasonCodes.includes('quota-list-empty'));
    assert.ok(!r.reasonCodes.includes('no-windows-reported'), JSON.stringify(r.reasonCodes));
  });

  test('a route whose collection did NOT complete is not called "reported"', () => {
    for (const outcome of ['failed', 'pending', 'skipped']) {
      const view = vm.buildViewSchema({ routes: [row(null)] }, { now: NOW, collection: collection(outcome) });
      assert.ok(!view.routes[0].reasonCodes.includes('no-windows-reported'), outcome);
    }
    const noBlock = vm.buildViewSchema({ routes: [row(null)] }, { now: NOW });
    assert.ok(!noBlock.routes[0].reasonCodes.includes('no-windows-reported'), 'no collection block → no claim');
  });

  test('a reason OUTSIDE the fixed vocabulary is dropped and does not take the fallback with it', () => {
    // An adapter cannot widen the envelope: an unknown code is filtered, and
    // the route still says why it has no windows.
    const view = vm.buildViewSchema({ routes: [row('some-provider-reason')] }, { now: NOW, collection: collection('completed') });
    const r = view.routes[0];
    assert.ok(!r.reasonCodes.includes('some-provider-reason'));
    assert.ok(r.reasonCodes.includes('no-windows-reported'), JSON.stringify(r.reasonCodes));
  });

  // PR #143 review finding — the ADAPTER-declared reason (`detail.reason`) is
  // provider-controlled text. Filtering reasonCodes downstream was not enough:
  // `stateReason` is ALSO the route's rendered note, so an unregistered value
  // reached the text view. The vocabulary check now happens at the assignment.
  test('an unregistered ADAPTER reason reaches no surface at all (JSON, text, LAN)', () => {
    const SENTINEL = 'provider-said-something';
    const view = vm.buildViewSchema(
      { routes: [row(null, SENTINEL)] },
      { now: NOW, collection: collection('completed') },
    );
    const r = view.routes[0];
    assert.strictEqual(r.state, 'unknown');
    assert.strictEqual(r.stateReason, null, 'the rendered note is not the provider string');
    assert.ok(r.reasonCodes.includes('no-windows-reported'), JSON.stringify(r.reasonCodes));
    assert.ok(!r.reasonCodes.includes(SENTINEL));
    assert.ok(!JSON.stringify(view).includes(SENTINEL), 'the JSON envelope carries no provider text');
    assert.ok(!vm.renderViewText(view).join('\n').includes(SENTINEL), 'the text view carries no provider text');

    const lan = redactForLan({
      schemaVersion: view.schemaVersion, status: 'ok', daemon: { intervalSeconds: 60 },
      collection: { state: 'idle', lastAttempt: { outcome: 'completed' } }, view,
    });
    assert.ok(!JSON.stringify(lan).includes(SENTINEL), 'the LAN projection carries no provider text');
    assert.ok(lan.view.routes[0].reasonCodes.includes('no-windows-reported'));
  });

  test('an adapter reason INSIDE the vocabulary still names the route and suppresses the fallback', () => {
    // The same path, with a registered code: this is what MiniMax publishes.
    const view = vm.buildViewSchema(
      { routes: [row(null, 'quota-list-empty')] },
      { now: NOW, collection: collection('completed') },
    );
    const r = view.routes[0];
    assert.strictEqual(r.stateReason, 'quota-list-empty');
    assert.ok(r.reasonCodes.includes('quota-list-empty'));
    assert.ok(!r.reasonCodes.includes('no-windows-reported'), JSON.stringify(r.reasonCodes));
    assert.ok(vm.renderViewText(view).join('\n').includes('quota-list-empty'), 'the note names the registered reason');
  });

  test('a REFUSAL code in the adapter reason stays in its own block, never as a state reason', () => {
    const view = vm.buildViewSchema(
      { routes: [row(null, 'built-in-endpoint-refused')] },
      { now: NOW, collection: collection('completed') },
    );
    const r = view.routes[0];
    assert.strictEqual(r.stateReason, null);
    assert.strictEqual(r.refusal.reason, 'built-in-endpoint-refused', 'the refusal block still claims it');
    assert.ok(r.reasonCodes.includes('no-windows-reported'), 'a refusal is not a no-window explanation');
  });

  console.log('\ngate — fail-open, asserted through lib/gate.js');

  test('a cached unknown/empty-window MiniMax entry is ALLOWED, never denied', () => {
    const entry = {
      routeId: ROUTE_ID,
      observedAt: OBSERVED_AT,
      freshUntil: FRESH_UNTIL,
      source: 'minimax',
      status: { state: 'unknown', windows: [], balance: null, resetAt: null, detail: { reason: 'quota-list-empty' } },
    };
    const decision = gateDecision({
      route: ROUTE,
      entry,
      now: NOW,
      config: { gate: { mode: 'deny', injectContext: true } },
    });
    assert.strictEqual(decision.action, 'allow', 'unknown is fail-open even in deny mode');
  });

  const failed = failures;
  console.log(failed ? `\n${failed} failure(s)` : '\nall no-window reason tests passed');
  process.exit(failed ? 1 : 0);
})();