'use strict';
// Offline end-to-end report coverage for full-precision normalized balances.
// The real CLI reads an isolated cache and file vault; no adapter or network
// path is invoked.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-report-balance-'));
const cli = path.resolve(__dirname, '../bin/vl.js');
const env = {
  ...process.env,
  CLAUDE_PLUGIN_DATA: dir,
  VIEW_LIMITS_MASTER_KEY: 'offline-report-test-key',
};

try {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [
      {
        id: 'openrouter-main', provider: 'openrouter', account: 'main',
        match: { model: 'openrouter' }, ttlSeconds: 120,
      },
      {
        id: 'openrouter-usage-only', provider: 'openrouter', account: 'secondary',
        match: { model: 'usage-only' }, ttlSeconds: 120,
      },
    ],
    vault: { backend: 'file', service: 'test' },
  }));

  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = env.VIEW_LIMITS_MASTER_KEY;
  require('../lib/vault').set('openrouter-main', 'test-token');
  require('../lib/vault').set('openrouter-usage-only', 'test-token');

  const available = 1 - 0.996;
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    updatedAt: '2026-09-21T00:00:00.000Z',
    routes: {
      'openrouter-main': {
        routeId: 'openrouter-main',
        observedAt: '2026-09-21T00:00:00.000Z',
        freshUntil: '2026-09-21T00:02:00.000Z',
        source: 'openrouter',
        status: {
          state: 'healthy',
          windows: [],
          balance: {
            currency: 'USD',
            available,
            spent: { weekly: 0.004 },
            limit: { amount: 20, reset: 'monthly' },
          },
          resetAt: null,
        },
      },
      'openrouter-usage-only': {
        routeId: 'openrouter-usage-only',
        observedAt: '2026-09-21T00:00:00.000Z',
        freshUntil: '2026-09-21T00:02:00.000Z',
        source: 'openrouter',
        status: {
          state: 'unknown',
          windows: [],
          balance: null,
          resetAt: null,
          detail: { usage: { currency: 'USD', weekly: 2.5 }, errors: { credits: 'HTTP 503' } },
        },
      },
    },
  }));

  const report = spawnSync(process.execPath, [cli, 'report'], { env, encoding: 'utf8' });
  assert.strictEqual(report.status, 0, report.stderr || String(report.error));
  assert.match(report.stdout, /openrouter-main: healthy/);
  assert.match(report.stdout, /balance <0\.01 USD/);
  assert.match(report.stdout, /spent <0\.01 USD week/);
  assert.match(report.stdout, /20\.00 USD monthly cap/);
  assert.match(report.stdout, /openrouter-usage-only: unknown · spent 2\.50 USD week/);
  assert.doesNotMatch(report.stdout, /balance 0\.00 USD|NaN|undefined/);

  const json = spawnSync(process.execPath, [cli, 'report', '--json'], { env, encoding: 'utf8' });
  assert.strictEqual(json.status, 0, json.stderr || String(json.error));
  const parsed = JSON.parse(json.stdout);
  assert.strictEqual(parsed.routes['openrouter-main'].status.balance.available, available);
  assert.ok(parsed.routes['openrouter-main'].status.balance.available > 0);
  assert.deepStrictEqual(parsed.routes['openrouter-main'].status.balance.spent, { weekly: 0.004 });
  assert.strictEqual(parsed.routes['openrouter-usage-only'].status.state, 'unknown');
  assert.deepStrictEqual(parsed.routes['openrouter-usage-only'].status.detail.usage, { currency: 'USD', weekly: 2.5 });

  console.log('sub-cent balance report and JSON precision: PASS');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
