'use strict';
// CLI integration for custom compat routes (Issue #55): the real
// `bin/vl.js refresh` and `check`, real resolver/recipes/transport, fake vault
// and recording fake fetch (test/fixtures/compat-cli-preload.cjs). Proves:
//   - refresh includes custom routes with a valid route.monitor + credential,
//     and skips an uncredentialed one silently (no request, no cache row)
//   - routine refresh/check send only read-only GETs, never inference (AC4)
//   - Anthropic-family requests never carry a Bearer token (AC1)
//   - an exhausted custom route's cache freshness ends at its recovery (D2)
//   - provider body/token never reaches stdout or status.json

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TOKEN = 'sk-CANARY-cli-token-5be1';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-compat-cli-'));
const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/compat-cli-preload.cjs');

const routes = [
  { id: 'custom-oa', provider: 'openai-compat', match: { model: 'oa-model' }, ttlSeconds: 600,
    monitor: { endpoint: 'https://oa.example.com', recipe: 'openai-compat', recipeOptions: { path: '/v1/models', scope: 'account' } } },
  { id: 'custom-an', provider: 'anthropic-compat', match: { model: 'an-model' }, ttlSeconds: 600,
    monitor: { endpoint: 'https://an.example.com/api', recipe: 'anthropic-compat', recipeOptions: { path: '/v1/models', scope: 'account' } } },
  { id: 'custom-nokey', provider: 'openai-compat', match: { model: 'nokey' }, ttlSeconds: 600,
    monitor: { endpoint: 'https://nokey.example.com', recipe: 'openai-compat', recipeOptions: { path: '/v1/models' } } },
];
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ routes, gate: { mode: 'deny' } }));

const HEADERS = {
  // openai: requests drained, recovers in 30s → exhausted
  'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '30s',
  // anthropic: plenty left → healthy
  'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '40',
  'anthropic-ratelimit-requests-reset': new Date(Date.now() + 60000).toISOString(),
};

function run(args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir,
    NODE_OPTIONS: `--require=${preload}`,
    VL_VAULT_IDS: 'custom-oa,custom-an',
    VL_FAKE_HEADERS: JSON.stringify(HEADERS),
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, `${args.join(' ')} exited ${r.status}: ${r.stderr}`);
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'token canary leaked to CLI output');
  return r;
}
const eventsPath = path.join(dir, 'events');
function fetches() {
  try { return fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'fetch'); }
  catch { return []; }
}
function resetEvents() { try { fs.unlinkSync(eventsPath); } catch { /* none yet */ } }
function assertReadOnly(list) {
  for (const f of list) {
    assert.strictEqual(f.method, 'GET', `${f.method} ${f.url}`);
    assert.strictEqual(f.redirect, 'manual');
    assert.doesNotMatch(f.url, /\/(chat\/)?completions|\/messages|\/responses|\/embeddings/i, f.url);
  }
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e && e.message || e}`); }
}

console.log('refresh — custom routes');

test('refresh fetches each credentialed custom route once; uncredentialed route is skipped', () => {
  resetEvents();
  run(['refresh', '--quiet']);
  const list = fetches();
  assert.deepStrictEqual(list.map((f) => f.url).sort(), [
    'https://an.example.com/api/v1/models',
    'https://oa.example.com/v1/models',
  ]);
  assertReadOnly(list);
});

test('auth separation over the real CLI: anthropic route has no Bearer/Authorization', () => {
  const list = fetches();
  const an = list.find((f) => f.url.startsWith('https://an.'));
  const oa = list.find((f) => f.url.startsWith('https://oa.'));
  assert.deepStrictEqual(an.headerNames, ['accept', 'anthropic-version', 'x-api-key']);
  assert.strictEqual(an.bearer, false);
  assert.deepStrictEqual(oa.headerNames, ['accept', 'authorization']);
  assert.strictEqual(oa.bearer, true);
});

test('cache: exhausted custom route expires at its recovery, healthy keeps TTL; no row for uncredentialed', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.ok(!JSON.stringify(doc).includes(TOKEN), 'token canary in status.json');
  assert.ok(!('custom-nokey' in doc.routes));
  const oa = doc.routes['custom-oa'];
  assert.strictEqual(oa.status.state, 'exhausted');
  const oaFresh = Date.parse(oa.freshUntil) - Date.parse(oa.observedAt);
  assert.ok(oaFresh > 25000 && oaFresh <= 31000, `exhausted freshness should end near the 30s recovery, got ${oaFresh}ms`);
  assert.strictEqual(oa.freshUntil, oa.status.resetAt);
  const an = doc.routes['custom-an'];
  assert.strictEqual(an.status.state, 'healthy');
  const anFresh = Date.parse(an.freshUntil) - Date.parse(an.observedAt);
  assert.ok(anFresh >= 599000 && anFresh <= 601000, `healthy keeps TTL, got ${anFresh}ms`);
});

console.log('check — custom routes');

test('check prints NormalizedStatus JSON from one read-only GET', () => {
  resetEvents();
  const r = run(['check', 'custom-an']);
  const st = JSON.parse(r.stdout);
  assert.strictEqual(st.state, 'healthy');
  assert.strictEqual(st.balance, null);
  assert.deepStrictEqual(st.windows.map((w) => [w.type, w.signal]), [['requests', 'throughput']]);
  const list = fetches();
  assert.strictEqual(list.length, 1);
  assertReadOnly(list);
});

test('check: provider 500 echoing the token → unknown http-500, nothing leaked', () => {
  resetEvents();
  const r = run(['check', 'custom-oa'], { VL_FAKE_STATUS: '500', VL_FAKE_BODY: `boom ${TOKEN}` });
  const st = JSON.parse(r.stdout);
  assert.strictEqual(st.state, 'unknown');
  assert.strictEqual(st.detail.reason, 'http-500');
});

test('check: 429 is never exhaustion', () => {
  const r = run(['check', 'custom-oa'], { VL_FAKE_STATUS: '429' });
  const st = JSON.parse(r.stdout);
  assert.strictEqual(st.state, 'unknown');
  assert.strictEqual(st.detail.reason, 'http-429');
});

fs.rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} compat-cli test(s) failed`);
  process.exit(1);
}
console.log('all compat-cli tests passed');
