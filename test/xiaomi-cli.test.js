'use strict';
// Xiaomi CLI integration: setup/update/remove/config/report/refresh/check/
// session-start/snapshot behavior for the Chrome-cookie fallback. Child
// processes run under a preload that injects synthetic cookies, password and
// transport — no real Chrome store, no Keychain, no network, no helper
// execution, no `security` binary (exec family hard-blocked). Run:
// node test/xiaomi-cli.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');

const cookieDb = require('./fixtures/xiaomi-cookie-db.cjs');
const CLI = path.resolve(__dirname, '../bin/vl.js');
const PRELOAD = path.resolve(__dirname, 'fixtures/xiaomi-cli-preload.cjs');

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

const OLD_COUNTS = 1111111111;
const FRESH_COUNTS = 28368322580;
const LIMIT = 38000000000;
const KIMI_ID = 'kimi-code-plan';
const XIOMI_ID = 'xiaomi-token-plan';

const kimiRoute = { id: KIMI_ID, provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 };
const xiaomiRoute = { id: XIOMI_ID, provider: 'xiaomi', account: 'token-plan', match: { model: 'mimo' }, ttlSeconds: 0, credentialSource: 'chrome-cookies' };
const kimiStatus = { state: 'healthy', windows: [{ type: 'weekly', remaining: 74, limit: 100, resetAt: null }], balance: null, resetAt: null, detail: {} };
const oldXiaomiStatus = {
  state: 'unknown',
  windows: [{ type: 'tokens', remaining: OLD_COUNTS, limit: LIMIT, resetAt: null }],
  balance: null, resetAt: null, detail: {},
};

function scratch(name, { xiaomi = true, kimi = true, cookies = true, status = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `vl-xiaomi-cli-${name}-`));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const chromeRoot = path.join(dir, 'chrome-root');
  let fixture = null;
  if (cookies) fixture = cookieDb.createConsoleFixture(chromeRoot, 'Profile 46');
  const routes = [];
  if (kimi) routes.push(kimiRoute);
  if (xiaomi) routes.push(xiaomiRoute);
  const config = {
    routes,
    providers: { kimi: { baseUrl: 'https://api.kimi.com' }, ...(xiaomi ? { xiaomi: { baseUrl: 'https://platform.xiaomimimo.com' } } : {}) },
    vault: { backend: 'file', service: 'test-only' },
    gate: { mode: 'off' },
    importMap: {},
    ...(xiaomi ? { xiaomi: { chromeSource: chromeRoot, chromeProfile: 'Profile 46' } } : {}),
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  if (status) fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
  return { dir, home, chromeRoot, fixture, config };
}

function envFor(ctx, extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: ctx.home,
    CLAUDE_PLUGIN_DATA: ctx.dir,
    VIEW_LIMITS_MASTER_KEY: 'test-master-key',
    NODE_OPTIONS: `--require=${PRELOAD}`,
    VL_XIAOMI_VAULT_LOG: path.join(ctx.dir, 'vault.log'),
    VL_XIAOMI_FETCH_LOG: path.join(ctx.dir, 'fetch.log'),
    VL_XIAOMI_BUILD_LOG: path.join(ctx.dir, 'build.log'),
    VL_XIAOMI_SPAWN_LOG: path.join(ctx.dir, 'spawn.log'),
    VL_XIAOMI_KEY_LOG: path.join(ctx.dir, 'key.log'),
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

function run(ctx, args, extra = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: envFor(ctx, extra.env), encoding: 'utf8', timeout: 25000, input: extra.input,
  });
}

function lines(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const vaultCalls = (ctx) => lines(path.join(ctx.dir, 'vault.log'));
const fetches = (ctx) => lines(path.join(ctx.dir, 'fetch.log'));
const builds = (ctx) => lines(path.join(ctx.dir, 'build.log'));
const keyReads = (ctx) => lines(path.join(ctx.dir, 'key.log'));
const clearFetches = (ctx) => { try { fs.unlinkSync(path.join(ctx.dir, 'fetch.log')); } catch { /* absent */ } };
const clearKeyReads = (ctx) => { try { fs.unlinkSync(path.join(ctx.dir, 'key.log')); } catch { /* absent */ } };

const readConfig = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.dir, 'config.json'), 'utf8'));
const readStatus = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.dir, 'status.json'), 'utf8'));

function noVaultForXiaomi(ctx, allowKimi = true) {
  for (const entry of vaultCalls(ctx)) {
    assert.notStrictEqual(entry.id, XIOMI_ID, `legacy vault.${entry.fn} must never run for ${XIOMI_ID}`);
    if (!allowKimi) assert.ok(false, `unexpected vault call: ${JSON.stringify(entry)}`);
  }
}

function cleanup(ctx) {
  if (ctx && ctx.fixture) { try { ctx.fixture.close(); } catch { /* closed */ } }
  if (ctx) fs.rmSync(ctx.dir, { recursive: true, force: true });
}

const seededCache = () => ({
  updatedAt: '2000-01-01T00:00:00.000Z',
  routes: {
    [XIOMI_ID]: { routeId: XIOMI_ID, observedAt: '2000-01-01T00:00:00.000Z', freshUntil: '2000-01-01T00:00:00.000Z', source: 'xiaomi', status: oldXiaomiStatus },
    [KIMI_ID]: { routeId: KIMI_ID, observedAt: '2000-01-01T00:00:00.000Z', freshUntil: '2000-01-01T00:00:00.000Z', source: 'kimi', status: kimiStatus },
  },
});

// F1 fixtures: an orphan row whose route no longer exists (source stamp) and
// one whose only recognizable provenance is a `tokens` window (renamed/legacy
// writer). Both must vanish from normal renders but survive in snapshots.
const orphanSeed = () => {
  const base = seededCache();
  const stale = (id, extra = {}) => ({
    routeId: id, observedAt: '2000-01-01T00:00:00.000Z', freshUntil: '2000-01-01T00:00:00.000Z',
    ...extra,
    status: { state: 'unknown', windows: [{ type: 'tokens', remaining: OLD_COUNTS, limit: LIMIT, resetAt: null }], balance: null, resetAt: null, detail: {} },
  });
  base.routes['orphan-xiaomi'] = stale('orphan-xiaomi', { source: 'xiaomi' });
  base.routes['renamed-xiaomi'] = stale('renamed-xiaomi'); // tokens provenance only
  return base;
};

// Seed a synthetic credential for a NON-xiaomi route through the real
// (file) vault so a report's configured-route check passes — never for
// xiaomi ids, which must not touch the vault at all.
function setVaultCredential(ctx, id, secret) {
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = ctx.dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'test-master-key';
  try {
    require('../lib/vault').set(id, secret);
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY;
    else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }
}

// Read a NON-xiaomi credential back from the real (file) vault — proves a
// denied xiaomi grant never rotated a sibling bearer key (round 5 P2-2).
function getVaultCredential(ctx, id) {
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = ctx.dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'test-master-key';
  try {
    return require('../lib/vault').get(id);
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY;
    else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }
}

