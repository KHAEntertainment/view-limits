'use strict';
// Issue #61 — real-CLI dashboard daemon tests. Every scenario starts REAL
// daemons (`node bin/vl.js dashboard start`) against a scratch
// CLAUDE_PLUGIN_DATA, with the shared collector running against a fake vault
// and fake provider (test/fixtures/dashboard-preload.cjs). No live provider
// call, no real credential, no browser. The preload reaches the daemon and the
// `vl.js view` child it spawns for every collection.
//
// Every daemon a test starts is stopped (or killed) in `cleanup`, and the file
// ends by asserting none of the daemons it recorded is still alive.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const daemonLib = require('../lib/dashboard/daemon');
const {
  CLI, PRELOAD, GUARD, records, dirs, sleep, FAKE_TOKEN, ROUTE, scratch, vl, record, raw, apiStatus, providerCalls,
  until, events, alive, liveStranger, deadPid, forgeTicket, tickets, started, note, cleanup, LOCK_DIR,
} = require('./helpers/dashboard-harness');

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// ---- lifecycle ---------------------------------------------------------------

console.log('lifecycle');

test('start returns after ready with the URL, holds none of its stdio, and status/stop work', async () => {
  const dir = scratch();
  const t0 = Date.now();
  const start = await vl(dir, ['dashboard', 'start']); // resolves on 'close': every inherited pipe has ended
  assert.strictEqual(start.status, 0, start.stderr);
  assert.ok(Date.now() - t0 < 20_000);
  const rec = record(dir);
  note(dir);
  assert.match(start.stdout, new RegExp(`started at http://127\\.0\\.0\\.1:${rec.port}/ \\(pid ${rec.pid}`));
  assert.strictEqual(rec.host, '127.0.0.1');
  assert.ok(rec.port > 0, 'port 0 was replaced by the bound port');
  assert.strictEqual(fs.statSync(records.recordPath(dir)).mode & 0o777, 0o600);
  const st = await vl(dir, ['dashboard', 'status'], { preload: false });
  assert.strictEqual(st.status, 0);
  assert.match(st.stdout, new RegExp(`running at http://127\\.0\\.0\\.1:${rec.port}/ \\(pid ${rec.pid}, up \\d+s, interval 30s\\)`));
  assert.ok(!st.stdout.includes(rec.nonce) && !st.stderr.includes(rec.nonce));
  const json = JSON.parse((await vl(dir, ['dashboard', 'status', '--json'], { preload: false })).stdout);
  assert.strictEqual(json.state, 'running');
  assert.ok(!JSON.stringify(json).includes(rec.nonce), 'status --json never carries the nonce');
  const stop = await vl(dir, ['dashboard', 'stop'], { preload: false });
  assert.strictEqual(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /stopped/);
});

test('AC1 concurrent start x2: exactly one instance; the other refuses', async () => {
  const dir = scratch();
  const [a, b] = await Promise.all([vl(dir, ['dashboard', 'start']), vl(dir, ['dashboard', 'start'])]);
  note(dir);
  const results = [a, b];
  const ok = results.filter((r) => r.status === 0);
  const refused = results.filter((r) => r.status === 1);
  assert.strictEqual(ok.length, 1, JSON.stringify(results));
  assert.strictEqual(refused.length, 1, JSON.stringify(results));
  assert.match(refused[0].stderr, /already running at http:\/\/127\.0\.0\.1:\d+\/|another start is in progress/);
  assert.strictEqual(tickets(dir).length, 1, 'one ownership ticket');
  const rec = record(dir);
  const st = JSON.parse((await vl(dir, ['dashboard', 'status', '--json'], { preload: false })).stdout);
  assert.strictEqual(st.state, 'running');
  assert.strictEqual(st.pid, rec.pid);
  // and a later start refuses the verified live instance
  const third = await vl(dir, ['dashboard', 'start']);
  assert.strictEqual(third.status, 1);
  assert.match(third.stderr, /already running at/);
  assert.strictEqual(record(dir).instanceId, rec.instanceId, 'the running instance was not replaced');
});

test('AC2 occupied --port: a clean error and NO record published', async () => {
  const dir = scratch();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  try {
    const res = await vl(dir, ['dashboard', 'start', '--port', String(port)]);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, new RegExp(`could not listen on 127\\.0\\.0\\.1:${port} \\(EADDRINUSE\\)`));
    assert.ok(!fs.existsSync(records.recordPath(dir)), 'no dashboard.json');
    assert.deepStrictEqual(tickets(dir), [], 'no ownership ticket left behind');
    assert.strictEqual((await vl(dir, ['dashboard', 'status'], { preload: false })).status, 3);
  } finally { await new Promise((r) => blocker.close(r)); }
  // and the data directory is usable afterwards
  const retry = await vl(dir, ['dashboard', 'start', '--port', String(port)]);
  assert.strictEqual(retry.status, 0, retry.stderr);
  note(dir);
  assert.strictEqual(record(dir).port, port, 'an explicit free port is honoured and recorded');
});

