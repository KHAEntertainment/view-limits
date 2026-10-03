'use strict';
// `vl.js check <routeId>`: adapter errors print one line on stderr and exit 1,
// never a stack trace. Fake vault and adapter via preload; no network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-check-cli-'));
const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/check-cli-preload.cjs');
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  routes: [{ id: 'glm-coding-plan', provider: 'glm', match: { model: 'glm' }, ttlSeconds: 180 }],
}));

function check(mode) {
  const r = spawnSync(process.execPath, [cli, 'check', 'glm-coding-plan'], {
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, NODE_OPTIONS: `--require=${preload}`, VL_CHECK_MODE: mode },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.ok(!r.error, String(r.error));
  return r;
}

function assertOneLineError(r, expected) {
  assert.strictEqual(r.status, 1, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, `view-limits: ${expected}\n`);
  assert.doesNotMatch(r.stderr, /\n.*\n|    at /, 'no stack trace or extra lines');
}

try {
  const ok = check('ok');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.strictEqual(JSON.parse(ok.stdout).state, 'healthy');
  console.log('  ✓ success still prints the status JSON');

  assertOneLineError(check('auth'),
    'check glm-coding-plan failed: Z.ai auth failed (code 1000: Authentication Failed) (rotate via /view-limits:update glm-coding-plan)');
  console.log('  ✓ auth failure (status 401) is one line with a rotate hint');

  assertOneLineError(check('plain'),
    'check glm-coding-plan failed: Z.ai code 500: no active coding plan on this account');
  console.log('  ✓ non-auth failure is one line without a rotate hint');

  assertOneLineError(check('multiline'),
    'check glm-coding-plan failed: HTTP 502: <html> <body>Bad Gateway</body> </html>');
  console.log('  ✓ multi-line provider body is collapsed to one line');

  console.log('check-cli: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
