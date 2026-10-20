'use strict';
// Alibaba Cloud Coding Plan recipe (Issue #56) — fixture tests.
//
// NO NETWORK, NO ACCOUNT, NO SUBPROCESS: `ctx.runBounded` is a stub that returns
// canned stdout/exit codes, and every payload below is built from the published
// `bl usage coding-plan --output json` contract (all fields optional, resetTime
// in epoch ms, `{}` when no active subscription) plus the documented Coding Plan
// semantics from help/en/model-studio/coding-plan.
//
// Nothing here is presented as live verification.

const assert = require('assert');
const alibaba = require('../lib/adapters/alibaba-coding-plan');
const { getRecipe, routeNeedsVaultCredential } = require('../lib/recipes');
const { runBounded } = require('../lib/adapters/bounded-exec');

let failures = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- harness ---------------------------------------------------------------

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const future = (mins) => NOW + mins * 60000;

function ok(stdout, code = 0) {
  return { ok: code === 0, error: null, code, stdout, stderr: '', timedOut: false, overflow: false };
}
function failed(code, stderr = '') {
  return { ok: false, error: null, code, stdout: '', stderr, timedOut: false, overflow: false };
}

// A recorder that answers `auth status` with a console login and the quota call
// with whatever stdout the test supplies.
function runner(quota, authPayload = { authenticated: true, config: 'default', console: { source: 'config', masked: 'c***n', region: 'cn-beijing', site: 'domestic' } }) {
  const calls = [];
  const fn = async (bin, args, opts) => {
    calls.push({ bin, args: args.slice(), env: (opts && opts.env) || null, timeoutMs: opts && opts.timeoutMs });
    const head = args[0];
    if (head === 'auth') return ok(JSON.stringify(authPayload));
    if (typeof quota === 'function') return quota(bin, args);
    return quota;
  };
  fn.calls = calls;
  return fn;
}

const CFG = Object.freeze({
  recipeId: 'alibaba-coding-plan',
  baseUrl: null,
  monitor: { recipe: 'alibaba-coding-plan', region: 'cn-beijing' },
  account: null,
  profile: null,
  region: 'cn-beijing',
  model: null,
  recipeOptions: {},
});

function ctx(run, extra = {}) {
  return Object.assign({ now: () => NOW, threshold: 0.2, runBounded: run }, extra);
}

const healthy = {
  instanceType: 'pro',
  per5Hour: { usedQuota: 38, totalQuota: 100, percentage: 0.38, resetTime: future(30) },
  perWeek: { usedQuota: 500, totalQuota: 1000, percentage: 0.5, resetTime: future(1000) },
  perBillMonth: { usedQuota: 500, totalQuota: 1000, percentage: 0.5, resetTime: future(10000) },
};
const quotaOk = (payload) => ok(JSON.stringify(payload));

async function run() {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
    } catch (e) {
      failures += 1;
      console.log(`  ✗ ${t.name}\n    ${(e && e.message) || e}`);
    }
  }
}

console.log('documented quota output normalizes correctly');

test('healthy payload -> three documented windows, correct types and arithmetic', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(healthy))));
  assert.strictEqual(st.state, 'healthy');
  assert.strictEqual(st.balance, null, 'balance is always null');
  assert.deepStrictEqual(st.windows.map((w) => w.type), ['rolling-5h', 'weekly', 'monthly']);
  assert.deepStrictEqual(st.windows.map((w) => w.remaining), [62, 500, 500]);
  assert.deepStrictEqual(st.windows.map((w) => w.limit), [100, 1000, 1000]);
  assert.ok(st.windows.every((w) => w.signal === 'quota'), 'windows are plan quota, not throughput');
  assert.strictEqual(st.detail.recipe, 'alibaba-coding-plan');
  assert.strictEqual(st.detail.instanceType, 'pro');
});

test('resetTime is read as epoch MILLISECONDS', async () => {
  const payload = JSON.parse(JSON.stringify(healthy));
  payload.per5Hour.resetTime = future(45); // ms
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(payload))));
  assert.strictEqual(st.windows[0].resetAt, new Date(future(45)).toISOString());
});

