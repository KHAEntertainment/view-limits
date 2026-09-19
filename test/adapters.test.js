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

function run(adapter, fixture) {
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => fixture,
    text: async () => JSON.stringify(fixture),
  });
  return adapter.fetchStatus({ baseUrl: 'https://test.invalid' }, 'sk-test', { threshold: 0.2 });
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

  console.log('glm');
  st = await run(glm, { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 40, nextResetTime: 1789775460000 }] } });
  test('healthy: 60% remaining, reset coerced from millis', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.windows[0].remaining, 60);
    assert.ok(st.resetAt);
  });
  st = await run(glm, { data: { limits: [{ percentage: 100 }] } });
  test('exhausted at 100%', () => assert.strictEqual(st.state, 'exhausted'));

  console.log('deepseek');
  st = await run(deepseek, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00' }] });
  test('healthy with balance', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.balance.available, '10.00');
  });
  st = await run(deepseek, { is_available: false, balance_infos: [] });
  test('exhausted when is_available false', () => assert.strictEqual(st.state, 'exhausted'));

  console.log('openrouter');
  st = await run(openrouter, { limit: 10, limit_remaining: 4.5, limit_reset: 'daily', usage: 5.5 });
  test('healthy credit 45%', () => {
    assert.strictEqual(st.state, 'healthy');
    assert.strictEqual(st.windows[0].remaining, 4.5);
  });
  st = await run(openrouter, { limit: 10, limit_remaining: 0 });
  test('exhausted at limit_remaining 0', () => assert.strictEqual(st.state, 'exhausted'));

  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall adapter tests passed');
})();
