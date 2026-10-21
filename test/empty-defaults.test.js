'use strict';
// Issue #81: config.json is ASSEMBLED by setup and PRUNED by remove. A fresh
// install shows no provider rows; the five shipped built-ins are offered for
// setup but not present until added; and an install that predates this — no
// config.json, credentials stored — is migrated once to rows for exactly those
// providers.
//
// This shipped once on PR #79 and was reverted after review found three P1s.
// Each has a section here that fails if its fix is reverted:
//
//   P1-1  the migration erased a concurrent `provider add`
//           -> "migration under the ownership boundary" (real lock, real fs)
//   P1-2  a transiently unreadable vault migrated routes away for good
//           -> "unreadable is never absent" (unit) and the real-file-vault
//              CLI case, where secrets/ really is unreadable
//   P1-3  /view-limits:setup handed the user a dead form on an empty config
//           -> "the setup form on a fresh install" (real form server, real
//              parent, the real POST)
//
// Real-CLI cases load test/fixtures/migration-preload.cjs, which forces the
// DEFAULT vault backend to the real file vault so a test never reads the
// developer's Keychain, journals any network attempt, and records instead of
// performing a browser launch. Nothing about the vault itself is stubbed.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const config = require('../lib/config');
// Same default the preload forces in the CLI: the real file vault, so the
// in-process premise checks below read the backend the CLI will use.
config.DEFAULTS.vault.backend = 'file';
const { DEFAULTS, BUILT_IN_ROUTES, builtInRoute, loadConfig, saveConfig, configPath } = config;
const vault = require('../lib/vault');
const lifecycle = require('../lib/provider-lifecycle');
const lockModule = require('../lib/lock');
const { getRuntimeSnapshot } = require('../lib/runtime-snapshot');

const cli = path.resolve(__dirname, '../bin/vl.js');
const preload = path.join(__dirname, 'fixtures/migration-preload.cjs');
const MASTER = 'vl-81-empty-defaults-master';
const KEY_A = 'sk-kimi-TEST-81-aaaa1111';
const KEY_B = 'sk-glm-TEST-81-bbbb2222';
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

// ---- harness -------------------------------------------------------------------

let failures = 0;
let queue = Promise.resolve();
function test(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures += 1;
      console.log(`  ✗ ${name}\n    ${(e && e.message) || e}`);
    }
  });
}
function section(name) { queue = queue.then(() => console.log(`\n${name}`)); }

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-'));
}

// Journals live OUTSIDE the data dir, so a zero-write assertion on the data
// dir is never disturbed by the test's own bookkeeping.
function journals() {
  const side = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-journal-'));
  return {
    net: path.join(side, 'net'),
    browser: path.join(side, 'browser'),
    read(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } },
  };
}

function envFor(dir, j, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    CLAUDE_PLUGIN_DATA: dir,
    VIEW_LIMITS_MASTER_KEY: MASTER,
    NODE_OPTIONS: `--require=${preload}`,
    VL_NET_JOURNAL: j.net,
    VL_BROWSER_JOURNAL: j.browser,
    ...extra,
  };
}

function run(dir, args, j = journals(), extra = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: envFor(dir, j, extra), encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not every command prints JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, j };
}

// Run fn with this data dir and master key, so the REAL lib/vault and
// lib/config resolve exactly what the CLI would.
function inDataDir(dir, fn) {
  const prev = { data: process.env.CLAUDE_PLUGIN_DATA, key: process.env.VIEW_LIMITS_MASTER_KEY };
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = MASTER;
  try { return fn(); } finally {
    if (prev.data === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev.data;
    if (prev.key === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prev.key;
  }
}

// A stored credential and NO config.json: an install from before empty
// defaults. Written by the real vault, exactly as setup would have.
function upgradeWith(...ids) {
  const dir = scratch();
  inDataDir(dir, () => { for (const id of ids) vault.set(id, `sk-${id}-TEST-81`); });
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'premise: no config.json');
  return dir;
}

// A config.json that exists — so nothing migrates — with the file vault.
function seeded(routes = []) {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes, vault: { backend: 'file' }, gate: { mode: 'off' },
  }, null, 1));
  return dir;
}

function routeIds(dir) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  return (Array.isArray(doc.routes) ? doc.routes : []).map((r) => r && r.id);
}

// Every path under dir, with each file's content hash, so an in-place rewrite
// is caught as well as a created or deleted file.
function tree(dir) {
  const out = [];
  (function walk(rel) {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = path.join(rel, name);
      const st = fs.statSync(path.join(dir, r));
      if (st.isDirectory()) { out.push(`${r}/`); walk(r); }
      else out.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex')}`);
    }
  }(''));
  return out;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function request(port, method, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/', headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.once('error', (e) => resolve({ status: 0, error: e.code }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitListening(port, exited, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let gone = false;
  exited.then(() => { gone = true; });
  while (Date.now() < deadline) {
    if (gone) return false;
    const r = await request(port, 'GET');
    if (r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

// ---- the migration as a unit -------------------------------------------------

// io for migrateFromVault, recording every call. `presence` is the sequence
// configPresence() returns: the first answer is the pre-check outside the lock,
// the second is the re-check inside it.
function fakeIo({ presence = ['absent'], states = {}, lockOk = true, saveThrows = false } = {}) {
  const calls = { presence: 0, probes: [], saves: [], locks: 0, releases: 0 };
  return {
    calls,
    configPresence: () => {
      const v = presence[Math.min(calls.presence, presence.length - 1)];
      calls.presence += 1;
      if (v instanceof Error) throw v;
      return v;
    },
    lock: () => {
      calls.locks += 1;
      return lockOk ? { ok: true, release: () => { calls.releases += 1; return true; } } : { ok: false, error: 'held' };
    },
    vault: {
      probe: (id) => {
        calls.probes.push(id);
        if (!Object.prototype.hasOwnProperty.call(states, id)) return 'absent';
        const v = states[id];
        if (v instanceof Error) throw v;
        return v;
      },
    },
    saveConfig: (doc) => {
      if (saveThrows) throw new Error('ENOSPC: no space left on device');
      calls.saves.push(JSON.parse(JSON.stringify(doc)));
    },
  };
}

section('empty defaults');

test('DEFAULTS ships no routes, and the catalog holds the five built-ins', () => {
  assert.deepStrictEqual(DEFAULTS.routes, [], 'a fresh install must show no provider rows');
  assert.deepStrictEqual(BUILT_IN_ROUTES.map((r) => r.id), [
    'minimax-token-plan', 'kimi-code-plan', 'glm-coding-plan', 'deepseek-direct', 'openrouter-main',
  ], 'the offered built-ins are part of the contract');
  assert.ok(Object.isFrozen(BUILT_IN_ROUTES), 'the catalog must be frozen');
});

test('the catalog is frozen all the way down: no row and no match is mutable through the export', () => {
  // Object.isFrozen(BUILT_IN_ROUTES) alone passed while every row was mutable,
  // and builtInRoute() copies from those rows into setup and the migration.
  for (const row of BUILT_IN_ROUTES) {
    assert.ok(Object.isFrozen(row), `catalog row ${row.id} is mutable`);
    assert.ok(Object.isFrozen(row.match), `catalog row ${row.id}'s match is mutable`);
  }
  const kimi = BUILT_IN_ROUTES.find((r) => r.id === 'kimi-code-plan');
  assert.throws(() => { 'use strict'; kimi.match.model = 'changed-through-export'; }, TypeError,
    'a strict-mode write through the export must throw');
  assert.throws(() => { 'use strict'; kimi.provider = 'changed-through-export'; }, TypeError);
  assert.strictEqual(builtInRoute('kimi-code-plan').match.model, 'kimi',
    'a mutation through the export reached the copies setup writes');
  // Copies stay the caller's own, so freezing the source costs callers nothing.
  const copy = builtInRoute('kimi-code-plan');
  copy.match.model = 'mine';
  assert.strictEqual(builtInRoute('kimi-code-plan').match.model, 'kimi');
});

section('the write-level guard: only the migration may create config.json');

// The invariant itself, not the dispatcher wiring: an absent config.json means
// the migration has not resolved, so ANY publish that would create the file is
// refused — whatever command, list or caller it came from — and every publish
// runs under the provider mutation lock.

// Run fn with this data dir AND the real mutation lock held, as every in-protocol
// publisher does.
function underLock(dir, fn) {
  return inDataDir(dir, () => {
    const lock = lifecycle.acquireMutationLock(dir);
    assert.ok(lock.ok, 'premise: the test holds the mutation lock');
    try { return fn(); } finally { lock.release(); }
  });
}
const PREV = (dir) => path.join(dir, 'config.json.prev');
const docAt = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('saveConfig refuses to CREATE config.json without the migration capability', () => {
  const dir = scratch();
  underLock(dir, () => {
    assert.throws(() => saveConfig({ routes: [] }), (e) => e.code === 'CONFIG_MIGRATION_PENDING');
    assert.throws(() => saveConfig({ routes: [] }, { capability: { capability: 'view-limits first config publish' } }),
      (e) => e.code === 'CONFIG_MIGRATION_PENDING', 'a look-alike capability must not pass: identity, not shape');
    assert.throws(() => saveConfig({ routes: [] }, { capability: 'view-limits first config publish' }),
      (e) => e.code === 'CONFIG_MIGRATION_PENDING', 'a string must not pass');
    assert.strictEqual(fs.existsSync(configPath()), false, 'a refused publish created config.json');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('config.json')), [],
      'a refused publish left a temp file or created anything');
    saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH });
    assert.deepStrictEqual(docAt(configPath()), { routes: [] });
    // The first publish is create-only: a second one loses, it never overwrites.
    assert.throws(() => saveConfig({ routes: ['x'] }, { capability: config.FIRST_PUBLISH }), (e) => e.code === 'EEXIST');
    assert.deepStrictEqual(docAt(configPath()), { routes: [] });
    // Once it exists, ordinary publishers replace it as before.
    saveConfig({ routes: [], gate: { mode: 'off' } });
    assert.deepStrictEqual(docAt(configPath()), { routes: [], gate: { mode: 'off' } });
  });
});

