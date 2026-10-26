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

  console.log('config-cli: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
