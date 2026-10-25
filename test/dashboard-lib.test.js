'use strict';
// Issue #61 — lib/dashboard unit tests. No provider, no credentials, no
// network beyond loopback sockets this file opens itself. The real-CLI daemon
// scenarios (concurrent start, crash/restart, authenticated stop, gate warmth)
// live in test/dashboard-cli.test.js.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const identity = require('../lib/dashboard/identity');
const { acquireInstanceLock, LOCK_DIR } = require('../lib/dashboard/instance-lock');
const records = require('../lib/dashboard/record');
const { createScheduler } = require('../lib/dashboard/scheduler');
const { createControlServer } = require('../lib/dashboard/server');
const { createViewRunner, parseEnvelope } = require('../lib/dashboard/view-runner');
const daemon = require('../lib/dashboard/daemon');
const { resolveDashboardInterval, DASHBOARD_INTERVAL } = require('../lib/config');

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `vl-dash-${label}-`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE_TOKEN = 'Mon Jan  1 00:00:00 2001';

// A real, live, unrelated process to forge identities against.
function liveStranger() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return child;
}
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  return child.pid;
}
function forgeTicket(dir, pid, pidStart, number) {
  const root = path.join(dir, LOCK_DIR);
  fs.mkdirSync(root, { recursive: true });
  const name = `${pid}-${'a'.repeat(31)}${number}.json`;
  fs.writeFileSync(path.join(root, name), JSON.stringify({ pid, pidStart, owner: 'x', number }));
  return path.join(root, name);
}

// Raw loopback request with full control of the Host header.
function raw(port, { method = 'GET', pathname = '/', headers = {}, body, host = `127.0.0.1:${port}` }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: Object.assign({ Host: host }, headers) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', (e) => resolve({ error: e.code || e.message }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const envelope = (outcome, extra = {}) => ({
  schemaVersion: 1, generatedAt: new Date().toISOString(), status: 'ok', routes: [],
  collection: { outcome, published: outcome === 'completed', reason: null, error: null, routes: [], native: null, ...extra },
});

// ---- identity ----------------------------------------------------------------

console.log('identity');

test('classify: absent pid is dead; matching token is same; a different token (PID reuse) is dead', () => {
  const v = identity.VERDICT;
  assert.strictEqual(identity.classify(4242, 'T', { exists: () => false }), v.DEAD);
  assert.strictEqual(identity.classify(4242, 'T', { exists: () => true, tokenOf: () => 'T' }), v.SAME);
  assert.strictEqual(identity.classify(4242, 'T', { exists: () => true, tokenOf: () => 'OTHER' }), v.DEAD);
});

test('classify: an unreadable token is UNVERIFIED, never a match', () => {
  const v = identity.VERDICT;
  assert.strictEqual(identity.classify(4242, 'T', { exists: () => true, tokenOf: () => null }), v.UNVERIFIED);
  assert.strictEqual(identity.classify(4242, null, { exists: () => true, tokenOf: () => 'T' }), v.UNVERIFIED);
  assert.strictEqual(identity.classify(4242, '', { exists: () => true, tokenOf: () => 'T' }), v.UNVERIFIED);
});

test('psStartToken reads this process, and is the same value twice', () => {
  const a = identity.psStartToken(process.pid);
  assert.match(a, /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9]\d \d\d:\d\d:\d\d \d{4}$/);
  assert.strictEqual(identity.psStartToken(process.pid), a);
  assert.strictEqual(identity.classify(process.pid, a), identity.VERDICT.SAME);
  assert.strictEqual(identity.psStartToken(-1), null);
});

// ---- instance lock -----------------------------------------------------------

console.log('instance lock');

test('concurrent acquire: exactly one winner, the rest refuse; release lets the next in', async () => {
  const dir = tmp('lock');
  const results = await Promise.all(Array.from({ length: 6 }, () => acquireInstanceLock(dir)));
  const winners = results.filter((r) => r.ok);
  assert.strictEqual(winners.length, 1, JSON.stringify(results.map((r) => r.ok || r.reason)));
  for (const r of results.filter((x) => !x.ok)) assert.ok(['held', 'indeterminate'].includes(r.reason), r.reason);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, LOCK_DIR)).length, 1, 'losers leave no ticket behind');
  winners[0].release();
  const next = await acquireInstanceLock(dir);
  assert.ok(next.ok);
  next.release();
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, LOCK_DIR)), []);
});

test('a ticket of a dead process is reaped and the lock is acquired', async () => {
  const dir = tmp('lock-dead');
  const file = forgeTicket(dir, await deadPid(), FAKE_TOKEN, 1);
  const lock = await acquireInstanceLock(dir);
  assert.ok(lock.ok);
  assert.ok(!fs.existsSync(file), 'the dead ticket was removed');
  lock.release();
});

