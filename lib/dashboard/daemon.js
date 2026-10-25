'use strict';
// Dashboard daemon lifecycle (Issue #61): run, start, stop, status.
//
// One instance per data directory, guarded by the ownership lock
// (./instance-lock) and published through ./record only after a successful
// bind. Nothing here trusts a PID or a record on its own: `status` and `stop`
// confirm the instance over loopback (the live listener must answer the
// recorded instanceId and pid) AND check the process identity, and `stop`
// asks the instance to shut itself down — it never signals a PID.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const identity = require('./identity');
const { acquireInstanceLock } = require('./instance-lock');
const records = require('./record');
const { createScheduler } = require('./scheduler');
const { createControlServer } = require('./server');
const { DASHBOARD_INTERVAL } = require('../config');

const LOOPBACK_HOSTS = Object.freeze({ '127.0.0.1': '127.0.0.1', localhost: '127.0.0.1', '::1': '::1' });
const MIN_INTERVAL_SECONDS = DASHBOARD_INTERVAL.min;
const MAX_INTERVAL_SECONDS = DASHBOARD_INTERVAL.max;
const READY_TIMEOUT_MS = 15_000;
const STOP_WAIT_MS = 15_000;
const LOG_NAME = 'dashboard.log';
const LOG_MAX_BYTES = 1024 * 1024;

// ---- option validation -------------------------------------------------------

// → { ok: true, host, port } | { ok: false, error }
function validateBind({ host = '127.0.0.1', port = 0 } = {}) {
  if (typeof host !== 'string' || !Object.prototype.hasOwnProperty.call(LOOPBACK_HOSTS, host)) {
    return { ok: false, error: `--host ${JSON.stringify(String(host))} is not supported: only loopback (127.0.0.1, localhost, ::1) is available for now. A LAN listener (--host 0.0.0.0) arrives with the dashboard page (#62).` };
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, error: `--port must be an integer from 0 to 65535 (0 = pick a free port); got ${JSON.stringify(port)}.` };
  }
  return { ok: true, host: LOOPBACK_HOSTS[host], port };
}

function validateInterval(seconds) {
  if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    return { ok: false, error: `the interval must be a whole number of seconds from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS}; got ${JSON.stringify(seconds)}.` };
  }
  return { ok: true, seconds };
}