test('percentage is ignored; remaining comes from used/total', async () => {
  // A lying percentage must not move the number. If it were trusted, this
  // window would look 90% full (remaining 10) instead of 50% (remaining 500).
  const payload = {
    per5Hour: { usedQuota: 500, totalQuota: 1000, percentage: 0.9, resetTime: future(30) },
    perWeek: { usedQuota: 1, totalQuota: 1000, percentage: 0.9, resetTime: future(30) },
    perBillMonth: { usedQuota: 1, totalQuota: 1000, percentage: 0.9, resetTime: future(30) },
  };
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(payload))));
  assert.strictEqual(st.windows[0].remaining, 500);
});

test('constrained when a window falls under the threshold', async () => {
  const payload = JSON.parse(JSON.stringify(healthy));
  payload.perWeek = { usedQuota: 950, totalQuota: 1000, resetTime: future(1000) };
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(payload))));
  assert.strictEqual(st.state, 'constrained');
});

test('exhausted needs remaining 0 AND a valid future reset; recovery is the last drained reset', async () => {
  const payload = {
    per5Hour: { usedQuota: 100, totalQuota: 100, resetTime: future(30) },
    perWeek: { usedQuota: 1000, totalQuota: 1000, resetTime: future(3000) },
    perBillMonth: { usedQuota: 10, totalQuota: 1000, resetTime: future(10000) },
  };
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(payload))));
  assert.strictEqual(st.state, 'exhausted');
  assert.strictEqual(st.resetAt, new Date(future(3000)).toISOString());
  assert.strictEqual(st.detail.recoveryAt, new Date(future(3000)).toISOString());
});

console.log('missing CLI on PATH');

test('missing CLI -> stable unknown cli-missing, no status guess', async () => {
  const run = async () => ({ ok: false, error: 'cli-missing', code: null, stdout: '', stderr: '', timedOut: false, overflow: false });
  const st = await alibaba.fetchStatus(CFG, null, ctx(run));
  assert.strictEqual(st.state, 'unknown');
  assert.strictEqual(st.detail.reason, 'cli-missing');
  assert.strictEqual(st.detail.monitorable, false);
  assert.deepStrictEqual(st.windows, []);
  assert.strictEqual(st.balance, null);
  assert.match(st.detail.note, /install the Bailian CLI/i);
});

console.log('missing / invalid auth');

test('no console login -> auth-required (auth status omits console)', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(healthy), { authenticated: false, config: 'default' })));
  assert.strictEqual(st.detail.reason, 'auth-required');
  assert.match(st.detail.note, /bl auth login --console/);
});

test('no console login -> the quota command is never run', async () => {
  const run = runner(quotaOk(healthy), { authenticated: false });
  await alibaba.fetchStatus(CFG, null, ctx(run));
  assert.strictEqual(run.calls.length, 1, 'only the auth preflight ran');
  assert.deepStrictEqual(run.calls[0].args, ['auth', 'status', '--output', 'json']);
});

test('malformed auth status -> auth-status-malformed, never a credential guess', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(healthy), 'not json at all')));
  assert.strictEqual(st.detail.reason, 'auth-status-malformed');
});

test('CLI exit 3 on the quota read -> auth-rejected', async () => {
  const run = async (bin, args) => (args[0] === 'auth' ? ok(JSON.stringify({ console: {}, config: 'default' })) : failed(3));
  const st = await alibaba.fetchStatus(CFG, null, ctx(run));
  assert.strictEqual(st.detail.reason, 'auth-rejected');
  assert.strictEqual(st.detail.cliExitCode, 3);
  assert.strictEqual(st.state, 'unknown');
});

console.log('malformed output');

test('stdout that is not JSON -> malformed-output', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(ok('Error: something went wrong\n'))));
  assert.strictEqual(st.detail.reason, 'malformed-output');
});

test('JSON that is not an object -> malformed-output', async () => {
  for (const body of ['[]', '"str"', '42', 'null']) {
    const st = await alibaba.fetchStatus(CFG, null, ctx(runner(ok(body))));
    assert.strictEqual(st.detail.reason, 'malformed-output', `body ${body}`);
  }
});

test('truncated JSON (over the stdout cap) never parses as complete', async () => {
  const run = async () => ({ ok: false, error: 'stdout-too-large', code: null, stdout: '{"per5Hour":{"used', stderr: '', timedOut: false, overflow: true });
  const st = await alibaba.fetchStatus(CFG, null, ctx(run));
  assert.strictEqual(st.detail.reason, 'cli-output-too-large');
});

test('{} -> no-active-subscription (documented: no VALID instance)', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(ok('{}'))));
  assert.strictEqual(st.detail.reason, 'no-active-subscription');
});