test('PID reuse: a live pid with a DIFFERENT start token is dead — reaped, never trusted', async () => {
  const dir = tmp('lock-reuse');
  const stranger = liveStranger();
  try {
    const file = forgeTicket(dir, stranger.pid, FAKE_TOKEN, 1);
    const lock = await acquireInstanceLock(dir);
    assert.ok(lock.ok, `reason ${lock.reason}`);
    assert.ok(!fs.existsSync(file));
    lock.release();
    assert.ok(identity.classify(stranger.pid, identity.psStartToken(stranger.pid)) === identity.VERDICT.SAME);
    process.kill(stranger.pid, 0); // the stranger was not touched
  } finally { stranger.kill('SIGKILL'); }
});

test('a live holder with a MATCHING start token keeps the lock', async () => {
  const dir = tmp('lock-live');
  const stranger = liveStranger();
  try {
    const file = forgeTicket(dir, stranger.pid, identity.psStartToken(stranger.pid), 1);
    const lock = await acquireInstanceLock(dir);
    assert.strictEqual(lock.ok, false);
    assert.strictEqual(lock.reason, 'held');
    assert.strictEqual(lock.ownerPid, stranger.pid);
    assert.ok(fs.existsSync(file), 'a live holder\'s ticket is never removed');
  } finally { stranger.kill('SIGKILL'); }
});

test('a holder whose identity cannot be read is UNVERIFIED and keeps the lock', async () => {
  const dir = tmp('lock-unverified');
  const stranger = liveStranger();
  try {
    const real = identity.psStartToken;
    const file = forgeTicket(dir, stranger.pid, 'whatever', 1);
    const lock = await acquireInstanceLock(dir, { tokenOf: (pid) => (pid === process.pid ? real(pid) : null) });
    assert.strictEqual(lock.ok, false);
    assert.ok(fs.existsSync(file));
  } finally { stranger.kill('SIGKILL'); }
});

test('no readable process start token for ourselves: refuse to become an unverifiable daemon', async () => {
  const lock = await acquireInstanceLock(tmp('lock-noid'), { tokenOf: () => null });
  assert.deepStrictEqual({ ok: lock.ok, reason: lock.reason }, { ok: false, reason: 'no-identity' });
});

// ---- record ------------------------------------------------------------------

console.log('record');

test('record: private 0600, atomic, round-trips, nonce stays in the file', () => {
  const dir = tmp('rec');
  const rec = records.newRecord({ host: '127.0.0.1', port: 40123, pidStart: FAKE_TOKEN });
  assert.ok(records.writeRecord(dir, rec).ok);
  assert.strictEqual(fs.statSync(records.recordPath(dir)).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir), ['dashboard.json'], 'no temporary file left behind');
  const read = records.readRecord(dir);
  assert.ok(read.ok);
  assert.deepStrictEqual(read.record, rec);
  assert.match(rec.nonce, /^[a-f0-9]{64}$/);
  assert.match(rec.instanceId, /^[a-f0-9]{32}$/);
});

test('record: absent, corrupt and malformed are distinguished and never trusted', () => {
  const dir = tmp('rec-bad');
  assert.deepStrictEqual(records.readRecord(dir), { ok: false, reason: 'absent' });
  fs.writeFileSync(records.recordPath(dir), '{not json');
  assert.deepStrictEqual(records.readRecord(dir), { ok: false, reason: 'corrupt' });
  const good = records.newRecord({ host: '127.0.0.1', port: 9, pidStart: FAKE_TOKEN });
  for (const bad of [{ ...good, port: 0 }, { ...good, port: 70000 }, { ...good, nonce: 'short' }, { ...good, pid: -1 }, { ...good, schema: 2 }, []]) {
    fs.writeFileSync(records.recordPath(dir), JSON.stringify(bad));
    assert.strictEqual(records.readRecord(dir).ok, false, JSON.stringify(bad).slice(0, 60));
  }
});

test('removeRecordIf removes only OUR instance record', () => {
  const dir = tmp('rec-rm');
  const mine = records.newRecord({ host: '127.0.0.1', port: 9, pidStart: FAKE_TOKEN });
  const theirs = records.newRecord({ host: '127.0.0.1', port: 9, pidStart: FAKE_TOKEN });
  records.writeRecord(dir, theirs);
  assert.strictEqual(records.removeRecordIf(dir, mine.instanceId), false);
  assert.ok(fs.existsSync(records.recordPath(dir)));
  assert.strictEqual(records.removeRecordIf(dir, theirs.instanceId), true);
  assert.ok(!fs.existsSync(records.recordPath(dir)));
});

// ---- control listener --------------------------------------------------------

console.log('control listener');

