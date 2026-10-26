'use strict';
// `vl.js config`: Issue #113 region + effective host per kimi/glm route, plus
// stable refusal reasons, exercised against a temp data dir (never the real
// one). The config command is read-only; a fake vault preload keeps it
// hermetic.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-config-cli-'));
const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/config-cli-preload.cjs');

fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  routes: [
    { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 },
    { id: 'kimi-china', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180, monitor: { recipe: 'built-in', region: 'china' } },
    { id: 'kimi-bad-endpoint', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180, monitor: { recipe: 'built-in', endpoint: 'https://api.example.com' } },
    { id: 'kimi-bad-region', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180, monitor: { recipe: 'built-in', region: 'europe' } },
    { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 180 },
    { id: 'glm-china', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 180, monitor: { recipe: 'built-in', region: 'china' } },
    // A custom/compat route whose provider label happens to be kimi keeps its
    // own region untouched: it is not a built-in route.
    { id: 'custom-kimi-label', provider: 'kimi', account: 'custom', match: { model: 'custom' }, ttlSeconds: 180, monitor: { recipe: 'stepfun-plan', region: 'europe' } },
  ],
}));

function config() {
  const r = spawnSync(process.execPath, [cli, 'config'], {
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, NODE_OPTIONS: `--require=${preload}` },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ok(!r.error, String(r.error));
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

try {
  const out = config();
  const byId = Object.fromEntries(out.routes.map((r) => [r.id, r]));

  assert.strictEqual(byId['kimi-code-plan'].region, 'global');
  assert.strictEqual(byId['kimi-code-plan'].effectiveHost, 'https://api.kimi.ai');
  assert.strictEqual(byId['kimi-code-plan'].reason, undefined);
  console.log('  ✓ kimi default route shows global host and no reason');

  assert.strictEqual(byId['kimi-china'].region, 'china');
  assert.strictEqual(byId['kimi-china'].effectiveHost, 'https://api.kimi.com');
  console.log('  ✓ kimi china route shows the china host');

  // Refused routes show the stable reason and no host.
  assert.strictEqual(byId['kimi-bad-endpoint'].region, undefined);
  assert.strictEqual(byId['kimi-bad-endpoint'].effectiveHost, undefined);
  assert.strictEqual(byId['kimi-bad-endpoint'].reason, 'built-in-endpoint-refused');
  console.log('  ✓ built-in endpoint refusal surfaces the stable reason');

  assert.strictEqual(byId['kimi-bad-region'].reason, 'unknown-region');
  console.log('  ✓ built-in unknown-region refusal surfaces the stable reason');

  assert.strictEqual(byId['glm-coding-plan'].region, 'international');
  assert.strictEqual(byId['glm-coding-plan'].effectiveHost, 'https://api.z.ai');
  assert.strictEqual(byId['glm-china'].region, 'china');
  assert.strictEqual(byId['glm-china'].effectiveHost, 'https://open.bigmodel.cn');
  console.log('  ✓ glm routes show international/china hosts');

  assert.strictEqual(byId['custom-kimi-label'].reason, 'unmonitored:stepfun-plan');
  assert.strictEqual(byId['custom-kimi-label'].effectiveHost, undefined);
  console.log('  ✓ custom route with kimi provider label is not a built-in refusal');

  // B3: provider-level baseUrl overrides are reported by their matched region
  // (or null when the host is unrecognised).
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [
      { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 },
      { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 180 },
    ],
    providers: {
      kimi: { baseUrl: 'https://api.kimi.com' },
      glm: { baseUrl: 'https://override.example' },
    },
  }));
  const out2 = config();
  const byId2 = Object.fromEntries(out2.routes.map((r) => [r.id, r]));
  assert.strictEqual(byId2['kimi-code-plan'].effectiveHost, 'https://api.kimi.com');
  assert.strictEqual(byId2['kimi-code-plan'].region, 'china');
  assert.strictEqual(byId2['glm-coding-plan'].effectiveHost, 'https://override.example');
  assert.strictEqual(byId2['glm-coding-plan'].region, null);
  console.log('  ✓ override hosts report their matched region (or null)');

  // N1: the per-route effectiveHost must never echo a secret-bearing override
  // (userinfo + query) — it is a sanitised origin. The pre-existing
  // `providers` map is out of scope and unchanged (flag filed separately).
  const SECRET_Q = '?api_key=fixture-query-secret';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [
      { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 },
    ],
    providers: { kimi: { baseUrl: `https://u:p@override.example/v1${SECRET_Q}` } },
  }));
  const out3 = config();
  const kimiScrubbed = out3.routes[0];
  assert.strictEqual(kimiScrubbed.effectiveHost, 'https://override.example');
  assert.strictEqual(kimiScrubbed.region, null);
  assert.ok(!JSON.stringify(out3.routes).includes('fixture-query-secret'), 'query secret leaked into route output');
  assert.ok(!JSON.stringify(out3.routes).includes('u:p'), 'userinfo leaked into route output');
  console.log('  ✓ per-route effectiveHost never echoes a secret-bearing override');

  console.log('config-cli: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