test('pin 1: no publish happens outside the provider mutation lock', () => {
  const dir = scratch();
  underLock(dir, () => saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH }));
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  inDataDir(dir, () => {
    assert.throws(() => saveConfig({ routes: [], gate: { mode: 'deny' } }), (e) => e.code === 'CONFIG_LOCK_REQUIRED');
    assert.throws(() => saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH }), (e) => e.code === 'CONFIG_LOCK_REQUIRED');
  });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, 'an unlocked publish changed config.json');
  // Released means released: holding it once does not license a later publish.
  inDataDir(dir, () => assert.throws(() => saveConfig({ routes: [] }), (e) => e.code === 'CONFIG_LOCK_REQUIRED'));
});

test('pin 2: a normal publish leaves no .prev, so a later outside delete re-arms the migration', () => {
  const dir = upgradeWith('kimi-code-plan');
  underLock(dir, () => {
    saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH });
    saveConfig({ routes: [], gate: { mode: 'off' } });
  });
  assert.strictEqual(fs.existsSync(PREV(dir)), false, 'a normal publish left config.json.prev behind');
  // A stale .prev planted BESIDE config.json is a leftover, not a document:
  // the next publish removes it rather than letting it outlive config.json.
  fs.writeFileSync(PREV(dir), '{"routes":[{"id":"stale"}]}');
  underLock(dir, () => saveConfig({ routes: [], gate: { mode: 'off' } }));
  assert.strictEqual(fs.existsSync(PREV(dir)), false, 'a stale .prev survived a publish beside config.json');
  // Outside delete: nothing may keep the migration disarmed now.
  fs.unlinkSync(path.join(dir, 'config.json'));
  assert.strictEqual(inDataDir(dir, () => config.configPresence()), 'absent');
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'the migration stayed disarmed after the delete');
});

test('pin 3: a crash between move-aside and link is recovered by the next writer, never a lockout', () => {
  const dir = scratch();
  const prior = { routes: [{ id: 'custom-prior', provider: 'stepplan', monitor: { recipe: 'stepfun-plan' }, retention: 'keep-unmonitored' }],
    vault: { backend: 'file' }, gate: { mode: 'off' } };
  // Exactly what an interrupted publish leaves: config.json moved aside, the
  // new document never linked in.
  fs.writeFileSync(PREV(dir), JSON.stringify(prior));
  // Readers see the document, read-only — no transient empty config.
  assert.strictEqual(inDataDir(dir, () => config.configPresence()), 'present');
  assert.deepStrictEqual(inDataDir(dir, () => loadConfig().routes.map((r) => r.id)), ['custom-prior']);
  const list = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(list.status, 0, list.stderr);
  assert.deepStrictEqual(list.json.routes.map((r) => r.id), ['custom-prior']);
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'a read wrote config.json');
  // A normal writer proceeds from the recovered document.
  const add = run(dir, ['provider', 'add', '--label', 'after', '--provider', 'stepplan', '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
  assert.strictEqual(add.status, 0, `the crash state locked the user out: ${add.stdout}${add.stderr}`);
  assert.deepStrictEqual(routeIds(dir), ['custom-prior', 'custom-after']);
  assert.strictEqual(fs.existsSync(PREV(dir)), false, 'recovery left config.json.prev behind');
});

function deleteAt(dir, at, args) {
  const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-del-')), 'hook');
  const r = run(dir, args, journals(), { VL_TEST_DELETE_CONFIG_AT: at, VL_TEST_HOOK_JOURNAL: hook });
  const fired = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, fired };
}
const ADD_AFTER = ['provider', 'add', '--label', 'after', '--provider', 'stepplan', '--recipe', 'stepfun-plan', '--keep-unmonitored'];

test('pin 4: config.json deleted right BEFORE the move-aside — refused (exit 8), and the migration still runs', () => {
  // The R3-1 interleaving: the publisher saw config.json, an outside actor
  // deletes it, and the publisher continues. It must not create the file.
  const dir = upgradeWith('kimi-code-plan');
  run(dir, ['provider', 'list', '--json']);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ routes: [], vault: { backend: 'file' }, gate: { mode: 'off' } }));
  assert.deepStrictEqual(routeIds(dir), [], 'premise: a config.json with no rows, and a stored Kimi credential');
  const { r, fired } = deleteAt(dir, 'before-move', ADD_AFTER);
  assert.deepStrictEqual(fired, [{ at: 'before-move', removed: true }], 'premise: the outside delete happened at the boundary');
  assert.strictEqual(r.status, 8, `a non-capability writer was not refused: ${r.stdout}${r.stderr}`);
  assert.ok(`${r.stdout}${r.stderr}`.includes(REFUSAL.slice('view-limits: '.length)), 'not the same refusal message');
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'the writer CREATED config.json and disarmed the migration');
  assert.strictEqual(fs.existsSync(PREV(dir)), false);
  const next = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(next.status, 0, next.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'the migration did not run after the delete');
});

test('pin 4: config.json deleted BETWEEN move-aside and link — nothing to delete; the replace completes', () => {
  const dir = seeded([]);
  const { r, fired } = deleteAt(dir, 'before-link', [...ADD_AFTER, '--json']);
  assert.deepStrictEqual(fired, [{ at: 'before-link', removed: false }],
    'config.json was still there to delete after it had been moved aside');
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.deepStrictEqual(routeIds(dir), ['custom-after'], 'this was a replace of an existing document');
  assert.strictEqual(fs.existsSync(PREV(dir)), false);
});

test('pin 5: no hard links means fail closed — no fallback to rename-over', () => {
  const dir = scratch();
  underLock(dir, () => saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH }));
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const realLink = fs.linkSync;
  const realRename = fs.renameSync;
  const renames = [];
  fs.linkSync = (from, to) => {
    if (path.basename(String(from)).startsWith('config.json.tmp.')) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
    return realLink(from, to);
  };
  fs.renameSync = (from, to) => { renames.push([path.basename(String(from)), path.basename(String(to))]); return realRename(from, to); };
  try {
    underLock(dir, () => assert.throws(() => saveConfig({ routes: [], gate: { mode: 'deny' } }), (e) => e.code === 'CONFIG_LINK_UNSUPPORTED'));
    const fresh = scratch();
    underLock(fresh, () => assert.throws(() => saveConfig({ routes: [] }, { capability: config.FIRST_PUBLISH }),
      (e) => e.code === 'CONFIG_LINK_UNSUPPORTED'));
    assert.strictEqual(fs.existsSync(path.join(fresh, 'config.json')), false);
  } finally {
    fs.linkSync = realLink;
    fs.renameSync = realRename;
  }
  assert.ok(!renames.some(([from, to]) => from.startsWith('config.json.tmp.') && to === 'config.json'),
    `a temp file was renamed over config.json: ${JSON.stringify(renames)}`);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, 'the previous document was not restored');
  assert.strictEqual(fs.existsSync(PREV(dir)), false);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp.')), [], 'a temp file was left behind');
});

// Readers (PR #82 round 4). A reader takes no lock, and the publisher is
// usually ANOTHER process, so synchronous I/O in the reader does not exclude
// it: a whole publish can complete between two of the reader's reads. These
// run that schedule deterministically — each time the reader misses
// config.json or .prev, the next scheduled writer step runs before the
// reader's next read. A step is the real saveConfig under the real lock, or
// saveConfig's real first step (the move-aside).
async function onReaderMiss(steps, fn) {
  const realRead = fs.readFileSync;
  const misses = [];
  fs.readFileSync = function readAtBoundary(file, ...rest) {
    try {
      return realRead.call(this, file, ...rest);
    } catch (e) {
      const name = path.basename(String(file));
      if (e && e.code === 'ENOENT' && (name === 'config.json' || name === 'config.json.prev')) {
        misses.push(name);
        const step = steps.shift();
        if (step) step();
      }
      throw e;
    }
  };
  try {
    return { value: await fn(), misses };
  } finally {
    fs.readFileSync = realRead;
  }
}
const customDoc = (id) => ({
  routes: [{ id, provider: 'stepplan', monitor: { recipe: 'stepfun-plan' }, retention: 'keep-unmonitored' }],
  vault: { backend: 'file' }, gate: { mode: 'off' },
});
const OLD_DOC = customDoc('custom-old');
const NEW_DOC = customDoc('custom-new');