async function withServer(fn) {
  const calls = { stop: 0, refresh: 0 };
  const instance = { instanceId: 'a'.repeat(32), pid: process.pid, startedAt: new Date().toISOString(), nonce: 'n'.repeat(64) };
  const server = createControlServer({
    identity: instance,
    getStatus: () => ({ schemaVersion: 1, status: 'pending', view: null }),
    refresh: () => { calls.refresh += 1; return { coalesced: calls.refresh > 1 }; },
    requestStop: () => { calls.stop += 1; },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port, calls, instance); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('GET /api/identity and /api/status answer; the nonce is in no response', async () => {
  await withServer(async (port, calls, instance) => {
    const id = await raw(port, { pathname: '/api/identity' });
    assert.strictEqual(id.status, 200);
    assert.deepStrictEqual(Object.keys(id.json).sort(), ['instanceId', 'pid', 'schema', 'startedAt']);
    const st = await raw(port, { pathname: '/api/status' });
    assert.strictEqual(st.status, 200);
    for (const r of [id, st, await raw(port, { pathname: '/' }), await raw(port, { pathname: '/api/stop' })]) {
      assert.ok(!r.text.includes(instance.nonce), 'the nonce must never be served');
    }
  });
});

test('exact local Host is required on EVERY request (rebinding / wrong port refused)', async () => {
  await withServer(async (port) => {
    for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `localhost:${port}.evil.example`]) {
      assert.strictEqual((await raw(port, { pathname: '/api/status', host })).status, 403, host);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      assert.strictEqual((await raw(port, { pathname: '/api/status', host })).status, 200, host);
    }
  });
});

test('forwarded-address / forwarded-host headers are ignored: they neither grant nor deny', async () => {
  await withServer(async (port, calls, instance) => {
    const fwd = { 'X-Forwarded-For': '8.8.8.8', 'X-Forwarded-Host': 'evil.example', Forwarded: 'for=8.8.8.8;host=evil.example', 'X-Real-IP': '8.8.8.8' };
    assert.strictEqual((await raw(port, { pathname: '/api/status', headers: fwd })).status, 200);
    // and a forwarded "127.0.0.1" does not stand in for the nonce
    const spoof = await raw(port, { method: 'POST', pathname: '/api/stop', headers: { 'X-Forwarded-For': '127.0.0.1' }, body: '' });
    assert.strictEqual(spoof.status, 401);
    assert.strictEqual(calls.stop, 0);
  });
});

test('POST /api/stop: missing or wrong nonce is refused identically; the right one shuts down', async () => {
  await withServer(async (port, calls, instance) => {
    const missing = await raw(port, { method: 'POST', pathname: '/api/stop', body: '' });
    const wrong = await raw(port, { method: 'POST', pathname: '/api/stop', headers: { 'X-VL-Nonce': 'x'.repeat(64) }, body: '' });
    const prefix = await raw(port, { method: 'POST', pathname: '/api/stop', headers: { 'X-VL-Nonce': instance.nonce.slice(0, 63) }, body: '' });
    assert.deepStrictEqual([missing.status, wrong.status, prefix.status], [401, 401, 401]);
    assert.deepStrictEqual(missing.json, wrong.json);
    assert.strictEqual(calls.stop, 0);
    const ok = await raw(port, { method: 'POST', pathname: '/api/stop', headers: { 'X-VL-Nonce': instance.nonce }, body: '' });
    assert.strictEqual(ok.status, 202);
    await sleep(20);
    assert.strictEqual(calls.stop, 1);
  });
});