test('windows declared but no usable numbers -> no-quota-data', async () => {
  const payload = { per5Hour: { totalQuota: 100 }, perWeek: {}, perBillMonth: {} };
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(ok(JSON.stringify(payload)))));
  assert.strictEqual(st.detail.reason, 'no-quota-data');
});

test('totalQuota 0 or negative drops the window; other windows survive', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(ok(JSON.stringify({
    per5Hour: { usedQuota: 5, totalQuota: 0 },
    perWeek: { usedQuota: 1, totalQuota: 10, resetTime: future(60) },
    perBillMonth: { usedQuota: 1, totalQuota: 10, resetTime: future(60) },
  })))));
  assert.deepStrictEqual(st.windows.map((w) => w.type), ['weekly', 'monthly']);
});

test('used > total -> contradictory-quota, never clamped to remaining 0', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(ok(JSON.stringify({
    per5Hour: { usedQuota: 150, totalQuota: 100, resetTime: future(30) },
    perWeek: { usedQuota: 1, totalQuota: 10, resetTime: future(60) },
    perBillMonth: { usedQuota: 1, totalQuota: 10, resetTime: future(60) },
  })))));
  assert.strictEqual(st.detail.reason, 'contradictory-quota');
  assert.strictEqual(st.state, 'unknown');
  assert.deepStrictEqual(st.windows, [], 'contradiction withholds the whole read, not just the window');
});

console.log('unsupported region');

test('no region declared -> region-required', async () => {
  const st = await alibaba.fetchStatus(Object.assign({}, CFG, { region: null }), null, ctx(runner(quotaOk(healthy))));
  assert.strictEqual(st.detail.reason, 'region-required');
  assert.strictEqual(st.state, 'unknown');
});

test('region of an undocumented shape -> unsupported-region, and never reaches the CLI', async () => {
  const run = runner(quotaOk(healthy));
  for (const bad of ['CN-Beijing', '--output', 'cn-beijing/../etc', 'b', 'cn beijing', '-cn-beijing', 'cn_beijing']) {
    const st = await alibaba.fetchStatus(Object.assign({}, CFG, { region: bad }), null, ctx(run));
    assert.strictEqual(st.detail.reason, 'unsupported-region', `region ${JSON.stringify(bad)}`);
  }
  // An empty region is "not declared", which is a different, equally stable
  // reason — and equally refuses to run anything.
  const empty = await alibaba.fetchStatus(Object.assign({}, CFG, { region: '' }), null, ctx(run));
  assert.strictEqual(empty.detail.reason, 'region-required');
  assert.strictEqual(run.calls.length, 0, 'no subprocess ran for a refused region');
});

test('region is reported as a declaration, never as verified', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(healthy))));
  assert.strictEqual(st.detail.region, 'cn-beijing');
  assert.strictEqual(st.detail.regionVerified, false);
  assert.strictEqual(st.detail.regionSource, 'route-declaration');
});

test('a documented-shaped region passes through to --console-region', async () => {
  const run = runner(quotaOk(healthy));
  await alibaba.fetchStatus(Object.assign({}, CFG, { region: 'ap-southeast-1' }), null, ctx(run));
  const quota = run.calls[1];
  assert.ok(quota.args.includes('--console-region'));
  assert.strictEqual(quota.args[quota.args.indexOf('--console-region') + 1], 'ap-southeast-1');
});

console.log('missing / invalid reset field');

test('missing resetTime on a drained window -> exhaustion-without-recovery', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(ok(JSON.stringify({
    per5Hour: { usedQuota: 100, totalQuota: 100 },
    perWeek: { usedQuota: 1000, totalQuota: 1000, resetTime: future(3000) },
    perBillMonth: { usedQuota: 10, totalQuota: 1000, resetTime: future(10000) },
  })))));
  assert.strictEqual(st.detail.reason, 'exhaustion-without-recovery');
  assert.strictEqual(st.state, 'unknown', 'unknown, never exhausted, when recovery is unproven');
});

test('a reset in the past is not a recovery time', async () => {
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(ok(JSON.stringify({
    per5Hour: { usedQuota: 100, totalQuota: 100, resetTime: NOW - 60000 },
    perWeek: { usedQuota: 10, totalQuota: 1000, resetTime: future(3000) },
    perBillMonth: { usedQuota: 10, totalQuota: 1000, resetTime: future(10000) },
  })))));
  assert.strictEqual(st.detail.reason, 'exhaustion-without-recovery');
});

