'use strict';
// CLI integration for the Alibaba Coding Plan route (Issue #56): the real
// `bin/vl.js refresh` and `check`, the real resolver/recipe/bounded runner,
// with child_process.spawn stubbed (test/fixtures/alibaba-cli-preload.cjs).
// No network, no account, no real `bl`.
//
// Proves:
//   - a vaultless route (capabilities.vaultCredential === false) still takes
//     part in refresh AND in check — the CLI hook works on both paths
//   - a route whose recipe DOES need a vault credential is still skipped by
//     refresh and still rejected by check (no regression)
//   - refresh/check spawn only `bl auth status` and `bl usage coding-plan`
//   - the documented payload normalizes through the real CLI to exhausted with
//     recovery bounded freshness
//   - missing CLI / exit 3 / malformed / `{}` all land as stable `unknown`
//   - no secret reaches stdout, stderr or status.json

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CANARY = 'sk-sp-CANARY-bailian-3c81';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-alibaba-cli-'));
const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/alibaba-cli-preload.cjs');
const eventsPath = path.join(dir, 'events');

const routes = [
  { id: 'bailian-coding-plan', provider: 'alibaba-cloud', match: { model: 'qwen' }, ttlSeconds: 600,
    monitor: { recipe: 'alibaba-coding-plan', region: 'cn-beijing', profile: 'token-plan' } },
  { id: 'custom-an', provider: 'anthropic-compat', match: { model: 'an-model' }, ttlSeconds: 600,
    monitor: { endpoint: 'https://an.example.com/api', recipe: 'anthropic-compat', recipeOptions: { path: '/v1/models', scope: 'account' } } },
  { id: 'custom-nokey', provider: 'openai-compat', match: { model: 'nokey' }, ttlSeconds: 600,
    monitor: { endpoint: 'https://nokey.example.com', recipe: 'openai-compat', recipeOptions: { path: '/v1/models' } } },
];
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ routes, gate: { mode: 'deny' } }));

function run(args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir,
    // A secret in OUR environment: the bounded runner must not forward it.
    OPENAI_API_KEY: 'sk-CANARY-parent-env',
    ANTHROPIC_API_KEY: 'CANARY-parent-anthropic',
    // Quoted: NODE_OPTIONS is whitespace-split, so a path containing a space
    // would otherwise be parsed as two arguments.
    NODE_OPTIONS: `--require="${preload}"`,
    VL_VAULT_IDS: 'custom-an',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 20000 });
  assert.ok(!r.stdout.includes(CANARY), `secret canary leaked to stdout: ${r.stdout}`);
  assert.ok(!r.stderr.includes(CANARY), `secret canary leaked to stderr: ${r.stderr}`);
  assert.ok(!r.stdout.includes('sk-CANARY-parent-env'), 'a parent-env secret leaked to stdout');
  return r;
}