test('control POSTs refuse a foreign Origin, a bad content type and an oversized body', async () => {
  await withServer(async (port, calls, instance) => {
    const auth = { 'X-VL-Nonce': instance.nonce };
    const foreign = await raw(port, { method: 'POST', pathname: '/api/refresh', headers: { ...auth, Origin: 'http://evil.example' }, body: '' });
    assert.strictEqual(foreign.status, 403);
    const sameOrigin = await raw(port, { method: 'POST', pathname: '/api/refresh', headers: { ...auth, Origin: `http://127.0.0.1:${port}` }, body: '' });
    assert.strictEqual(sameOrigin.status, 202);
    const textBody = await raw(port, { method: 'POST', pathname: '/api/refresh', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.strictEqual(textBody.status, 400);
    const arrayBody = await raw(port, { method: 'POST', pathname: '/api/refresh', headers: { ...auth, 'Content-Type': 'application/json' }, body: '[]' });
    assert.strictEqual(arrayBody.status, 400);
    const huge = await raw(port, { method: 'POST', pathname: '/api/refresh', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ pad: 'x'.repeat(4096) }) });
    assert.ok(huge.status === 413 || huge.error, `expected 413 or a reset, got ${JSON.stringify(huge)}`);
    assert.strictEqual(calls.refresh, 1, 'only the one valid request reached the collector');
    const emptyOk = await raw(port, { method: 'POST', pathname: '/api/refresh', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(emptyOk.status, 202);
    assert.strictEqual(emptyOk.json.coalesced, true);
  });
});

test('unknown paths 404 and wrong methods 405 (the page itself: test/dashboard-page.test.js)', async () => {
  await withServer(async (port) => {
    assert.strictEqual((await raw(port, { pathname: '/index.html' })).status, 404);
    assert.strictEqual((await raw(port, { pathname: '/api/nope' })).status, 404);
    assert.strictEqual((await raw(port, { method: 'POST', pathname: '/api/status', body: '' })).status, 405);
    assert.strictEqual((await raw(port, { method: 'GET', pathname: '/api/refresh' })).status, 405);
  });
});

test('a request from a NON-loopback socket address is refused even with the right nonce and Host', async () => {
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) { console.log('    (skipped: no non-loopback IPv4 interface on this machine)'); return; }
  const calls = { stop: 0 };
  const instance = { instanceId: 'b'.repeat(32), pid: process.pid, startedAt: 'x', nonce: 'm'.repeat(64) };
  const server = createControlServer({ identity: instance, getStatus: () => ({}), refresh: () => ({ coalesced: false }), requestStop: () => { calls.stop += 1; } });
  // Test-only: bind wide so a connection can arrive from a non-loopback address.
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;
  try {
    const res = await new Promise((resolve) => {
      const req = http.request({ host: lan.address, port, method: 'POST', path: '/api/stop', headers: { Host: `127.0.0.1:${port}`, 'X-VL-Nonce': instance.nonce }, localAddress: lan.address }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
      req.on('error', (e) => resolve(e.code));
      req.end();
    });
    assert.strictEqual(res, 403);
    assert.strictEqual(calls.stop, 0);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});

// ---- scheduler ---------------------------------------------------------------

console.log('scheduler');

test('slow collector longer than the interval: collections never overlap (max in flight = 1)', async () => {
  let active = 0; let max = 0; let calls = 0;
  const scheduler = createScheduler({
    intervalSeconds: 0.01,
    collect: async () => { active += 1; calls += 1; max = Math.max(max, active); await sleep(60); active -= 1; return { ok: true, envelope: envelope('completed') }; },
  });
  scheduler.start();
  await sleep(400);
  await scheduler.stop();
  assert.strictEqual(max, 1, `observed ${max} concurrent collections`);
  assert.ok(calls >= 2 && calls <= 8, `expected a few serialized collections, got ${calls}`);
  const snap = scheduler.snapshot();
  assert.ok(snap.collection.skippedTicks > 5, `ticks fired during a run are counted as skipped, got ${snap.collection.skippedTicks}`);
  assert.strictEqual(snap.collection.attempts, calls);
});

test('refresh requests coalesce into the run in flight instead of starting another', async () => {
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const scheduler = createScheduler({ intervalSeconds: 3600, collect: async () => { calls += 1; await gate; return { ok: true, envelope: envelope('completed') }; } });
  scheduler.start();
  const a = scheduler.run('refresh'); const b = scheduler.run('refresh'); const c = scheduler.run('refresh');
  assert.deepStrictEqual([a.joined, b.joined, c.joined], [true, true, true]);
  release();
  await scheduler.stop();
  assert.strictEqual(calls, 1);
  assert.strictEqual(scheduler.snapshot().collection.coalescedRefreshes, 3);
  assert.strictEqual(scheduler.run('refresh').joined, true, 'a stopped scheduler starts nothing');
  assert.strictEqual(calls, 1);
});

test('polling the status never collects; before the first result it is a pending envelope', async () => {
  let calls = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const scheduler = createScheduler({ intervalSeconds: 3600, collect: async () => { calls += 1; await gate; return { ok: true, envelope: envelope('completed') }; } });
  const before = scheduler.snapshot();
  assert.strictEqual(before.status, 'pending');
  assert.strictEqual(before.view, null);
  assert.strictEqual(before.collection.lastAttempt, null);
  assert.strictEqual(before.collection.observationAgeSeconds, null);
  scheduler.start();
  for (let i = 0; i < 50; i += 1) scheduler.snapshot();
  assert.strictEqual(scheduler.snapshot().status, 'pending', 'still pending while the first collection runs');
  assert.strictEqual(scheduler.snapshot().collection.state, 'collecting');
  release();
  await scheduler.stop();
  for (let i = 0; i < 200; i += 1) scheduler.snapshot();
  assert.strictEqual(calls, 1, 'two hundred polls made no extra collection');
  assert.strictEqual(scheduler.snapshot().status, 'ok');
});

test('a failed collection keeps the last view, marks it stale and never renews its age', async () => {
  let t = Date.parse('2026-10-24T12:00:00Z');
  const queue = [
    { ok: true, envelope: envelope('completed', { marker: 1 }) },
    { ok: false, outcome: 'timeout', error: 'the view did not finish within 90s' },
    { ok: true, envelope: envelope('in-progress') },
    { ok: true, envelope: envelope('failed', { reason: 'lock-unavailable', error: 'EACCES' }) },
    { ok: true, envelope: envelope('partial') },
  ];
  const scheduler = createScheduler({ intervalSeconds: 3600, now: () => t, collect: async () => queue.shift() });
  const step = async (ms) => { t += ms; await scheduler.run('refresh').done; return scheduler.snapshot(); };

  const first = await (async () => { await scheduler.run('start').done; return scheduler.snapshot(); })();
  assert.strictEqual(first.status, 'ok');
  assert.strictEqual(first.collection.lastGoodAt, '2026-10-24T12:00:00.000Z');
  const goodView = first.view;

  const timedOut = await step(40_000);
  assert.strictEqual(timedOut.status, 'stale');
  assert.strictEqual(timedOut.collection.lastAttempt.outcome, 'timeout');
  assert.match(timedOut.collection.lastAttempt.error, /90s/);
  assert.strictEqual(timedOut.view, goodView, 'the previous view is retained, not blanked or replaced');
  assert.strictEqual(timedOut.collection.lastGoodAt, first.collection.lastGoodAt, 'a failure does not renew the observation');
  assert.strictEqual(timedOut.collection.observationAgeSeconds, 40);

  const contended = await step(30_000);
  assert.strictEqual(contended.status, 'stale');
  assert.strictEqual(contended.collection.lastAttempt.outcome, 'in-progress');
  assert.strictEqual(contended.collection.observationAgeSeconds, 70);

  const failed = await step(30_000);
  assert.strictEqual(failed.status, 'stale');
  assert.strictEqual(failed.collection.lastAttempt.reason, 'lock-unavailable');
  assert.strictEqual(failed.collection.lastAttempt.error, 'EACCES');
  assert.strictEqual(failed.collection.observationAgeSeconds, 100);

  const recovered = await step(10_000);
  assert.strictEqual(recovered.status, 'ok');
  assert.strictEqual(recovered.collection.observationAgeSeconds, 0);
  assert.strictEqual(recovered.collection.stale, false);
});

test('a first collection that fails with no view is `unavailable` with its diagnostic, not pending and not ok', async () => {
  const scheduler = createScheduler({ intervalSeconds: 3600, collect: async () => { throw new Error('boom'); } });
  await scheduler.run('start').done;
  const snap = scheduler.snapshot();
  assert.strictEqual(snap.status, 'unavailable');
  assert.strictEqual(snap.view, null);
  assert.strictEqual(snap.collection.lastAttempt.outcome, 'error');
  assert.strictEqual(snap.collection.lastAttempt.error, 'boom');
  assert.strictEqual(snap.collection.lastGoodAt, null);
});

// ---- view runner -------------------------------------------------------------

console.log('view runner');

function fakeVl(source) {
  const dir = tmp('runner');
  const file = path.join(dir, 'fake-vl.js');
  fs.writeFileSync(file, source);
  return { dir, file };
}

test('a valid envelope is a view — including from a non-zero exit', async () => {
  const env = envelope('failed', { reason: 'lock-unavailable' });
  const { file } = fakeVl(`process.stdout.write(${JSON.stringify(JSON.stringify(env))}); process.exitCode = 1;`);
  const res = await createViewRunner({ vlPath: file })();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.envelope.collection.reason, 'lock-unavailable');
});

test('the runner spawns node + the checkout\'s vl.js with `view --json`: no shell, own process group, daemon env', async () => {
  const seen = [];
  const { file } = fakeVl(`process.stdout.write(${JSON.stringify(JSON.stringify(envelope('completed')))});`);
  const runner = createViewRunner({ vlPath: file, env: { PATH: '/x', CLAUDE_PLUGIN_DATA: '/y' }, spawnFn: (cmd, args, opts) => { seen.push({ cmd, args, opts }); return require('child_process').spawn(cmd, args, { ...opts, env: process.env }); } });
  assert.strictEqual((await runner()).ok, true);
  assert.strictEqual(seen[0].cmd, process.execPath);
  assert.deepStrictEqual(seen[0].args, [file, 'view', '--json']);
  assert.ok(!seen[0].opts.shell);
  assert.strictEqual(seen[0].opts.detached, true);
  assert.deepStrictEqual(seen[0].opts.env, { PATH: '/x', CLAUDE_PLUGIN_DATA: '/y' });
});

test('strict parsing: garbage, empty output, wrong schema version and a missing collection are errors — never a view', async () => {
  for (const [label, out] of [
    ['garbage', 'not json at all'],
    ['empty', ''],
    ['wrong version', JSON.stringify({ ...envelope('completed'), schemaVersion: 2 })],
    ['no collection', JSON.stringify({ schemaVersion: 1, routes: [] })],
    ['no routes', JSON.stringify({ schemaVersion: 1, collection: { outcome: 'completed' } })],
    ['array', '[]'],
  ]) {
    const { file } = fakeVl(`process.stdout.write(${JSON.stringify(out)}); process.stderr.write('\\u001b[31mboom\\u001b[0m'); process.exitCode = 3;`);
    const res = await createViewRunner({ vlPath: file })();
    assert.strictEqual(res.ok, false, label);
    assert.strictEqual(res.outcome, 'error', label);
    assert.match(res.error, /no valid envelope \(exit 3\)/, label);
    assert.ok(!/\u001b/.test(res.error), 'control characters are stripped from child diagnostics');
  }
  assert.strictEqual(parseEnvelope(JSON.stringify(envelope('completed'))).schemaVersion, 1);
});

test('a hung view is killed at the deadline (whole group) and reported as a timeout', async () => {
  const dir = tmp('runner-hang');
  const pidFile = path.join(dir, 'pids');
  const { file } = fakeVl(`
    const { spawn } = require('child_process');
    const grand = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' });
    require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(grand.pid));
    setTimeout(() => {}, 60000);
  `);
  const started = Date.now();
  const res = await createViewRunner({ vlPath: file, timeoutMs: 400 })();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.outcome, 'timeout');
  assert.ok(Date.now() - started < 5000);
  await sleep(100);
  const grand = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(grand, 0), /ESRCH/, 'the grandchild died with the group');
});

