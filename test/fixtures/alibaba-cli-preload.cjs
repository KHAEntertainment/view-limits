'use strict';
// Preload for test/alibaba-cli.test.js: the real bin/vl.js, real resolver, real
// recipes and the real bounded subprocess runner, with child_process.spawn
// replaced by a recording stub that answers the two documented `bl` commands.
// Every other network channel throws. No external credentials or I/O.
//
//   VL_VAULT_IDS     comma-separated route ids that "have" a vault credential
//   VL_BAILIAN_QUOTA  verbatim stdout for the `usage coding-plan` call
//   VL_BAILIAN_MODE   ok | missing | exit3 | malformed | nonobject | empty
//                    | huge | authno | trailing | hang
const fs = require('fs');
const path = require('path');
const Module = require('module');
const cp = require('child_process');
const { EventEmitter } = require('events');

const dir = process.env.CLAUDE_PLUGIN_DATA;
const CANARY = 'sk-sp-CANARY-bailian-3c81';
const FUTURE = Date.now() + 45 * 60 * 1000;

function log(kind, extra = {}) {
  fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({ kind, pid: process.pid, ...extra }) + '\n');
}

// No network is permitted: this recipe's whole point is that the CLI is the
// only source. If anything reaches for the network it must fail loudly.
const forbidden = () => { throw new Error('network forbidden'); };
for (const mod of ['http', 'https']) for (const m of ['get', 'request']) require(mod)[m] = forbidden;
for (const m of ['connect', 'createConnection']) require('net')[m] = forbidden;
require('tls').connect = forbidden;

const MODE = process.env.VL_BAILIAN_MODE || 'ok';

// `VL_BAILIAN_QUOTA` overrides the quota stdout verbatim, so a demo can drive
// any documented payload without a second fixture. It is bounded like every
// other read (over 256 KiB the bounded runner refuses to parse it).
const QUOTA_OVERRIDE = process.env.VL_BAILIAN_QUOTA;

const QUOTA_OK = JSON.stringify({
  instanceType: 'pro',
  per5Hour: { usedQuota: 1800, totalQuota: 6000, percentage: 0.3, resetTime: FUTURE },
  perWeek: { usedQuota: 45000, totalQuota: 45000, percentage: 1, resetTime: FUTURE },
  perBillMonth: { usedQuota: 12000, totalQuota: 90000, percentage: 0.133, resetTime: FUTURE },
  // A secret in a field the recipe does not read. It must never be echoed into
  // a status: unknown payload fields are dropped, not copied.
  leakedAccessToken: CANARY,
});

const AUTH_OK = JSON.stringify({
  authenticated: true,
  config: 'default',
  console: { source: 'config', masked: 'c***n', region: 'cn-beijing', site: 'domestic' },
});

function fakeSpawn(bin, args, opts) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  log('spawn', {
    bin,
    args,
    shell: !!opts.shell,
    stdio: opts.stdio,
    envKeys: Object.keys(opts.env || {}).sort(),
    envCanary: Object.values(opts.env || {}).some((v) => String(v).includes('CANARY')),
  });

  if (MODE === 'missing') {
    setImmediate(() => {
      const e = new Error('spawn ENOENT');
      e.code = 'ENOENT';
      child.emit('error', e);
    });
    return child;
  }

  const isAuth = args[0] === 'auth';
  let stdout = '';
  let code = 0;
  if (isAuth) {
    stdout = MODE === 'authno' ? JSON.stringify({ authenticated: false, config: 'default' }) : AUTH_OK;
    if (MODE === 'exit3') code = 3;
  } else {
    if (QUOTA_OVERRIDE) stdout = QUOTA_OVERRIDE;
    else if (MODE === 'ok') stdout = QUOTA_OK;
    else if (MODE === 'exit3') { code = 3; stdout = ''; }
    else if (MODE === 'malformed') stdout = `Error: not json${CANARY}`;
    else if (MODE === 'trailing') stdout = `${QUOTA_OK}\nsecret-on-stdout: ${CANARY}`;
    else if (MODE === 'nonobject') stdout = '[]';
    else if (MODE === 'empty') stdout = '{}';
    else if (MODE === 'huge') stdout = `{"per5Hour":{"usedQuota":1,"totalQuota":2,"pad":"${'x'.repeat(300 * 1024)}"}}`;
    // 'hang': the auth preflight answers, then the quota call never emits
    // `close`. The recipe's own deadline must end the read.
    else if (MODE === 'hang') { if (!isAuth) return child; }
  }

  setImmediate(() => {
    // stdout carries a secret the recipe must drop (an unread field on the ok
    // path, noise on the trailing mode). stderr always carries one too. The
    // adapter parses stdout strictly as one JSON document, so the ok path stays
    // parseable while still proving an unknown field never reaches a status.
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.stderr.emit('data', Buffer.from(`stderr noise ${CANARY}`));
    child.emit('close', code);
  });
  return child;
}

const ids = new Set((process.env.VL_VAULT_IDS || '').split(',').filter(Boolean));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'child_process') return Object.assign({}, cp, { spawn: fakeSpawn });
  if (id.endsWith('/lib/vault')) {
    return { has: (rid) => ids.has(rid), get: (rid) => (ids.has(rid) ? CANARY : null), remove: () => false };
  }
  return load.call(this, id, ...args);
};