test('pin 6: a publish completing between the reader\'s two reads is read, never "no config" (round 4 F1)', async () => {
  const dir = scratch();
  // The writer has moved config.json aside; its link and .prev unlink are next.
  fs.writeFileSync(PREV(dir), JSON.stringify(OLD_DOC));
  // The shipped darwin default — what a fall-through to DEFAULTS would select.
  const forced = DEFAULTS.vault.backend;
  DEFAULTS.vault.backend = 'keychain';
  try {
    const { value, misses } = await onReaderMiss([() => underLock(dir, () => saveConfig(NEW_DOC))],
      () => inDataDir(dir, () => loadConfig()));
    assert.deepStrictEqual(misses, ['config.json', 'config.json.prev'],
      'premise: the reader missed config.json, the publish completed, then the reader missed .prev');
    assert.strictEqual(value.vault.backend, 'file',
      'a completed publish read as "no config": the vault backend fell back to the default');
    assert.deepStrictEqual(value.routes.map((r) => r.id), ['custom-new']);
  } finally {
    DEFAULTS.vault.backend = forced;
  }
});

test('pin 6: back-to-back publishes between reads — the reader keeps reading until it holds a document', async () => {
  // One extra read of config.json is not enough: a second publish can move it
  // aside again before that read, and then the document is .prev once more.
  const dir = scratch();
  fs.writeFileSync(PREV(dir), JSON.stringify(OLD_DOC));
  const { value, misses } = await onReaderMiss([
    () => underLock(dir, () => saveConfig(NEW_DOC)),
    () => fs.renameSync(path.join(dir, 'config.json'), PREV(dir)),
  ], () => inDataDir(dir, () => loadConfig()));
  assert.deepStrictEqual(misses, ['config.json', 'config.json.prev', 'config.json'],
    'premise: publish 1 completed between the first two reads, publish 2 moved config.json aside before the third');
  assert.deepStrictEqual(value.routes.map((r) => r.id), ['custom-new'], 'the reader gave up while a document existed');
});

test('pin 6: with no document the reader stops after a bounded number of reads, without a delay', async () => {
  // Lax: six lock-free reads, then INCONCLUSIVE — it cannot tell absent from a
  // publish it never caught. Strict: one more round under the lock, then ENOENT.
  const dir = scratch();
  const lax = await onReaderMiss([], () => {
    try { config.readConfigTextIn(dir); return null; } catch (e) { return e.code; }
  });
  assert.strictEqual(lax.value, 'CONFIG_INCONCLUSIVE', 'a lax reader claimed absence it cannot prove');
  assert.deepStrictEqual(lax.misses, ['config.json', 'config.json.prev', 'config.json', 'config.json.prev', 'config.json', 'config.json.prev']);
  const strict = await onReaderMiss([], () => {
    try { config.readConfigTextIn(dir, { strict: true }); return null; } catch (e) { return e.code; }
  });
  assert.strictEqual(strict.value, 'ENOENT', 'absence proven under the lock must surface as ENOENT');
  assert.strictEqual(strict.misses.length, 8, `six lock-free reads, then one round under the lock: ${strict.misses}`);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('config.json')), [], 'a read wrote config.json');
});

test('pin 7: the runtime snapshot reads the same logical document as loadConfig (round 4 F2)', async () => {
  const dir = scratch();
  // A lone .prev: a publish in flight, or one interrupted between its steps.
  fs.writeFileSync(PREV(dir), JSON.stringify(OLD_DOC));
  const before = fs.readdirSync(dir).sort();
  const s = await getRuntimeSnapshot({ refresh: false, dataDir: dir });
  assert.deepStrictEqual(s.routes.map((r) => r.id), ['custom-old'], 'the snapshot read a lone .prev as "no config"');
  assert.ok(!s.diagnostics.some((d) => d.code === 'config-corrupt'), JSON.stringify(s.diagnostics));
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'the snapshot wrote to the data dir');
  // And mid-publish: the publish completes between the snapshot's two reads.
  const { value, misses } = await onReaderMiss([() => underLock(dir, () => saveConfig(NEW_DOC))],
    () => getRuntimeSnapshot({ refresh: false, dataDir: dir }));
  assert.deepStrictEqual(misses, ['config.json', 'config.json.prev'], 'premise: the publish completed between the reads');
  assert.deepStrictEqual(value.routes.map((r) => r.id), ['custom-new']);
  // Corruption is still reported when the document being read is .prev.
  const bad = scratch();
  fs.writeFileSync(PREV(bad), '{not json');
  const c = await getRuntimeSnapshot({ refresh: false, dataDir: bad });
  assert.ok(c.diagnostics.some((d) => d.code === 'config-corrupt'), 'a corrupt .prev was not reported as corrupt');
});

// ---- PR #82 round 5: absence is proven under the lock -----------------------------
//
// N back-to-back publishes by other processes can exhaust any N lock-free
// rounds. The schedule below is the reviewer's: in every round writer k moves
// config.json aside (at the reader's .prev miss of the round before), then
// completes — link, unlink .prev — at the reader's config.json miss, so both
// reads of every round miss while a valid document exists at the end.
function nWriterSchedule(dir, docs) {
  const steps = [];
  docs.forEach((doc, i) => {
    steps.push(() => underLock(dir, () => saveConfig(doc)));
    if (i < docs.length - 1) steps.push(() => fs.renameSync(path.join(dir, 'config.json'), PREV(dir)));
  });
  return steps;
}
const SIX_MISSES = ['config.json', 'config.json.prev', 'config.json', 'config.json.prev', 'config.json', 'config.json.prev'];

// Counts every lock acquire made through lib/lock.js's module object, which is
// how lib/config.js takes it.
async function countingAcquires(fn) {
  const real = lockModule.acquireMutationLock;
  let count = 0;
  lockModule.acquireMutationLock = function countedAcquire(...a) { count += 1; return real.apply(this, a); };
  try {
    const value = await fn(() => count);
    return { value, count };
  } finally {
    lockModule.acquireMutationLock = real;
  }
}

test('pin 8: N writers exhaust every lock-free round — the strict read proves the document under the lock', async () => {
  const dir = scratch();
  fs.writeFileSync(PREV(dir), JSON.stringify(customDoc('custom-0')));
  const forced = DEFAULTS.vault.backend;
  DEFAULTS.vault.backend = 'keychain';
  try {
    const { value, count } = await countingAcquires(async () => {
      const r = await onReaderMiss(nWriterSchedule(dir, ['custom-1', 'custom-2', 'custom-3'].map(customDoc)),
        () => inDataDir(dir, () => config.loadConfigStrict()));
      assert.deepStrictEqual(r.misses, SIX_MISSES, 'premise: all six lock-free reads missed');
      return r.value;
    });
    assert.strictEqual(count, 1, 'the exhausted strict read must take the lock exactly once');
    assert.strictEqual(value.vault.backend, 'file', 'an exhausted strict read answered with DEFAULTS');
    assert.deepStrictEqual(value.routes.map((r) => r.id), ['custom-3']);
  } finally {
    DEFAULTS.vault.backend = forced;
  }
});