test('output beyond the size bound is an error, and abort() kills the collection in flight', async () => {
  const { file } = fakeVl('const chunk = "x".repeat(1 << 20); (function w(){ for (let i = 0; i < 12; i++) process.stdout.write(chunk); setTimeout(w, 5); })();');
  const res = await createViewRunner({ vlPath: file, timeoutMs: 20_000 })();
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /size bound/);

  const slow = fakeVl('setTimeout(() => {}, 60000);');
  const runner = createViewRunner({ vlPath: slow.file, timeoutMs: 30_000 });
  const pending = runner();
  await sleep(150);
  runner.abort();
  const aborted = await pending;
  assert.strictEqual(aborted.ok, false);
});

// ---- daemon (in-process) -----------------------------------------------------

console.log('daemon');

function deferredCollect() {
  const state = { calls: 0, release: null };
  const gate = new Promise((r) => { state.release = r; });
  state.collect = async () => { state.calls += 1; await gate; return { ok: true, envelope: envelope('completed') }; };
  return state;
}
async function body(dir) {
  const read = records.readRecord(dir);
  assert.ok(read.ok, 'a record is published');
  return read.record;
}

test('port 0 binds, THEN the record is published with the bound port; shutdown removes record and lock', async () => {
  const dir = tmp('run');
  const d = deferredCollect();
  const h = await daemon.runDaemon({ dir, host: '127.0.0.1', port: 0, intervalSeconds: 30, collect: d.collect });
  assert.ok(h.ok, JSON.stringify(h));
  try {
    const rec = await body(dir);
    assert.ok(rec.port > 0 && rec.port === h.port);
    assert.strictEqual(rec.host, '127.0.0.1');
    assert.strictEqual(rec.pid, process.pid);
    assert.strictEqual(rec.instanceId, h.instanceId);
    assert.strictEqual(fs.statSync(records.recordPath(dir)).mode & 0o777, 0o600);
    // pending envelope before the first result; polling is observation-only
    const pending = await daemon.request(rec, { pathname: '/api/status' });
    assert.strictEqual(pending.json.status, 'pending');
    assert.strictEqual(pending.json.view, null);
    for (let i = 0; i < 25; i += 1) await daemon.request(rec, { pathname: '/api/status' });
    d.release();
    await sleep(50);
    const done = await daemon.request(rec, { pathname: '/api/status' });
    assert.strictEqual(done.json.status, 'ok');
    assert.strictEqual(done.json.daemon.instanceId, h.instanceId);
    assert.ok(!JSON.stringify(done.json).includes(rec.nonce), 'the nonce is not in the status document');
    assert.strictEqual(d.calls, 1, '26 polls and zero extra collections');
    // a refresh request over loopback with the nonce coalesces into one new run
    const refreshed = await daemon.request(rec, { method: 'POST', pathname: '/api/refresh', headers: { 'X-VL-Nonce': rec.nonce }, body: {} });
    assert.strictEqual(refreshed.status, 202);
  } finally {
    await h.shutdown('test');
  }
  assert.ok(!fs.existsSync(records.recordPath(dir)), 'the record is removed on shutdown');
  const again = await acquireInstanceLock(dir);
  assert.ok(again.ok, 'the ownership lock is released on shutdown');
  again.release();
});

