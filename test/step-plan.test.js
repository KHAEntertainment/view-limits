'use strict';
// Tests for the stepfun-plan recipe (#57) — documentation-based, unmonitored.
// Evidence is documentation (platform.stepfun.ai/step-plan, /step-code, docs
// API reference): no read-only quota API is documented for Step Plan
// subscription Credits, so this recipe makes no request, needs no credential,
// and must return stable unknown. The only documented endpoint
// (GET /v1/accounts) reports Open Platform cash balance — a different system
// from subscription Credits — and is deliberately never read (no-conflation
// rule). These fixtures reflect that documented classification; none is
// labeled live evidence.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { RECIPES, getRecipe, knownRecipes, routeNeedsVaultCredential } = require('../lib/recipes');
const { resolveEffectiveConfig } = require('../lib/effective-config');
const { getAdapter } = require('../lib/adapters');
const { validateMonitor, validateRecipeOptions } = require('../lib/monitor-schema');

let failures = 0;
async function runTests() {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failures += 1;
      console.log(`  ✗ ${t.name}\n    ${e && e.message || e}`);
    }
  }
}
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

console.log('registry — stepfun-plan is a first-class unmonitored recipe');

test('stepfun-plan is registered and frozen', () => {
  assert.ok(knownRecipes().has('stepfun-plan'));
  const r = getRecipe('stepfun-plan');
  assert.strictEqual(r.id, 'stepfun-plan');
  assert.strictEqual(r.family, null); // no wire family constrains the route
  assert.strictEqual(r.capabilities.monitorable, false);
  assert.strictEqual(r.capabilities.inference, false);
  assert.strictEqual(r.capabilities.credential, 'none');
  assert.strictEqual(r.unmonitoredReason, 'unmonitored-no-documented-quota-source');
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.capabilities));
  assert.deepStrictEqual(r.options, {});
  // B2 contract: the capability flag — never a recipe id — drives the CLI's
  // credential exemption (routeNeedsVaultCredential in lib/recipes).
  assert.strictEqual(r.capabilities.vaultCredential, false);
});

test('routeNeedsVaultCredential is false for a stepfun-plan route (capability-driven)', () => {
  assert.strictEqual(routeNeedsVaultCredential(ROUTE), false);
  // A route with the same shape but a credential-holding recipe still needs
  // one, so the flag is genuinely capability-driven and not id-blind.
  assert.strictEqual(
    routeNeedsVaultCredential({ ...ROUTE, monitor: { recipe: 'openai-compat', recipeOptions: { path: '/v1' } } }),
    true,
  );
});

console.log('fetch — local-only stable unknown, never healthy/exhausted');

test('fetch returns unknown with empty windows, null balance, fixed reason', async () => {
  const r = getRecipe('stepfun-plan');
  const st = await r.fetch({}, null, {});
  assert.strictEqual(st.state, 'unknown');
  assert.deepStrictEqual(st.windows, []);
  assert.strictEqual(st.balance, null);
  assert.strictEqual(st.resetAt, null);
  assert.strictEqual(st.detail.reason, 'unmonitored-no-documented-quota-source');
  assert.strictEqual(st.detail.monitorable, false);
});

test('fetch never touches the network (http/https/net/tls/fetch stubbed)', async () => {
  const hits = [];
  const realFetch = global.fetch;
  const http = require('http');
  const https = require('https');
  const net = require('net');
  const tls = require('tls');
  const save = {
    fetch: realFetch,
    httpGet: http.get, httpReq: http.request,
    httpsGet: https.get, httpsReq: https.request,
    netConnect: net.connect, netCreate: net.createConnection,
    tlsConnect: tls.connect,
  };
  const forbidden = () => { hits.push('network'); throw new Error('network forbidden'); };
  global.fetch = forbidden;
  http.get = http.request = forbidden;
  https.get = https.request = forbidden;
  net.connect = net.createConnection = forbidden;
  tls.connect = forbidden;
  try {
    const st = await getRecipe('stepfun-plan').fetch({ baseUrl: 'https://api.stepfun.ai/v1' }, 'sk-never-sent', {});
    assert.strictEqual(st.state, 'unknown');
    assert.deepStrictEqual(hits, []);
  } finally {
    global.fetch = save.fetch;
    http.get = save.httpGet; http.request = save.httpReq;
    https.get = save.httpsGet; https.request = save.httpsReq;
    net.connect = save.netConnect; net.createConnection = save.netCreate;
    tls.connect = save.tlsConnect;
  }
});