test('AC3 stale record, dead PID: reported stale, then recovered by start', async () => {
  const dir = scratch();
  const pid = await deadPid();
  const stale = records.newRecord({ host: '127.0.0.1', port: 9, pid, pidStart: FAKE_TOKEN });
  records.writeRecord(dir, stale);
  forgeTicket(dir, pid, FAKE_TOKEN);
  const st = await vl(dir, ['dashboard', 'status'], { preload: false });
  assert.strictEqual(st.status, 3);
  assert.match(st.stdout, /not running — a stale record names pid \d+/);
  const stop = await vl(dir, ['dashboard', 'stop'], { preload: false });
  assert.strictEqual(stop.status, 1);
  assert.match(stop.stderr, /no verified instance \(stale: process-not-running\); nothing was signalled/);
  const start = await vl(dir, ['dashboard', 'start']);
  assert.strictEqual(start.status, 0, start.stderr);
  note(dir);
  assert.notStrictEqual(record(dir).instanceId, stale.instanceId);
  assert.strictEqual(tickets(dir).length, 1, 'the dead ticket was reaped');
});

test('AC3 stale record whose PID is ALIVE but a different process (PID reuse): not trusted, not killed', async () => {
  const dir = scratch();
  const stranger = liveStranger();
  const stale = records.newRecord({ host: '127.0.0.1', port: 9, pid: stranger.pid, pidStart: FAKE_TOKEN });
  records.writeRecord(dir, stale);
  forgeTicket(dir, stranger.pid, FAKE_TOKEN);
  const st = await vl(dir, ['dashboard', 'status'], { preload: false });
  assert.strictEqual(st.status, 3);
  assert.match(st.stdout, /stale record/);
  assert.match(st.stdout, /pid-reused-by-another-process/);
  const stop = await vl(dir, ['dashboard', 'stop'], { preload: false });
  assert.strictEqual(stop.status, 1);
  assert.match(stop.stderr, /stale: pid-reused-by-another-process/);
  assert.ok(alive(stranger.pid), 'stop never signals a PID taken from a record');
  const start = await vl(dir, ['dashboard', 'start']);
  assert.strictEqual(start.status, 0, start.stderr);
  note(dir);
  assert.ok(alive(stranger.pid), 'start recovered the record without touching the stranger');
  assert.notStrictEqual(record(dir).pid, stranger.pid);
});

test('AC4 crash (SIGKILL) then restart: start succeeds after the liveness check', async () => {
  const dir = scratch();
  assert.strictEqual((await vl(dir, ['dashboard', 'start'])).status, 0);
  const first = record(dir);
  note(dir);
  process.kill(first.pid, 'SIGKILL'); // the test crashes the daemon it started
  await until(() => !alive(first.pid), 'the killed daemon to be gone');
  assert.ok(fs.existsSync(records.recordPath(dir)), 'a crash leaves its record behind');
  assert.strictEqual(tickets(dir).length, 1, '…and its ticket');
  const st = await vl(dir, ['dashboard', 'status'], { preload: false });
  assert.strictEqual(st.status, 3);
  assert.match(st.stdout, /stale record/);
  const restart = await vl(dir, ['dashboard', 'start']);
  assert.strictEqual(restart.status, 0, restart.stderr);
  const second = record(dir);
  note(dir);
  assert.notStrictEqual(second.instanceId, first.instanceId);
  assert.notStrictEqual(second.pid, first.pid);
  assert.strictEqual((await vl(dir, ['dashboard', 'status'], { preload: false })).status, 0);
  assert.strictEqual(tickets(dir).length, 1);
});