test('occupied --port: a clean error, NO record published, lock released', async () => {
  const dir = tmp('run-busy');
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  try {
    const h = await daemon.runDaemon({ dir, host: '127.0.0.1', port: busy, intervalSeconds: 30, collect: async () => ({ ok: true, envelope: envelope('completed') }) });
    assert.strictEqual(h.ok, false);
    assert.strictEqual(h.reason, 'bind-failed');
    assert.strictEqual(h.code, 'EADDRINUSE');
    assert.ok(!fs.existsSync(records.recordPath(dir)), 'nothing was published');
    const lock = await acquireInstanceLock(dir);
    assert.ok(lock.ok, 'the failed start did not leave the lock held');
    lock.release();
  } finally { await new Promise((r) => blocker.close(r)); }
});

test('two daemons in one data dir: one runs, the other is refused', async () => {
  const dir = tmp('run-two');
  const collect = async () => ({ ok: true, envelope: envelope('completed') });
  const results = await Promise.all([0, 1, 2].map(() => daemon.runDaemon({ dir, host: '127.0.0.1', port: 0, intervalSeconds: 30, collect })));
  const winners = results.filter((r) => r.ok);
  assert.strictEqual(winners.length, 1);
  for (const r of results.filter((x) => !x.ok)) assert.ok(['held', 'indeterminate'].includes(r.reason), r.reason);
  await winners[0].shutdown('test');
});