test('a non-numeric resetTime is treated as absent, not as zero', async () => {
  const payload = JSON.parse(JSON.stringify(healthy));
  payload.per5Hour.resetTime = 'not-a-number';
  const st = await alibaba.fetchStatus(CFG, null, ctx(runner(quotaOk(payload))));
  assert.strictEqual(st.windows[0].resetAt, null, 'unparseable reset is not a reset');
  assert.strictEqual(st.windows[0].remaining, 62, 'the window itself survives');
  assert.strictEqual(st.state, 'healthy');
});

console.log('auth-rejected / non-zero exits');

test('every published non-zero exit code maps to a stable reason', async () => {
  const expected = { 1: 'cli-exit-1', 2: 'usage-error', 4: 'cli-exit-4', 5: 'cli-timeout', 6: 'network-error', 7: 'cli-exit-7', 10: 'cli-exit-10' };
  for (const [code, reason] of Object.entries(expected)) {
    const run = async (bin, args) => (args[0] === 'auth' ? ok(JSON.stringify({ console: {}, config: 'default' })) : failed(Number(code)));
    const st = await alibaba.fetchStatus(CFG, null, ctx(run));
    assert.strictEqual(st.detail.reason, reason, `exit ${code}`);
    assert.strictEqual(st.state, 'unknown');
    assert.strictEqual(st.detail.cliExitCode, Number(code));
  }
});

test('a timeout from the runner maps to cli-timeout', async () => {
  const run = async (bin, args) => (args[0] === 'auth' ? ok(JSON.stringify({ console: {}, config: 'default' })) : { ok: false, error: 'timeout', code: null, stdout: '', stderr: '', timedOut: true, overflow: false });
  const st = await alibaba.fetchStatus(CFG, null, ctx(run));
  assert.strictEqual(st.detail.reason, 'cli-timeout');
});

console.log('argv allowlist — no login, no profile mutation, no delegated identity, no inference');

test('the only commands reachable are `auth status` and `usage coding-plan`', async () => {
  const run = runner(quotaOk(healthy));
  await alibaba.fetchStatus(CFG, null, ctx(run));
  assert.deepStrictEqual(run.calls.map((c) => c.args[0]), ['auth', 'usage']);
  assert.deepStrictEqual(run.calls[1].args.slice(0, 4), ['usage', 'coding-plan', '--output', 'json']);
});

test('no mutating, login or delegated-access token ever appears in argv', async () => {
  const run = runner(quotaOk(healthy));
  await alibaba.fetchStatus(CFG, null, ctx(run));
  const argv = run.calls.map((c) => c.args.join(' ')).join(' ');
  for (const banned of ['login', 'logout', 'config use', 'config set', '--api-key', '--access-key-secret', '--console-switch-agent', '--dry-run']) {
    assert.ok(!argv.includes(banned), `argv must never contain ${banned}: ${argv}`);
  }
});

test('no inference subcommand is reachable', async () => {
  const run = runner(quotaOk(healthy));
  await alibaba.fetchStatus(CFG, null, ctx(run));
  const argv = run.calls.map((c) => c.args.join(' '));
  for (const banned of ['chat', 'generate', 'run ', 'completion', 'messages', 'embeddings']) {
    assert.ok(!argv.some((a) => a.includes(banned)), `argv must never reach ${banned}: ${argv.join(' | ')}`);
  }
});