test('AC5 stop: wrong or missing nonce refused; the correct one shuts down cleanly and removes the record', async () => {
  const dir = scratch();
  assert.strictEqual((await vl(dir, ['dashboard', 'start'])).status, 0);
  const rec = record(dir);
  note(dir);
  const missing = await raw(rec.port, { method: 'POST', pathname: '/api/stop', body: '' });
  const wrong = await raw(rec.port, { method: 'POST', pathname: '/api/stop', headers: { 'X-VL-Nonce': 'a'.repeat(64) }, body: '' });
  assert.deepStrictEqual([missing.status, wrong.status], [401, 401]);
  assert.ok(alive(rec.pid), 'a refused stop leaves the daemon running');

  // The CLI refuses when the record's nonce does not match the instance's.
  const tampered = { ...rec, nonce: 'c'.repeat(64) };
  records.writeRecord(dir, tampered);
  const refused = await vl(dir, ['dashboard', 'stop'], { preload: false });
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /refused \(stop-refused 401\)/);
  assert.ok(alive(rec.pid));
  records.writeRecord(dir, rec);

  const stop = await vl(dir, ['dashboard', 'stop'], { preload: false });
  assert.strictEqual(stop.status, 0, stop.stderr);
  await until(() => !alive(rec.pid), 'the daemon process to exit');
  assert.ok(!fs.existsSync(records.recordPath(dir)), 'the record is removed');
  assert.deepStrictEqual(tickets(dir), [], 'the ownership lock is released');
  assert.strictEqual((await vl(dir, ['dashboard', 'status'], { preload: false })).stdout.trim(), 'dashboard: not running');
});

// ---- refresh model -----------------------------------------------------------

console.log('refresh model');

test('AC7 /api/status: first poll is a pending envelope; N polls cause zero extra provider calls', async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'provider-mode'), 'slow:2500');
  assert.strictEqual((await vl(dir, ['dashboard', 'start'])).status, 0);
  note(dir);
  const rec = record(dir);
  const first = (await raw(rec.port, { pathname: '/api/status' })).json;
  assert.strictEqual(first.status, 'pending', 'before the first result the status is pending');
  assert.strictEqual(first.view, null);
  assert.strictEqual(first.collection.lastAttempt, null);
  assert.strictEqual(first.collection.observationAgeSeconds, null);
  for (let i = 0; i < 40; i += 1) assert.strictEqual((await raw(rec.port, { pathname: '/api/status' })).status, 200);
  const populated = await until(async () => { const s = await apiStatus(dir); return s.status === 'ok' ? s : null; }, 'the first collection to publish');
  assert.strictEqual(populated.view.schemaVersion, 1);
  assert.ok(populated.view.routes.some((r) => r.id === 'kimi-code-plan'));
  assert.strictEqual(populated.collection.lastAttempt.outcome, 'completed');
  assert.strictEqual(populated.collection.state, 'idle');
  const settled = providerCalls(dir);
  assert.strictEqual(settled, 1, 'startup made exactly one collection, one provider call');
  for (let i = 0; i < 60; i += 1) await raw(rec.port, { pathname: '/api/status' });
  await sleep(300);
  assert.strictEqual(providerCalls(dir), settled, 'sixty more polls made zero provider calls');
});

test('a local refresh request coalesces through the shared ownership: duplicate clicks run one collection', async () => {
  const dir = scratch();
  assert.strictEqual((await vl(dir, ['dashboard', 'start'])).status, 0);
  note(dir);
  const rec = record(dir);
  await until(async () => (await apiStatus(dir)).status === 'ok', 'startup collection');
  const before = providerCalls(dir);
  fs.writeFileSync(path.join(dir, 'provider-mode'), 'slow:1200');
  const auth = { 'X-VL-Nonce': rec.nonce };
  const clicks = await Promise.all([1, 2, 3, 4, 5].map(() => raw(rec.port, { method: 'POST', pathname: '/api/refresh', headers: auth, body: '' })));
  for (const c of clicks) assert.strictEqual(c.status, 202);
  assert.ok(clicks.filter((c) => c.json.coalesced).length >= 4, 'all but the first click joined the run in flight');
  await until(async () => (await apiStatus(dir)).collection.state === 'idle' && providerCalls(dir) > before, 'the refresh to finish');
  assert.strictEqual(providerCalls(dir), before + 1, 'five clicks, one collection');
  const bad = await raw(rec.port, { method: 'POST', pathname: '/api/refresh', body: '' });
  assert.strictEqual(bad.status, 401, 'a refresh without the nonce is refused');
  assert.strictEqual(providerCalls(dir), before + 1);
});