test('a stale record from a crash is replaced once the lock is won — the old record is never trusted', async () => {
  const dir = tmp('run-stale');
  const dead = records.newRecord({ host: '127.0.0.1', port: 9, pid: await deadPid(), pidStart: FAKE_TOKEN });
  records.writeRecord(dir, dead);
  forgeTicket(dir, dead.pid, FAKE_TOKEN, 1);
  assert.strictEqual((await daemon.statusDaemon(dir)).state, 'stale');
  const h = await daemon.runDaemon({ dir, host: '127.0.0.1', port: 0, intervalSeconds: 30, collect: async () => ({ ok: true, envelope: envelope('completed') }) });
  assert.ok(h.ok);
  try {
    const rec = await body(dir);
    assert.notStrictEqual(rec.instanceId, dead.instanceId);
    const status = await daemon.statusDaemon(dir);
    assert.strictEqual(status.state, 'running');
    assert.ok(!('nonce' in status), 'status never carries the nonce');
  } finally { await h.shutdown('test'); }
});

test('status: PID reuse (a live, unrelated pid under the record) is stale, never running', async () => {
  const dir = tmp('status-reuse');
  const stranger = liveStranger();
  try {
    const rec = records.newRecord({ host: '127.0.0.1', port: 9, pid: stranger.pid, pidStart: FAKE_TOKEN });
    records.writeRecord(dir, rec);
    const status = await daemon.statusDaemon(dir);
    assert.strictEqual(status.state, 'stale');
    assert.strictEqual(status.reason, 'pid-reused-by-another-process');
    const stop = await daemon.stopDaemon(dir);
    assert.strictEqual(stop.ok, false);
    process.kill(stranger.pid, 0); // never signalled
  } finally { stranger.kill('SIGKILL'); }
});

test('status: a live process with the right start token whose port answers a DIFFERENT instance is stale', async () => {
  const dir = tmp('status-impostor');
  const impostor = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ instanceId: 'f'.repeat(32), pid: process.pid })); });
  await new Promise((r) => impostor.listen(0, '127.0.0.1', r));
  try {
    const rec = records.newRecord({ host: '127.0.0.1', port: impostor.address().port, pid: process.pid, pidStart: identity.psStartToken(process.pid) });
    records.writeRecord(dir, rec);
    const status = await daemon.statusDaemon(dir);
    assert.strictEqual(status.state, 'stale');
    assert.strictEqual(status.reason, 'identity-mismatch');
    assert.strictEqual((await daemon.stopDaemon(dir)).ok, false);
  } finally { impostor.closeAllConnections(); await new Promise((r) => impostor.close(r)); }
});

test('status: a listener that answers but whose process identity is unreadable is UNVERIFIED and stop refuses', async () => {
  const dir = tmp('status-unverified');
  const d = deferredCollect();
  const h = await daemon.runDaemon({ dir, host: '127.0.0.1', port: 0, intervalSeconds: 30, collect: d.collect });
  assert.ok(h.ok);
  try {
    const blind = { identity: { tokenOf: () => null }, timeoutMs: 2000 };
    const status = await daemon.statusDaemon(dir, blind);
    assert.strictEqual(status.state, 'unverified');
    const stop = await daemon.stopDaemon(dir, blind);
    assert.strictEqual(stop.ok, false);
    assert.strictEqual((await daemon.statusDaemon(dir)).state, 'running', 'refused: the daemon was not asked to stop');
  } finally { d.release(); await h.shutdown('test'); }
});

// ---- start's ready handshake -------------------------------------------------

console.log('start handshake');

function fakeDaemonScript(source) {
  const dir = tmp('fakedaemon');
  const file = path.join(dir, 'fake-daemon.js');
  fs.writeFileSync(file, source);
  return { dir, file };
}
const readyLine = JSON.stringify({ ok: true, url: 'http://127.0.0.1:1/', instanceId: 'a'.repeat(32), intervalSeconds: 30 });

