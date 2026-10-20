'use strict';
// The Issue #58 lifecycle through the REAL CLI: `vl.js provider add|update|
// remove|list` and `vl.js remove`, the real service, the real resolver and the
// real file-backed vault, with a recording fake provider
// (test/fixtures/lifecycle-cli-preload.cjs). Proves against the four ACs:
//
//   AC1  setup/update/remove work for a custom endpoint AND a built-in;
//        collision, probe failure and partial-persistence recovery are tested
//   AC2  a non-monitorable outcome requires an explicit retention choice and
//        returns a stable machine-readable status + exit code, with no prompt
//   AC3  removal clears owned state, performs NO native logout, and mutations
//        expose usable revision checks
//   AC4  the probe is read-only: no inference request on any lifecycle path
//
// The vault here is the real AES-256-GCM file backend, so "the credential was
// stored" and "the credential was rolled back" are read off disk, not a stub.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/lifecycle-cli-preload.cjs');
const KEY_A = 'sk-TEST-lifecycle-aaaa1111';
const KEY_B = 'sk-TEST-lifecycle-bbbb2222';
const MASTER = 'vl-58-test-master-key';

// Headers of a healthy OpenAI-documented source: plenty of requests left.
const HEALTHY_HEADERS = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-remaining-requests': '800',
  'x-ratelimit-reset-requests': '45s',
};

