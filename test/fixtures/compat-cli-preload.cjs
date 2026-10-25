'use strict';
// Preload for test/compat-cli.test.js: the real bin/vl.js, real adapters and
// resolver, with a fake vault and a recording fake fetch. Every other network
// and subprocess channel throws. No external credentials or I/O.
//
//   VL_VAULT_IDS     comma-separated route ids that "have" a credential
//   VL_FAKE_STATUS   HTTP status for every fetch (default 200)
//   VL_FAKE_HEADERS  JSON object of response headers
//   VL_FAKE_BODY     response body text
const fs = require('fs');
const path = require('path');
const Module = require('module');
const cp = require('child_process');
const { isModuleId } = require('./module-id.cjs');

const dir = process.env.CLAUDE_PLUGIN_DATA;
const TOKEN = 'sk-CANARY-cli-token-5be1';
function log(kind, extra = {}) {
  fs.appendFileSync(path.join(dir, 'events'), JSON.stringify({ kind, pid: process.pid, ...extra }) + '\n');
}

const forbidden = () => { throw new Error('network forbidden'); };
for (const mod of ['http', 'https']) for (const m of ['get', 'request']) require(mod)[m] = forbidden;
for (const m of ['connect', 'createConnection']) require('net')[m] = forbidden;
require('tls').connect = forbidden;
for (const m of ['exec', 'execFile', 'execSync', 'execFileSync']) cp[m] = forbidden;

global.fetch = async (url, init = {}) => {
  log('fetch', {
    url: String(url),
    method: init.method || 'GET',
    redirect: init.redirect,
    headerNames: Object.keys(init.headers || {}).map((k) => k.toLowerCase()).sort(),
    bearer: Object.values(init.headers || {}).some((v) => /^bearer /i.test(String(v))),
  });
  return new Response(process.env.VL_FAKE_BODY || '', {
    status: Number(process.env.VL_FAKE_STATUS || 200),
    headers: JSON.parse(process.env.VL_FAKE_HEADERS || '{}'),
  });
};

const ids = new Set((process.env.VL_VAULT_IDS || '').split(',').filter(Boolean));
const load = Module._load;
Module._load = function (id, ...args) {
  if (isModuleId(id, 'vault')) return { has: (rid) => ids.has(rid), get: (rid) => (ids.has(rid) ? TOKEN : null) };
  return load.call(this, id, ...args);
};