test('start settles on the first newline even while something still holds fd 3 open', async () => {
  // The fake daemon answers and then KEEPS fd 3 open (as a leaked grandchild would).
  const { dir, file } = fakeDaemonScript(`require('fs').writeSync(3, ${JSON.stringify(readyLine + '\n')}); setTimeout(() => {}, 30000);`);
  const t0 = Date.now();
  const res = await daemon.startDaemon({ dir, daemonArgs: [file], readyTimeoutMs: 5000 });
  try {
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.ok(Date.now() - t0 < 3000, `start waited ${Date.now() - t0}ms for the held-open channel`);
    assert.strictEqual(res.url, 'http://127.0.0.1:1/');
  } finally { try { process.kill(-res.pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('start settles exactly once on the FIRST line; later lines and the later close are ignored', async () => {
  const bad = JSON.stringify({ ok: false, reason: 'second-line' });
  const { dir, file } = fakeDaemonScript(`require('fs').writeSync(3, ${JSON.stringify(readyLine + '\n' + bad + '\n')}); setTimeout(() => {}, 30000);`);
  const res = await daemon.startDaemon({ dir, daemonArgs: [file], readyTimeoutMs: 5000 });
  try {
    assert.strictEqual(res.ok, true);
    await sleep(200);
  } finally { try { process.kill(-res.pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('start still parses a ready line that arrives without a newline when the channel closes', async () => {
  const { dir, file } = fakeDaemonScript(`const fs = require('fs'); fs.writeSync(3, ${JSON.stringify(readyLine)}); fs.closeSync(3); setTimeout(() => {}, 30000);`);
  const res = await daemon.startDaemon({ dir, daemonArgs: [file], readyTimeoutMs: 5000 });
  try { assert.strictEqual(res.ok, true, JSON.stringify(res)); } finally { try { process.kill(-res.pid, 'SIGKILL'); } catch { /* gone */ } }
});

test('start reports a daemon that dies before answering, and a daemon that never answers times out', async () => {
  const dead = fakeDaemonScript('process.exit(7);');
  const gone = await daemon.startDaemon({ dir: dead.dir, daemonArgs: [dead.file], readyTimeoutMs: 5000 });
  assert.deepStrictEqual({ ok: gone.ok, reason: gone.reason }, { ok: false, reason: 'no-ready-line' });
  const mute = fakeDaemonScript('setTimeout(() => {}, 30000);');
  const t0 = Date.now();
  const late = await daemon.startDaemon({ dir: mute.dir, daemonArgs: [mute.file], readyTimeoutMs: 400 });
  assert.deepStrictEqual({ ok: late.ok, reason: late.reason }, { ok: false, reason: 'ready-timeout' });
  assert.ok(Date.now() - t0 < 4000);
});

test('runDaemon answers onReady AFTER the record is published and BEFORE the first collection starts', async () => {
  const dir = tmp('run-ready');
  const order = [];
  const h = await daemon.runDaemon({
    dir, host: '127.0.0.1', port: 0, intervalSeconds: 30,
    onReady: (info) => { order.push(`ready:${records.readRecord(dir).ok ? 'record-published' : 'no-record'}:${info.port > 0}`); },
    collect: async () => { order.push('collect'); return { ok: true, envelope: envelope('completed') }; },
  });
  assert.ok(h.ok);
  try {
    await sleep(50);
    assert.deepStrictEqual(order, ['ready:record-published:true', 'collect']);
  } finally { await h.shutdown('test'); }
});

// ---- option validation -------------------------------------------------------

console.log('options');

test('bind validation: loopback only; ports and intervals are validated', () => {
  assert.strictEqual(daemon.validateBind({ host: 'localhost', port: 0 }).host, '127.0.0.1');
  assert.strictEqual(daemon.validateBind({ host: '::1' }).host, '::1');
  for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.com', '', undefined === 1]) {
    if (host === undefined) continue;
    const r = daemon.validateBind({ host });
    assert.strictEqual(r.ok, false, String(host));
  }
  assert.match(daemon.validateBind({ host: '0.0.0.0' }).error, /loopback/);
  for (const port of [-1, 65536, 1.5, NaN, '80']) assert.strictEqual(daemon.validateBind({ port }).ok, false, String(port));
  for (const bad of [0, 14, 3601, 30.5, NaN, '30', null]) assert.strictEqual(daemon.validateInterval(bad).ok, false, String(bad));
  assert.strictEqual(daemon.validateInterval(15).ok, true);
  assert.strictEqual(daemon.validateInterval(3600).ok, true);
});

test('interval resolution: flag > config > default 30; an invalid config value refuses, never defaults', () => {
  assert.deepStrictEqual(resolveDashboardInterval({}, undefined), { ok: true, seconds: 30, source: 'default' });
  assert.strictEqual(DASHBOARD_INTERVAL.default, 30);
  assert.deepStrictEqual(resolveDashboardInterval({ dashboard: { intervalSeconds: 60 } }, undefined), { ok: true, seconds: 60, source: 'config' });
  assert.deepStrictEqual(resolveDashboardInterval({ dashboard: { intervalSeconds: 60 } }, 20), { ok: true, seconds: 20, source: 'flag' });
  assert.deepStrictEqual(resolveDashboardInterval({ dashboard: { intervalSeconds: 'x' } }, 20).source, 'flag');
  for (const bad of [5, 3601, 30.5, '30', null, 0, -3]) {
    const r = resolveDashboardInterval({ dashboard: { intervalSeconds: bad } }, undefined);
    assert.strictEqual(r.ok, false, String(bad));
    assert.match(r.error, /dashboard\.intervalSeconds/);
  }
  assert.strictEqual(resolveDashboardInterval({ dashboard: 'x' }, undefined).ok, false);
  assert.strictEqual(resolveDashboardInterval({ dashboard: [] }, undefined).ok, false);
  assert.strictEqual(resolveDashboardInterval({}, 14).ok, false);
});

(async () => {
  for (const { name, fn } of cases) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
  }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall dashboard-lib tests passed');
  process.exit(0);
})();