const BUILT_IN = { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 };
const OTHER_BUILT_IN = { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 180 };

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${(e && e.message) || e}`); }
}

// A fresh data dir per scenario: config.json seeded with explicit routes (which
// replace the shipped defaults), the file vault backend, and nothing else.
function freshDir(routes = [BUILT_IN, OTHER_BUILT_IN]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-lifecycle-cli-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes, vault: { backend: 'file' }, gate: { mode: 'off' },
  }, null, 1));
  return dir;
}

function run(dir, args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    CLAUDE_PLUGIN_DATA: dir,
    VIEW_LIMITS_MASTER_KEY: MASTER,
    NODE_OPTIONS: `--require=${preload}`,
    VL_FAKE_HEADERS: JSON.stringify(HEALTHY_HEADERS),
    ...extraEnv,
  };
  // stdin is /dev/null: a command that tried to prompt would hang and the
  // timeout would fail the test. Headlessness is enforced here, not asserted.
  const r = spawnSync(process.execPath, [cli, ...args], {
    env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ok(!r.error, `spawn failed for "${args.join(' ')}": ${r.error && r.error.message}`);
  for (const stream of [r.stdout, r.stderr]) {
    assert.ok(!stream.includes(KEY_A) && !stream.includes(KEY_B),
      `credential leaked to CLI output of "${args.join(' ')}"`);
  }
  let json = null;
  if (args.includes('--json')) {
    try { json = JSON.parse(r.stdout); } catch { json = null; }
  }
  return { ...r, json };
}

function events(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'events'), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
const fetches = (dir) => events(dir).filter((e) => e.kind === 'fetch');
const children = (dir) => events(dir).filter((e) => e.kind === 'child');
function resetEvents(dir) { try { fs.unlinkSync(path.join(dir, 'events')); } catch { /* none yet */ } }

function userRoutes(dir) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  return Array.isArray(doc.routes) ? doc.routes : [];
}
function routeById(dir, id) { return userRoutes(dir).find((r) => r.id === id) || null; }
function secretFiles(dir) {
  try { return fs.readdirSync(path.join(dir, 'secrets')).sort(); } catch { return []; }
}
function cacheRoutes(dir) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
    return doc.routes || {};
  } catch { return {}; }
}
function seedCache(dir, rows) {
  fs.writeFileSync(path.join(dir, 'status.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), routes: rows }, null, 1));
}

const ADD_ACME = [
  'provider', 'add', '--label', 'acme-plan', '--recipe', 'openai-compat',
  '--endpoint', 'https://acme.example.com', '--option', 'path=/v1/models',
  '--option', 'scope=account', '--match-model', 'acme', '--key', KEY_A, '--json',
];

// A second, independent custom endpoint — used where a test needs to add one
// route while another already exists and must survive untouched.
const ADD_BETA = [
  'provider', 'add', '--label', 'beta-plan', '--recipe', 'openai-compat',
  '--endpoint', 'https://beta.example.com', '--option', 'path=/v1/models',
  '--option', 'scope=account', '--key', KEY_B, '--json',
];

console.log('provider add — custom endpoint');

test('a monitored probe persists route, credential and cache; exit 0', () => {
  const dir = freshDir();
  const r = run(dir, ADD_ACME);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.status, 'ok');
  assert.strictEqual(r.json.probe.outcome, 'monitored');
  assert.strictEqual(r.json.probe.state, 'healthy');
  assert.deepStrictEqual(r.json.persisted, { credential: true, config: true, cache: true });
  const route = routeById(dir, 'custom-acme-plan');
  assert.ok(route, 'route must be written to config.json');
  assert.strictEqual(route.monitor.recipe, 'openai-compat');
  assert.strictEqual(route.monitor.endpoint, 'https://acme.example.com');
  assert.deepStrictEqual(route.monitor.recipeOptions, { path: '/v1/models', scope: 'account' });
  assert.deepStrictEqual(secretFiles(dir), ['custom-acme-plan.enc']);
  // The shipped built-ins seeded in config.json must survive the write.
  assert.ok(routeById(dir, 'kimi-code-plan'), 'an existing route must not be dropped');
});

test('the probe is one read-only GET and never an inference request (AC4)', () => {
  const dir = freshDir();
  resetEvents(dir);
  run(dir, ADD_ACME);
  const list = fetches(dir);
  assert.strictEqual(list.length, 1, `expected one probe fetch, got ${list.length}`);
  assert.strictEqual(list[0].method, 'GET');
  assert.strictEqual(list[0].redirect, 'manual');
  assert.strictEqual(list[0].url, 'https://acme.example.com/v1/models');
  assert.doesNotMatch(list[0].url, /\/(chat\/)?completions|\/messages|\/responses|\/embeddings/i);
  assert.strictEqual(children(dir).length, 0, 'the probe must not spawn a subprocess');
});

test('a colliding label is refused without overwriting anything; exit 3', () => {
  const dir = freshDir();
  run(dir, ADD_ACME);
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const r = run(dir, [...ADD_ACME.slice(0, -1), '--json']);
  assert.strictEqual(r.status, 3, r.stderr);
  assert.strictEqual(r.json.status, 'id-collision');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before,
    'a collision must leave config.json byte-identical');
});

test('a label impersonating a built-in family is refused; exit 4', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'add', '--label', 'kimi-mine', '--recipe', 'openai-compat',
    '--endpoint', 'https://k.example.com', '--option', 'path=/v1/models', '--key', KEY_A, '--json']);
  assert.strictEqual(r.status, 4, r.stderr);
  assert.strictEqual(r.json.status, 'invalid-route');
  assert.match(r.json.error, /reserved prefix/);
});

test('an unknown recipe is refused as unsupported-recipe; exit 4', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'add', '--label', 'acme-plan', '--recipe', 'not-a-recipe',
    '--provider', 'acme', '--json']);
  assert.strictEqual(r.status, 4, r.stderr);
  assert.strictEqual(r.json.status, 'unsupported-recipe');
});

test('a credential-shaped recipe option is refused before any write; exit 4', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'add', '--label', 'acme-plan', '--recipe', 'openai-compat',
    '--endpoint', 'https://acme.example.com', '--option', 'path=/v1/models',
    '--option', `api_key=${KEY_A}`, '--key', KEY_A, '--json']);
  assert.strictEqual(r.status, 4, r.stderr);
  assert.match(r.json.error, /credential-shaped/);
  assert.deepStrictEqual(secretFiles(dir), []);
  assert.strictEqual(routeById(dir, 'custom-acme-plan'), null);
});

console.log('provider add — retention choice (AC2)');

test('a failed probe requires an explicit choice, persists nothing, exit 2, no prompt', () => {
  const dir = freshDir();
  run(dir, ADD_ACME); // an existing working route that must survive
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const r = run(dir, ['provider', 'add', '--label', 'broken-plan', '--recipe', 'openai-compat',
    '--endpoint', 'https://broken.example.com', '--option', 'path=/v1/models',
    '--option', 'scope=account', '--key', KEY_B, '--json'], { VL_FAKE_STATUS: '500' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(r.json.status, 'retention-choice-required');
  assert.deepStrictEqual(r.json.persisted, { credential: false, config: false, cache: false });
  assert.strictEqual(routeById(dir, 'custom-broken-plan'), null);
  assert.deepStrictEqual(secretFiles(dir), ['custom-acme-plan.enc'],
    'a failed probe must not store a credential');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before,
    'a failed probe must leave the existing working route untouched');
  assert.doesNotMatch(r.stdout + r.stderr, /paste|\?\s*$/i, 'the headless path must not prompt');
});

test('a diagnostic-scope source reports no usable signal rather than healthy', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'add', '--label', 'diag-plan', '--recipe', 'openai-compat',
    '--endpoint', 'https://diag.example.com', '--option', 'path=/v1/models', '--key', KEY_A, '--json']);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(r.json.probe.outcome, 'no-signal');
  assert.strictEqual(r.json.status, 'retention-choice-required');
});

test('--keep-unmonitored registers the route with the explicit retention flag; exit 0', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'add', '--label', 'broken-plan', '--recipe', 'openai-compat',
    '--endpoint', 'https://broken.example.com', '--option', 'path=/v1/models',
    '--option', 'scope=account', '--key', KEY_B, '--keep-unmonitored', '--json'],
  { VL_FAKE_STATUS: '500' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.status, 'ok');
  const route = routeById(dir, 'custom-broken-plan');
  assert.strictEqual(route.retention, 'keep-unmonitored');
  assert.strictEqual(route.monitor.retention, undefined, 'retention must stay out of monitor');
  assert.deepStrictEqual(secretFiles(dir), ['custom-broken-plan.enc'], 'the credential is kept');
});

test('report names an explicitly kept-unmonitored route', () => {
  const dir = freshDir();
  run(dir, ['provider', 'add', '--label', 'broken-plan', '--recipe', 'openai-compat',
    '--endpoint', 'https://broken.example.com', '--option', 'path=/v1/models',
    '--option', 'scope=account', '--key', KEY_B, '--keep-unmonitored', '--json'],
  { VL_FAKE_STATUS: '500' });
  const r = run(dir, ['report']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout,
    /custom-broken-plan: unmonitored — kept by explicit choice \(no usable quota signal at setup\)/);
});

test('--clear-credential stores nothing and creates no route; exit 0', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'add', '--label', 'broken-plan', '--recipe', 'openai-compat',
    '--endpoint', 'https://broken.example.com', '--option', 'path=/v1/models',
    '--option', 'scope=account', '--key', KEY_B, '--clear-credential', '--json'],
  { VL_FAKE_STATUS: '500' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.cleared, true);
  assert.deepStrictEqual(secretFiles(dir), []);
  assert.strictEqual(routeById(dir, 'custom-broken-plan'), null);
});

test('the two retention flags are mutually exclusive', () => {
  const dir = freshDir();
  const r = run(dir, [...ADD_ACME, '--keep-unmonitored', '--clear-credential']);
  assert.strictEqual(r.status, 1, 'conflicting flags are bad arguments (exit 1)');
  assert.match(r.stderr, /cannot be used together/);
});

console.log('provider add — partial-persistence recovery (AC1)');

// config.json is published atomically (temp file + rename), so neither
// chmod-ing the FILE (a rename replaces it regardless of its mode) nor
// freezing the data DIRECTORY (that fails earlier, at the mutation lock)
// exercises the config stage. `VL_FAIL_CONFIG_RENAME` fails the publication
// itself, exactly as a full disk would, which is the failure the credential
// rollback exists for.
const FAIL_CONFIG = { VL_FAIL_CONFIG_RENAME: '1' };

test('a failed config publication rolls the credential back; exit 5, nothing persisted', () => {
  const dir = freshDir();
  const r = run(dir, ADD_ACME, FAIL_CONFIG);
  assert.strictEqual(r.status, 5, `${r.stdout}${r.stderr}`);
  assert.strictEqual(r.json.status, 'persist-failed');
  assert.strictEqual(r.json.stage, 'config');
  assert.strictEqual(r.json.rollback, 'credential-removed');
  assert.strictEqual(r.json.persisted.credential, false);
  assert.deepStrictEqual(secretFiles(dir), [], 'the rolled-back credential must be gone from disk');
  assert.strictEqual(routeById(dir, 'custom-acme-plan'), null);
});

test('rerunning after the failure completes the add', () => {
  const dir = freshDir();
  assert.strictEqual(run(dir, ADD_ACME, FAIL_CONFIG).status, 5);
  const r = run(dir, ADD_ACME);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.json.persisted, { credential: true, config: true, cache: true });
  assert.ok(routeById(dir, 'custom-acme-plan'));
});

test('a failed publication leaves the existing config.json byte-identical', () => {
  const dir = freshDir();
  assert.strictEqual(run(dir, ADD_ACME).status, 0);
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const r = run(dir, ADD_BETA, FAIL_CONFIG);
  assert.strictEqual(r.status, 5, r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before,
    'a failed publication must not damage the previous document');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith('config.json.tmp')), [],
    'a failed publication left its temp file behind');
  assert.deepStrictEqual(secretFiles(dir), ['custom-acme-plan.enc'],
    'the earlier route keeps its credential; the new one was rolled back');
});

test('a read-only data dir cannot take the mutation lock, and persists nothing', () => {
  const dir = freshDir();
  fs.chmodSync(dir, 0o555);
  const r = run(dir, ADD_ACME);
  fs.chmodSync(dir, 0o755);
  assert.strictEqual(r.status, 6, r.stderr);
  assert.strictEqual(r.json.status, 'lock-busy');
  assert.deepStrictEqual(secretFiles(dir), []);
  assert.strictEqual(routeById(dir, 'custom-acme-plan'), null);
});

test('a malformed config.json is refused, not overwritten', () => {
  const dir = freshDir();
  const broken = '{\n "vault": { "backend": "file" },\n "routes": [\n  { "id": "mine", "provider": "kimi" },\n ]\n}\n';
  fs.writeFileSync(path.join(dir, 'config.json'), broken);
  const r = run(dir, ADD_ACME);
  assert.strictEqual(r.status, 5, r.stderr);
  assert.strictEqual(r.json.stage, 'config-unreadable');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), broken,
    'a config we could not parse must be left exactly as it was');
  assert.deepStrictEqual(secretFiles(dir), [], 'and no credential may be stored');
});

test('a busy mutation lock is reported, not silently queued; exit 6', () => {
  const dir = freshDir();
  // A ticket held by THIS process: a live contender is never taken over, and
  // its lower number wins the election outright.
  const tickets = path.join(dir, 'provider-mutations');
  fs.mkdirSync(tickets, { recursive: true });
  const held = path.join(tickets, `${process.pid}-${'1'.repeat(32)}.json`);
  fs.writeFileSync(held, JSON.stringify({ pid: process.pid, owner: 'someone-else', number: 1 }));
  const r = run(dir, ADD_ACME);
  assert.strictEqual(r.status, 6, r.stderr);
  assert.strictEqual(r.json.status, 'lock-busy');
  assert.deepStrictEqual(secretFiles(dir), []);
  assert.strictEqual(routeById(dir, 'custom-acme-plan'), null);
  assert.ok(fs.existsSync(held), "a refused contender must not remove the holder's ticket");
  assert.deepStrictEqual(fs.readdirSync(tickets), [path.basename(held)],
    'a refused contender left its own ticket behind, which would block the next mutation');
});

console.log('credentials never reach the output');

test('a mistyped --key=SECRET is not echoed back', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'add', '--label', 'acme-plan', '--recipe', 'openai-compat',
    `--key=${KEY_A}`, '--json']);
  assert.strictEqual(r.status, 1, 'unsupported syntax is a bad argument');
  // `run` already fails the test if either stream contains KEY_A; assert the
  // shape of what IS printed so the redaction is pinned, not just absence.
  assert.match(r.stderr, /unknown option "--key=<redacted>"/);
});

test('a probe failure never prints provider or credential text', () => {
  const dir = freshDir();
  // 500 with a body: the adapter classifies it, and nothing of the exchange
  // may reach stdout.
  const r = run(dir, ADD_ACME, { VL_FAKE_STATUS: '500' });
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(r.json.probe.outcome, 'no-signal');
  assert.strictEqual(JSON.stringify(r.json).includes(KEY_A), false);
  assert.strictEqual(JSON.stringify(r.json).includes('Bearer'), false);
});

console.log('provider update');

test('rotating the credential reaches the wire and keeps the route identity', () => {
  const dir = freshDir();
  run(dir, ADD_ACME);
  resetEvents(dir);
  const first = run(dir, ['provider', 'update', 'custom-acme-plan', '--json']);
  assert.strictEqual(first.status, 0, first.stderr);
  const beforeFp = fetches(dir).at(-1).authFingerprint;
  resetEvents(dir);
  const r = run(dir, ['provider', 'update', 'custom-acme-plan', '--key', KEY_B, '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.rotated, true);
  const afterFp = fetches(dir).at(-1).authFingerprint;
  assert.notStrictEqual(afterFp, beforeFp, 'the probe must use the NEW credential');
  assert.deepStrictEqual(secretFiles(dir), ['custom-acme-plan.enc']);
  assert.ok(routeById(dir, 'custom-acme-plan'), 'the route identity is retained across a rotation');
});

test('an endpoint change keeps the id and changes the published revision (AC3)', () => {
  const dir = freshDir();
  const added = run(dir, ADD_ACME);
  const r = run(dir, ['provider', 'update', 'custom-acme-plan',
    '--endpoint', 'https://acme2.example.com', '--option', 'path=/v1/models',
    '--option', 'scope=account', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(routeById(dir, 'custom-acme-plan').monitor.endpoint, 'https://acme2.example.com');
  assert.notStrictEqual(r.json.configRevision, added.json.configRevision,
    'a different source must publish a different revision');
});

test('provider and recipe are immutable; exit 4 and no write', () => {
  const dir = freshDir();
  run(dir, ADD_ACME);
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const r = run(dir, ['provider', 'update', 'custom-acme-plan', '--recipe', 'anthropic-compat', '--json']);
  assert.strictEqual(r.status, 4, r.stderr);
  assert.match(r.json.error, /immutable/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
});

test('an unknown route is not-found; exit 7', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'update', 'custom-ghost', '--json']);
  assert.strictEqual(r.status, 7, r.stderr);
  assert.strictEqual(r.json.status, 'not-found');
});

test('a built-in route is pointed at the credential path, not edited here', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'update', 'kimi-code-plan', '--key', KEY_A, '--json']);
  assert.strictEqual(r.status, 4, r.stderr);
  assert.match(r.json.error, /vl\.js update kimi-code-plan/);
});

console.log('provider remove / vl.js remove (AC3)');

test('removing a custom route clears route, credential and cache row; exit 0', () => {
  const dir = freshDir();
  run(dir, ADD_ACME);
  seedCache(dir, {
    'custom-acme-plan': { routeId: 'custom-acme-plan', status: { state: 'healthy' } },
    'kimi-code-plan': { routeId: 'kimi-code-plan', status: { state: 'healthy' } },
  });
  const r = run(dir, ['provider', 'remove', 'custom-acme-plan', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.json.removed, { credential: true, config: true, cache: true, nativeLogout: false });
  assert.strictEqual(routeById(dir, 'custom-acme-plan'), null);
  assert.deepStrictEqual(secretFiles(dir), []);
  assert.strictEqual(cacheRoutes(dir)['custom-acme-plan'], undefined);
  assert.ok(cacheRoutes(dir)['kimi-code-plan'], 'an unrelated cache row must survive');
});

test('vl.js remove on a BUILT-IN drops its credential and cache row, keeps the route', () => {
  const dir = freshDir();
  run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  assert.deepStrictEqual(secretFiles(dir), ['kimi-code-plan.enc'], 'setup must store the built-in key');
  seedCache(dir, {
    'kimi-code-plan': { routeId: 'kimi-code-plan', status: { state: 'healthy' } },
    'glm-coding-plan': { routeId: 'glm-coding-plan', status: { state: 'healthy' } },
  });
  const r = run(dir, ['remove', 'kimi-code-plan']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(secretFiles(dir), []);
  assert.strictEqual(cacheRoutes(dir)['kimi-code-plan'], undefined, "the built-in's cache row must be dropped");
  assert.ok(cacheRoutes(dir)['glm-coding-plan'], "another built-in's row must not be touched");
  assert.ok(routeById(dir, 'kimi-code-plan'), 'the configured built-in route must stay configured');
  assert.match(r.stderr, /removed .*credential.* for "kimi-code-plan"/);
});

test('vl.js remove keeps its documented exit codes (0 when there is nothing to do)', () => {
  const dir = freshDir();
  const r = run(dir, ['remove', 'kimi-code-plan']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /no credential for "kimi-code-plan"/);
});

test('provider remove reports not-found with its own stable code; exit 7', () => {
  const dir = freshDir();
  const r = run(dir, ['provider', 'remove', 'custom-ghost', '--json']);
  assert.strictEqual(r.status, 7, r.stderr);
  assert.strictEqual(r.json.status, 'not-found');
});

test('a credential-free recipe is removed without any vault delete', () => {
  const dir = freshDir();
  const added = run(dir, ['provider', 'add', '--label', 'stepplan-main', '--provider', 'stepplan',
    '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
  assert.strictEqual(added.status, 0, added.stderr);
  assert.deepStrictEqual(secretFiles(dir), [], 'an unmonitored recipe stores no credential');
  const r = run(dir, ['provider', 'remove', 'custom-stepplan-main', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.removed.credential, false);
  assert.strictEqual(r.json.removed.config, true);
});

test('removal is resumable: a failed config publication keeps the cleared credential reported', () => {
  const dir = freshDir();
  run(dir, ADD_ACME);
  const r = run(dir, ['provider', 'remove', 'custom-acme-plan', '--json'], FAIL_CONFIG);
  assert.strictEqual(r.status, 5, r.stderr);
  assert.strictEqual(r.json.removed.credential, true);
  assert.strictEqual(r.json.removed.config, false);
  assert.match(r.json.recovery, /rerun the removal/);
  const again = run(dir, ['provider', 'remove', 'custom-acme-plan', '--json']);
  assert.strictEqual(again.status, 0, again.stderr);
  assert.strictEqual(routeById(dir, 'custom-acme-plan'), null);
});

// The REAL vault's failure behaviour, not the unit suite's fake: production
// `fileGet` swallows every read/decrypt error and returns null, and
// `fileDelete` swallows every unlink error and returns false. So a delete that
// FAILED is byte-for-byte indistinguishable from a secret that was never
// there, if all you have is get() and remove(). Here the secret is provably
// still on disk and the delete provably failed, which is the case a read-back
// would have announced as a successful removal — leaving an orphaned
// credential behind a deleted route.
test('a credential that could not be deleted is reported as failed, not removed (real vault)', () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('    (skipped: running as root, where mode bits do not deny)');
    return;
  }
  const dir = freshDir();
  run(dir, ADD_ACME);
  const secrets = path.join(dir, 'secrets');
  const blob = path.join(secrets, 'custom-acme-plan.enc');
  assert.strictEqual(fs.existsSync(blob), true, 'the add did not store a credential to delete');
  // r-x: the blob can still be STAT'd (so presence is provable) but the
  // directory cannot be written, so unlink fails. This is exactly the shape of
  // a vault that is intact and inaccessible.
  fs.chmodSync(secrets, 0o500);
  try {
    const r = run(dir, ['provider', 'remove', 'custom-acme-plan', '--json']);
    assert.strictEqual(r.status, 5, r.stderr);
    assert.strictEqual(r.json.stage, 'vault');
    assert.strictEqual(r.json.removed.credential, false,
      'a failed delete was reported as a credential removal');
    assert.strictEqual(r.json.removed.config, false,
      'the route was deleted while its credential was still stored');
    assert.match(r.json.recovery, /still stored/);
    assert.strictEqual(fs.existsSync(blob), true, 'the test premise failed: the blob was deleted');
    assert.ok(!JSON.stringify(r.json).includes(KEY_A), 'the credential appeared in the result');
    assert.ok(routeById(dir, 'custom-acme-plan'), 'the route entry must survive a failed vault stage');
  } finally {
    fs.chmodSync(secrets, 0o700);
  }
  // Idempotent: once the vault is reachable again the same command finishes.
  const again = run(dir, ['provider', 'remove', 'custom-acme-plan', '--json']);
  assert.strictEqual(again.status, 0, again.stderr);
  assert.strictEqual(again.json.removed.credential, true);
  assert.strictEqual(fs.existsSync(blob), false);
  assert.strictEqual(routeById(dir, 'custom-acme-plan'), null);
});

console.log('no native logout (AC3)');

// Every lifecycle command, custom and built-in, over one data dir: the
// subprocess journal must stay empty. The preload records an attempt before
// refusing it, so a path that shelled out to `bl auth logout`, a profile
// switch, or anything else would be visible here.
function runWholeLifecycle(dir, extraEnv = {}) {
  run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A], extraEnv);
  run(dir, ADD_ACME, extraEnv);
  run(dir, ['provider', 'list', '--json'], extraEnv);
  run(dir, ['provider', 'update', 'custom-acme-plan', '--key', KEY_B, '--json'], extraEnv);
  run(dir, ['provider', 'remove', 'custom-acme-plan', '--json'], extraEnv);
  run(dir, ['remove', 'kimi-code-plan'], extraEnv);
}

test('no lifecycle command spawns a subprocess of any kind', () => {
  const dir = freshDir();
  resetEvents(dir);
  runWholeLifecycle(dir);
  assert.deepStrictEqual(children(dir), [], 'a lifecycle command spawned a subprocess');
});

test('no lifecycle command touches a native CLI session (argv journal)', () => {
  const dir = freshDir();
  resetEvents(dir);
  runWholeLifecycle(dir);
  const argv = children(dir).flatMap((e) => e.argv).join(' ');
  assert.doesNotMatch(argv, /\b(logout|login|auth|config\s+use|bl|bailian|aliyun|security)\b/,
    `a lifecycle command referenced a native CLI session: ${argv}`);
});

test('TRIPWIRE: that assertion can fail — forcing one forbidden spawn trips it', () => {
  const dir = freshDir();
  resetEvents(dir);
  // Route deliberately through the forbidden path (test-only preload flag).
  runWholeLifecycle(dir, { VL_TEST_FORCE_SPAWN: '1' });
  const recorded = children(dir);
  assert.ok(recorded.length > 0, 'the subprocess recorder never fired — the assertion above is vacuous');
  const argv = recorded.flatMap((e) => e.argv).join(' ');
  assert.match(argv, /\b(logout|bl)\b/, 'the recorder must capture the forbidden argv');
});

console.log('provider list (AC3 — usable revision checks)');

test('lists credential need, retention and revision agreement', () => {
  const dir = freshDir();
  run(dir, ADD_ACME);
  run(dir, ['refresh', '--quiet']);
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const row = r.json.routes.find((x) => x.id === 'custom-acme-plan');
  assert.strictEqual(row.needsCredential, true);
  assert.strictEqual(row.hasCredential, true);
  assert.strictEqual(row.custom, true);
  assert.strictEqual(row.recipe, 'openai-compat');
  assert.strictEqual(row.cachedRevision, row.configRevision,
    'refresh must publish the route revision into the cache');
  assert.strictEqual(row.configObsolete, false);
  const builtIn = r.json.routes.find((x) => x.id === 'kimi-code-plan');
  assert.strictEqual(builtIn.custom, false);
  assert.strictEqual(builtIn.needsCredential, true);
  assert.strictEqual(builtIn.hasCredential, false);
});

test('flags a cached row left behind by a hand-edited route', () => {
  const dir = freshDir();
  run(dir, ADD_ACME);
  run(dir, ['refresh', '--quiet']);
  // Edit the route the way a user editing config.json would.
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  doc.routes.find((r) => r.id === 'custom-acme-plan').monitor.account = 'second-seat';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(doc, null, 1));
  const r = run(dir, ['provider', 'list', '--json']);
  const row = r.json.routes.find((x) => x.id === 'custom-acme-plan');
  assert.strictEqual(row.configObsolete, true,
    'a cached observation from the previous config must read as obsolete');
});

test('list performs no probe and no subprocess', () => {
  const dir = freshDir();
  run(dir, ADD_ACME);
  resetEvents(dir);
  run(dir, ['provider', 'list', '--json']);
  assert.deepStrictEqual(fetches(dir), []);
  assert.deepStrictEqual(children(dir), []);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall provider-lifecycle CLI tests passed');
}