test('pin 8: the same schedule through the lax reader is DEFAULTS marked inconclusive, and reaches the display', async () => {
  const dir = scratch();
  fs.writeFileSync(PREV(dir), JSON.stringify(customDoc('custom-0')));
  const { value, count } = await countingAcquires(() => onReaderMiss(
    nWriterSchedule(dir, ['custom-1', 'custom-2', 'custom-3'].map(customDoc)), () => inDataDir(dir, () => loadConfig())));
  assert.deepStrictEqual(value.misses, SIX_MISSES, 'premise');
  assert.strictEqual(count, 0, 'the lax reader took the lock');
  assert.strictEqual(config.configInconclusive(value.value), true, 'DEFAULTS from an unconfirmed read were not marked');
  assert.deepStrictEqual(value.value.routes, []);
  // A read that confirms the document is not marked.
  assert.strictEqual(config.configInconclusive(inDataDir(dir, () => loadConfig())), false);
  // The snapshot (report / recommend render it) carries the reason code.
  fs.renameSync(path.join(dir, 'config.json'), PREV(dir));
  const snap = await onReaderMiss(nWriterSchedule(dir, ['custom-4', 'custom-5', 'custom-6'].map(customDoc)),
    () => getRuntimeSnapshot({ refresh: false, dataDir: dir }));
  assert.deepStrictEqual(snap.value.diagnostics.filter((d) => d.scope === 'routes').map((d) => d.code), ['config-inconclusive']);
  assert.match(snap.value.diagnostics.find((d) => d.code === 'config-inconclusive').summary, /being replaced while it was read/);
  // The CLI display: `report` says the configuration could not be confirmed,
  // never "no credentials configured". An unreadable vault keeps config.json
  // absent (the migration cannot run), which a lax read cannot tell apart
  // from a publish in flight.
  const pending = upgradeWith('kimi-code-plan');
  if (!IS_ROOT) {
    fs.chmodSync(path.join(pending, 'secrets'), 0o000);
    try {
      const r = run(pending, ['report']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.match(r.stdout, /config\.json could not be confirmed/, `report output: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /no credentials configured/i);
    } finally {
      fs.chmodSync(path.join(pending, 'secrets'), 0o700);
    }
  }
});

test('pin 8: the uncontended read path never takes the lock — before and after the exhaustion branch', async () => {
  const present = seeded([]);
  const lone = scratch();
  fs.writeFileSync(PREV(lone), JSON.stringify(customDoc('custom-lone')));
  inDataDir(present, () => vault.set('kimi-code-plan', KEY_A));
  const workload = async () => {
    for (const dir of [present, lone]) {
      inDataDir(dir, () => {
        loadConfig();
        config.loadConfigStrict();
        config.readConfigTextIn(dir);
        config.readConfigTextIn(dir, { strict: true });
        vault.probe('kimi-code-plan');
        vault.get('kimi-code-plan');
      });
      await getRuntimeSnapshot({ refresh: false, dataDir: dir });
    }
  };
  const { count } = await countingAcquires(async (acquires) => {
    await workload();
    assert.strictEqual(acquires(), 0, 'a read of a present or lone-.prev document took the lock');
    // The exhaustion branch takes it exactly once ...
    const churn = scratch();
    fs.writeFileSync(PREV(churn), JSON.stringify(customDoc('custom-0')));
    await onReaderMiss(nWriterSchedule(churn, ['custom-1', 'custom-2', 'custom-3'].map(customDoc)),
      () => inDataDir(churn, () => config.loadConfigStrict()));
    assert.strictEqual(acquires(), 1);
    // ... and leaves nothing behind that puts the lock on the hot path.
    await workload();
    assert.strictEqual(acquires(), 1, 'the hot path took the lock after an exhaustion');
  });
  assert.strictEqual(count, 1);
});

test('pin 8: a strict read while THIS process holds the lock proves absence without re-acquiring it', async () => {
  // The migration and every in-protocol writer read config while holding the
  // lock: no other publish can be in flight, so a miss is already proof.
  const dir = scratch();
  const { value, count } = await countingAcquires(() => underLock(dir, () => {
    try { config.readConfigTextIn(dir, { strict: true }); return null; } catch (e) { return e.code; }
  }));
  assert.strictEqual(value, 'ENOENT');
  assert.strictEqual(count, 0, 'the strict read re-acquired a lock this process already holds');
});

// A ticket planted for another process, numbered ahead of any newcomer.
function plantTicket(dir, pid) {
  const root = path.join(dir, lockModule.LOCK_DIR);
  fs.mkdirSync(root, { recursive: true });
  const name = `${pid}-${crypto.randomBytes(16).toString('hex')}.json`;
  fs.writeFileSync(path.join(root, name), JSON.stringify({ pid, owner: 'planted', number: 1 }));
  return path.join(root, name);
}

test('pin 8: the lock held by a live process — every vault operation hard-fails INCONCLUSIVE, none falls back', async () => {
  const dir = scratch();
  // process.ppid is alive and is not this process: a live foreign holder.
  plantTicket(dir, process.ppid);
  const started = Date.now();
  const read = (() => {
    try { config.readConfigTextIn(dir, { strict: true }); return null; } catch (e) { return e.code; }
  })();
  const waited = Date.now() - started;
  assert.strictEqual(read, 'CONFIG_INCONCLUSIVE', 'absence was claimed without the lock');
  assert.ok(waited >= 900 && waited < 5000, `the bounded wait was ${waited}ms`);
  inDataDir(dir, () => {
    assert.strictEqual(vault.probe('kimi-code-plan'), 'inconclusive', 'probe must not report absent');
    for (const op of [() => vault.set('kimi-code-plan', KEY_A), () => vault.get('kimi-code-plan'), () => vault.remove('kimi-code-plan')]) {
      assert.throws(op, (e) => e.code === 'CONFIG_INCONCLUSIVE', 'a vault operation chose a backend from DEFAULTS');
    }
  });
  assert.strictEqual(fs.existsSync(path.join(dir, 'secrets')), false, 'a credential was written to the default backend');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.startsWith('config.json')), []);
});

test('pin 8: a lock left by a dead process is reclaimed by the existing liveness check, and the strict read converges', async () => {
  const dir = scratch();
  const child = spawnSync(process.execPath, ['-e', '0']);
  assert.strictEqual(child.status, 0);
  const stale = plantTicket(dir, child.pid);
  const started = Date.now();
  const { value, count } = await countingAcquires(() => {
    try { config.readConfigTextIn(dir, { strict: true }); return null; } catch (e) { return e.code; }
  });
  assert.strictEqual(value, 'ENOENT', 'a dead holder left the strict read inconclusive');
  assert.strictEqual(count, 1, 'reclaimed on the first attempt, not by waiting out the timeout');
  assert.ok(Date.now() - started < 900, 'the reclaim waited out the timeout');
  assert.strictEqual(fs.existsSync(stale), false, 'the dead ticket was not reaped');
});

test('pin 8: every vault operation chooses its backend through the strict reader', () => {
  // The grep is the audit; this pins it. Each backend decision is vaultCfg(),
  // and vaultCfg is the strict read — no operation reads the lax config.
  const src = fs.readFileSync(path.join(__dirname, '../lib/vault.js'), 'utf8');
  assert.match(src, /function vaultCfg\(\) \{\n {2}return loadConfigStrict\(\)\.vault;\n\}/);
  assert.doesNotMatch(src, /\bloadConfig\(/, 'the vault reads the lax config somewhere');
  for (const op of ['set', 'get', 'probe', 'remove']) {
    const body = src.slice(src.indexOf(`function ${op}(`)).split('\n}\n')[0];
    assert.match(body, /vaultCfg\(\)/, `vault.${op} does not choose its backend through vaultCfg`);
  }
});

test('pin 8: the PreToolUse gate path never reads strictly, never takes The lock and never touches the vault', () => {
  const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-strict-')), 'journal');
  const status = (dir) => fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
    updatedAt: new Date().toISOString(),
    routes: { 'kimi-code-plan': {
      routeId: 'kimi-code-plan', observedAt: new Date(Date.now() - 60000).toISOString(),
      freshUntil: new Date(Date.now() + 300000).toISOString(), source: 'kimi',
      status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
    } },
  }));
  const doc = JSON.stringify({ gate: { mode: 'deny', injectContext: true }, routes: [builtInRoute('kimi-code-plan')], vault: { backend: 'file' } });
  const present = scratch();
  fs.writeFileSync(path.join(present, 'config.json'), doc);
  status(present);
  const lone = scratch();
  fs.writeFileSync(PREV(lone), doc);
  status(lone);
  const absent = scratch();
  for (const [dir, expectDeny] of [[present, true], [lone, true], [absent, false]]) {
    const r = spawnSync(process.execPath, [cli, 'gate'], {
      input: JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }),
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, VL_STRICT_JOURNAL: journal,
        NODE_OPTIONS: `--require=${path.join(__dirname, 'fixtures/strict-journal.cjs')}` },
      encoding: 'utf8', timeout: 20000,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(/"permissionDecision":"deny"/.test(r.stdout), expectDeny, `premise: the gate ran its path: ${r.stdout}`);
  }
  const calls = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean) : [];
  assert.deepStrictEqual(calls, [], 'the gate path reached the strict reader, the lock or the vault');
  assert.strictEqual(fs.existsSync(path.join(absent, lockModule.LOCK_DIR)), false, 'the gate wrote a lock ticket');
});

test('pin 8: UNCONTENDED READ WORKLOAD — gate, report, snapshot, check and session-start take the lock 0 times', () => {
  // The load-bearing hot-path property, as its own test. The PreToolUse gate,
  // report (/view-limits), snapshot, check and session-start run for real —
  // the real file vault (they read credentials), outbound network refused —
  // on a present config and on a lone .prev. Every lock acquire in each
  // process is journaled; acquireCount must be 0 for every one.
  const doc = { routes: [builtInRoute('kimi-code-plan')], vault: { backend: 'file' }, gate: { mode: 'deny' } };
  // The document first: a strict credential write with NO document proves
  // absence under the lock, which would leave the lock directory behind.
  const present = scratch();
  fs.writeFileSync(path.join(present, 'config.json'), JSON.stringify(doc));
  inDataDir(present, () => vault.set('kimi-code-plan', KEY_A));
  const lone = scratch();
  fs.writeFileSync(PREV(lone), JSON.stringify(doc));
  inDataDir(lone, () => vault.set('kimi-code-plan', KEY_A));
  for (const dir of [present, lone]) {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({
      updatedAt: new Date().toISOString(),
      routes: { 'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date(Date.now() - 60000).toISOString(),
        freshUntil: new Date(Date.now() + 300000).toISOString(), source: 'kimi',
        status: { state: 'exhausted', windows: [], balance: null, resetAt: null },
      } },
    }));
  }
  const strictJournal = path.join(__dirname, 'fixtures/strict-journal.cjs');
  for (const dir of [present, lone]) {
    for (const args of [['gate'], ['report'], ['snapshot', '--json'], ['check', 'kimi-code-plan'], ['session-start']]) {
      const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-strict-')), 'journal');
      const j = journals();
      const r = spawnSync(process.execPath, [cli, ...args], {
        env: envFor(dir, j, {
          NODE_OPTIONS: `--require=${preload} --require=${strictJournal}`,
          VL_STRICT_JOURNAL: journal, VL_STRICT_JOURNAL_VAULT: 'pass',
        }),
        input: args[0] === 'gate' ? JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }) : '',
        encoding: 'utf8', timeout: 20000,
      });
      assert.ok(r.status !== null, `${args.join(' ')} did not finish`);
      if (args[0] === 'gate') assert.match(r.stdout, /"permissionDecision":"deny"/, `premise: the gate ran its full path: ${r.stdout}${r.stderr}`);
      const calls = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n').filter(Boolean) : [];
      assert.deepStrictEqual(calls.filter((c) => c.startsWith('acquireMutationLock')), [],
        `${args.join(' ')} on ${dir === lone ? 'a lone .prev' : 'a present config'} took the lock: ${calls}`);
      assert.ok(args[0] !== 'session-start' || calls.includes('vault.has'), `premise: session-start read the credential: ${calls}`);
    }
    assert.strictEqual(fs.existsSync(path.join(dir, lockModule.LOCK_DIR)), false, 'a read command wrote a lock ticket');
  }
});

test('pin 8: lib/lock.js requires nothing in lib/, and only lib/config.js and lib/provider-lifecycle.js require it', () => {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'lib/lock.js'), 'utf8');
  const deps = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
  assert.deepStrictEqual(deps.sort(), ['crypto', 'fs', 'path'], `lib/lock.js requires: ${deps}`);
  const importers = [];
  for (const sub of ['lib', 'bin', 'harness']) {
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js') && /require\((['"])[./]*(lib\/)?lock(\.js)?\1\)/.test(fs.readFileSync(p, 'utf8'))) {
          importers.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, sub));
  }
  assert.deepStrictEqual(importers.sort(), ['lib/config.js', 'lib/provider-lifecycle.js']);
});

test('the lifecycle publish path, called directly with the migration pending, is refused', async () => {
  // No dispatcher in front: persistRoute -> io.saveConfig must not create
  // config.json, and reports the same migration-pending status.
  const dir = scratch();
  const prev = { data: process.env.CLAUDE_PLUGIN_DATA, key: process.env.VIEW_LIMITS_MASTER_KEY };
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = MASTER;
  try {
    const r = await lifecycle.setupProvider({
      label: 'direct', provider: 'stepplan', recipe: 'stepfun-plan', retention: lifecycle.RETENTION.KEEP,
    }, {
      effectiveRoutes: () => [], readUserConfig: () => ({}), readUserConfigStrict: () => ({ ok: true, doc: {} }),
      saveConfig, lock: () => lifecycle.acquireMutationLock(dir),
      vault: { assertWritable() {}, get: () => null, set() {}, remove() {}, probe: () => 'absent' },
      readCache: () => ({ routes: {} }), writeCache() {},
    });
    assert.strictEqual(r.status, lifecycle.STATUS.MIGRATION_PENDING, `the lifecycle publish was not refused: ${JSON.stringify(r)}`);
    assert.strictEqual(lifecycle.exitCodeFor(r.status), 8);
    assert.strictEqual(fs.existsSync(configPath()), false, 'the lifecycle created config.json with the migration pending');
  } finally {
    if (prev.data === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev.data;
    if (prev.key === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prev.key;
  }
});

test('setup <id> --key exits 1 when its row does not materialize, as bare setup does', () => {
  // The credential is stored; the row is not (the lock is busy). Exit 0 here
  // would tell a script the route exists while the gate stays fail-open.
  const dir = seeded([]);
  const held = lifecycle.acquireMutationLock(dir);
  assert.ok(held.ok);
  try {
    const r = run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
    assert.strictEqual(r.status, 1, `a row-less store reported success: ${r.stderr}`);
    assert.match(r.stderr, /the credential for "kimi-code-plan" is stored, but its route is not configured yet — run: vl\.js setup \(with no route id\) to add it\./);
    assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A, 'premise: the credential was stored');
    assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'premise: the row did not materialize');
  } finally {
    held.release();
  }
  const ok = run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.ok(routeIds(dir).includes('kimi-code-plan'));
});

test('a fresh install loads zero routes, and reading writes nothing', () => {
  const dir = scratch();
  inDataDir(dir, () => {
    assert.deepStrictEqual(loadConfig().routes, []);
    assert.strictEqual(fs.existsSync(configPath()), false);
  });
});

test('builtInRoute hands out deep copies, never the catalog itself', () => {
  const a = builtInRoute('kimi-code-plan');
  a.ttlSeconds = 99999;
  a.match.model = 'mutated';
  const b = builtInRoute('kimi-code-plan');
  assert.strictEqual(b.ttlSeconds, 180, 'the catalog was mutated through a handed-out route');
  assert.strictEqual(b.match.model, 'kimi', 'a nested catalog field was mutated');
  assert.strictEqual(builtInRoute('custom-acme-plan'), null);
  assert.strictEqual(builtInRoute(undefined), null);
});

section('migrateFromVault — publication is all or nothing');

test('absent config + stored credentials -> rows for exactly those providers, catalog rows in full', () => {
  const io = fakeIo({ states: { 'kimi-code-plan': 'present', 'openrouter-main': 'present' } });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: true, ids: ['kimi-code-plan', 'openrouter-main'] });
  assert.deepStrictEqual(io.calls.saves, [{ routes: [builtInRoute('kimi-code-plan'), builtInRoute('openrouter-main')] }]);
  assert.deepStrictEqual(io.calls.probes, BUILT_IN_ROUTES.map((x) => x.id), 'every built-in is asked exactly once');
});

test('a definitive all-absent publishes routes: [] so the vault is not re-probed forever', () => {
  const io = fakeIo();
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: true, ids: [] });
  assert.deepStrictEqual(io.calls.saves, [{ routes: [] }]);
});

test('UNREADABLE is never absent: one unreadable built-in aborts the whole migration', () => {
  // kimi is provably stored. If the unreadable glm were skipped and the rest
  // published, the document would disarm the trigger with glm lost for good.
  const io = fakeIo({ states: { 'kimi-code-plan': 'present', 'glm-coding-plan': 'unreadable' } });
  const r = lifecycle.migrateFromVault(io);
  assert.strictEqual(r.migrated, false);
  assert.strictEqual(r.reason, 'vault-unreadable');
  assert.strictEqual(r.retry, true);
  assert.deepStrictEqual(io.calls.saves, [], 'a partial set was published, disarming the trigger');
});

test('an unreadable vault with NOTHING present still publishes nothing', () => {
  // The exact shape of the reverted bug: every probe unreadable read as
  // "no credentials" and published routes: [] — permanently.
  const io = fakeIo({ states: Object.fromEntries(BUILT_IN_ROUTES.map((x) => [x.id, 'unreadable'])) });
  const r = lifecycle.migrateFromVault(io);
  assert.strictEqual(r.reason, 'vault-unreadable');
  assert.deepStrictEqual(io.calls.saves, [], 'unreadable was read as absent and routes: [] was published');
});

test('a probe that throws, or returns anything unexpected, is not proof of absence', () => {
  for (const bad of [new Error('keychain locked'), undefined, null, true, 'yes', 1]) {
    const io = fakeIo({ states: { 'deepseek-direct': bad } });
    const r = lifecycle.migrateFromVault(io);
    assert.strictEqual(r.reason, 'vault-unreadable', `probe value ${String(bad)} was accepted`);
    assert.deepStrictEqual(io.calls.saves, [], `probe value ${String(bad)} led to a publication`);
  }
});

test('a present config is never touched: no lock, no vault access', () => {
  const io = fakeIo({ presence: ['present'] });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: false, reason: 'config-present' });
  assert.strictEqual(io.calls.locks, 0);
  assert.deepStrictEqual(io.calls.probes, []);
});

test('a config that cannot even be stat-ed is not absent, so nothing migrates', () => {
  for (const presence of [['unreadable'], [new Error('EACCES')], ['maybe']]) {
    const io = fakeIo({ presence });
    const r = lifecycle.migrateFromVault(io);
    assert.strictEqual(r.migrated, false);
    assert.strictEqual(r.reason, 'config-unreadable');
    assert.deepStrictEqual(io.calls.saves, []);
    assert.deepStrictEqual(io.calls.probes, []);
  }
});

test('absence is re-checked INSIDE the lock: a writer that got there first wins', () => {
  // Absent at the pre-check, present by the time we hold the lock.
  const io = fakeIo({ presence: ['absent', 'present'], states: { 'kimi-code-plan': 'present' } });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: false, reason: 'config-present' });
  assert.deepStrictEqual(io.calls.saves, [], 'published over a document another writer had just written');
  assert.deepStrictEqual(io.calls.probes, [], 'the vault was probed after the re-check said present');
});

test('a busy lock writes nothing and stays armed for the next command', () => {
  const io = fakeIo({ lockOk: false, states: { 'kimi-code-plan': 'present' } });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: false, reason: 'lock-busy', retry: true });
  assert.deepStrictEqual(io.calls.saves, []);
  assert.deepStrictEqual(io.calls.probes, [], 'the vault was read without holding the lock');
});

test('the lock is released on every path that took it', () => {
  const cases = [
    { name: 'success', opts: { states: { 'kimi-code-plan': 'present' } } },
    { name: 'unreadable', opts: { states: { 'kimi-code-plan': 'unreadable' } } },
    { name: 'probe throws', opts: { states: { 'kimi-code-plan': new Error('boom') } } },
    { name: 'write fails', opts: { saveThrows: true } },
    { name: 're-check present', opts: { presence: ['absent', 'present'] } },
  ];
  for (const c of cases) {
    const io = fakeIo(c.opts);
    lifecycle.migrateFromVault(io);
    assert.strictEqual(io.calls.locks, 1, `${c.name}: lock taken ${io.calls.locks}x`);
    assert.strictEqual(io.calls.releases, 1, `${c.name}: a leaked ticket would be lock-busy for the rest of the process`);
  }
});

test('a failed write reports retry and publishes nothing', () => {
  const io = fakeIo({ saveThrows: true, states: { 'kimi-code-plan': 'present' } });
  const r = lifecycle.migrateFromVault(io);
  assert.deepStrictEqual(r, { migrated: false, reason: 'write-failed', retry: true });
});

test('an io without the strict pieces is refused rather than guessed at', () => {
  for (const io of [null, {}, { ...fakeIo(), vault: {} }, { ...fakeIo(), configPresence: undefined }]) {
    assert.strictEqual(lifecycle.migrateFromVault(io).reason, 'unsupported-io');
  }
});

section('migration under the ownership boundary (real lock, real saveConfig)');

function realPresence(dir) {
  return () => {
    try { fs.statSync(path.join(dir, 'config.json')); return 'present'; }
    catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  };
}

test('a provider add that completes before the migration locks is never erased', () => {
  // The round-3 P1-1 interleaving, with the real lock and the real atomic
  // publish: the migration's pre-check sees no config; a `provider add` then
  // takes the lock, publishes its route and releases; the migration locks.
  const dir = scratch();
  inDataDir(dir, () => {
    let addDone = false;
    const io = {
      configPresence: realPresence(dir),
      lock: () => {
        if (!addDone) {
          addDone = true;
          const theirs = lifecycle.acquireMutationLock(dir);
          assert.ok(theirs.ok, 'premise: the concurrent writer took the lock');
          // Another process whose migration won: only a migration may CREATE
          // config.json (the write-level guard), so it holds the capability.
          saveConfig({ routes: [{ id: 'custom-theirs', provider: 'stepplan', monitor: { recipe: 'stepfun-plan' } }] },
            { capability: config.FIRST_PUBLISH });
          assert.strictEqual(theirs.release(), true);
        }
        return lifecycle.acquireMutationLock(dir);
      },
      vault: { probe: () => 'present' },
      saveConfig,
    };
    const r = lifecycle.migrateFromVault(io);
    assert.strictEqual(r.reason, 'config-present');
    assert.deepStrictEqual(routeIds(dir), ['custom-theirs'],
      "the migration replaced a provider add that had already completed");
  });
});

test('while the migration holds the lock, a concurrent writer is refused rather than racing', () => {
  const dir = scratch();
  inDataDir(dir, () => {
    const attempts = [];
    const io = {
      configPresence: realPresence(dir),
      lock: () => lifecycle.acquireMutationLock(dir),
      // Called only while the migration holds the lock: any other writer must
      // be turned away, so it retries after rather than interleaving.
      vault: {
        probe: (id) => {
          const other = lifecycle.acquireMutationLock(dir);
          attempts.push(other.ok);
          if (other.ok) other.release();
          return id === 'kimi-code-plan' ? 'present' : 'absent';
        },
      },
      saveConfig,
    };
    const r = lifecycle.migrateFromVault(io);
    assert.deepStrictEqual(r, { migrated: true, ids: ['kimi-code-plan'] });
    assert.strictEqual(attempts.length, BUILT_IN_ROUTES.length);
    assert.ok(attempts.every((ok) => ok === false), 'another writer acquired the lock during the migration');
    assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, lifecycle.LOCK_DIR)), [], 'a ticket leaked');
  });
});

section('real CLI — the one-time migration');

test('an upgrade migrates on its first allowlisted command, for exactly the stored credentials', () => {
  const dir = upgradeWith('kimi-code-plan');
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
  assert.deepStrictEqual(r.json.routes.map((x) => x.id), ['kimi-code-plan']);
  assert.match(r.stderr, /migrated existing credentials into routes: kimi-code-plan/);
  assert.deepStrictEqual(r.j.read(r.j.net), [], 'a migration path made a network call');
});

test('it runs once: the second command neither re-migrates nor rewrites', () => {
  const dir = upgradeWith('kimi-code-plan');
  run(dir, ['provider', 'list', '--json']);
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /migrated/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
});

test('a credential-free fresh install gains routes: [] on its first allowlisted command', () => {
  // Disclosed in README: "fresh install" resolves on first use. The document
  // is what stops the vault being re-probed on every later command.
  const dir = scratch();
  const r = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.json.routes, [], 'a fresh install must show no provider rows');
  assert.deepStrictEqual(routeIds(dir), []);
});

test('a TRANSIENTLY UNREADABLE real vault migrates nothing, and migrates once it is readable', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  const secrets = path.join(dir, 'secrets');
  fs.chmodSync(secrets, 0o000);
  try {
    // Premise, read off the REAL vault: this is unreadable, not absent.
    assert.strictEqual(inDataDir(dir, () => vault.probe('kimi-code-plan')), 'unreadable',
      'premise: the real file vault reports unreadable, not absent');
    const r = run(dir, ['provider', 'list', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(r.json.routes, []);
    assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false,
      'an unreadable vault published a config, which disarms the migration forever');
    assert.strictEqual(r.stderr, `${UNREADABLE_NOTICE}\n`, 'the notice changed shape or gained text');
  } finally {
    fs.chmodSync(secrets, 0o700);
  }
  const later = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'],
    'the stored credential was never migrated once the vault came back');
});

test('an unparseable config is present: refused and left byte-identical', () => {
  const dir = upgradeWith('kimi-code-plan');
  const broken = '{ "routes": [ { "id": "mine", } ] }';
  fs.writeFileSync(path.join(dir, 'config.json'), broken);
  run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), broken);
});

test('routes: [] and {} are choices, never resurrected from the vault', () => {
  for (const doc of ['{"routes":[]}', '{}']) {
    const dir = upgradeWith('kimi-code-plan');
    fs.writeFileSync(path.join(dir, 'config.json'), doc);
    run(dir, ['provider', 'list', '--json']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), doc, `${doc} was rewritten`);
  }
});

section('real CLI — the unreadable-vault notice: where it lands, what it says, when');

// Verbatim on purpose: a notice that silently changes shape is a user-facing
// regression, so any rewording has to change this line too.
const UNREADABLE_NOTICE = 'view-limits: the credential vault could not be read, so stored credentials were not migrated into routes and no configuration was written — this retries on the next command.';
const NO_CREDS_NUDGE = JSON.stringify({ systemMessage: 'view-limits: no credentials configured yet. Run /view-limits:setup to add your provider keys.' });

function withLockedSecrets(dir, fn) {
  const secrets = path.join(dir, 'secrets');
  fs.chmodSync(secrets, 0o000);
  try { return fn(); } finally { fs.chmodSync(secrets, 0o700); }
}

test('session-start reports an unreadable vault in its systemMessage, exactly, and nowhere else', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  const r = withLockedSecrets(dir, () => run(dir, ['session-start']));
  assert.strictEqual(r.status, 0, r.stderr);
  // stdout is the hook's JSON. systemMessage is shown to the user; nothing
  // goes to additionalContext, so nothing enters the model's context.
  assert.strictEqual(r.stdout, JSON.stringify({ systemMessage: UNREADABLE_NOTICE }));
  assert.strictEqual(r.stderr, '', 'session-start must not also print the notice to stderr');
  assert.ok(!r.stdout.includes(dir), 'the notice carried a data-dir path');
  assert.doesNotMatch(r.stdout, /EACCES|EPERM|Error|sk-/, 'the notice carried error text or credential material');
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'an unreadable vault published a config');
});

test('negative: a readable fresh install gets the setup nudge, never the unreadable notice', () => {
  const dir = scratch();
  const r = run(dir, ['session-start']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, NO_CREDS_NUDGE);
  assert.strictEqual(r.stderr, '');
  assert.deepStrictEqual(routeIds(dir), [], 'the fresh install was not resolved to routes: []');
});

test('negative: a configured install with an unreadable vault never shows the migration notice', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  run(dir, ['provider', 'list', '--json']);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'premise: the install is configured');
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  for (const args of [['session-start'], ['provider', 'list', '--json']]) {
    const r = withLockedSecrets(dir, () => run(dir, args));
    assert.ok(!`${r.stdout}${r.stderr}`.includes('could not be read, so stored credentials'),
      `${args[0]} showed the migration notice on a configured install`);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before, `${args[0]} rewrote config.json`);
  }
});

section('real CLI — an unresolved migration refuses every command that writes config');

// The miss that sent round 1 back: migrateFromVault aborted correctly, and
// then `provider add` ran anyway, published config.json, and disarmed the
// migration for good. So the matrix crosses an unreadable vault with EVERY
// command, in both directions.
const REFUSAL = 'view-limits: not run: stored credentials have not been migrated into routes yet (the credential vault could not be read, or another provider change is in progress), and this command would change the configuration before they are. Your stored credentials are untouched and nothing was written. Make sure the vault is accessible (for example, unlock the Keychain), then rerun this command.';
const CONFIG_WRITERS = [
  ['setup'],
  ['setup', 'glm-coding-plan', '--key', KEY_B],
  ['update'],
  ['update', 'kimi-code-plan'],
  ['remove', 'kimi-code-plan'],
  ['provider', 'add', '--label', 'new-plan', '--provider', 'stepplan', '--recipe', 'stepfun-plan', '--keep-unmonitored'],
  ['provider', 'update', 'custom-new-plan', '--match-model', 'x'],
  ['provider', 'remove', 'kimi-code-plan'],
];
const READERS = [
  ['refresh'], ['refresh', '--quiet', '--session-start'], ['check', 'kimi-code-plan'], ['session-start'],
  ['report'], ['status'], ['snapshot', '--json'], ['recommend', '--json'], ['provider', 'list', '--json'],
];

function assertRefused(dir, args, r) {
  const label = args.join(' ');
  assert.strictEqual(r.status, 8, `${label}: expected the migration-pending refusal (exit 8); got ${r.status}: ${r.stderr}`);
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, `${label} wrote config.json`);
  const text = `${r.stdout}${r.stderr}`;
  assert.ok(!text.includes(dir), `${label}: the refusal carried a data-dir path`);
  assert.doesNotMatch(text, /EACCES|EPERM|ENOENT|Error:|sk-/, `${label}: the refusal carried errno, error text or credential material`);
}

test('with the vault unreadable, every config-writing command is refused: exit 8, nothing written', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  withLockedSecrets(dir, () => {
    for (const args of CONFIG_WRITERS) {
      const r = run(dir, args);
      assertRefused(dir, args, r);
      assert.ok(r.stderr.includes(`${REFUSAL}\n`), `${args.join(' ')}: the refusal text changed shape: ${r.stderr}`);
    }
    // --json keeps stdout machine-readable: one document with a stable status.
    const j = run(dir, ['provider', 'add', '--label', 'new-plan', '--provider', 'stepplan',
      '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
    assertRefused(dir, ['provider', 'add', '--json'], j);
    assert.deepStrictEqual(j.json, { command: 'add', ok: false, status: 'migration-pending', error: REFUSAL.slice('view-limits: '.length) });
  });
  // Access returns: the migration was never disarmed, so it completes.
  const later = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'the stored credential lost its route');
});

test('with the vault unreadable, read-only and cache-only commands still run and write no config', () => {
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  withLockedSecrets(dir, () => {
    for (const args of READERS) {
      const r = run(dir, args);
      assert.notStrictEqual(r.status, 8, `${args.join(' ')} was refused, but it never writes config`);
      assert.notStrictEqual(r.status, null, `${args.join(' ')} timed out`);
      assert.ok(!r.stderr.includes('not run: stored credentials'), `${args.join(' ')} printed the refusal`);
      assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, `${args.join(' ')} wrote config.json`);
    }
  });
});

test('a migration that is lock-busy refuses config writers the same way (keyed on retry, not the reason)', () => {
  const dir = upgradeWith('kimi-code-plan');
  const held = lifecycle.acquireMutationLock(dir);
  assert.ok(held.ok, 'premise: the test holds the mutation lock');
  try {
    const args = ['provider', 'add', '--label', 'new-plan', '--provider', 'stepplan', '--recipe', 'stepfun-plan', '--keep-unmonitored'];
    const r = run(dir, args);
    assertRefused(dir, args, r);
    assert.notStrictEqual(r.status, 6, 'an unresolved migration is not an ordinary lock-busy');
  } finally {
    held.release();
  }
});

test('negative: a READABLE vault never triggers the refusal', () => {
  for (const dir of [upgradeWith('kimi-code-plan'), scratch()]) {
    const r = run(dir, ['provider', 'add', '--label', 'new-plan', '--provider', 'stepplan',
      '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!`${r.stdout}${r.stderr}`.includes('not run: stored credentials'));
    assert.ok(routeIds(dir).includes('custom-new-plan'));
  }
});

test('a DIRECTLY invoked serve is refused before it listens, and writes nothing', async () => {
  // Not through setup: a parent-path test passes while the bypass stays open.
  // `serve <port> <nonce> <ids…>` is a command the dispatcher accepts, and its
  // POST materializes a built-in row, so it is a config writer like the rest.
  if (IS_ROOT) { console.log('    (skipped: root ignores mode bits)'); return; }
  const dir = upgradeWith('kimi-code-plan');
  const port = await freePort();
  const r = withLockedSecrets(dir, () => run(dir, ['serve', String(port), 'nonce-81', 'glm-coding-plan']));
  assert.notStrictEqual(r.status, null, 'serve started listening instead of refusing (timed out)');
  assertRefused(dir, ['serve'], r);
  assert.ok(r.stderr.includes(`${REFUSAL}\n`), `the refusal text changed shape: ${r.stderr}`);
  const probe = await request(port, 'GET');
  assert.strictEqual(probe.status, 0, 'something is listening on the refused form port');
  assert.strictEqual(probe.error, 'ECONNREFUSED');
  // Access returns: the migration was never disarmed.
  const later = run(dir, ['provider', 'list', '--json']);
  assert.strictEqual(later.status, 0, later.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
});

section('real CLI — a stored credential whose row failed to materialize is repaired by bare setup');

// The other four built-ins are configured and stored, so bare setup has
// nothing missing and opens no form; only kimi can be row-less.
function setUpOthers() {
  const others = BUILT_IN_ROUTES.map((r) => r.id).filter((id) => id !== 'kimi-code-plan');
  const dir = seeded(others.map((id) => builtInRoute(id)));
  inDataDir(dir, () => { for (const id of others) vault.set(id, `sk-${id}-TEST-81`); });
  return dir;
}

function rowlessKimi() {
  const dir = setUpOthers();
  const held = lifecycle.acquireMutationLock(dir);
  assert.ok(held.ok, 'premise: the test holds the mutation lock');
  const r = run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  assert.match(r.stderr, /credential stored, but another provider mutation holds the lock — rerun to add the "kimi-code-plan" route\./);
  assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A, 'premise: the credential was stored');
  assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'premise: the row did not materialize');
  return { dir, held };
}

test('lock busy after the vault write, then a bare setup rerun, and the row exists', () => {
  const { dir, held } = rowlessKimi();
  // Still busy: bare setup must not claim everything is present.
  const busy = run(dir, ['setup']);
  assert.strictEqual(busy.status, 1, busy.stderr);
  assert.match(busy.stderr, /stored credentials still have no route: kimi-code-plan/);
  assert.doesNotMatch(busy.stderr, /all credentials present/, 'a false "all present" while a credential has no row');
  held.release();
  const r = run(dir, ['setup']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(routeIds(dir).includes('kimi-code-plan'), 'bare setup did not repair the row its own message promised');
  assert.match(r.stderr, /added the missing route for stored credentials: kimi-code-plan/);
  assert.match(r.stderr, /all credentials present\./);
  assert.deepStrictEqual(r.j.read(r.j.browser), [], 'nothing was missing, so no form should open');
});

test('update points a row-less stored credential at bare setup instead of "unknown route"', () => {
  const { dir, held } = rowlessKimi();
  held.release();
  const one = run(dir, ['update', 'kimi-code-plan']);
  assert.strictEqual(one.status, 1);
  assert.match(one.stderr, /"kimi-code-plan" has a stored credential but no route yet — run: vl\.js setup \(with no route id\) to add it\./);
  assert.doesNotMatch(one.stderr, /unknown route/);
  // Nothing else stored, so bare update has no form to open.
  const alone = scratch();
  fs.writeFileSync(path.join(alone, 'config.json'), JSON.stringify({ routes: [], vault: { backend: 'file' }, gate: { mode: 'off' } }));
  inDataDir(alone, () => vault.set('kimi-code-plan', KEY_A));
  const bare = run(alone, ['update']);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.match(bare.stderr, /stored credentials with no route yet: kimi-code-plan — run: vl\.js setup \(with no route id\) to add them\./);
  assert.doesNotMatch(bare.stderr, /no credentials to update/, 'a false "no credentials" while one is stored');
  assert.ok(!routeIds(alone).includes('kimi-code-plan'), 'update must point at the repair, not perform it');
});

test('a credential removed between the repair scan and its lock gets no row, and no "added" report', () => {
  // Deterministic, not a sleep: the preload runs a REAL `provider remove` to
  // completion at setup's first lock acquire — after the repair loop decided
  // Kimi was owed a row, before materializeBuiltInRoute holds the lock.
  const dir = setUpOthers();
  inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
  assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'premise: kimi is row-less');
  const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-hook-')), 'hook');
  const r = run(dir, ['setup', '--headless'], journals(), {
    VL_TEST_BEFORE_FIRST_LOCK: JSON.stringify(['provider', 'remove', 'kimi-code-plan', '--json']),
    VL_TEST_HOOK_JOURNAL: hook,
  });
  assert.notStrictEqual(r.status, null, `setup timed out: ${r.stderr}`);
  const fired = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.strictEqual(fired.length, 1, 'premise: the interleaved remove never ran');
  assert.strictEqual(fired[0].status, 0, `premise: the interleaved remove failed: ${fired[0].stdout}`);
  assert.strictEqual(inDataDir(dir, () => vault.probe('kimi-code-plan')), 'absent', 'premise: the remove cleared the credential');
  assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'a row was published for a credential that is no longer stored');
  assert.match(r.stderr, /the "kimi-code-plan" credential is no longer stored, so its route was not added\./);
  assert.doesNotMatch(r.stderr, /added the missing route/, 'a false "added" report for a row that does not exist');
});

section('real CLI — lock order: migration, then the command, in one process');

// A nested acquire cannot hang (the lock never waits) but would surface as a
// spurious lock-busy, exit 6. Both orders below force migration first.
test('provider add on an upgrade succeeds: migration released before the add locked', () => {
  const dir = upgradeWith('kimi-code-plan');
  const r = run(dir, ['provider', 'add', '--label', 'solo', '--provider', 'stepplan',
    '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
  assert.notStrictEqual(r.status, 6, `nested lock acquisition: ${r.stderr}`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan', 'custom-solo']);
  assert.deepStrictEqual(r.j.read(r.j.net), [], 'an unmonitored add made a network call');
});

test('setup --key on an upgrade succeeds: migration released before the row was materialized', () => {
  const dir = upgradeWith('kimi-code-plan');
  const r = run(dir, ['setup', 'glm-coding-plan', '--key', KEY_B]);
  assert.notStrictEqual(r.status, 6, `nested lock acquisition: ${r.stderr}`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan', 'glm-coding-plan']);
});

section('real CLI — cache-only reads never migrate and write nothing');

test('gate on an upgrade fails open and leaves the data dir byte-identical', () => {
  const dir = upgradeWith('kimi-code-plan', 'openrouter-main');
  const before = tree(dir);
  const j = journals();
  const r = spawnSync(process.execPath, [cli, 'gate'], {
    env: envFor(dir, j), encoding: 'utf8', timeout: 20000,
    input: JSON.stringify({ tool_name: 'Task', tool_input: { model: 'kimi-k2' } }),
  });
  assert.strictEqual(r.status, 0, `the gate must fail open with no routes; stderr=${r.stderr}`);
  assert.strictEqual(r.stdout, '', 'no route resolved, so the gate must say nothing');
  assert.deepStrictEqual(tree(dir), before, 'gate created or modified a file under the data dir');
});

test('report, status, snapshot and recommend write nothing either', () => {
  for (const args of [['report'], ['status'], ['snapshot', '--json'], ['recommend', '--json']]) {
    const dir = upgradeWith('kimi-code-plan');
    const before = tree(dir);
    const r = run(dir, args);
    assert.notStrictEqual(r.status, null, `${args[0]} timed out`);
    assert.deepStrictEqual(tree(dir), before, `${args.join(' ')} wrote under the data dir`);
  }
});

section('real CLI — the setup form on a fresh install (the documented primary path)');

test('the form server accepts a catalog built-in with no config row, and the POST creates it', async () => {
  const dir = seeded([]);
  const j = journals();
  const port = await freePort();
  const child = spawn(process.execPath, [cli, 'serve', String(port), 'nonce-81', 'kimi-code-plan'], {
    env: envFor(dir, j), stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((res) => child.once('exit', (code) => res(code)));
  try {
    assert.strictEqual(await waitListening(port, exited), true,
      `the form server never listened on an empty config: ${stderr.trim()}`);
    assert.deepStrictEqual(routeIds(dir), [], 'a row was published before any credential was stored');
    const post = await request(port, 'POST', { nonce: 'nonce-81', credentials: { 'kimi-code-plan': KEY_A } });
    assert.strictEqual(post.status, 200, post.body);
    assert.strictEqual(await exited, 0);
    assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'storing the credential did not assemble the row');
    assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A);
  } finally {
    child.kill();
  }
});

test('the form server still refuses an id that is neither configured nor shipped', async () => {
  const dir = seeded([]);
  const r = run(dir, ['serve', String(await freePort()), 'nonce-81', 'not-a-route']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown route/);
});

test('setup without --key prints a URL only for a form server that is really listening', async () => {
  const dir = seeded([]);
  const r = run(dir, ['setup', 'kimi-code-plan']);
  assert.strictEqual(r.status, 0, r.stderr);
  const m = /credential form: http:\/\/127\.0\.0\.1:(\d+)/.exec(r.stderr);
  assert.ok(m, `no URL printed: ${r.stderr}`);
  const port = Number(m[1]);
  // The parent has already exited. The detached child must be up at that URL.
  const page = await request(port, 'GET');
  assert.strictEqual(page.status, 200, 'the printed URL is a dead page');
  const expected = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'cmd' : 'xdg-open');
  const launches = r.j.read(r.j.browser);
  assert.strictEqual(launches.length, 1, `browser launches: ${JSON.stringify(launches)}`);
  assert.ok(launches[0].startsWith(expected) && launches[0].includes(`http://127.0.0.1:${port}`),
    `the browser was not launched at the live URL: ${launches[0]}`);
  // Finish the form through the real POST, which also lets the child exit.
  const nonce = /nonce:"([a-f0-9]{48})"/.exec(page.body);
  assert.ok(nonce, 'premise: the form page carries its nonce');
  const post = await request(port, 'POST', { nonce: nonce[1], credentials: { 'kimi-code-plan': KEY_A } });
  assert.strictEqual(post.status, 200, post.body);
  await new Promise((res) => setTimeout(res, 400));
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
});

test("setup reports the form server's exit instead of printing a dead URL", () => {
  const dir = seeded([]);
  const r = run(dir, ['setup', 'kimi-code-plan'], journals(), { VL_TEST_SERVE_EXIT: '3' });
  assert.strictEqual(r.status, 1, `a dead form server must fail setup; stderr=${r.stderr}`);
  assert.match(r.stderr, /credential form server exited \(code 3\)/);
  assert.doesNotMatch(r.stderr, /credential form: http/, 'a URL was printed for a server that never listened');
  assert.deepStrictEqual(r.j.read(r.j.browser), [], 'a browser was opened at a dead page');
  assert.deepStrictEqual(routeIds(dir), []);
});

section('real CLI — offer versus create');

test('setup offers all five built-ins by name on an empty config', () => {
  const dir = seeded([]);
  const r = run(dir, ['setup', 'not-a-route', '--key', KEY_A]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown route "not-a-route"/);
  for (const x of BUILT_IN_ROUTES) assert.ok(r.stderr.includes(x.id), `${x.id} must be offered`);
});

test('setup --key assembles the row once, and a repeat does not duplicate it', () => {
  const dir = seeded([]);
  assert.strictEqual(run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]).status, 0);
  assert.strictEqual(run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]).status, 0);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan']);
});