function urlFor(host, port) {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}/`;
}

// ---- loopback client ---------------------------------------------------------

// One request to the instance a record names. Resolves { status, json } or
// { error: 'refused'|'timeout'|'failed' }; never throws.
function request(record, { method = 'GET', pathname, headers = {}, body, timeoutMs = 3000 }) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    const payload = body === undefined ? null : JSON.stringify(body);
    const hostHeader = `${record.host.includes(':') ? `[${record.host}]` : record.host}:${record.port}`;
    const req = http.request({
      host: record.host,
      port: record.port,
      method,
      path: pathname,
      headers: Object.assign({ Host: hostHeader, Connection: 'close' }, headers,
        payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 16 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
        settle({ status: res.statusCode, json });
      });
      res.on('error', () => settle({ error: 'failed' }));
    });
    req.on('timeout', () => { settle({ error: 'timeout' }); req.destroy(); });
    req.on('error', (e) => settle({ error: e && e.code === 'ECONNREFUSED' ? 'refused' : 'failed' }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ---- status ------------------------------------------------------------------

// What can be said about the instance this data directory's record names.
//   running      the listener answered the recorded instance id AND pid
//   stopped      no record
//   stale        a record, but nothing alive answers it (crash, or the port was
//                taken by something else) — `start` recovers it
//   unverified   a record and something answering, but identity or process
//                identity could not be established — never acted on
//   record-corrupt
async function statusDaemon(dir, io = {}) {
  const read = records.readRecord(dir);
  if (!read.ok) {
    return read.reason === 'absent' ? { state: 'stopped' } : { state: 'record-corrupt' };
  }
  const record = read.record;
  const verdict = identity.classify(record.pid, record.pidStart, io.identity);
  const base = { pid: record.pid, startedAt: record.startedAt, url: urlFor(record.host, record.port), host: record.host, port: record.port };
  if (verdict === identity.VERDICT.DEAD) {
    // A live pid under a dead daemon's record is a different process (PID reuse).
    const exists = (io.identity && io.identity.exists) || identity.processExists;
    return Object.assign({ state: 'stale', reason: exists(record.pid) ? 'pid-reused-by-another-process' : 'process-not-running' }, base);
  }

  const idRes = await request(record, { pathname: '/api/identity', timeoutMs: io.timeoutMs });
  if (idRes.error === 'refused') return Object.assign({ state: 'stale', reason: 'not-listening' }, base);
  if (idRes.error) return Object.assign({ state: 'unverified', reason: `listener ${idRes.error}` }, base);
  const body = idRes.json;
  if (idRes.status !== 200 || !body || body.instanceId !== record.instanceId || body.pid !== record.pid) {
    return Object.assign({ state: 'stale', reason: 'identity-mismatch' }, base);
  }
  if (verdict !== identity.VERDICT.SAME) {
    return Object.assign({ state: 'unverified', reason: 'process-identity-unverified' }, base);
  }
  const statusRes = await request(record, { pathname: '/api/status', timeoutMs: io.timeoutMs });
  const status = statusRes.status === 200 && statusRes.json ? statusRes.json : null;
  const now = io.now ? io.now() : Date.now();
  return Object.assign({
    state: 'running',
    instanceId: record.instanceId,
    uptimeSeconds: Math.max(0, Math.round((now - Date.parse(record.startedAt)) / 1000)),
    intervalSeconds: status && status.daemon ? status.daemon.intervalSeconds : null,
    status: status ? status.status : null,
    collection: status ? status.collection : null,
  }, base);
}

// ---- stop --------------------------------------------------------------------

// → { ok: true } | { ok: false, reason, state? }. Never signals a PID.
async function stopDaemon(dir, io = {}) {
  const info = await statusDaemon(dir, io);
  if (info.state !== 'running') return { ok: false, reason: 'not-running', state: info.state, detail: info.reason || null, info };
  const read = records.readRecord(dir);
  if (!read.ok || read.record.instanceId !== info.instanceId) return { ok: false, reason: 'record-changed', info };
  const record = read.record;
  const res = await request(record, {
    method: 'POST',
    pathname: '/api/stop',
    headers: { 'X-VL-Nonce': record.nonce },
    body: {},
    timeoutMs: io.timeoutMs,
  });
  if (res.error || res.status !== 202) return { ok: false, reason: 'stop-refused', status: res.status || null, info };
  const deadline = Date.now() + (io.waitMs || STOP_WAIT_MS);
  for (;;) {
    const gone = identity.classify(record.pid, record.pidStart, io.identity) === identity.VERDICT.DEAD;
    const after = records.readRecord(dir);
    const recordGone = !after.ok || after.record.instanceId !== record.instanceId;
    if (gone && recordGone) return { ok: true, info };
    if (Date.now() >= deadline) return { ok: false, reason: 'stop-timeout', info };
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---- run (the long-lived daemon) ---------------------------------------------

// Acquire the lock, bind, publish, collect. → { ok: true, ...handle } | { ok: false, reason, ... }
// The handle's `stopped` promise resolves after a full shutdown.
//
// `onReady(info)` runs after the record is published and BEFORE the first
// collection is started. The detached daemon uses it to answer `start`'s ready
// handshake and close that channel (fd 3): a collection spawned while fd 3 is
// still open would inherit it, and `start` would then wait on the collection.
async function runDaemon({ dir, host, port, intervalSeconds, collect, log = () => {}, io = {}, onReady }) {
  const bind = validateBind({ host, port });
  if (!bind.ok) return { ok: false, reason: 'invalid-bind', error: bind.error };
  const interval = validateInterval(intervalSeconds);
  if (!interval.ok) return { ok: false, reason: 'invalid-interval', error: interval.error };

  const lock = await acquireInstanceLock(dir, io.identity);
  if (!lock.ok) return { ok: false, reason: lock.reason, ownerPid: lock.ownerPid, error: lock.error };

  let record = null;
  let scheduler = null;
  let server = null;
  let stopping = null;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });

  const fail = (reason, extra) => {
    if (server) { try { server.close(); } catch { /* not listening */ } }
    lock.release();
    return Object.assign({ ok: false, reason }, extra);
  };

  // The listener needs the identity before the record exists only for the
  // handlers, which read it lazily; the record is published AFTER the bind.
  const instance = { instanceId: null, pid: process.pid, startedAt: null, nonce: null };
  let lastLoggedOutcome = null;
  scheduler = createScheduler({
    collect,
    intervalSeconds: interval.seconds,
    onAttempt: (attempt) => {
      const key = `${attempt.outcome}|${attempt.reason || ''}|${attempt.error || ''}`;
      if (key !== lastLoggedOutcome) {
        lastLoggedOutcome = key;
        log(`collection ${attempt.outcome}${attempt.reason ? ` (${attempt.reason})` : ''}${attempt.error ? `: ${attempt.error}` : ''}`);
      }
    },
  });

  async function shutdown(why) {
    if (stopping) return stopping;
    stopping = (async () => {
      log(`stopping (${why})`);
      if (typeof collect.abort === 'function') collect.abort();
      await scheduler.stop();
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      // The record goes BEFORE the lock, so a successor that wins the lock can
      // never find (or lose) a record of ours.
      if (record) records.removeRecordIf(dir, record.instanceId);
      lock.release();
      resolveStopped();
    })();
    return stopping;
  }

  server = createControlServer({
    identity: instance,
    getStatus: () => scheduler.snapshot({
      instanceId: instance.instanceId,
      startedAt: instance.startedAt,
      host: record ? record.host : null,
      port: record ? record.port : null,
    }),
    refresh: () => ({ coalesced: scheduler.run('refresh').joined }),
    requestStop: () => { shutdown('requested'); },
  });

  const bound = await new Promise((resolve) => {
    server.once('error', (e) => resolve({ error: (e && e.code) || 'bind-failed' }));
    server.listen(bind.port, bind.host, () => resolve({ address: server.address() }));
  });
  if (bound.error) return fail('bind-failed', { code: bound.error, error: `could not listen on ${bind.host}:${bind.port} (${bound.error})` });

  record = records.newRecord({ host: bound.address.address, port: bound.address.port, pidStart: lock.pidStart });
  instance.instanceId = record.instanceId;
  instance.startedAt = record.startedAt;
  instance.nonce = record.nonce;
  const wrote = records.writeRecord(dir, record);
  if (!wrote.ok) return fail('record-write-failed', { error: `could not publish the daemon record (${wrote.error})` });

  const handle = {
    ok: true,
    instanceId: record.instanceId,
    host: record.host,
    port: record.port,
    url: urlFor(record.host, record.port),
    intervalSeconds: interval.seconds,
    shutdown,
    stopped,
    scheduler,
  };
  log(`listening on ${handle.url} interval ${interval.seconds}s instance ${record.instanceId}`);
  if (typeof onReady === 'function') onReady(handle);
  scheduler.start();
  return handle;
}

// ---- start (the CLI side) ----------------------------------------------------

function openLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOG_NAME);
  try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.truncateSync(file, 0); } catch { /* new file */ }
  return fs.openSync(file, 'a', 0o600);
}

// Spawn the daemon detached and wait for its ready line.
// → { ok: true, url, pid, ... } | { ok: false, reason, ... }
// `daemonArgs` is the argv after the node binary, e.g. [vlPath, 'dashboard', '__daemon', ...].
async function startDaemon({ dir, nodePath = process.execPath, daemonArgs, env = process.env, readyTimeoutMs = READY_TIMEOUT_MS }) {
  const existing = await statusDaemon(dir);
  if (existing.state === 'running') return { ok: false, reason: 'already-running', info: existing };
  if (existing.state === 'unverified') return { ok: false, reason: 'unverified', info: existing };

  let logFd;
  try { logFd = openLog(dir); } catch (e) {
    return { ok: false, reason: 'log-unavailable', error: (e && e.code) || 'log-unavailable' };
  }
  let child;
  try {
    // fd 3 is the ready channel; stdout/stderr go to the private log, never to
    // the caller's terminal, so the detached daemon holds none of its stdio.
    child = spawn(nodePath, daemonArgs, { cwd: dir, detached: true, env, stdio: ['ignore', logFd, logFd, 'pipe'] });
  } catch (e) {
    fs.closeSync(logFd);
    return { ok: false, reason: 'spawn-failed', error: (e && e.code) || 'spawn-failed' };
  }
  fs.closeSync(logFd);

  // The daemon writes ONE JSON line and closes fd 3. Settle on the first
  // newline rather than on end-of-stream: if any process the daemon spawned
  // held fd 3 open, 'end' would wait for it. End-of-stream still settles a
  // daemon that exits (or closes) without a newline. Settles exactly once.
  const ready = await new Promise((resolve) => {
    let buf = '';
    let done = false;
    const settle = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const parse = (text) => {
      try { settle(JSON.parse(text)); } catch { settle({ ok: false, reason: 'no-ready-line' }); }
    };
    const timer = setTimeout(() => settle({ ok: false, reason: 'ready-timeout' }), readyTimeoutMs);
    child.stdio[3].on('data', (c) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) parse(buf.slice(0, nl));
    });
    child.stdio[3].on('end', () => parse(buf.split('\n')[0]));
    child.on('error', (e) => settle({ ok: false, reason: 'spawn-failed', error: (e && e.code) || 'spawn-failed' }));
    child.on('exit', (code) => setTimeout(() => settle({ ok: false, reason: 'daemon-exited', code }), 200));
  });
  child.stdio[3].destroy();
  if (ready.ok) { child.unref(); return Object.assign({}, ready, { pid: child.pid }); }
  if (ready.reason === 'ready-timeout') { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } }
  child.unref();
  return ready;
}

module.exports = {
  LOOPBACK_HOSTS, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, LOG_NAME,
  validateBind, validateInterval, urlFor, request,
  statusDaemon, stopDaemon, runDaemon, startDaemon,
};