test('AC8 provider failure: truthful age and diagnostics, the last good view is kept, age is not renewed', async () => {
  const dir = scratch();
  assert.strictEqual((await vl(dir, ['dashboard', 'start'])).status, 0);
  note(dir);
  const rec = record(dir);
  const good = await until(async () => { const s = await apiStatus(dir); return s.status === 'ok' ? s : null; }, 'startup collection');
  const goodRow = good.view.routes.find((r) => r.id === 'kimi-code-plan');
  fs.writeFileSync(path.join(dir, 'provider-mode'), 'fail');
  await sleep(1100);
  assert.strictEqual((await raw(rec.port, { method: 'POST', pathname: '/api/refresh', headers: { 'X-VL-Nonce': rec.nonce }, body: '' })).status, 202);
  const failed = await until(async () => {
    const s = await apiStatus(dir);
    return s.collection.attempts >= 2 && s.collection.state === 'idle' ? s : null;
  }, 'the failing collection to settle');
  assert.strictEqual(failed.status, 'stale');
  assert.strictEqual(failed.collection.stale, true);
  assert.notStrictEqual(failed.collection.lastAttempt.outcome, 'completed');
  assert.strictEqual(failed.collection.lastGoodAt, good.collection.lastGoodAt, 'the failure did not renew the observation');
  assert.ok(failed.collection.observationAgeSeconds >= 1, `age keeps growing, got ${failed.collection.observationAgeSeconds}`);
  const failure = failed.view.collection.routes.find((r) => r.id === 'kimi-code-plan');
  assert.strictEqual(failure.outcome, 'failed');
  assert.match(failure.error, /upstream unavailable/);
  const row = failed.view.routes.find((r) => r.id === 'kimi-code-plan');
  assert.deepStrictEqual(row.state, goodRow.state, 'the prior observation is still what the route shows');
  // it recovers on the next good collection
  fs.writeFileSync(path.join(dir, 'provider-mode'), 'healthy');
  await raw(rec.port, { method: 'POST', pathname: '/api/refresh', headers: { 'X-VL-Nonce': rec.nonce }, body: '' });
  const healed = await until(async () => { const s = await apiStatus(dir); return s.status === 'ok' && s.collection.attempts >= 3 ? s : null; }, 'recovery');
  assert.strictEqual(healed.collection.stale, false);
});

test('the daemon closes its ready channel right after answering, before any collection can hold it (EOF while the first collection still runs)', async () => {
  // Root cause of a start that blocked on the first collection: fd 3 inherited by
  // the `view` child, so the channel reached EOF only when the collection ended.
  // Spawn the daemon exactly as `start` does and watch fd 3 itself. (On macOS
  // libuv spawns with POSIX_SPAWN_CLOEXEC_DEFAULT, so a leak cannot show here;
  // on Linux a child forked while fd 3 is open inherits it. The ordering that
  // prevents it — answer, close, THEN collect — is pinned platform-independently
  // by dashboard-lib "runDaemon answers onReady … BEFORE the first collection".)
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'provider-mode'), 'slow:9000');
  const child = spawn(process.execPath, [CLI, 'dashboard', '__daemon', '--host', '127.0.0.1', '--port', '0', '--interval', '30'], {
    cwd: dir,
    detached: true,
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, NODE_OPTIONS: `--require=${PRELOAD}` },
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  child.unref();
  let text = '';
  const t0 = Date.now();
  const eof = new Promise((resolve) => { child.stdio[3].on('data', (c) => { text += c; }); child.stdio[3].on('end', resolve); });
  const outcome = await Promise.race([eof.then(() => 'eof'), sleep(4000).then(() => 'still-open')]);
  note(dir);
  assert.strictEqual(outcome, 'eof', 'fd 3 is held open past the ready line: something the daemon spawned inherited it');
  assert.ok(Date.now() - t0 < 4000);
  assert.strictEqual(JSON.parse(text.split('\n')[0]).ok, true);
  // the 9 s collection is still running: EOF did not wait for it
  const status = await apiStatus(dir);
  assert.strictEqual(status.collection.state, 'collecting');
  assert.strictEqual(status.status, 'pending');
});

test('start returns promptly even when the first collection outlasts the ready timeout', async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'provider-mode'), 'slow:9000');
  const t0 = Date.now();
  const res = await daemonLib.startDaemon({
    dir,
    daemonArgs: [CLI, 'dashboard', '__daemon', '--host', '127.0.0.1', '--port', '0', '--interval', '30'],
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, NODE_OPTIONS: `--require=${PRELOAD}` },
    readyTimeoutMs: 3000,
  });
  note(dir);
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.ok(Date.now() - t0 < 3000, `start took ${Date.now() - t0}ms; it waited on the collection`);
  assert.strictEqual((await apiStatus(dir)).collection.state, 'collecting');
});

// ---- gate warmth -------------------------------------------------------------

console.log('gate warmth');