test('update rotates only what exists: an unconfigured built-in is unknown there', () => {
  const dir = seeded([]);
  const r = run(dir, ['update', 'kimi-code-plan']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown route "kimi-code-plan"/);
});

test('a custom route goes zero rows -> one -> zero', () => {
  const dir = seeded([]);
  const add = run(dir, ['provider', 'add', '--label', 'acme', '--provider', 'stepplan',
    '--recipe', 'stepfun-plan', '--keep-unmonitored', '--json']);
  assert.strictEqual(add.status, 0, add.stderr);
  assert.deepStrictEqual(routeIds(dir), ['custom-acme']);
  const rm = run(dir, ['provider', 'remove', 'custom-acme', '--json']);
  assert.strictEqual(rm.status, 0, rm.stderr);
  assert.deepStrictEqual(routeIds(dir), []);
});

test('a configured shipped built-in keeps its row on remove; its credential goes', () => {
  const dir = seeded([]);
  run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  const r = run(dir, ['remove', 'kimi-code-plan']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(routeIds(dir), ['kimi-code-plan'], 'a shipped id was deleted from config.json');
  assert.strictEqual(inDataDir(dir, () => vault.probe('kimi-code-plan')), 'absent');
});

test('provider remove on a never-added built-in: not-found when nothing exists', () => {
  const dir = seeded([]);
  const r = run(dir, ['provider', 'remove', 'kimi-code-plan', '--json']);
  assert.strictEqual(r.status, 7, r.stderr);
  assert.strictEqual(r.json.status, 'not-found');
  assert.deepStrictEqual(routeIds(dir), []);
});

test('provider remove on a never-added built-in still clears an orphaned credential', () => {
  const dir = seeded([]);
  inDataDir(dir, () => vault.set('kimi-code-plan', KEY_A));
  const r = run(dir, ['provider', 'remove', 'kimi-code-plan', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.json.removed.credential, true);
  assert.strictEqual(inDataDir(dir, () => vault.probe('kimi-code-plan')), 'absent');
  assert.deepStrictEqual(routeIds(dir), [], 'removal created a row for a route nobody set up');
});

queue.then(() => {
  if (failures) {
    console.error(`\n${failures} empty-defaults test(s) failed`);
    process.exit(1);
  }
  console.log('\nall empty-defaults tests passed');
});
