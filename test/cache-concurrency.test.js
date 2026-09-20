'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork, spawn } = require('child_process');
const { once } = require('events');
const cache = require('../lib/cache');
const cases = [];
const test = (name, run) => cases.push({ name, run });
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-cache-suite-'));
const originalData = process.env.CLAUDE_PLUGIN_DATA;
const children = new Set();
function scratch() {
  const dir = fs.mkdtempSync(path.join(base, 'case-'));
  process.env.CLAUDE_PLUGIN_DATA = dir;
  return dir;
}
function waitMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`timeout waiting for ${type}`)), 8000);
    function finish(error, value) {
      clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', errorEvent);
      error ? reject(error) : resolve(value);
    }
    function message(value) { if (value.type === type) finish(null, value); }
    function exit(code) { finish(new Error(`child exited ${code} before ${type}`)); }
    function errorEvent(error) { finish(error); }
    child.on('message', message); child.on('exit', exit); child.on('error', errorEvent);
  });
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; children.delete(child);
}
async function contenders(dir, count) {
  const group = [];
  try {
    for (let i = 0; i < count; i++) {
      const child = fork(path.join(__dirname, 'fixtures/refresh-worker-barrier.js'), [], {
        env: { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: dir }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      children.add(child); group.push(child);
      await waitMessage(child, 'ready');
    }
    const results = group.map(c => waitMessage(c, 'result'));
    group.forEach(c => c.send('go'));
    const values = await Promise.all(results);
    assert.strictEqual(values.filter(v => v.handle.acquired).length, 1, JSON.stringify(values));
    assert.deepStrictEqual(Object.keys(cache.readCache().routes), ['winner']);
    return values;
  } finally { await Promise.all(group.map(stop)); }
}
function inject(object, method, replacement, run) {
  const original = object[method]; object[method] = replacement(original);
  try { return run(); } finally { object[method] = original; }
}

test('write and rename failures preserve old cache and clean only own temp', () => {
  const dir = scratch(); cache.writeCache({ old: {} });
  const before = fs.readFileSync(cache.cachePath(), 'utf8');
  const other = path.join(dir, 'status.json.tmp.other'); fs.writeFileSync(other, 'keep');
  for (const method of ['writeFileSync', 'renameSync']) {
    inject(fs, method, original => (...args) => {
      if (String(args[0]).includes('status.json.tmp.')) {
        if (method === 'writeFileSync') original(args[0], 'partial');
        throw Object.assign(new Error('injected I/O failure'), { code: 'EIO' });
      }
      return original(...args);
    }, () => assert.throws(() => cache.writeCache({ newer: {} }), /injected/));
    assert.strictEqual(fs.readFileSync(cache.cachePath(), 'utf8'), before);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['status.json', 'status.json.tmp.other']);
  }
});

test('malformed envelopes and read failures return unknown; scheduling failures do not throw', () => {
  scratch();
  for (const raw of ['null', '[]', '3', '{"routes":null}', '{"routes":[]}', '{']) {
    fs.writeFileSync(cache.cachePath(), raw);
    assert.deepStrictEqual(cache.readCache(), { updatedAt: null, routes: {} });
  }
  inject(fs, 'readFileSync', () => () => { throw new Error('EACCES'); }, () => assert.deepStrictEqual(cache.readCache().routes, {}));
  inject(fs, 'mkdirSync', () => () => { throw new Error('EACCES'); }, () => assert.strictEqual(cache.tryScheduleRefresh(Date.now(), 60), false));
});

test('scheduling throttle is separate from actual ownership', async () => {
  scratch(); const now = Date.now();
  assert.strictEqual(cache.tryScheduleRefresh(now, 60), true);
  assert.strictEqual(cache.tryScheduleRefresh(now, 60), false);
  const handle = await cache.acquireWorker({ ownerToken: 'scheduled-child' });
  assert.strictEqual(handle.acquired, true);
  assert.strictEqual(cache.releaseWorker(handle), true);
});

test('invalid route containers are omitted without losing valid siblings', () => {
  scratch();
  const valid = { routeId: 'good', freshUntil: '2030-01-01T00:00:00Z', status: { state: 'healthy' } };
  const doc = { updatedAt: '2026-09-20T00:00:00Z', routes: {
    good: valid, nullEntry: null, arrayEntry: [], stringEntry: 'bad', numberEntry: 3, boolEntry: true,
  } };
  fs.writeFileSync(cache.cachePath(), JSON.stringify(doc));
  assert.deepStrictEqual(cache.readCache(), { updatedAt: doc.updatedAt, routes: { good: valid } });
});

test('live owner excludes competitors regardless of elapsed throttle; old release cannot clear successor', async () => {
  scratch(); const first = await cache.acquireWorker({ ownerToken: 'first' });
  assert.strictEqual(first.acquired, true);
  assert.strictEqual((await cache.acquireWorker({ ownerToken: 'second' })).acquired, false);
  assert.strictEqual(cache.releaseWorker(first), true);
  const second = await cache.acquireWorker({ ownerToken: 'second' });
  assert.strictEqual(second.acquired, true);
  assert.strictEqual(cache.releaseWorker(first), false);
  assert.ok(fs.existsSync(path.join(second.dir, second.id)));
  cache.releaseWorker(second);
});

test('unknown PID liveness errors never displace a peer', async () => {
  scratch(); const first = await cache.acquireWorker({ ownerToken: 'first' });
  const original = process.kill;
  try {
    for (const code of ['EPERM', 'EACCES', 'EIO']) {
      process.kill = () => { throw Object.assign(new Error(code), { code }); };
      assert.strictEqual((await cache.acquireWorker({ ownerToken: code })).acquired, false);
      assert.ok(fs.existsSync(path.join(first.dir, first.id)));
    }
  } finally { process.kill = original; cache.releaseWorker(first); }
});

test('partial live claim blocks conservatively and I/O failures are visible', async () => {
  const dir = scratch(); const owners = path.join(dir, 'refresh-workers'); fs.mkdirSync(owners);
  const file = path.join(owners, `${process.pid}-${'a'.repeat(32)}.json`); fs.writeFileSync(file, '{');
  assert.strictEqual((await cache.acquireWorker({ ownerToken: 'blocked' })).acquired, false);
  assert.ok(fs.existsSync(file)); fs.unlinkSync(file);
  const original = fs.mkdirSync; fs.mkdirSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  try { assert.strictEqual((await cache.acquireWorker({ ownerToken: 'error' })).error, 'EACCES'); }
  finally { fs.mkdirSync = original; }
});

test('barrier contenders elect one writer; killed owner recovers without deleting successor', async () => {
  const dir = scratch();
  await contenders(dir, 4); // winner is killed, leaving abandoned ownership
  await contenders(dir, 4); // concurrent recovery of that exact dead record
  await contenders(dir, 4);
});

test('concurrent atomic publishers expose complete old/new documents', async () => {
  const dir = scratch(); cache.writeCache({ old: {} });
  const writers = [0, 1].map(index => {
    const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/concurrent-writer.js')], {
      env: { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: dir, VL_WRITER_INDEX: String(index), VL_WRITER_COUNT: '40' },
      stdio: 'ignore',
    }); children.add(child); return child;
  });
  let finished = 0, observations = 0;
  const exits = writers.map(c => once(c, 'exit').then(([code]) => { finished++; assert.strictEqual(code, 0); }));
  const deadline = Date.now() + 8000;
  try {
    while (finished < writers.length) {
      assert.ok(Date.now() < deadline, 'writers must finish');
      const doc = JSON.parse(fs.readFileSync(cache.cachePath(), 'utf8'));
      assert.strictEqual(Object.keys(doc.routes).length, 1); observations++;
      await new Promise(setImmediate);
    }
    await Promise.all(exits); assert.ok(observations > 1);
    assert.deepStrictEqual(fs.readdirSync(dir), ['status.json']);
  } finally { await Promise.all(writers.map(stop)); }
});

(async () => {
  let failures = 0;
  try {
    for (const { name, run } of cases) {
      try { await run(); console.log(`  ✓ ${name}`); }
      catch (error) { failures++; console.error(`  ✗ ${name}\n${error.stack}`); }
      finally { await Promise.all([...children].map(stop)); }
    }
  } finally {
    if (originalData === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = originalData;
    fs.rmSync(base, { recursive: true, force: true });
  }
  process.exitCode = failures ? 1 : 0;
})();
