'use strict';
// Fixture tests for the provider adapters. Mocks global.fetch so the adapters'
// real parse/normalize path runs against researched response shapes — no
// network, no credentials. Run: node test/adapters.test.js

const assert = require('assert');

const minimax = require('../lib/adapters/minimax');
const kimi = require('../lib/adapters/kimi');
const glm = require('../lib/adapters/glm');
const deepseek = require('../lib/adapters/deepseek');
const openrouter = require('../lib/adapters/openrouter');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

function run(adapter, responder) {
  global.fetch = typeof responder === 'function'
    ? responder
    : async () => ({ ok: true, status: 200, json: async () => responder, text: async () => JSON.stringify(responder) });
  return adapter.fetchStatus({ baseUrl: 'https://test.invalid' }, 'sk-test', { threshold: 0.2 });
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function unknownWithoutCapacity(status) {
  assert.strictEqual(status.state, 'unknown');
  assert.deepStrictEqual(status.windows, []);
  assert.strictEqual(status.balance, null);
}

(async () => {
  console.log('minimax');
  let st = await run(minimax, {
    model_remains: [
      { model_name: 'general', current_interval_remaining_percent: 99, current_weekly_remaining_percent: 64, end_time: 1789794000000, weekly_end_time: 1789948800000 },
      { model_name: 'video', current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100 },
    ],
    base_resp: { status_code: 0, status_msg: 'success' },
  });
  test('healthy: rolling-5h 99%, weekly 64% (per-model percent)', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.windows.length, 2);
    assert.strictEqual(st.windows[0].type, 'rolling-5h');
    assert.strictEqual(st.windows[1].remaining, 64);
  });
  st = await run(minimax, { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 10, current_weekly_remaining_percent: 0 }] });
  test('exhausted when weekly remaining 0', () => assert.strictEqual(st.state, 'exhausted'));
  st = await run(minimax, { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 0, current_weekly_remaining_percent: 60 }] });
  test('short-window pressure remains constrained rather than newly exhausted', () => assert.strictEqual(st.state, 'constrained'));
  st = await run(minimax, {});
  test('empty payload is unknown', () => unknownWithoutCapacity(st));
  st = await run(minimax, { model_remains: [{ model_name: 'general', current_interval_remaining_percent: 'n/a' }] });
  test('nonempty general entry without finite percentages is unknown', () => unknownWithoutCapacity(st));
  st = await run(minimax, { model_remains: [
    { model_name: 'general', current_interval_remaining_percent: 'invalid' },
    { model_name: 'general', current_interval_remaining_percent: 35, current_weekly_remaining_percent: 80 },
  ] });
  test('malformed sibling does not hide a valid general-model window', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.deepStrictEqual(st.windows.map((w) => w.remaining), [35, 80]);
  });

  console.log('kimi');
  st = await run(kimi, {
    usage: { limit: '100', used: '26', remaining: '74', resetTime: '2026-09-19T00:00:00Z' },
    limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', used: '15', remaining: '85', resetTime: '2026-09-18T23:00:00Z' } }],
    user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
    parallel: { limit: 30 },
  });
  test('healthy: rolling-5h 85, weekly 74 (strings parsed)', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.windows.length, 2);
    assert.strictEqual(st.detail.membership, 'LEVEL_INTERMEDIATE');
  });
  st = await run(kimi, { usage: { limit: '100', used: '100', remaining: '0' } });
  test('exhausted when remaining 0', () => assert.strictEqual(st.state, 'exhausted'));
  st = await run(kimi, { usage: { limit: '100', remaining: '10' } });
  test('valid low remaining window is constrained', () => assert.strictEqual(st.state, 'constrained'));
  st = await run(kimi, {});
  test('empty payload is unknown', () => unknownWithoutCapacity(st));
  st = await run(kimi, { usage: { limit: '100', remaining: '12tokens' }, limits: [{ detail: [] }] });
  test('malformed successful containers and partial numeric strings are unknown', () => unknownWithoutCapacity(st));
  st = await run(kimi, { limits: [
    { detail: { remaining: 'bad', limit: 100 } },
    { detail: { remaining: 25, limit: 100, resetTime: 1e20 } },
  ] });
  test('malformed sibling does not hide a valid finite window', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.windows[0].remaining, 25);
    assert.strictEqual(st.windows[0].resetAt, null);
  });

  console.log('glm');
  st = await run(glm, { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 40, nextResetTime: 1789775460000 }] } });
  test('healthy: 60% remaining, reset coerced from millis', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.windows[0].remaining, 60);
    assert.ok(st.resetAt);
  });
  st = await run(glm, { data: { limits: [{ percentage: 100 }] } });
  test('exhausted at 100%', () => assert.strictEqual(st.state, 'exhausted'));
  st = await run(glm, { data: { limits: [{ percentage: 90 }] } });
  test('valid high usage is constrained', () => assert.strictEqual(st.state, 'constrained'));
  st = await run(glm, {});
  test('empty payload is unknown', () => unknownWithoutCapacity(st));
  st = await run(glm, { data: { limits: [{ percentage: 'Infinity' }, { percentage: '40%' }] } });
  test('nonempty limits without finite percentages are unknown', () => unknownWithoutCapacity(st));
  st = await run(glm, { data: { limits: [null, { percentage: 'bad' }, { type: 'TOKENS_LIMIT', percentage: 30 }] } });
  test('malformed siblings do not hide a valid limit', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.windows[0].remaining, 70);
  });

  console.log('deepseek');
  st = await run(deepseek, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] });
  test('healthy with balance', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.balance.available, '10.00');
  });
  st = await run(deepseek, { is_available: false, balance_infos: [] });
  test('exhausted when is_available false', () => assert.strictEqual(st.state, 'exhausted'));
  st = await run(deepseek, { is_available: true, balance_infos: [] });
  test('explicit true is healthy without optional balance', () => assert.strictEqual(st.state, 'healthy'));
  st = await run(deepseek, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '0' }] });
  test('explicit true with zero balance retains constrained policy', () => assert.strictEqual(st.state, 'constrained'));
  st = await run(deepseek, {});
  test('missing explicit availability is unknown', () => unknownWithoutCapacity(st));
  st = await run(deepseek, { is_available: 'false', balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] });
  test('non-boolean availability remains unknown even with balance evidence', () => {
    assert.strictEqual(st.state, 'unknown');
    assert.strictEqual(st.balance.available, '10.00');
  });
  st = await run(deepseek, { is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: 'not-money' },
    { currency: 'CNY', total_balance: '8.50' },
  ] });
  test('malformed balance sibling does not discard a valid balance', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.balance.available, '8.50');
  });
  st = await run(deepseek, { is_available: true, balance_infos: [{ total_balance: '8.50' }] });
  test('missing currency is not replaced with an invented default', () => assert.strictEqual(st.balance.currency, null));

  console.log('openrouter');
  const orResponder = async (url) => {
    const body = url.includes('/credits')
      ? { data: { total_credits: 220, total_usage: 212.22 } }
      : { data: { limit: 20, limit_reset: 'monthly', usage_daily: 0, usage_weekly: 0, usage_monthly: 0.0047, is_free_tier: false } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  st = await run(openrouter, orResponder);
  test('healthy balance = credits − usage, cap notated', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.ok(Math.abs(st.balance.available - 7.78) < Number.EPSILON * 10);
    assert.strictEqual(st.balance.spent.daily, 0);
    assert.strictEqual(st.balance.limit.amount, 20);
    assert.strictEqual(st.balance.limit.reset, 'monthly');
  });
  const orNoCap = async (url) => {
    const body = url.includes('/credits')
      ? { data: { total_credits: 220, total_usage: 212.22 } }
      : { data: { limit: null, usage_daily: 0, usage_weekly: 0 } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  st = await run(openrouter, orNoCap);
  test('no cap notation when limit is null', () => assert.strictEqual(st.balance.limit, null));
  const orExhausted = async (url) => {
    const body = url.includes('/credits')
      ? { data: { total_credits: 100, total_usage: 100 } }
      : { data: { usage_daily: 0, usage_weekly: 0 } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  st = await run(openrouter, orExhausted);
  test('exhausted when balance 0', () => assert.strictEqual(st.state, 'exhausted'));

  const orSubCent = async (url) => response(url.includes('/credits')
    ? { data: { total_credits: 1, total_usage: 0.996 } }
    : { data: { usage_daily: 0.25 } });
  st = await run(openrouter, orSubCent);
  test('positive sub-cent balance retains precision and is not exhausted', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.ok(st.balance.available > 0 && st.balance.available < 0.01);
  });

  const orNegative = async (url) => response(url.includes('/credits')
    ? { data: { total_credits: 1, total_usage: 1.001 } }
    : { data: {} });
  st = await run(openrouter, orNegative);
  test('negative finite balance remains exhausted', () => assert.strictEqual(st.state, 'exhausted'));

  const orNonfinite = async (url) => response(url.includes('/credits')
    ? { data: { total_credits: 'Infinity', total_usage: 1 } }
    : { data: { usage_weekly: 2 } });
  st = await run(openrouter, orNonfinite);
  test('nonfinite credit operands keep capacity unknown while retaining usage', () => {
    unknownWithoutCapacity(st);
    assert.deepStrictEqual(st.detail.usage, { currency: 'USD', weekly: 2 });
  });

  const orKeyFailure = async (url) => {
    if (url.includes('/credits')) return response({ data: { total_credits: 5, total_usage: 2 } });
    return response({ error: 'key unavailable' }, 503);
  };
  st = await run(openrouter, orKeyFailure);
  test('credits survive a separate key endpoint failure', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.balance.available, 3);
    assert.ok(!('spent' in st.balance));
    assert.match(st.detail.errors.key, /HTTP 503/);
  });

  const orCreditsFailure = async (url) => {
    if (url.includes('/credits')) return response({ error: 'credits unavailable' }, 503);
    return response({ data: { usage_weekly: 2.5, is_free_tier: false } });
  };
  st = await run(openrouter, orCreditsFailure);
  test('key usage survives credits failure without fabricating capacity or zero fields', () => {
    unknownWithoutCapacity(st);
    assert.deepStrictEqual(st.detail.usage, { currency: 'USD', weekly: 2.5 });
    assert.strictEqual(st.detail.is_free_tier, false);
    assert.ok(!('daily' in st.detail.usage));
  });

  st = await run(openrouter, async () => response({ data: [] }));
  test('malformed nonempty endpoint containers are unknown', () => unknownWithoutCapacity(st));

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall adapter tests passed');
})();