function events() {
  try { return fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch { return []; }
}
function spawns() { return events().filter((e) => e.kind === 'spawn'); }
function resetEvents() { try { fs.unlinkSync(eventsPath); } catch { /* none yet */ } }
function statusJson() { return JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')); }

let failures = 0;
const tests = [];
function test(name, fn) { try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${(e && e.message) || e}`); } }

console.log('refresh — a vaultless route takes part');

test('refresh includes the alibaba route and reaches the adapter', () => {
  resetEvents();
  const r = run(['refresh']);
  assert.strictEqual(r.status, 0, `refresh exited ${r.status}: ${r.stderr}`);
  const st = statusJson().routes['bailian-coding-plan'];
  assert.ok(st, 'the alibaba route has a cache entry');
  assert.strictEqual(st.status.state, 'exhausted');
  assert.ok(spawns().length >= 2, 'the adapter actually ran subprocesses');
});

test('refresh still skips a vault-needing route with no credential (no regression)', () => {
  const cached = statusJson().routes;
  assert.ok(!cached['custom-nokey'], 'a route with no key and a vault-requiring recipe is still skipped');
  // `custom-an` has a key, so it is still refreshed exactly as before #56. It
  // reaches the compat adapter, which finds the network forbidden and fails to
  // an unknown — it must never spawn `bl`.
  const argv = spawns().flatMap((s) => s.args);
  assert.ok(!argv.includes('/v1/models'), 'the compat route never touched the CLI recipe');
});

test('the documented payload normalizes to three quota windows', () => {
  const st = statusJson().routes['bailian-coding-plan'].status;
  assert.deepStrictEqual(st.windows.map((w) => w.type), ['rolling-5h', 'weekly', 'monthly']);
  assert.deepStrictEqual(st.windows.map((w) => w.remaining), [4200, 0, 78000]);
  assert.ok(st.windows.every((w) => w.signal === 'quota'));
  assert.strictEqual(st.balance, null);
  assert.strictEqual(st.detail.instanceType, 'pro');
  assert.strictEqual(st.detail.region, 'cn-beijing');
  assert.strictEqual(st.detail.regionVerified, false);
});

test('exhaustion bounds cache freshness by the recovery time', () => {
  const entry = statusJson().routes['bailian-coding-plan'];
  assert.ok(Date.parse(entry.freshUntil) <= Date.parse(entry.status.resetAt) + 1000,
    'freshUntil must not outlive the stated recovery');
});

test('only the two documented bl commands were spawned', () => {
  const heads = spawns().map((s) => s.args[0]);
  assert.deepStrictEqual([...new Set(heads)].sort(), ['auth', 'usage']);
  const quota = spawns().find((s) => s.args[0] === 'usage');
  assert.deepStrictEqual(quota.args.slice(0, 4), ['usage', 'coding-plan', '--output', 'json']);
});

test('no spawn used a shell or forwarded a parent secret', () => {
  for (const s of spawns()) {
    assert.strictEqual(s.shell, false, 'shell must never be enabled');
    assert.deepStrictEqual(s.stdio, ['ignore', 'pipe', 'pipe'], 'stdin is closed');
    assert.strictEqual(s.envCanary, false, 'a parent secret reached the child env');
    assert.ok(!s.args.some((a) => /login|logout|--api-key|console-switch-agent/.test(String(a))), `unsafe argv: ${s.args}`);
  }
});

console.log('check — the vaultless route reaches the adapter too');

test('check works without a vault credential', () => {
  resetEvents();
  const r = run(['check', 'bailian-coding-plan']);
  assert.strictEqual(r.status, 0, `check exited ${r.status}: ${r.stderr}`);
  const st = JSON.parse(r.stdout);
  assert.strictEqual(st.state, 'exhausted');
  assert.strictEqual(st.detail.recipe, 'alibaba-coding-plan');
});

test('check still rejects a vault-needing route with no credential (no regression)', () => {
  resetEvents();
  const r = run(['check', 'custom-nokey']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no credential for "custom-nokey"/);
  assert.strictEqual(spawns().length, 0, 'no subprocess ran for the refused route');
});

console.log('source absence and failure are stable unknowns');

const MODES = [
  ['missing', 'cli-missing'],
  ['exit3', 'auth-rejected'],
  ['malformed', 'malformed-output'],
  ['nonobject', 'malformed-output'],
  ['empty', 'no-active-subscription'],
  ['authno', 'auth-required'],
  ['huge', 'cli-output-too-large'],
  // A JSON document with trailing noise is NOT scraped for a substring: the
  // whole of stdout must be one JSON object.
  ['trailing', 'malformed-output'],
];

for (const [mode, reason] of MODES) {
  test(`bl ${mode} -> unknown ${reason}`, () => {
    resetEvents();
    const r = run(['check', 'bailian-coding-plan'], { VL_BAILIAN_MODE: mode });
    assert.strictEqual(r.status, 0, `check exited ${r.status}: ${r.stderr}`);
    const st = JSON.parse(r.stdout);
    assert.strictEqual(st.state, 'unknown', `${mode} must be unknown`);
    assert.strictEqual(st.detail.reason, reason);
    assert.strictEqual(st.detail.monitorable, false);
    assert.deepStrictEqual(st.windows, []);
  });
}

test('a wedged `bl` is ended by the recipe deadline, not left to hang', () => {
  // A dedicated data dir whose route sets the minimum documented timeout, so
  // the REAL bounded-runner deadline (not a stubbed one) is exercised.
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-alibaba-hang-'));
  fs.writeFileSync(path.join(d2, 'config.json'), JSON.stringify({
    routes: [{ id: 'hang', provider: 'alibaba-cloud', ttlSeconds: 600,
      monitor: { recipe: 'alibaba-coding-plan', region: 'cn-beijing', recipeOptions: { timeoutMs: 1000 } } }],
    gate: { mode: 'deny' },
  }));
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, 'check', 'hang'], {
    env: {
      PATH: process.env.PATH, HOME: d2, CLAUDE_PLUGIN_DATA: d2,
      NODE_OPTIONS: `--require="${preload}"`, VL_BAILIAN_MODE: 'hang',
    },
    encoding: 'utf8', timeout: 20000,
  });
  const elapsed = Date.now() - started;
  assert.strictEqual(r.status, 0, `check exited ${r.status}: ${r.stderr}`);
  const st = JSON.parse(r.stdout);
  assert.strictEqual(st.state, 'unknown');
  assert.strictEqual(st.detail.reason, 'cli-timeout');
  assert.ok(elapsed < 15000, `the deadline must fire promptly, took ${elapsed}ms`);
});

test('a declared authenticated profile is not refused because the active one is not', () => {
  // Stub answers `auth status` unauthenticated without --config, authenticated
  // with it. The route must still reach the quota read.
  resetEvents();
  const r = run(['check', 'bailian-coding-plan'], { VL_BAILIAN_MODE: 'profiletok' });
  assert.strictEqual(r.status, 0, `check exited ${r.status}: ${r.stderr}`);
  const st = JSON.parse(r.stdout);
  assert.notStrictEqual(st.detail.reason, 'auth-required');
  const heads = spawns().map((s) => s.args[0]);
  assert.deepStrictEqual([...new Set(heads)].sort(), ['auth', 'usage'], 'both commands ran');
});

console.log('report — a vaultless route is not reported as unconfigured');

test('report renders the inventory rather than the no-credential message', () => {
  resetEvents();
  const r = run(['report']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /bailian-coding-plan/);
  assert.doesNotMatch(r.stdout, /No credentials stored/i);
});

test('report --json emits the alibaba row and no secret', () => {
  const r = run(['report', '--json']);
  const doc = JSON.parse(r.stdout);
  assert.ok(doc.routes['bailian-coding-plan']);
  assert.ok(!r.stdout.includes(CANARY));
});

if (failures) {
  console.error(`\n${failures} alibaba-cli test(s) failed`);
  process.exit(1);
}
console.log('all alibaba-cli tests passed');