test('a hostile profile cannot inject a flag', async () => {
  const run = runner(quotaOk(healthy));
  for (const bad of ['--output', '--config', '-x', 'a b', '../../etc', '--console-region']) {
    const st = await alibaba.fetchStatus(Object.assign({}, CFG, { profile: bad }), null, ctx(run));
    assert.strictEqual(st.detail.reason, 'profile-invalid', `profile ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(run.calls.length, 0, 'a refused profile never reaches the CLI');
});

test('a declared profile is passed with the per-invocation --config flag', async () => {
  const run = runner(quotaOk(healthy));
  const st = await alibaba.fetchStatus(Object.assign({}, CFG, { profile: 'token-plan' }), null, ctx(run));
  const argv = run.calls.find((c) => c.args[0] === 'usage').args;
  assert.strictEqual(argv[argv.indexOf('--config') + 1], 'token-plan');
  assert.strictEqual(st.detail.profile, 'token-plan');
});

test('with no declared profile the CLI active profile is reported, and no --config is passed', async () => {
  const run = runner(quotaOk(healthy), { console: {}, config: 'default' });
  const st = await alibaba.fetchStatus(CFG, null, ctx(run));
  assert.strictEqual(st.detail.profile, 'default');
  const quotaCall = run.calls.find((c) => c.args[0] === 'usage');
  assert.ok(quotaCall, 'the quota command ran');
  assert.ok(!quotaCall.args.includes('--config'), `no --config when undeclared: ${quotaCall.args}`);
});

test('the auth preflight is scoped to the declared profile, not the active one', async () => {
  // The declared profile has a console login; the ACTIVE profile does not. A
  // preflight that ignored the declaration would return auth-required with a
  // misleading "log in again" hint and never run the quota read.
  const authPayload = (bin, args) => (args.includes('--config')
    ? ok(JSON.stringify({ authenticated: true, config: 'token-plan', console: { source: 'config', masked: 'c***n' } }))
    : ok(JSON.stringify({ authenticated: false, config: 'default' })));
  const run = runner((bin, args) => (args[0] === 'auth' ? authPayload(bin, args) : ok(JSON.stringify(healthy))));
  const st = await alibaba.fetchStatus(Object.assign({}, CFG, { profile: 'token-plan' }), null, ctx(run));
  assert.notStrictEqual(st.detail.reason, 'auth-required', 'a declared authenticated profile must not be refused');
  assert.strictEqual(st.state, 'healthy');
  const preflight = run.calls[0];
  assert.ok(preflight.args.includes('--config'), 'the preflight must carry the declared profile');
  assert.strictEqual(preflight.args[preflight.args.indexOf('--config') + 1], 'token-plan');
  assert.strictEqual(st.detail.profile, 'token-plan');
});

test('recipeOptions.site selects the documented commodity', async () => {
  const run = runner(quotaOk(healthy));
  await alibaba.fetchStatus(Object.assign({}, CFG, { recipeOptions: { site: 'international' } }), null, ctx(run));
  const argv = run.calls[1].args;
  assert.strictEqual(argv[argv.indexOf('--console-site') + 1], 'international');
});

console.log('secrets never reach the status or the child environment');

test('a token in child output never appears anywhere in the status', async () => {
  const CANARY = 'sk-sp-CANARY-9f2b7c-do-not-leak';
  const run = async (bin, args) => {
    if (args[0] === 'auth') {
      return ok(JSON.stringify({ authenticated: true, config: 'default', console: { source: 'config', masked: 'c***n' } }));
    }
    return { ok: true, error: null, code: 0, stdout: JSON.stringify(healthy), stderr: `leaked ${CANARY}`, timedOut: false, overflow: false };
  };
  const st = await alibaba.fetchStatus(CFG, CANARY, ctx(run));
  assert.ok(!JSON.stringify(st).includes(CANARY), 'the canary must not appear in the status');
});

test('a token echoed inside a stdout payload does not survive into the status', async () => {
  const CANARY = 'sk-sp-CANARY-inside-payload';
  const run = async (bin, args) => (args[0] === 'auth'
    ? ok(JSON.stringify({ console: {}, config: 'default' }))
    : ok(JSON.stringify(Object.assign({}, healthy, { secretEcho: CANARY, access_token: CANARY }))));
  const st = await alibaba.fetchStatus(CFG, CANARY, ctx(run));
  assert.ok(!JSON.stringify(st).includes(CANARY), 'unknown payload fields must not be echoed into the status');
});

test('the child environment is an allowlist: no vault or harness secret crosses over', async () => {
  const SECRETS = {
    OPENAI_API_KEY: 'sk-CANARY-env-leak',
    ANTHROPIC_API_KEY: 'CANARY-anthropic',
    VL_VAULT_TOKEN: 'CANARY-vault',
    DASHSCOPE_API_KEY: 'sk-CANARY-dashscope',
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'CANARY-ali-secret',
    GITHUB_TOKEN: 'ghp_CANARY-github',
  };
  const run = runner(quotaOk(healthy));
  await alibaba.fetchStatus(CFG, 'vault-token', ctx(run, {
    env: Object.assign({}, process.env, SECRETS, { PATH: '/usr/bin:/bin', HOME: '/tmp/x' }),
  }));
  assert.strictEqual(run.calls.length, 2, 'both subprocesses ran');
  for (const call of run.calls) {
    assert.ok(call.env, 'a child env was passed');
    for (const key of Object.keys(SECRETS)) {
      assert.ok(!(key in call.env), `${key} must not be forwarded to the child`);
      assert.ok(!JSON.stringify(call.env).includes(SECRETS[key]), `${key}'s value must not be forwarded`);
    }
    // Documented necessities are kept.
    assert.strictEqual(call.env.PATH, '/usr/bin:/bin');
    assert.strictEqual(call.env.HOME, '/tmp/x');
    assert.strictEqual(call.env.NO_COLOR, '1');
    assert.strictEqual(call.env.TERM, 'dumb');
  }
});

