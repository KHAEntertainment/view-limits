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
          saveConfig({ routes: [{ id: 'custom-theirs', provider: 'stepplan', monitor: { recipe: 'stepfun-plan' } }] });
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
    assert.match(r.stderr, /vault could not be read/);
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