console.log('resolver — unmonitored capability + null-family short-circuit');

const CFG = { routes: [], providers: {} };
const ROUTE = {
  id: 'stepfun-plan-main',
  provider: 'stepfun-plan',
  match: { model: 'stepfun' },
  monitor: { recipe: 'stepfun-plan' },
};

test('resolver yields {monitorable:false, reason:unmonitored:stepfun-plan}', () => {
  const eff = resolveEffectiveConfig(ROUTE, CFG, { getAdapter });
  assert.strictEqual(eff.capability.monitorable, false);
  assert.strictEqual(eff.capability.reason, 'unmonitored:stepfun-plan');
  assert.strictEqual(typeof eff.adapterFn, 'function');
});

test('null family: any route.provider resolves (no recipe-family-mismatch)', () => {
  for (const provider of ['stepfun-plan', 'openai-compat', 'some-future-harness']) {
    const eff = resolveEffectiveConfig({ ...ROUTE, provider }, CFG, { getAdapter });
    assert.strictEqual(eff.capability.reason, 'unmonitored:stepfun-plan',
      `provider "${provider}" should not trip the family check`);
  }
});

console.log('recipeOptions — declared empty; unknown keys rejected');

test('recipeOptions {} is valid; {path:...} is rejected', () => {
  assert.strictEqual(validateMonitor(ROUTE).ok, true);
  assert.strictEqual(validateRecipeOptions('stepfun-plan', {}).ok, true);
  const bad = validateRecipeOptions('stepfun-plan', { path: '/v1/anything' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /not an option of recipe "stepfun-plan"/);
});

console.log('CLI — refresh/report/check with no credential (tmp CLAUDE_PLUGIN_DATA)');

const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/step-plan-preload.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-step-plan-'));
const env = {
  PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir,
  NODE_OPTIONS: `--require=${preload}`,
};
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  routes: [ROUTE],
  gate: { mode: 'deny', injectContext: true },
  refreshOnSessionStart: false,
}));

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 5000 });
  return result;
}

test('refresh exits 0 and writes an unknown/unmonitored cache entry', () => {
  const res = run(['refresh', '--quiet']);
  assert.strictEqual(res.status, 0, res.stderr || String(res.error));
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  const entry = doc.routes['stepfun-plan-main'];
  assert.ok(entry, 'expected cache entry for stepfun-plan-main');
  assert.strictEqual(entry.status.state, 'unknown');
  assert.deepStrictEqual(entry.status.windows, []);
  assert.strictEqual(entry.status.balance, null);
  assert.strictEqual(entry.status.detail.reason, 'unmonitored-no-documented-quota-source');
});

test('report (text) shows the exact unmonitored wording', () => {
  const res = run(['report']);
  assert.strictEqual(res.status, 0, res.stderr || String(res.error));
  assert.match(res.stdout, /stepfun-plan-main: unmonitored — no documented quota source/);
});

test('check exits 0 and prints stable unknown JSON without a credential', () => {
  const res = run(['check', 'stepfun-plan-main']);
  assert.strictEqual(res.status, 0, res.stderr || String(res.error));
  const st = JSON.parse(res.stdout);
  assert.strictEqual(st.state, 'unknown');
  assert.deepStrictEqual(st.windows, []);
  assert.strictEqual(st.balance, null);
  assert.strictEqual(st.detail.reason, 'unmonitored-no-documented-quota-source');
});

test('no network, exec, or vault access during the CLI runs (tripwire observed)', () => {
  // The preload's forbidden handlers log BEFORE throwing and its vault stub
  // records every has/get, so a real attempt would appear here. Assert all
  // three directions: the tripwire ran (exit events exist), and neither the
  // network/exec tripwires nor the vault counter ever fired.
  const events = fs.readFileSync(path.join(dir, 'events'), 'utf8');
  assert.match(events, /"kind":"exit"/, 'preload must have run (exit events recorded)');
  assert.doesNotMatch(events, /"kind":"network"/);
  assert.doesNotMatch(events, /"kind":"exec"/);
  assert.doesNotMatch(events, /"kind":"vault-has"/, 'credential-free route must never consult vault.has');
  assert.doesNotMatch(events, /"kind":"vault-get"/, 'credential-free route must never consult vault.get');
  assert.doesNotMatch(events, /network forbidden|exec forbidden/);
});

runTests().then(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  if (failures) {
    console.error(`\n${failures} step-plan test(s) failed`);
    process.exit(1);
  }
  console.log('all step-plan tests passed');
});