test('the timeout option reaches the runner', async () => {
  const run = runner(quotaOk(healthy));
  await alibaba.fetchStatus(Object.assign({}, CFG, { recipeOptions: { timeoutMs: 2500 } }), null, ctx(run));
  assert.ok(run.calls.every((c) => c.timeoutMs === 2500), 'recipeOptions.timeoutMs is honoured');
});

test('the real runner does not hand process.env to the child', async () => {
  // `/usr/bin/env` prints its own environment. Run it through the real bounded
  // runner and confirm a secret from THIS process never appears in the child.
  const CANARY = 'CANARY-process-env-4d21';
  process.env.VL_ENV_CANARY = CANARY;
  try {
    const res = await runBounded('/usr/bin/env', [], {
      timeoutMs: 2000,
      env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME }, { NO_COLOR: '1', TERM: 'dumb' }),
    });
    assert.ok(res.ok, `env exited ${res.code}: ${res.error}`);
    assert.ok(!res.stdout.includes(CANARY), 'the child must not inherit this process environment');
  } finally {
    delete process.env.VL_ENV_CANARY;
  }
});

console.log('capability is unknown when the source is absent');

test('capability classification follows the recipe registry', () => {
  const recipe = getRecipe('alibaba-coding-plan');
  assert.strictEqual(recipe.capabilities.monitorable, true);
  assert.strictEqual(recipe.capabilities.credential, 'cli-managed-auth');
  assert.strictEqual(recipe.capabilities.vaultCredential, false);
  assert.strictEqual(recipe.capabilities.inference, false);
  assert.strictEqual(recipe.family, null);
});

test('routeNeedsVaultCredential is true everywhere except a vaultless recipe', () => {
  assert.strictEqual(routeNeedsVaultCredential({ monitor: { recipe: 'alibaba-coding-plan', region: 'cn-beijing' } }), false);
  for (const route of [
    { monitor: { recipe: 'anthropic-compat' } },
    { monitor: { recipe: 'openai-compat' } },
    { monitor: { recipe: 'built-in' } },
    { monitor: { recipe: 'stepfun-not-yet' } },
    { id: 'kimi-code-plan' },
    {},
    null,
    'not-a-route',
    { monitor: null },
    { monitor: 'nope' },
    { monitor: { recipe: 7 } },
  ]) {
    assert.strictEqual(routeNeedsVaultCredential(route), true, JSON.stringify(route));
  }
});

console.log('invalid recipe options are refused before any subprocess');

test('an unknown recipeOption key is refused', async () => {
  const run = runner(quotaOk(healthy));
  const st = await alibaba.fetchStatus(Object.assign({}, CFG, { recipeOptions: { nope: 1 } }), null, ctx(run));
  assert.strictEqual(st.detail.reason, 'invalid-recipe-options');
  assert.strictEqual(run.calls.length, 0);
});

test('an out-of-enum site or binary is refused', async () => {
  for (const options of [{ site: 'mars' }, { binary: '/usr/bin/env' }, { timeoutMs: 999999 }]) {
    const run = runner(quotaOk(healthy));
    const st = await alibaba.fetchStatus(Object.assign({}, CFG, { recipeOptions: options }), null, ctx(run));
    assert.strictEqual(st.detail.reason, 'invalid-recipe-options', JSON.stringify(options));
    assert.strictEqual(run.calls.length, 0);
  }
});

test('a credential-shaped recipeOption is refused (monitor-schema block-list)', async () => {
  const run = runner(quotaOk(healthy));
  const st = await alibaba.fetchStatus(Object.assign({}, CFG, { recipeOptions: { apiKey: 'x' } }), null, ctx(run));
  assert.strictEqual(st.detail.reason, 'invalid-recipe-options');
  assert.strictEqual(run.calls.length, 0);
});

run().then(() => {
  if (failures) {
    console.error(`\n${failures} alibaba-coding-plan test(s) failed`);
    process.exit(1);
  }
  console.log('all alibaba-coding-plan tests passed');
});