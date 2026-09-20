'use strict';
// Pure-function tests for lib/routes.js — resolveRoute and dispatchContext.
// These codify the F1/F1a acceptance: ties return null; harness/model conflicts
// with no unique combined match return null; unique combined match wins;
// dispatchContext never falls back to a Traycer profile as a harness.

const assert = require('assert');

const { resolveRoute, dispatchContext } = require('../lib/routes');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const ROUTES_DEFAULT = [
  { id: 'minimax-token-plan', provider: 'minimax', account: 'token-plan', match: { model: 'minimax' } },
  { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' } },
  { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' } },
  { id: 'deepseek-direct', provider: 'deepseek', account: 'personal', match: { model: 'deepseek' } },
  { id: 'openrouter-main', provider: 'openrouter', account: 'main', match: { model: 'openrouter', harness: 'openrouter' } },
];

console.log('resolveRoute — conflict + tie handling (F1, F1a)');

test('two identical kimi routes in either order → null', () => {
  const a = [
    { id: 'kimi-plan-a', match: { model: 'kimi' } },
    { id: 'kimi-plan-b', match: { model: 'kimi' } },
  ];
  const b = [a[1], a[0]];
  assert.strictEqual(resolveRoute('kimi-k2', { harness: null }, a), null);
  assert.strictEqual(resolveRoute('kimi-k2', { harness: null }, b), null);
});

test('harnessId=openrouter, model=kimi-k2 → null (no combined match, signals conflict)', () => {
  assert.strictEqual(
    resolveRoute('kimi-k2', { harness: 'openrouter' }, ROUTES_DEFAULT),
    null,
  );
});

test('harnessId=openrouter, model=openrouter/kimi-k2 → unique openrouter-main (corroborated)', () => {
  const r = resolveRoute('openrouter/kimi-k2', { harness: 'openrouter' }, ROUTES_DEFAULT);
  assert.ok(r, 'expected a route');
  assert.strictEqual(r.id, 'openrouter-main');
});

test('duplicate equally-specific openrouter account routes → null (combined tie)', () => {
  const r = [
    { id: 'openrouter-main', match: { model: 'openrouter', harness: 'openrouter' } },
    { id: 'openrouter-alt', match: { model: 'openrouter', harness: 'openrouter' } },
  ];
  assert.strictEqual(
    resolveRoute('openrouter/kimi-k2', { harness: 'openrouter' }, r),
    null,
  );
});

test('kimi-k2 alone (no harness hint) → kimi-code-plan preserved (longest model specificity)', () => {
  const r = resolveRoute('kimi-k2', { harness: null }, ROUTES_DEFAULT);
  assert.ok(r);
  assert.strictEqual(r.id, 'kimi-code-plan');
});

test('longer model substring beats shorter when both match', () => {
  const routes = [
    { id: 'kimi-short', match: { model: 'kimi' } },
    { id: 'kimi-k2-route', match: { model: 'kimi-k2' } },
  ];
  const r = resolveRoute('kimi-k2-extra', { harness: null }, routes);
  assert.ok(r);
  assert.strictEqual(r.id, 'kimi-k2-route');
});

test('unknown model + unknown harness → null', () => {
  assert.strictEqual(
    resolveRoute('mystery-9', { harness: 'wat' }, ROUTES_DEFAULT),
    null,
  );
});

test('harness-only hit resolves when no model hint is present', () => {
  const routes = [{ id: 'openrouter-main', match: { harness: 'openrouter' } }];
  assert.strictEqual(
    resolveRoute('anything', { harness: 'openrouter' }, routes).id,
    'openrouter-main',
  );
});

test('harness-only tie → null', () => {
  const routes = [
    { id: 'harness-a', match: { harness: 'shared' } },
    { id: 'harness-b', match: { harness: 'shared' } },
  ];
  assert.strictEqual(
    resolveRoute('whatever', { harness: 'shared' }, routes),
    null,
  );
});

test('null/undefined routes array → null (no crash)', () => {
  assert.strictEqual(resolveRoute('kimi-k2', { harness: null }, null), null);
  assert.strictEqual(resolveRoute('kimi-k2', { harness: null }, undefined), null);
  assert.strictEqual(resolveRoute('kimi-k2', { harness: null }), null);
});

test('route without match.match → null', () => {
  assert.strictEqual(
    resolveRoute('kimi-k2', { harness: null }, [{ id: 'nope' }]),
    null,
  );
});

console.log('\ndispatchContext — payload extraction');

test('native Agent → harness: claude, surface: claude', () => {
  const c = dispatchContext({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } });
  assert.strictEqual(c.surface, 'claude');
  assert.strictEqual(c.harness, 'claude');
  assert.strictEqual(c.model, 'kimi-k2');
});

test('native Task → harness: claude, surface: claude', () => {
  const c = dispatchContext({ tool_name: 'Task', tool_input: { model: 'kimi-k2' } });
  assert.strictEqual(c.surface, 'claude');
  assert.strictEqual(c.harness, 'claude');
});

test('traycer create/configure/fork with harnessId → that harness', () => {
  for (const t of ['mcp__traycer_a2a__traycer_create_agent', 'mcp__traycer_a2a__traycer_configure_agent', 'mcp__traycer_a2a__traycer_fork_agent']) {
    const c = dispatchContext({ tool_name: t, tool_input: { model: 'openrouter/kimi-k2', harnessId: 'openrouter' } });
    assert.strictEqual(c.surface, 'traycer');
    assert.strictEqual(c.harness, 'openrouter');
    assert.strictEqual(c.model, 'openrouter/kimi-k2');
  }
});

test('traycer tool with only profile → harness is null (profile is NOT a harness)', () => {
  const c = dispatchContext({
    tool_name: 'mcp__traycer_a2a__traycer_create_agent',
    tool_input: { model: 'kimi-k2', profile: 'kimi-coding-plan' },
  });
  assert.strictEqual(c.surface, 'traycer');
  assert.strictEqual(c.harness, null);
});

test('traycer tool with neither harnessId nor profile → harness is null', () => {
  const c = dispatchContext({ tool_name: 'mcp__traycer_a2a__traycer_create_agent', tool_input: { model: 'kimi-k2' } });
  assert.strictEqual(c.harness, null);
});

test('unknown tool name → surface: unknown, harness: null', () => {
  const c = dispatchContext({ tool_name: 'Bash', tool_input: { model: 'kimi-k2' } });
  assert.strictEqual(c.surface, 'unknown');
  assert.strictEqual(c.harness, null);
  assert.strictEqual(c.model, 'kimi-k2');
});

test('missing tool_input → still produces context, no throw', () => {
  const c = dispatchContext({ tool_name: 'Agent' });
  assert.strictEqual(c.harness, 'claude');
  assert.strictEqual(c.model, undefined);
});

test('non-object tool_input → no throw', () => {
  const c = dispatchContext({ tool_name: 'Task', tool_input: 'a string' });
  assert.strictEqual(c.harness, 'claude');
  assert.strictEqual(c.model, undefined);
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall routes tests passed');
