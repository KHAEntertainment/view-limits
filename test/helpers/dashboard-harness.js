'use strict';
// Shared harness for the real-CLI dashboard tests (Issue #61): scratch data
// dirs, the CLI runner with the hermetic preload, loopback requests, and the
// cleanup that stops (or kills) every daemon a test file started. Module state
// is per process, and every test file runs as its own process.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CLI = path.resolve(__dirname, '../../bin/vl.js');
const PRELOAD = path.join(__dirname, '../fixtures/dashboard-preload.cjs');
const GUARD = path.join(__dirname, '../guard.cjs');
const identity = require('../../lib/dashboard/identity');
const records = require('../../lib/dashboard/record');
const { LOCK_DIR } = require('../../lib/dashboard/instance-lock');

const dirs = [];
const strangers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_TOKEN = 'Mon Jan  1 00:00:00 2001';
const ROUTE = { id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 300 };

function scratch(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-dashcli-'));
  dirs.push(dir);
  if (config !== null) {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config || { routes: [ROUTE], gate: { mode: 'deny', injectContext: false } }));
  }
  return dir;
}

// Run the real CLI. `preload` hands the hermetic fixture to the process (and,
// through the environment, to the daemon and view children it spawns).
function vl(dir, args, { preload = true, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: Object.assign({ PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir },
        preload ? { NODE_OPTIONS: `--require=${PRELOAD}` } : {}, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function record(dir) {
  const r = records.readRecord(dir);
  assert.ok(r.ok, `expected a record in ${dir}: ${JSON.stringify(r)}`);
  return r.record;
}
function raw(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: Object.assign({ Host: `127.0.0.1:${port}` }, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', (e) => resolve({ error: e.code }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const apiStatus = async (dir) => (await raw(record(dir).port, { pathname: '/api/status' })).json;
function events(dir) {
  try { return fs.readFileSync(path.join(dir, 'events'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; }
}
const providerCalls = (dir) => events(dir).filter((e) => e.kind === 'provider').length;
async function until(predicate, label, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    assert.ok(Date.now() < end, `timed out waiting for ${label}`);
    await sleep(50);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function liveStranger() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  strangers.push(child);
  return child;
}
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  return child.pid;
}
function forgeTicket(dir, pid, pidStart) {
  const root = path.join(dir, LOCK_DIR);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${pid}-${'b'.repeat(32)}.json`), JSON.stringify({ pid, pidStart, owner: 'x', number: 1 }));
}
const tickets = (dir) => { try { return fs.readdirSync(path.join(dir, LOCK_DIR)); } catch { return []; } };

// Daemons this file started, for cleanup and the final no-leftovers check.
const started = new Set();
function note(dir) { try { started.add(record(dir).pid); } catch { /* none */ } }
async function cleanup() {
  for (const dir of dirs) {
    const r = records.readRecord(dir);
    if (r.ok) started.add(r.record.pid);
    await vl(dir, ['dashboard', 'stop'], { preload: false });
  }
  for (const pid of started) {
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  for (const s of strangers) { try { s.kill('SIGKILL'); } catch { /* gone */ } }
}


module.exports = {
  CLI,
  PRELOAD,
  GUARD,
  records,
  LOCK_DIR,
  dirs,
  strangers,
  sleep,
  FAKE_TOKEN,
  ROUTE,
  scratch,
  vl,
  record,
  raw,
  apiStatus,
  events,
  providerCalls,
  until,
  alive,
  liveStranger,
  deadPid,
  forgeTicket,
  tickets,
  started,
  note,
  cleanup,
  identity,
};