async function until(predicate, deadlineMs = 5000) {
  const end = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('wait barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

(async () => {
  console.log('xiaomi CLI — setup/update/remove/config + live report/refresh');

  if (!cookieDb.HAS_SQLITE) {
    console.log('  (node:sqlite unavailable — CLI tests skipped)');
    return;
  }

  // ---- setup ----------------------------------------------------------------
  let ctx = scratch('setup', { xiaomi: false });
  const setup = () => run(ctx, ['setup', XIOMI_ID, '--chrome-source', ctx.chromeRoot, '--profile', 'Profile 46']);
  try {
    const first = setup();
    assert.strictEqual(first.status, 0, first.stderr);
    const cfg = readConfig(ctx);
    const written = cfg.routes.find((r) => r.id === XIOMI_ID);
    assert.deepStrictEqual(written, {
      id: XIOMI_ID, provider: 'xiaomi', account: 'token-plan',
      match: { model: 'mimo' }, ttlSeconds: 0, credentialSource: 'chrome-cookies',
    }, 'route schema must match the adapter design exactly');
    assert.strictEqual(cfg.providers.xiaomi.baseUrl, 'https://platform.xiaomimimo.com');
    assert.strictEqual(cfg.xiaomi.chromeSource, ctx.chromeRoot);
    assert.strictEqual(cfg.xiaomi.chromeProfile, 'Profile 46');
    assert.ok(builds(ctx).length === 1, 'user-invoked setup builds the helper once');
    const installed = path.join(ctx.dir, 'bin', 'kh-helper');
    assert.ok(fs.existsSync(installed), 'helper installed under the application dataDir/bin');
    assert.strictEqual(fs.statSync(installed).mode & 0o777, 0o700);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'EXECUTED')), 'setup never executes the helper');
    assert.match(first.stderr, /configured Chrome cookie source for xiaomi-token-plan \(profile Profile 46\)/);
    assert.doesNotMatch(first.stderr, /credential form:/, 'no paste form for xiaomi');
    noVaultForXiaomi(ctx, false);
    // Round 4: setup performs the user-driven interactive grant exactly once
    // and prints the single-line "Always Allow" instruction before the dialog.
    assert.match(first.stderr, /Approve Chrome key access: click "Always Allow" \(not "Allow"\) in the macOS dialog\./);
    const grants = keyReads(ctx).filter((entry) => entry.key === 'interactive-grant');
    assert.strictEqual(grants.length, 1, 'setup runs the interactive grant exactly once');
    assert.strictEqual(grants[0].purpose, 'interactive-setup');

    const before = JSON.stringify(readConfig(ctx));
    const withKey = run(ctx, ['setup', XIOMI_ID, '--key', 'sk-should-not-store']);
    assert.strictEqual(withKey.status, 1);
    assert.match(withKey.stderr, /stores no key — Chrome console cookies are read at refresh time \(no paste form\)/);
    assert.strictEqual(JSON.stringify(readConfig(ctx)), before, 'rejected setup changes nothing');

    const headless = run(ctx, ['setup', XIOMI_ID, '--headless']);
    assert.strictEqual(headless.status, 1);
    assert.match(headless.stderr, /--headless does not apply/);

    const badProfile = run(ctx, ['setup', XIOMI_ID, '--profile', '../evil', '--chrome-source', ctx.chromeRoot]);
    assert.strictEqual(badProfile.status, 1);
    assert.match(badProfile.stderr, /invalid Chrome profile — use "Default" or "Profile <number>"/);
    assert.ok(!badProfile.stderr.includes(ctx.chromeRoot), 'no directory path in setup errors');

    const wrongRoute = run(ctx, ['setup', KIMI_ID, '--profile', 'Profile 46']);
    assert.strictEqual(wrongRoute.status, 1);
    assert.match(wrongRoute.stderr, /--profile and --chrome-source apply only to xiaomi-token-plan/);
    noVaultForXiaomi(ctx, false);
    console.log('  ✓ setup writes the opt-in route, builds (never runs) the helper, refuses keys/forms');
  } finally {
    cleanup(ctx);
  }

  // ---- config ---------------------------------------------------------------
  ctx = scratch('config');
  try {
    const out = run(ctx, ['config']);
    assert.strictEqual(out.status, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    const x = parsed.routes.find((r) => r.id === XIOMI_ID);
    assert.ok(x, 'configured source stays visible');
    assert.strictEqual(x.credentialSource, 'chrome-cookies');
    assert.strictEqual(x.cookieSourceConfigured, true);
    assert.strictEqual(x.chromeProfile, 'Profile 46');
    assert.strictEqual(x.chromeSource, ctx.chromeRoot);
    assert.ok(!('hasCredential' in x), 'xiaomi never reports a vault credential');
    const k = parsed.routes.find((r) => r.id === KIMI_ID);
    assert.strictEqual(k.hasCredential, false, 'non-xiaomi keeps vault behavior');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ config shows source/profile from metadata without any Xiaomi vault read');
  } finally {
    cleanup(ctx);
  }

  // ---- report: live success over a stale cache --------------------------------
  ctx = scratch('report-ok', { status: seededCache() });
  try {
    clearFetches(ctx);
    const json = run(ctx, ['report', '--json']);
    assert.strictEqual(json.status, 0, json.stderr);
    const doc = JSON.parse(json.stdout);
    const entry = doc.routes[XIOMI_ID];
    assert.strictEqual(entry.status.state, 'unknown');
    assert.strictEqual(entry.status.windows[0].remaining, FRESH_COUNTS, 'fresh live counts, not the cached ones');
    assert.notStrictEqual(entry.observedAt, '2000-01-01T00:00:00.000Z');
    assert.ok(Date.parse(entry.freshUntil) > Date.now() - 1000, 'just-observed entry renders fresh');
    assert.deepStrictEqual(doc.routes[KIMI_ID], seededCache().routes[KIMI_ID], 'other providers untouched');
    assert.strictEqual(fetches(ctx).length, 2, 'one usage + one detail per report');

    clearFetches(ctx);
    const text = run(ctx, ['report']);
    assert.strictEqual(text.status, 0, text.stderr);
    assert.match(text.stdout, /xiaomi-token-plan: unknown · tokens 75%/);
    assert.doesNotMatch(text.stdout, /xiaomi-token-plan:[^\n]*\(stale\)/, 'live Xiaomi observation is not marked stale');
    assert.ok(!text.stdout.includes('rotate via'), 'xiaomi rows never get the rotate hint');
    assert.strictEqual(fetches(ctx).length, 2, 'text report performs its own single pair');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ report (text + json) is live: fresh counts replace the cached success');
  } finally {
    cleanup(ctx);
  }

  // ---- report: live auth failure must not surface old counts ------------------
  ctx = scratch('report-auth', { status: seededCache() });
  try {
    const json = run(ctx, ['report', '--json'], { env: { VL_XIAOMI_FETCH_MODE: 'auth' } });
    assert.strictEqual(json.status, 0, json.stderr);
    assert.ok(!json.stdout.includes(String(OLD_COUNTS)), 'old cached counts must not appear in JSON');
    assert.ok(!json.stdout.includes(String(LIMIT)), 'old limit must not appear in JSON');
    const entry = JSON.parse(json.stdout).routes[XIOMI_ID];
    assert.deepStrictEqual(entry.status.windows, []);
    assert.strictEqual(entry.status.detail.reauth.reason, 'auth-expired');
    assert.strictEqual(entry.status.detail.reauth.url, 'https://platform.xiaomimimo.com/');
    assert.strictEqual(entry.status.detail.reauth.profile, 'Profile 46');
    assert.strictEqual(fetches(ctx).length, 1, 'auth on usage stops before detail');

    clearFetches(ctx);
    const text = run(ctx, ['report'], { env: { VL_XIAOMI_FETCH_MODE: 'auth' } });
    assert.strictEqual(text.status, 0, text.stderr);
    assert.ok(!text.stdout.includes(String(OLD_COUNTS)), 'old counts must not appear in text');
    assert.match(text.stdout, /session unavailable — open https:\/\/platform\.xiaomimimo\.com\/ in Chrome \(profile Profile 46\) and log in if needed; next refresh checks for new cookies/);
    assert.doesNotMatch(text.stdout, /rotate via \/view-limits:update xiaomi-token-plan/);
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ live auth failure shows the full dashboard link with zero cached counts');
  } finally {
    cleanup(ctx);
  }

  // ---- report: live network failure ------------------------------------------
  ctx = scratch('report-network', { status: seededCache() });
  try {
    const json = run(ctx, ['report', '--json'], { env: { VL_XIAOMI_FETCH_MODE: 'network' } });
    assert.strictEqual(json.status, 0, json.stderr);
    const text = json.stdout;
    assert.ok(!text.includes(String(OLD_COUNTS)), 'no old counts after a network failure');
    assert.ok(!text.includes('raw-cli-network-secret'), 'transport error text never surfaces');
    const entry = JSON.parse(text).routes[XIOMI_ID];
    assert.deepStrictEqual(entry.status.windows, []);
    assert.strictEqual(entry.status.detail.error, 'console request failed');
    console.log('  ✓ live network failure → classified error, no counts, no raw transport text');
  } finally {
    cleanup(ctx);
  }

  // ---- refresh ----------------------------------------------------------------
  ctx = scratch('refresh', { status: seededCache() });
  try {
    clearFetches(ctx);
    const out = run(ctx, ['refresh']);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /xiaomi-token-plan: unknown · tokens 75%/);
    assert.ok(!out.stdout.includes(String(OLD_COUNTS)));
    assert.ok(!out.stdout.includes('(stale)'));
    assert.strictEqual(fetches(ctx).length, 2);
    const entry = readStatus(ctx).routes[XIOMI_ID];
    assert.strictEqual(entry.status.windows[0].remaining, FRESH_COUNTS);
    const ttl = Date.parse(entry.freshUntil) - Date.parse(entry.observedAt);
    assert.ok(ttl >= 0 && ttl <= 1000, `cache entry keeps ttlSeconds 0 (ttl=${ttl})`);
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ refresh writes live counts with ttlSeconds 0 and renders them fresh');
  } finally {
    cleanup(ctx);
  }

  // ---- refresh contention: pending, no cached Xiaomi counts --------------------
  ctx = scratch('busy', { status: orphanSeed() });
  let owner = null;
  try {
    clearFetches(ctx);
    const workers = path.join(ctx.dir, 'refresh-workers');
    owner = spawn(process.execPath, [CLI, 'refresh', '--quiet'], {
      env: envFor(ctx, { VL_XIAOMI_FETCH_MODE: 'hang' }), stdio: 'ignore',
    });
    await until(() => fs.existsSync(workers) && fs.readdirSync(workers).length > 0);
    const loser = run(ctx, ['refresh']);
    assert.strictEqual(loser.status, 0, loser.stderr);
    assert.match(loser.stdout, /refresh already in progress/);
    assert.match(loser.stdout, /refresh in progress — live Xiaomi usage not fetched \(no cached counts shown\)/);
    assert.ok(!loser.stdout.includes(String(OLD_COUNTS)), 'busy owner must not replay cached Xiaomi counts');
    assert.ok(!loser.stdout.includes(String(LIMIT)), 'busy owner must not replay the cached limit');
    // F1: the contended overlay also strips orphan/renamed Xiaomi rows.
    assert.ok(!loser.stdout.includes('orphan-xiaomi'), 'orphan Xiaomi row stripped under contention');
    assert.ok(!loser.stdout.includes('renamed-xiaomi'), 'tokens-provenance orphan stripped under contention');
    assert.ok(fetches(ctx).length <= 1, 'the loser performs no usage/detail pair of its own');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ contended refresh shows pending Xiaomi with zero cached counts (orphans stripped)');
  } finally {
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const exit = once(owner, 'exit');
      owner.kill('SIGKILL');
      await exit.catch(() => {});
    }
    cleanup(ctx);
  }

  // ---- session-start ------------------------------------------------------------
  ctx = scratch('session-start');
  try {
    const out = run(ctx, ['session-start']);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.ok(!out.stdout.includes('no credentials configured'), 'xiaomi counts as configured without vault');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ SessionStart eligibility treats the configured source as present (no vault)');
  } finally {
    cleanup(ctx);
  }

  // ---- update -------------------------------------------------------------------
  ctx = scratch('update');
  try {
    // Seed private metadata that update must clear.
    const xiaomiDir = path.join(ctx.dir, 'xiaomi');
    fs.mkdirSync(xiaomiDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(xiaomiDir, 'rejected.json'), JSON.stringify({ digest: 'a'.repeat(64) }), { mode: 0o600 });
    fs.writeFileSync(path.join(xiaomiDir, 'key-suppressed.json'), JSON.stringify({ code: 'denied', at: 'x' }), { mode: 0o600 });

    const out = run(ctx, ['update', XIOMI_ID, '--profile', 'Profile 7']);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(readConfig(ctx).xiaomi.chromeProfile, 'Profile 7');
    assert.ok(!fs.existsSync(path.join(xiaomiDir, 'rejected.json')), 'stale rejection cleared on revalidate');
    assert.ok(!fs.existsSync(path.join(xiaomiDir, 'key-suppressed.json')), 'key suppression cleared on revalidate');
    assert.match(out.stderr, /Chrome cookie source revalidated for xiaomi-token-plan \(profile Profile 7\)/);
    assert.doesNotMatch(out.stderr, /credential form:/);
    noVaultForXiaomi(ctx, true);
    // Round 4: update DELIBERATELY performs the same user-approved grant.
    assert.match(out.stderr, /Approve Chrome key access: click "Always Allow"/);
    assert.ok(keyReads(ctx).some((entry) => entry.key === 'interactive-grant' && entry.purpose === 'interactive-setup'),
      'update performs the interactive grant');

    const bare = run(ctx, ['update']);
    assert.strictEqual(bare.status, 0, bare.stderr);
    assert.match(bare.stderr, /revalidated/);
    assert.doesNotMatch(bare.stderr, /credential form:/);
    assert.doesNotMatch(bare.stderr, /updating credentials for/);
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ update revalidates source/profile, clears private metadata, never opens a form');
  } finally {
    cleanup(ctx);
  }

  ctx = scratch('update-unset', { xiaomi: false });
  try {
    const out = run(ctx, ['update', XIOMI_ID]);
    assert.strictEqual(out.status, 1);
    assert.match(out.stderr, /not configured — run \/view-limits:setup xiaomi-token-plan first/);
    noVaultForXiaomi(ctx, false);
  } finally {
    cleanup(ctx);
  }

  // Any xiaomi-PROVIDER route (even a hand-added id) must never reach the
  // vault or the paste form — only the supported route id is handled.
  ctx = scratch('custom-xiaomi-id', { xiaomi: false });
  try {
    const cfg = readConfig(ctx);
    cfg.routes.push({ id: 'xiaomi-other', provider: 'xiaomi', account: 'token-plan', match: { model: 'mimo2' }, ttlSeconds: 0, credentialSource: 'chrome-cookies' });
    fs.writeFileSync(path.join(ctx.dir, 'config.json'), JSON.stringify(cfg, null, 2));
    for (const [cmd, expected] of [
      ['setup', /only xiaomi-token-plan is supported as a Chrome-cookie source route/],
      ['update', /only xiaomi-token-plan is supported as a Chrome-cookie source route/],
    ]) {
      const out = run(ctx, [cmd, 'xiaomi-other']);
      assert.strictEqual(out.status, 1, out.stderr);
      assert.match(out.stderr, expected);
      assert.doesNotMatch(out.stderr, /credential form:/);
    }
    noVaultForXiaomi(ctx, false);
    console.log('  ✓ hand-added xiaomi-provider routes are refused before any vault or form access');
  } finally {
    cleanup(ctx);
  }

  // ---- check ---------------------------------------------------------------------
  ctx = scratch('check');
  try {
    const ok = run(ctx, ['check', XIOMI_ID]);
    assert.strictEqual(ok.status, 0, ok.stderr);
    const st = JSON.parse(ok.stdout);
    assert.strictEqual(st.state, 'unknown');
    assert.strictEqual(st.windows[0].remaining, FRESH_COUNTS);

    const auth = run(ctx, ['check', XIOMI_ID], { env: { VL_XIAOMI_FETCH_MODE: 'auth' } });
    assert.strictEqual(auth.status, 1);
    assert.strictEqual(auth.stdout, '');
    assert.match(auth.stderr, /^view-limits: check xiaomi-token-plan failed: session unavailable — open https:\/\/platform\.xiaomimimo\.com\/ in Chrome \(profile Profile 46\) and log in if needed; next refresh checks for new cookies\n$/);
    assert.doesNotMatch(auth.stderr, /\n.*\n|    at /, 'one line, no stack');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ check prints live JSON on success and a one-line classified failure otherwise');
  } finally {
    cleanup(ctx);
  }

  // ---- remove ----------------------------------------------------------------------
  ctx = scratch('remove', { status: seededCache() });
  try {
    const xiaomiDir = path.join(ctx.dir, 'xiaomi');
    fs.mkdirSync(xiaomiDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(xiaomiDir, 'rejected.json'), JSON.stringify({ digest: 'b'.repeat(64) }), { mode: 0o600 });

    const out = run(ctx, ['remove', XIOMI_ID]);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stderr, /disabled Chrome cookie source for "xiaomi-token-plan" and removed private metadata/);
    const cfg = readConfig(ctx);
    assert.deepStrictEqual(cfg.routes.map((r) => r.id), [KIMI_ID], 'route disabled (removed) but siblings kept');
    // F7: removing the FINAL Xiaomi route drops its saved source/profile and
    // provider metadata too, while unrelated settings stay untouched.
    assert.ok(!('xiaomi' in cfg), 'saved source/profile metadata removed with the final route');
    assert.ok(!('xiaomi' in cfg.providers), 'provider metadata removed with the final route');
    assert.ok(cfg.providers && cfg.providers.kimi, 'unrelated provider settings preserved');
    assert.deepStrictEqual(cfg.gate, { mode: 'off' }, 'unrelated gate settings preserved');
    assert.deepStrictEqual(cfg.vault, { backend: 'file', service: 'test-only' }, 'unrelated vault settings preserved');
    assert.strictEqual(fetches(ctx).length, 0, 'removal performs no Chrome read');
    assert.ok(!fs.existsSync(path.join(xiaomiDir, 'rejected.json')), 'private metadata removed');
    const status = readStatus(ctx);
    assert.ok(!(XIOMI_ID in status.routes), 'cached counts dropped so no orphan row renders them');
    assert.ok(KIMI_ID in status.routes, 'unrelated cache rows preserved');
    noVaultForXiaomi(ctx, false);

    const again = run(ctx, ['remove', XIOMI_ID]);
    assert.strictEqual(again.status, 0);
    assert.match(again.stderr, /no Chrome cookie source configured/);
    noVaultForXiaomi(ctx, false);
    console.log('  ✓ remove disables the source, drops private metadata and cached counts');
  } finally {
    cleanup(ctx);
  }

  // ---- snapshot: diagnostic cache stays, age explicit, reauth whitelisted --------
  ctx = scratch('snapshot', { status: seededCache() });
  try {
    const status = seededCache();
    status.routes[XIOMI_ID].status.detail = {
      reauth: { reason: 'auth-expired', url: 'https://platform.xiaomimimo.com/', profile: 'Profile 46' },
    };
    fs.writeFileSync(path.join(ctx.dir, 'status.json'), JSON.stringify(status));
    const out = run(ctx, ['snapshot', '--json']);
    assert.strictEqual(out.status, 0, out.stderr);
    const snap = JSON.parse(out.stdout);
    const row = snap.routes.find((r) => r.id === XIOMI_ID);
    assert.deepStrictEqual(row.resource.reauth, {
      reason: 'auth-expired', url: 'https://platform.xiaomimimo.com/', profile: 'Profile 46',
    });
    assert.strictEqual(row.resource.freshness, 'stale', 'diagnostic snapshot keeps age explicit');
    assert.strictEqual(row.resource.observedAt.value, '2000-01-01T00:00:00.000Z');
    noVaultForXiaomi(ctx, true);

    // Hostile reauth shapes are dropped by the whitelist.
    status.routes[XIOMI_ID].status.detail.reauth = { reason: 'auth-expired', url: 'https://evil.example/steal', profile: '../x' };
    fs.writeFileSync(path.join(ctx.dir, 'status.json'), JSON.stringify(status));
    const poisoned = run(ctx, ['snapshot', '--json']);
    const snap2 = JSON.parse(poisoned.stdout);
    const row2 = snap2.routes.find((r) => r.id === XIOMI_ID);
    assert.strictEqual(row2.resource.reauth, null, 'non-dashboard reauth URLs are dropped');
    assert.ok(!poisoned.stdout.includes('evil.example'), 'poisoned URL never reaches the snapshot');
    console.log('  ✓ snapshot preserves timestamped diagnostics and strictly whitelists reauth');
  } finally {
    cleanup(ctx);
  }

  // ---- configured-but-empty visibility ------------------------------------------
  ctx = scratch('empty-visible', { status: seededCache(), cookies: false });
  try {
    // No cookie DB at all — the configured source must stay visible.
    fs.rmSync(ctx.chromeRoot, { recursive: true, force: true });
    const cfg = readConfig(ctx);
    assert.strictEqual(cfg.xiaomi.chromeSource, ctx.chromeRoot, 'config still names the source');
    const out = run(ctx, ['report'], { env: { VL_XIAOMI_FETCH_MODE: 'ok' } });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /xiaomi-token-plan: unknown/);
    assert.match(out.stdout, /chrome cookie store unreadable/);
    assert.ok(!out.stdout.includes(String(OLD_COUNTS)), 'no stale counts when the store is gone');
    const json = run(ctx, ['report', '--json']);
    const entry = JSON.parse(json.stdout).routes[XIOMI_ID];
    assert.ok(entry, 'configured source remains present in JSON');
    assert.deepStrictEqual(entry.status.windows, []);
    console.log('  ✓ configured source stays visible with an actionable error when cookies are absent');
  } finally {
    cleanup(ctx);
  }

  // ---- helper never executed by any CLI path --------------------------------------
  ctx = scratch('no-helper-exec');
  try {
    const out = run(ctx, ['refresh']);
    assert.strictEqual(out.status, 0, out.stderr);
    const spawns = lines(path.join(ctx.dir, 'spawn.log'));
    for (const entry of spawns) {
      const cmd = String(entry.cmd || entry.blocked || '');
      assert.ok(!cmd.includes('kh-helper'), 'no CLI path may execute the helper binary');
      assert.ok(!cmd.includes('security'), 'no CLI path may execute /usr/bin/security');
      assert.ok(!entry.blocked, `unexpected exec-family call: ${JSON.stringify(entry)}`);
    }
    console.log('  ✓ no helper execution and no security binary on any CLI path');
  } finally {
    cleanup(ctx);
  }

  // ---- gate: xiaomi resolves fail-open with no vault and no fetch --------------
  ctx = scratch('gate', { status: seededCache() });
  try {
    const cfg = readConfig(ctx);
    cfg.gate = { mode: 'deny', injectContext: true };
    fs.writeFileSync(path.join(ctx.dir, 'config.json'), JSON.stringify(cfg, null, 2));
    const input = JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'mimo-mini' } });
    const gate = run(ctx, ['gate'], { input });
    assert.strictEqual(gate.status, 0, gate.stderr);
    if (gate.stdout.trim()) {
      const out = JSON.parse(gate.stdout);
      assert.ok(!out.hookSpecificOutput || !out.hookSpecificOutput.permissionDecision,
        `xiaomi unknown/stale must fail open, got: ${gate.stdout}`);
    }
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ gate resolves the xiaomi route fail-open without any Xiaomi vault read');
  } finally {
    cleanup(ctx);
  }

  // ---- Node without node:sqlite: modules load, failure is actionable -----------
  ctx = scratch('no-sqlite');
  try {
    const blockSqlite = path.resolve(__dirname, 'fixtures/block-node-sqlite.cjs');
    // Every xiaomi module must load when node:sqlite cannot be required
    // (Node 18 bearer installs take no xiaomi path but must not crash).
    const load = spawnSync(process.execPath, [
      '-e',
      `require(${JSON.stringify(path.resolve(__dirname, '../lib/xiaomi-session.js'))});`
      + `require(${JSON.stringify(path.resolve(__dirname, '../lib/cookies/chrome.js'))});`
      + `require(${JSON.stringify(path.resolve(__dirname, '../lib/cookies/http-get.js'))});`
      + `require(${JSON.stringify(path.resolve(__dirname, '../lib/cookies/fingerprint.js'))});`
      + `require(${JSON.stringify(path.resolve(__dirname, '../lib/adapters/xiaomi.js'))});`
      + `require(${JSON.stringify(path.resolve(__dirname, '../lib/helper-install.js'))});`
      + "console.log('lazy-ok');",
    ], { env: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${blockSqlite}` }, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(load.status, 0, load.stderr);
    assert.match(load.stdout, /lazy-ok/);

    // A live report under the same condition classifies actionably.
    const out = run(ctx, ['report'], { env: { NODE_OPTIONS: `--require=${PRELOAD} --require=${blockSqlite}` } });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.match(out.stdout, /Node with node:sqlite \(22\.5\+\) is required for the Chrome cookie fallback/);
    assert.ok(!out.stdout.includes(String(OLD_COUNTS)), 'no cached counts without a readable store');
    console.log('  ✓ modules load without node:sqlite and the capability failure is actionable');
  } finally {
    cleanup(ctx);
  }

  // ---- F1: orphan/renamed Xiaomi rows never satisfy a normal report ------------
  ctx = scratch('orphan', { status: orphanSeed() });
  try {
    const json = run(ctx, ['report', '--json']);
    assert.strictEqual(json.status, 0, json.stderr);
    assert.ok(!json.stdout.includes('orphan-xiaomi'), 'source-stamped orphan stripped from JSON');
    assert.ok(!json.stdout.includes('renamed-xiaomi'), 'tokens-provenance orphan stripped from JSON');
    assert.ok(!json.stdout.includes(String(OLD_COUNTS)), 'no old Xiaomi counts anywhere in JSON');
    const doc = JSON.parse(json.stdout);
    assert.strictEqual(doc.routes[XIOMI_ID].status.windows[0].remaining, FRESH_COUNTS, 'live counts replace the canonical row');
    assert.deepStrictEqual(doc.routes[KIMI_ID], seededCache().routes[KIMI_ID], 'non-Xiaomi rows untouched');

    const text = run(ctx, ['report']);
    assert.strictEqual(text.status, 0, text.stderr);
    assert.ok(!text.stdout.includes('orphan-xiaomi'), 'source-stamped orphan stripped from text');
    assert.ok(!text.stdout.includes('renamed-xiaomi'), 'tokens-provenance orphan stripped from text');
    assert.match(text.stdout, /xiaomi-token-plan: unknown · tokens 75%/);
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ normal text/JSON reports strip orphan and renamed Xiaomi cache rows');
  } finally {
    cleanup(ctx);
  }

  // Canonical Xiaomi id in cache while NO Xiaomi route is configured: still
  // recognizable (canonical id + source stamp) and stripped.
  ctx = scratch('canonical-orphan', { xiaomi: false, status: {
    updatedAt: '2000-01-01T00:00:00.000Z',
    routes: {
      [XIOMI_ID]: { routeId: XIOMI_ID, source: 'xiaomi', observedAt: '2000-01-01T00:00:00.000Z', freshUntil: '2000-01-01T00:00:00.000Z', status: oldXiaomiStatus },
    },
  } });
  try {
    setVaultCredential(ctx, KIMI_ID, 'fake-kimi-key');
    const json = run(ctx, ['report', '--json']);
    assert.strictEqual(json.status, 0, json.stderr);
    assert.ok(!(XIOMI_ID in JSON.parse(json.stdout).routes), 'canonical id stripped when route not configured');
    assert.ok(!json.stdout.includes(String(OLD_COUNTS)), 'no old canonical counts without a configured route');
    const text = run(ctx, ['report']);
    assert.strictEqual(text.status, 0, text.stderr);
    assert.ok(!text.stdout.includes(XIOMI_ID), 'canonical Xiaomi row absent from text');
    // Diagnostic snapshot still keeps the age-labelled historical evidence.
    const snap = run(ctx, ['snapshot', '--json']);
    const row = JSON.parse(snap.stdout).routes.find((r) => r.id === XIOMI_ID);
    assert.ok(row && row.resource.freshness === 'stale', 'snapshot retains the historical row, age explicit');
    assert.strictEqual(row.resource.windows[0].remaining, OLD_COUNTS, 'snapshot keeps the old counts as diagnostic evidence');
  } finally {
    cleanup(ctx);
  }

  // ---- F1: first-run and corrupt cache — success AND failure both render -------
  ctx = scratch('first-run'); // no status.json at all
  try {
    const ok = run(ctx, ['report']);
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /xiaomi-token-plan: unknown · tokens 75%/, 'first-run success renders live counts');
    const okJson = run(ctx, ['report', '--json']);
    assert.strictEqual(JSON.parse(okJson.stdout).routes[XIOMI_ID].status.windows[0].remaining, FRESH_COUNTS);
    const failed = run(ctx, ['report'], { env: { VL_XIAOMI_FETCH_MODE: 'auth' } });
    assert.strictEqual(failed.status, 0, failed.stderr);
    assert.match(failed.stdout, /session unavailable — open https:\/\/platform\.xiaomimimo\.com\//);
    assert.ok(!failed.stdout.includes(String(LIMIT)), 'first-run failure renders no counts');
  } finally {
    cleanup(ctx);
  }

  ctx = scratch('corrupt');
  try {
    fs.writeFileSync(path.join(ctx.dir, 'status.json'), 'garbage{{{not-json');
    const ok = run(ctx, ['report']);
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /xiaomi-token-plan: unknown · tokens 75%/, 'corrupt-cache success renders live counts');
    assert.match(ok.stdout, /status-cache-corrupt/, 'corruption stays visible as a diagnostic');
    const okJson = JSON.parse(run(ctx, ['report', '--json']).stdout);
    assert.strictEqual(okJson.routes[XIOMI_ID].status.windows[0].remaining, FRESH_COUNTS);
    const failed = run(ctx, ['report', '--json'], { env: { VL_XIAOMI_FETCH_MODE: 'network' } });
    assert.strictEqual(failed.status, 0, failed.stderr);
    const failedDoc = JSON.parse(failed.stdout);
    assert.strictEqual(failedDoc.routes[XIOMI_ID].status.detail.error, 'console request failed');
    assert.deepStrictEqual(failedDoc.routes[XIOMI_ID].status.windows, [], 'corrupt-cache failure renders no counts');
  } finally {
    cleanup(ctx);
  }

  // ---- F4: one key read + one usage/detail pair for the whole operation --------
  ctx = scratch('alias-coalesce');
  try {
    const cfg = readConfig(ctx);
    cfg.routes.push({
      id: 'xiaomi-custom', provider: 'xiaomi', account: 'token-plan',
      match: { model: 'mimo2' }, ttlSeconds: 0, credentialSource: 'chrome-cookies',
    });
    fs.writeFileSync(path.join(ctx.dir, 'config.json'), JSON.stringify(cfg, null, 2));

    clearFetches(ctx);
    clearKeyReads(ctx);
    const json = run(ctx, ['report', '--json']);
    assert.strictEqual(json.status, 0, json.stderr);
    assert.strictEqual(fetches(ctx).length, 2, 'canonical + alias share ONE usage/detail pair');
    assert.strictEqual(keyReads(ctx).length, 1, 'ONE Chrome key acquisition for the whole report');
    const doc = JSON.parse(json.stdout);
    const canonical = doc.routes[XIOMI_ID];
    const alias = doc.routes['xiaomi-custom'];
    assert.ok(canonical && alias, 'both aliases present');
    assert.deepStrictEqual(alias.status, canonical.status, 'single status projected to both aliases');
    assert.strictEqual(alias.observedAt, canonical.observedAt, 'stable point-in-time projection');
    assert.strictEqual(canonical.status.windows[0].remaining, FRESH_COUNTS);

    clearFetches(ctx);
    clearKeyReads(ctx);
    const refresh = run(ctx, ['refresh']);
    assert.strictEqual(refresh.status, 0, refresh.stderr);
    assert.strictEqual(fetches(ctx).length, 2, 'refresh also shares ONE pair across aliases');
    assert.strictEqual(keyReads(ctx).length, 1, 'refresh: ONE key acquisition');
    assert.match(refresh.stdout, /xiaomi-token-plan: unknown · tokens 75%/);
    assert.match(refresh.stdout, /xiaomi-custom: unknown · tokens 75%/);
    const cached = readStatus(ctx);
    assert.strictEqual(cached.routes[XIOMI_ID].status.windows[0].remaining, FRESH_COUNTS);
    assert.deepStrictEqual(cached.routes['xiaomi-custom'].status, cached.routes[XIOMI_ID].status);

    clearFetches(ctx);
    clearKeyReads(ctx);
    const auth = run(ctx, ['report', '--json'], { env: { VL_XIAOMI_FETCH_MODE: 'auth' } });
    assert.strictEqual(auth.status, 0, auth.stderr);
    assert.strictEqual(fetches(ctx).length, 1, 'auth on usage stops before detail even with aliases');
    assert.strictEqual(keyReads(ctx).length, 1);
    const authDoc = JSON.parse(auth.stdout);
    for (const id of [XIOMI_ID, 'xiaomi-custom']) {
      assert.deepStrictEqual(authDoc.routes[id].status.windows, []);
      assert.strictEqual(authDoc.routes[id].status.detail.reauth.reason, 'auth-expired');
    }
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ canonical+alias share one key read and one usage/detail pair per operation');
  } finally {
    cleanup(ctx);
  }

  // ---- F3: setup publishes config/state ONLY after a successful helper build ----
  const FAILED_BUILD_PRELOAD = path.resolve(__dirname, 'fixtures/xiaomi-failed-build-preload.cjs');
  for (const [label, failCode, expectErr] of [
    ['compile', 'helper-build-failed', /install the Xcode command line tools/],
    ['install', 'helper-install-failed', /helper build failed — rerun \/view-limits:setup/],
  ]) {
    ctx = scratch(`setup-${label}-fail`);
    try {
      // Prior functioning selection + a live suppression marker.
      const xiaomiDir = path.join(ctx.dir, 'xiaomi');
      fs.mkdirSync(xiaomiDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(xiaomiDir, 'key-suppressed.json'),
        JSON.stringify({ code: 'denied', at: 'x' }), { mode: 0o600 });

      const out = run(ctx, ['setup', XIOMI_ID, '--profile', 'Profile 9', '--chrome-source', ctx.chromeRoot], {
        env: {
          NODE_OPTIONS: `--require=${FAILED_BUILD_PRELOAD}`,
          VL_XIAOMI_BUILD_FAIL_CODE: failCode,
        },
      });
      assert.strictEqual(out.status, 1, out.stderr);
      assert.match(out.stderr, expectErr);
      const cfg = readConfig(ctx);
      assert.strictEqual(cfg.xiaomi.chromeProfile, 'Profile 46', `${label} failure preserves the prior profile`);
      assert.strictEqual(cfg.xiaomi.chromeSource, ctx.chromeRoot, `${label} failure preserves the prior source`);
      assert.ok(cfg.routes.some((r) => r.id === XIOMI_ID), 'prior route selection preserved');
      assert.ok(fs.existsSync(path.join(xiaomiDir, 'key-suppressed.json')),
        `${label} failure preserves the prior suppression marker`);
      assert.strictEqual(builds(ctx).length, 0, 'the failed buildHelper was the injected one (no real build log)');
      noVaultForXiaomi(ctx, true);
    } finally {
      cleanup(ctx);
    }
  }

  ctx = scratch('first-setup-fail', { xiaomi: false });
  try {
    const out = run(ctx, ['setup', XIOMI_ID, '--chrome-source', ctx.chromeRoot], {
      env: {
        NODE_OPTIONS: `--require=${FAILED_BUILD_PRELOAD}`,
        VL_XIAOMI_BUILD_FAIL_CODE: 'helper-build-failed',
      },
    });
    assert.strictEqual(out.status, 1, out.stderr);
    const cfg = readConfig(ctx);
    assert.ok(!cfg.routes.some((r) => r.id === XIOMI_ID), 'failed first setup must NOT enable the route');
    assert.ok(!('xiaomi' in cfg), 'failed first setup writes no source/profile');
    assert.ok(!('xiaomi' in (cfg.providers || {})), 'failed first setup writes no provider metadata');
    assert.strictEqual(keyReads(ctx).filter((e) => e.key === 'interactive-grant').length, 0,
      'a failed build must not reach the interactive grant');
    noVaultForXiaomi(ctx, false);
    console.log('  ✓ failed compile/install setup preserves prior config+suppression; first setup stays disabled');
  } finally {
    cleanup(ctx);
  }

  // ---- N2: unsafe final metadata refuses BEFORE config is published -----------
  // The helper build SUCCEEDS (stubbed — no compile), then the owned-state
  // reset refuses. A failed command must not change the saved selection.
  const OK_BUILD_PRELOAD = path.resolve(__dirname, 'fixtures/xiaomi-ok-build-preload.cjs');
  const UNSAFE_MSG = /Xiaomi private state is unsafe — delete the xiaomi folder under the view-limits data directory/;
  const REMOVE_MSG = /Xiaomi private state could not be cleared — the xiaomi folder under the view-limits data directory is not writable/;

  ctx = scratch('setup-unsafe-state');
  try {
    const xiaomiDir = path.join(ctx.dir, 'xiaomi');
    fs.mkdirSync(xiaomiDir, { recursive: true, mode: 0o700 });
    const sentinel = path.join(ctx.dir, 'sentinel');
    fs.writeFileSync(sentinel, 'UNCHANGED', { mode: 0o644 });
    fs.symlinkSync(sentinel, path.join(xiaomiDir, 'key-suppressed.json'));

    const out = run(ctx, ['setup', XIOMI_ID, '--profile', 'Profile 9', '--chrome-source', ctx.chromeRoot], {
      env: { NODE_OPTIONS: `--require=${OK_BUILD_PRELOAD}` },
    });
    assert.strictEqual(out.status, 1, out.stderr);
    assert.match(out.stderr, UNSAFE_MSG);
    assert.doesNotMatch(out.stderr, /configured Chrome cookie source/, 'no success message on refusal');
    const cfg = readConfig(ctx);
    assert.strictEqual(cfg.xiaomi.chromeProfile, 'Profile 46', 'N2: refused setup must NOT publish the new profile');
    assert.strictEqual(cfg.xiaomi.chromeSource, ctx.chromeRoot, 'N2: prior source preserved');
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED', 'planted symlink target untouched');
    assert.ok(fs.lstatSync(path.join(xiaomiDir, 'key-suppressed.json')).isSymbolicLink(),
      'refusal leaves the planted link alone');
    assert.strictEqual(builds(ctx).length, 0, 'stubbed success build — no real compile in this regression');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ N2: setup with unsafe final metadata refuses BEFORE publishing config');
  } finally {
    cleanup(ctx);
  }

  ctx = scratch('update-unsafe-state');
  try {
    const xiaomiDir = path.join(ctx.dir, 'xiaomi');
    fs.mkdirSync(xiaomiDir, { recursive: true, mode: 0o700 });
    const sentinel = path.join(ctx.dir, 'sentinel');
    fs.writeFileSync(sentinel, 'UNCHANGED', { mode: 0o644 });
    fs.symlinkSync(sentinel, path.join(xiaomiDir, 'key-suppressed.json'));

    const out = run(ctx, ['update', XIOMI_ID, '--profile', 'Profile 9']);
    assert.strictEqual(out.status, 1, out.stderr);
    assert.match(out.stderr, UNSAFE_MSG);
    assert.doesNotMatch(out.stderr, /revalidated/, 'no success message on refusal');
    assert.strictEqual(readConfig(ctx).xiaomi.chromeProfile, 'Profile 46',
      'N2: refused update must NOT switch the selection (46 -> 9)');
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ N2: update with unsafe final metadata refuses BEFORE publishing config');
  } finally {
    cleanup(ctx);
  }

  // ---- N1: read-only private metadata — failed unlink refuses the CLI ---------
  // Exactly the round-2 counterexample: a suppression file inside an owned
  // 0500 dir validates as private but unlink fails EACCES. update/remove/
  // setup must exit non-zero with the classified message, keep config, keep
  // the suppression file, and print no success line.
  ctx = scratch('readonly-state');
  const roDir = path.join(ctx.dir, 'xiaomi');
  try {
    fs.mkdirSync(roDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(roDir, 'key-suppressed.json'),
      JSON.stringify({ code: 'denied', at: 'x' }), { mode: 0o600 });
    fs.chmodSync(roDir, 0o500); // owned + private (validates), readable, NOT writable

    const upd = run(ctx, ['update', XIOMI_ID, '--profile', 'Profile 9']);
    assert.strictEqual(upd.status, 1, upd.stderr);
    assert.match(upd.stderr, REMOVE_MSG);
    assert.doesNotMatch(upd.stderr, /revalidated/, 'no success message when reset failed');
    assert.strictEqual(readConfig(ctx).xiaomi.chromeProfile, 'Profile 46',
      'N1: failed reset must not publish the selection');
    assert.ok(fs.existsSync(path.join(roDir, 'key-suppressed.json')), 'suppression stays (undeletable)');

    const rem = run(ctx, ['remove', XIOMI_ID]);
    assert.strictEqual(rem.status, 1, rem.stderr);
    assert.match(rem.stderr, REMOVE_MSG);
    assert.doesNotMatch(rem.stderr, /removed private metadata/, 'no false cleanup claim');
    const afterRemove = readConfig(ctx);
    assert.ok(afterRemove.routes.some((r) => r.id === XIOMI_ID), 'N1: route preserved on failed reset');
    assert.ok(afterRemove.xiaomi && afterRemove.providers.xiaomi, 'N1: source/provider metadata preserved');
    assert.ok(fs.existsSync(path.join(roDir, 'key-suppressed.json')), 'suppression file never silently swallowed');

    const setupOut = run(ctx, ['setup', XIOMI_ID, '--profile', 'Profile 9', '--chrome-source', ctx.chromeRoot], {
      env: { NODE_OPTIONS: `--require=${OK_BUILD_PRELOAD}` },
    });
    assert.strictEqual(setupOut.status, 1, setupOut.stderr);
    assert.match(setupOut.stderr, REMOVE_MSG);
    assert.doesNotMatch(setupOut.stderr, /configured Chrome cookie source/, 'no success message on refusal');
    assert.strictEqual(readConfig(ctx).xiaomi.chromeProfile, 'Profile 46',
      'N1: setup refusal preserves the prior selection');
    assert.ok(fs.existsSync(path.join(roDir, 'key-suppressed.json')));
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ N1: read-only private metadata makes update/remove/setup refuse, config untouched');
  } finally {
    try { fs.chmodSync(roDir, 0o700); } catch { /* already gone */ }
    cleanup(ctx);
  }

  // ---- R4: the interactive grant is user-driven; denial refuses the command ---
  ctx = scratch('setup-grant-denied');
  try {
    const out = run(ctx, ['setup', XIOMI_ID, '--profile', 'Profile 9', '--chrome-source', ctx.chromeRoot], {
      env: { VL_XIAOMI_GRANT_MODE: 'denied' },
    });
    assert.strictEqual(out.status, 1, out.stderr);
    assert.match(out.stderr, /Approve Chrome key access: click "Always Allow" \(not "Allow"\) in the macOS dialog\./);
    assert.match(out.stderr, /Chrome key access was not granted — rerun \/view-limits:setup xiaomi-token-plan, then click "Always Allow" \(not "Allow"\)/);
    assert.doesNotMatch(out.stderr, /configured Chrome cookie source/, 'no success message on denial');
    const cfg = readConfig(ctx);
    assert.strictEqual(cfg.xiaomi.chromeProfile, 'Profile 46', 'denied grant must NOT publish the new selection');
    assert.ok(cfg.routes.some((r) => r.id === XIOMI_ID), 'prior route selection preserved');
    assert.ok(fs.existsSync(path.join(ctx.dir, 'bin', 'kh-helper')), 'the helper was built before the grant ran');
    assert.ok(keyReads(ctx).some((entry) => entry.key === 'interactive-grant'), 'the grant was attempted');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ R4: setup grant denial exits nonzero with the prior selection preserved');
  } finally {
    cleanup(ctx);
  }

  ctx = scratch('update-grant-denied');
  try {
    // Round 5 (P2-1): seed BOTH private markers — a denied update must leave
    // them intact (nothing mutating may run before the grant succeeds).
    const xiaomiDir = path.join(ctx.dir, 'xiaomi');
    fs.mkdirSync(xiaomiDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(xiaomiDir, 'rejected.json'),
      JSON.stringify({ digest: 'e'.repeat(64) }), { mode: 0o600 });
    fs.writeFileSync(path.join(xiaomiDir, 'key-suppressed.json'),
      JSON.stringify({ code: 'denied', at: 'x' }), { mode: 0o600 });

    const out = run(ctx, ['update', XIOMI_ID, '--profile', 'Profile 9'], { env: { VL_XIAOMI_GRANT_MODE: 'denied' } });
    assert.strictEqual(out.status, 1, out.stderr);
    assert.match(out.stderr, /Chrome key access was not granted — rerun \/view-limits:setup xiaomi-token-plan/);
    assert.doesNotMatch(out.stderr, /revalidated/, 'no success message on denial');
    assert.strictEqual(readConfig(ctx).xiaomi.chromeProfile, 'Profile 46', 'denied grant keeps the prior config');
    assert.ok(fs.existsSync(path.join(xiaomiDir, 'rejected.json')),
      'P2-1: rejection digest intact after a denied update');
    assert.ok(fs.existsSync(path.join(xiaomiDir, 'key-suppressed.json')),
      'P2-1: suppression marker intact after a denied update');
    noVaultForXiaomi(ctx, true);
    console.log('  ✓ R4: update grant denial exits nonzero with the prior config intact');
  } finally {
    cleanup(ctx);
  }

  // ---- R5 P2-2: bare update AWAITs the grant before touching siblings ---------
  ctx = scratch('bare-update-grant-denied');
  try {
    setVaultCredential(ctx, KIMI_ID, 'original-kimi-bearer-key');
    assert.strictEqual(getVaultCredential(ctx, KIMI_ID), 'original-kimi-bearer-key');
    // Delayed denial: without the await, the kimi rotation (promptHeadless
    // with piped stdin) runs WHILE the grant is pending and lands first.
    const out = run(ctx, ['update', '--headless'], {
      env: { VL_XIAOMI_GRANT_MODE: 'denied-delayed' },
      input: 'rotated-kimi-bearer-key\n',
    });
    assert.strictEqual(out.status, 1, out.stderr);
    assert.match(out.stderr, /Chrome key access was not granted/);
    assert.doesNotMatch(out.stderr, /updating credentials for/, 'rotation must not begin before the grant resolves');
    assert.strictEqual(getVaultCredential(ctx, KIMI_ID), 'original-kimi-bearer-key',
      'P2-2: a denied xiaomi grant aborts the bare update before any sibling credential is touched');
    console.log('  ✓ P2-2: bare update awaits the grant — denial aborts before sibling rotation');
  } finally {
    cleanup(ctx);
  }

  // ---- F7: shared metadata kept while an alias still needs it -------------------
  ctx = scratch('remove-alias');
  try {
    const cfg = readConfig(ctx);
    cfg.routes.push({
      id: 'xiaomi-custom', provider: 'xiaomi', account: 'token-plan',
      match: { model: 'mimo2' }, ttlSeconds: 0, credentialSource: 'chrome-cookies',
    });
    fs.writeFileSync(path.join(ctx.dir, 'config.json'), JSON.stringify(cfg, null, 2));
    const xiaomiDir = path.join(ctx.dir, 'xiaomi');
    fs.mkdirSync(xiaomiDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(xiaomiDir, 'rejected.json'), JSON.stringify({ digest: 'c'.repeat(64) }), { mode: 0o600 });

    const first = run(ctx, ['remove', XIOMI_ID]);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.match(first.stderr, /shared Chrome cookie source kept for other Xiaomi routes/);
    const afterFirst = readConfig(ctx);
    assert.deepStrictEqual(afterFirst.routes.map((r) => r.id).sort(), [KIMI_ID, 'xiaomi-custom']);
    assert.ok(afterFirst.xiaomi && afterFirst.xiaomi.chromeProfile === 'Profile 46', 'shared source kept for the alias');
    assert.ok(afterFirst.providers.xiaomi, 'shared provider metadata kept for the alias');
    assert.ok(fs.existsSync(path.join(xiaomiDir, 'rejected.json')), 'shared private state kept while an alias exists');
    assert.strictEqual(fetches(ctx).length, 0, 'no Chrome read during removal');
    noVaultForXiaomi(ctx, false);

    const second = run(ctx, ['remove', 'xiaomi-custom']);
    assert.strictEqual(second.status, 0, second.stderr);
    assert.match(second.stderr, /removed private metadata/);
    const afterSecond = readConfig(ctx);
    assert.deepStrictEqual(afterSecond.routes.map((r) => r.id), [KIMI_ID]);
    assert.ok(!('xiaomi' in afterSecond), 'final alias removal drops source/profile metadata');
    assert.ok(!('xiaomi' in afterSecond.providers), 'final alias removal drops provider metadata');
    assert.ok(!fs.existsSync(path.join(xiaomiDir, 'rejected.json')), 'final removal drops private state');
    assert.ok(afterSecond.providers.kimi && afterSecond.gate, 'unrelated settings preserved');
    noVaultForXiaomi(ctx, false);
    console.log('  ✓ alias removal keeps shared metadata; final removal drops it (no vault/Chrome reads)');
  } finally {
    cleanup(ctx);
  }

  if (failures) {
    console.error(`\n${failures} xiaomi CLI test(s) failed`);
    process.exit(1);
  }
  console.log('\nall xiaomi CLI tests passed');
})();