test('AC9 the gate reads the daemon-written status.json network-free (guard preload fails on any socket)', async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'provider-mode'), 'exhausted');
  assert.strictEqual((await vl(dir, ['dashboard', 'start'])).status, 0);
  note(dir);
  await until(async () => (await apiStatus(dir)).status === 'ok', 'the daemon to publish');
  const cache = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.strictEqual(cache.routes['kimi-code-plan'].status.state, 'exhausted', 'the daemon wrote status.json');
  assert.ok(Date.parse(cache.routes['kimi-code-plan'].freshUntil) > Date.now(), 'and it is fresh');

  const log = path.join(dir, 'trace.log');
  const gate = spawnSync(process.execPath, [CLI, 'gate'], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }),
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, NODE_OPTIONS: `--require=${GUARD}`, REVIEW_LOG: log },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.strictEqual(gate.status, 0, gate.stderr);
  const out = JSON.parse(gate.stdout);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', 'the fresh daemon-written exhaustion is what the gate decided on');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /kimi-code-plan/);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  assert.deepStrictEqual(calls.filter((c) => /fetch|http|net\.|tls/.test(c.kind)), [], 'no network attempt in the gate path');
  assert.deepStrictEqual(calls.filter((c) => /spawn|exec/.test(c.kind)), [], 'a fresh daemon-warmed cache schedules no refresh');

  // The gate never needs the daemon: stop it, and the same cache still decides.
  assert.strictEqual((await vl(dir, ['dashboard', 'stop'], { preload: false })).status, 0);
  const after = spawnSync(process.execPath, [CLI, 'gate'], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }),
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, NODE_OPTIONS: `--require=${GUARD}` },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.strictEqual(JSON.parse(after.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

// ---- refusals ----------------------------------------------------------------

console.log('refusals (nothing is started)');

test('config that cannot be proven refuses loudly: absent/inconclusive → 9, corrupt → 10, invalid interval → 1', async () => {
  const absent = scratch(null);
  const a = await vl(absent, ['dashboard', 'start']);
  assert.strictEqual(a.status, 9, a.stderr);
  const corrupt = scratch();
  fs.writeFileSync(path.join(corrupt, 'config.json'), '{ not json');
  const c = await vl(corrupt, ['dashboard', 'start']);
  assert.strictEqual(c.status, 10, c.stderr);
  const bad = scratch({ routes: [ROUTE], dashboard: { intervalSeconds: 5 } });
  const b = await vl(bad, ['dashboard', 'start']);
  assert.strictEqual(b.status, 1);
  assert.match(b.stderr, /dashboard\.intervalSeconds.*15 to 3600; got 5/);
  for (const dir of [absent, corrupt, bad]) {
    assert.ok(!fs.existsSync(records.recordPath(dir)) && !fs.existsSync(path.join(dir, 'dashboard.log')), 'no daemon was spawned');
  }
});

test('flags are validated: non-loopback host, bad port, bad interval, unknown option', async () => {
  const dir = scratch();
  const cases2 = [
    [['--host', '0.0.0.0'], 1, /only loopback.*#62/],
    [['--host', '192.168.1.20'], 1, /only loopback/],
    [['--port', '70000'], 1, /--port must be an integer from 0 to 65535/],
    [['--port', 'abc'], 1, /--port must be an integer/],
    [['--interval', '5'], 1, /--interval must be a whole number of seconds from 15 to 3600/],
    [['--interval', '30s'], 1, /--interval/],
    [['--interval'], 2, /--interval needs a value/],
    [['--interval', '20', '--interval', '30'], 2, /given twice/],
    [['--bogus', '1'], 2, /unknown option/],
  ];
  for (const [flags, code, pattern] of cases2) {
    const res = await vl(dir, ['dashboard', 'start', ...flags]);
    assert.strictEqual(res.status, code, `${flags.join(' ')} → ${res.status}: ${res.stderr}`);
    assert.match(res.stderr, pattern, flags.join(' '));
  }
  assert.ok(!fs.existsSync(records.recordPath(dir)), 'nothing was started');
  assert.strictEqual((await vl(dir, ['dashboard'], { preload: false })).status, 2);
  assert.strictEqual((await vl(dir, ['dashboard', 'frobnicate'], { preload: false })).status, 2);
  assert.strictEqual((await vl(dir, ['dashboard', 'stop', '--force'], { preload: false })).status, 2);
});

(async () => {
  try {
    for (const { name, fn } of cases) {
      try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
    }
  } finally {
    await cleanup();
  }
  for (const pid of started) {
    if (alive(pid)) { failures += 1; console.log(`  ✗ daemon ${pid} survived cleanup`); }
  }
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall dashboard-cli tests passed');
  process.exit(0);
})();
