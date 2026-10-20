'use strict';
// Preload for test/provider-lifecycle-cli.test.js (Issue #58): the real
// bin/vl.js, the real lifecycle service, the real resolver/recipes, and the
// REAL file-backed vault (VIEW_LIMITS_MASTER_KEY + vault.backend "file"), with
// a recording fake fetch standing in for the provider.
//
// Every subprocess channel is recorded and then refused, which is what makes
// the "no native logout" assertion meaningful: if any lifecycle path ever
// tried to shell out — `bl auth logout`, a CLI profile switch, anything — the
// attempt lands in the journal and the command fails loudly.
//
//   VL_FAKE_STATUS        HTTP status for every fetch (default 200)
//   VL_FAKE_HEADERS       JSON object of response headers
//   VL_TEST_FORCE_SPAWN   test-only tripwire proof: deliberately attempt a
//                         forbidden `bl auth logout` so the suite can confirm
//                         the subprocess assertion is capable of failing.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const dir = process.env.CLAUDE_PLUGIN_DATA;
function log(kind, extra = {}) {
  fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({ kind, pid: process.pid, ...extra }) + '\n');
}

// Record first, then refuse. Covers every spawn surface node exposes.
for (const m of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  if (typeof cp[m] !== 'function') continue;
  cp[m] = (...args) => {
    log('child', { fn: m, argv: args.slice(0, 2).map((a) => (Array.isArray(a) ? a.join(' ') : String(a))) });
    throw new Error('subprocess forbidden in this test');
  };
}
const forbidden = () => { throw new Error('direct socket forbidden'); };
for (const mod of ['http', 'https']) for (const m of ['get', 'request']) require(mod)[m] = forbidden;
for (const m of ['connect', 'createConnection']) require('net')[m] = forbidden;
require('tls').connect = forbidden;

global.fetch = async (url, init = {}) => {
  const headers = init.headers || {};
  const auth = Object.entries(headers)
    .filter(([k]) => /^(authorization|x-api-key)$/i.test(k))
    .map(([, v]) => String(v))
    .join('|');
  log('fetch', {
    url: String(url),
    method: init.method || 'GET',
    redirect: init.redirect,
    bearer: /^bearer /i.test(auth),
    // Fingerprint, never the credential itself: enough to prove a rotation
    // reached the wire, impossible to read the key back out of the journal.
    authFingerprint: auth ? crypto.createHash('sha256').update(auth).digest('hex').slice(0, 12) : null,
  });
  return new Response('', {
    status: Number(process.env.VL_FAKE_STATUS || 200),
    headers: JSON.parse(process.env.VL_FAKE_HEADERS || '{}'),
  });
};

// Tripwire proof: route deliberately through the forbidden path so the suite
// can watch its own "no subprocess" assertion fail. Test-only — nothing in
// lib/ or bin/ reads this variable.
if (process.env.VL_TEST_FORCE_SPAWN === '1') {
  try { cp.execFileSync('bl', ['auth', 'logout']); } catch { /* recorded, then refused */ }
}
