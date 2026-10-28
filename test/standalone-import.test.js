'use strict';
// Issue #148 — the one-time import of the standalone data dir (~/.view-limits)
// into the Claude plugin's data dir.
//
// Four conditions, each with its own tests:
//   (1) the copy runs only with --claude-plugin, and only into a dir that has no
//       config.json;
//   (2) any failure leaves no partial files, vault leftovers included;
//   (3) two concurrent SessionStart hooks copy at most once (real processes);
//   (4) runtime files are never copied.
//
// Everything runs against a scratch HOME. The real ~/.view-limits and every
// ~/.claude/plugins/data/* directory are never read, written or named.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'vl.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-import-'));
let seq = 0;
const fresh = (label) => { const d = path.join(scratch, `${label}-${seq += 1}`); fs.mkdirSync(d, { recursive: true }); return d; };

let failures = 0;
function test(name, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  if (opts.skip) { console.log(`  - ${name} (skipped)`); return; }
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

const SOURCE_DOC = {
  routes: [{ id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 300 }],
  vault: { backend: 'file' },
  gate: { mode: 'off' },
};
const SECRETS = { 'kimi-code-plan.enc': '{"salt":"a","iv":"b","tag":"c","ct":"kimi"}', 'minimax-token-plan.enc': '{"salt":"d","iv":"e","tag":"f","ct":"mm"}' };
const MASTER = 'master-key-bytes-0123456789';

// Runtime state that must never travel: a daemon's pid and port, a LAN token,
// locks, caches and receipts are wrong in another directory.
const RUNTIME = {
  'status.json': '{"routes":{}}',
  'refresh.scheduled': '1',
  'dashboard.json': '{"pid":1,"port":5555}',
  'dashboard.log': 'log',
  'dashboard-lan-token': 'f'.repeat(64),
  'credential-receipt.json': '{"outcome":"stored"}',
  'runtime.json': '{"version":1}',
  'refresh-workers/1-aa.json': '{}',
  'dashboard-lock/1-aa.json': '{}',
  'xiaomi/key-suppressed.json': '{"code":"x"}',
  'xiaomi/rejected.json': '{}',
  'bin/kh-helper': '#!/bin/sh\n',
};

function write(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
}

// A fresh scratch HOME with a populated standalone data dir.
function makeHome({ runtime = true, secrets = SECRETS, master = MASTER, doc = SOURCE_DOC } = {}) {
  const home = fresh('home');
  const src = path.join(home, '.view-limits');
  fs.mkdirSync(src, { mode: 0o700 });
  write(path.join(src, 'config.json'), JSON.stringify(doc, null, 2) + '\n', 0o600);
  if (master !== null) write(path.join(src, 'master.key'), master, 0o600);
  fs.mkdirSync(path.join(src, 'secrets'), { mode: 0o700 });
  for (const [name, text] of Object.entries(secrets)) write(path.join(src, 'secrets', name), text, 0o600);
  if (runtime) for (const [rel, text] of Object.entries(RUNTIME)) write(path.join(src, rel), text, 0o600);
  return { home, src };
}

// Every file under dir, relative, minus the mutation lock's own directory (the
// lock a copy takes is not state).
function tree(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const rel = path.relative(base, p);
    if (rel === 'provider-mutations') continue;
    if (fs.lstatSync(p).isDirectory()) { out.push(rel + '/'); tree(p, base, out); } else out.push(rel);
  }
  return out;
}
const mode = (f) => fs.statSync(f).mode & 0o777;

// ---- in-process: lib/standalone-import.js ---------------------------------------

const config = require('../lib/config');
const lockLib = require('../lib/lock');
const { importStandalone } = require('../lib/standalone-import');
function runImport(target, home, deps) {
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = target;
  try { return importStandalone({ target, home }, deps); } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = saved;
  }
}

console.log('\nimport — what is copied, and how');

test('durable user state arrives: config.json, master.key, secrets/*.enc', () => {
  const { home, src } = makeHome();
  const target = fresh('plugin');
  const r = runImport(target, home);
  assert.strictEqual(r.status, 'copied', JSON.stringify(r));
  assert.deepStrictEqual(tree(target), ['config.json', 'master.key', 'secrets/', 'secrets/kimi-code-plan.enc', 'secrets/minimax-token-plan.enc']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')), SOURCE_DOC);
  assert.strictEqual(fs.readFileSync(path.join(target, 'master.key'), 'utf8'), MASTER);
  for (const [name, text] of Object.entries(SECRETS)) {
    assert.strictEqual(fs.readFileSync(path.join(target, 'secrets', name), 'utf8'), text);
  }
  assert.ok(fs.existsSync(path.join(src, 'config.json')), 'the source is left exactly where it was');
});

test('permissions are kept: 0600 stays 0600 and a tighter 0400 stays 0400', () => {
  const { home, src } = makeHome();
  fs.chmodSync(path.join(src, 'master.key'), 0o400);
  fs.chmodSync(path.join(src, 'secrets', 'minimax-token-plan.enc'), 0o400);
  const target = fresh('plugin');
  const prior = process.umask(0o077);
  try { assert.strictEqual(runImport(target, home).status, 'copied'); } finally { process.umask(prior); }
  assert.strictEqual(mode(path.join(target, 'config.json')), 0o600);
  assert.strictEqual(mode(path.join(target, 'master.key')), 0o400);
  assert.strictEqual(mode(path.join(target, 'secrets', 'kimi-code-plan.enc')), 0o600);
  assert.strictEqual(mode(path.join(target, 'secrets', 'minimax-token-plan.enc')), 0o400);
  assert.strictEqual(mode(path.join(target, 'secrets')), 0o700);
});

test('a looser umask cannot widen a 0600 file', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const prior = process.umask(0);
  try { assert.strictEqual(runImport(target, home).status, 'copied'); } finally { process.umask(prior); }
  assert.strictEqual(mode(path.join(target, 'master.key')), 0o600);
  assert.strictEqual(mode(path.join(target, 'secrets', 'kimi-code-plan.enc')), 0o600);
});

test('a Keychain-backed standalone dir (no master.key, no secrets/) copies config.json alone', () => {
  const { home, src } = makeHome({ master: null, secrets: {} });
  fs.rmSync(path.join(src, 'secrets'), { recursive: true });
  const target = fresh('plugin');
  assert.strictEqual(runImport(target, home).status, 'copied');
  assert.deepStrictEqual(tree(target), ['config.json']);
});

test('(4) runtime files are excluded — every one of them', () => {
  const { home } = makeHome({ runtime: true });
  const target = fresh('plugin');
  assert.strictEqual(runImport(target, home).status, 'copied');
  const got = tree(target);
  for (const rel of Object.keys(RUNTIME)) {
    assert.ok(!got.includes(rel), `${rel} must not be copied`);
  }
  assert.deepStrictEqual(got.filter((p) => !/^(config\.json|master\.key|secrets\/.*)$/.test(p)), [],
    'nothing but the three durable kinds arrives');
});

test('a vault writer\'s leftover temp file in the source is not a credential and is skipped', () => {
  const { home, src } = makeHome();
  write(path.join(src, 'secrets', 'kimi-code-plan.enc.tmp-123-abcdef0123456789'), 'partial', 0o600);
  const target = fresh('plugin');
  assert.strictEqual(runImport(target, home).status, 'copied');
  assert.ok(!tree(target).some((p) => p.includes('.tmp-')));
});

console.log('\nimport — (1) only into a dir with no config.json');

test('a target that already has config.json is never touched', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  write(path.join(target, 'config.json'), '{"routes":[]}\n', 0o600);
  const r = runImport(target, home);
  assert.deepStrictEqual([r.status, r.reason], ['skipped', 'config-present']);
  assert.deepStrictEqual(tree(target), ['config.json']);
  assert.strictEqual(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"routes":[]}\n');
});

test('a swap in flight (config.json.prev alone) counts as present', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  write(path.join(target, 'config.json.prev'), '{"routes":[]}\n', 0o600);
  assert.strictEqual(runImport(target, home).reason, 'config-present');
  assert.deepStrictEqual(tree(target), ['config.json.prev']);
});

test('the second run is a no-op: copy once', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  assert.strictEqual(runImport(target, home).status, 'copied');
  fs.writeFileSync(path.join(target, 'master.key'), 'changed-by-user');
  assert.strictEqual(runImport(target, home).reason, 'config-present');
  assert.strictEqual(fs.readFileSync(path.join(target, 'master.key'), 'utf8'), 'changed-by-user');
});

test('no standalone dir, or one without a config.json: nothing is created in the target', () => {
  const none = fresh('home');
  const t1 = path.join(fresh('plugin'), 'not-yet');
  assert.deepStrictEqual([runImport(t1, none).status, runImport(t1, none).reason], ['skipped', 'no-standalone-dir']);
  assert.ok(!fs.existsSync(t1), 'the target directory was not even created');
  const { home, src } = makeHome();
  fs.rmSync(path.join(src, 'config.json'));
  const t2 = path.join(fresh('plugin'), 'not-yet');
  assert.strictEqual(runImport(t2, home).reason, 'no-standalone-config');
  assert.ok(!fs.existsSync(t2));
});

test('the standalone dir as its own target is skipped', () => {
  const { home, src } = makeHome();
  const r = runImport(src, home);
  assert.deepStrictEqual([r.status, r.reason], ['skipped', 'same-dir']);
});

test('a target that is not the directory dataDir() resolves refuses rather than split', () => {
  const { home } = makeHome();
  const a = fresh('plugin');
  const b = fresh('plugin');
  const saved = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = b;
  try { assert.strictEqual(importStandalone({ target: a, home }).reason, 'target-mismatch'); } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = saved;
  }
  assert.deepStrictEqual(tree(a).concat(tree(b)), []);
});

test('a mutation lock held elsewhere: copy nothing, retry next time', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const held = lockLib.acquireMutationLock(target);
  assert.ok(held.ok);
  try {
    const r = runImport(target, home);
    assert.deepStrictEqual([r.status, r.reason, r.retry], ['skipped', 'lock-busy', true]);
    assert.deepStrictEqual(tree(target), []);
  } finally { held.release(); }
  assert.strictEqual(runImport(target, home).status, 'copied', 'and it copies once the lock is free');
});

test('another plugin\'s data dir is not read, written or listed', () => {
  const { home } = makeHome();
  const other = path.join(home, '.claude', 'plugins', 'data', 'codex-inline');
  write(path.join(other, 'config.json'), '{"other":true}\n', 0o600);
  const before = fs.statSync(path.join(other, 'config.json'));
  fs.chmodSync(other, 0o000);
  try {
    assert.strictEqual(runImport(fresh('plugin'), home).status, 'copied');
  } finally { fs.chmodSync(other, 0o700); }
  assert.deepStrictEqual(tree(other), ['config.json']);
  const after = fs.statSync(path.join(other, 'config.json'));
  assert.strictEqual(after.mtimeMs, before.mtimeMs);
});

console.log('\nimport — (2) any failure leaves nothing behind');

function assertNothingCopied(target, why) {
  assert.deepStrictEqual(tree(target), [], `${why}: no partial files, vault leftovers included`);
}

test('a symlink in secrets/ fails closed before anything is written', () => {
  const { home, src } = makeHome();
  fs.symlinkSync('/etc/hosts', path.join(src, 'secrets', 'evil.enc'));
  const target = fresh('plugin');
  const r = runImport(target, home);
  assert.deepStrictEqual([r.status, r.reason], ['failed', 'unsafe-source']);
  assertNothingCopied(target, 'symlink');
});

test('a symlinked master.key fails closed', () => {
  const { home, src } = makeHome();
  fs.rmSync(path.join(src, 'master.key'));
  fs.symlinkSync(path.join(src, 'config.json'), path.join(src, 'master.key'));
  const target = fresh('plugin');
  assert.strictEqual(runImport(target, home).status, 'failed');
  assertNothingCopied(target, 'symlinked master.key');
});

test('a symlinked standalone dir fails closed', () => {
  const { home, src } = makeHome();
  const real = path.join(home, 'elsewhere');
  fs.renameSync(src, real);
  fs.symlinkSync(real, src);
  const target = fresh('plugin');
  assert.strictEqual(runImport(target, home).status, 'failed');
  assertNothingCopied(target, 'symlinked source dir');
});

test('an unexpected entry in secrets/ fails closed', () => {
  const { home, src } = makeHome();
  write(path.join(src, 'secrets', 'notes.txt'), 'who knows', 0o600);
  const target = fresh('plugin');
  assert.strictEqual(runImport(target, home).reason, 'unexpected-source-entry');
  assertNothingCopied(target, 'unexpected entry');
});

test('a config.json that is not a JSON object fails closed', () => {
  for (const text of ['{ not json', '[]', 'null', '"str"']) {
    const { home, src } = makeHome();
    write(path.join(src, 'config.json'), text, 0o600);
    const target = fresh('plugin');
    assert.strictEqual(runImport(target, home).reason, 'source-config-unreadable', text);
    assertNothingCopied(target, `config ${text}`);
  }
});

test('an unreadable secret fails closed (nothing is written before every file is read)', { skip: process.getuid && process.getuid() === 0 }, () => {
  const { home, src } = makeHome();
  fs.chmodSync(path.join(src, 'secrets', 'minimax-token-plan.enc'), 0o000);
  const target = fresh('plugin');
  try { assert.strictEqual(runImport(target, home).status, 'failed'); } finally {
    fs.chmodSync(path.join(src, 'secrets', 'minimax-token-plan.enc'), 0o600);
  }
  assertNothingCopied(target, 'unreadable secret');
});

test('a mid-copy failure (secrets is a file in the target) removes the master.key already written', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  write(path.join(target, 'secrets'), 'squatter', 0o600);
  const r = runImport(target, home);
  assert.deepStrictEqual([r.status, r.reason], ['failed', 'copy-failed']);
  assert.deepStrictEqual(tree(target), ['secrets'], 'only the squatter is left');
  assert.strictEqual(fs.readFileSync(path.join(target, 'secrets'), 'utf8'), 'squatter', 'and it is untouched');
});

test('a pre-existing file is never overwritten, and the files written before it are removed', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  write(path.join(target, 'secrets', 'minimax-token-plan.enc'), 'mine', 0o600);
  const r = runImport(target, home);
  assert.strictEqual(r.status, 'failed');
  assert.deepStrictEqual(tree(target), ['secrets/', 'secrets/minimax-token-plan.enc'],
    'master.key and kimi-code-plan.enc were rolled back; the existing file and its directory stay');
  assert.strictEqual(fs.readFileSync(path.join(target, 'secrets', 'minimax-token-plan.enc'), 'utf8'), 'mine');
});

test('a pre-existing master.key in the target fails before any secret is written', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  write(path.join(target, 'master.key'), 'mine', 0o600);
  assert.strictEqual(runImport(target, home).status, 'failed');
  assert.deepStrictEqual(tree(target), ['master.key']);
  assert.strictEqual(fs.readFileSync(path.join(target, 'master.key'), 'utf8'), 'mine');
});

test('a failed publish rolls back the vault files and the directory it created', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = runImport(target, home, { saveConfig: () => { throw new Error('boom'); } });
  assert.deepStrictEqual([r.status, r.reason], ['failed', 'copy-failed']);
  assertNothingCopied(target, 'failed publish');
});

test('a publish that does not read back as the source document is rolled back, config.json included', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const lying = (doc, opts) => config.saveConfig({ ...doc, routes: [] }, opts);
  const r = runImport(target, home, { saveConfig: lying });
  assert.strictEqual(r.status, 'failed');
  assertNothingCopied(target, 'verify mismatch');
});

test('a create-only publish that finds config.json already there removes only what this run wrote', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const racing = (doc, opts) => {
    write(path.join(target, 'config.json'), '{"routes":[],"by":"someone else"}\n', 0o600);
    return config.saveConfig(doc, opts); // FIRST_PUBLISH refuses: EEXIST
  };
  const r = runImport(target, home, { saveConfig: racing });
  assert.strictEqual(r.status, 'failed');
  assert.deepStrictEqual(tree(target), ['config.json'], 'the vault files are gone');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).by, 'someone else',
    'and the document that appeared in the meantime is not clobbered or removed');
});

// ---- through the real CLI ---------------------------------------------------------

function cli(argv, { home, env = {}, async: asyncRun = false } = {}) {
  const e = { PATH: process.env.PATH, HOME: home, ...env };
  return asyncRun
    ? spawn(process.execPath, [CLI, ...argv], { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync(process.execPath, [CLI, ...argv], { env: e, encoding: 'utf8', timeout: 30000 });
}

console.log('\nimport — (1) through the CLI: --claude-plugin is the only trigger');

test('--data-dir alone (Codex/OpenCode) never copies', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = cli(['--data-dir', target, 'config'], { home });
  assert.ok([0, 9].includes(r.status), r.stderr); // an unconfigured dir is refused by `config`: not under test
  assert.deepStrictEqual(tree(target), []);
  assert.doesNotMatch(r.stderr, /copied/);
});

test('no option at all (a terminal) never copies', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = cli(['config'], { home, env: { CLAUDE_PLUGIN_DATA: target } });
  assert.ok([0, 9].includes(r.status), r.stderr);
  assert.deepStrictEqual(tree(target), []);
});

test('--data-dir with --claude-plugin copies once and says so in one fixed line, no path', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = cli(['--data-dir', target, '--claude-plugin', 'config'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /^view-limits: copied your existing settings from the standalone data folder into the plugin data folder\.$/m);
  assert.ok(!r.stderr.includes(home) && !r.stderr.includes(target), 'no path in the notice');
  assert.deepStrictEqual(tree(target), ['config.json', 'master.key', 'secrets/', 'secrets/kimi-code-plan.enc', 'secrets/minimax-token-plan.enc']);
  const again = cli(['--data-dir', target, '--claude-plugin', 'config'], { home });
  assert.doesNotMatch(again.stderr, /copied/, 'the second call is silent');
});

test('a hook (no --data-dir, CLAUDE_PLUGIN_DATA in the environment) copies the same way', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = cli(['--claude-plugin', 'config'], { home, env: { CLAUDE_PLUGIN_DATA: target } });
  assert.match(r.stderr, /copied your existing settings/);
  assert.ok(tree(target).includes('master.key'));
});

test('the import runs before the migration: a first-run view finds the copied routes', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = cli(['--data-dir', target, '--claude-plugin', 'status', '--json'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')), SOURCE_DOC);
});

test('a failed copy prints one fixed line, still runs the command, and leaves nothing', () => {
  const { home, src } = makeHome();
  write(path.join(src, 'secrets', 'notes.txt'), 'x', 0o600);
  const target = fresh('plugin');
  const r = cli(['--data-dir', target, '--claude-plugin', 'config'], { home });
  assert.ok([0, 9].includes(r.status), r.stderr); // the command then runs on the unconfigured dir
  assert.match(r.stderr, /^view-limits: could not copy your existing settings .* nothing was copied/m);
  assert.deepStrictEqual(tree(target), []);
});

// ---- (3) two concurrent processes -------------------------------------------------

// Both children block in a preload until the barrier file exists, so they reach
// the import together instead of one finishing before the other has started. A
// second preload replaces the vault (no Keychain read from a test).
const BARRIER = path.join(scratch, 'barrier.cjs');
fs.writeFileSync(BARRIER, `'use strict';
const fs = require('fs');
const go = process.env.VL_TEST_GO;
if (go) { const until = Date.now() + 15000; while (!fs.existsSync(go) && Date.now() < until) { /* spin */ } }
const Module = require('module');
const load = Module._load;
Module._load = function (id, ...rest) {
  if (typeof id === 'string' && (id.endsWith('/lib/vault') || id === './vault')) {
    return { has: () => false, get: () => null, remove: () => true, set: () => true, assertWritable: () => {}, probe: () => 'absent' };
  }
  return load.call(this, id, ...rest);
};
`);

function race(argvA, argvB, { home, target }) {
  const go = path.join(fresh('go'), 'go');
  const env = { NODE_OPTIONS: `--require=${BARRIER}`, VL_TEST_GO: go };
  const run = (argv) => new Promise((resolve) => {
    const child = cli(argv, { home, env, async: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  });
  const pa = run(argvA);
  const pb = run(argvB);
  setTimeout(() => fs.writeFileSync(go, '1'), 400);
  return Promise.all([pa, pb]);
}

(async () => {
  console.log('\nimport — (3) two concurrent processes copy at most once');

  const ROUNDS = 6;
  try {
    // Two copies of the same command: no migration involved, so exactly one wins.
    for (let i = 0; i < ROUNDS; i += 1) {
      const { home } = makeHome();
      const target = fresh('plugin');
      const argv = ['--data-dir', target, '--claude-plugin', 'config'];
      const [a, b] = await race(argv, argv, { home, target });
      // 9 is the existing "config unreadable mid-write; retry" answer of a
      // reader that arrives while the other process holds the lock.
      assert.ok([a.code, b.code].every((c) => c === 0 || c === 9), `${a.err}${b.err}`);
      const copies = [a, b].filter((r) => /copied your existing settings/.test(r.err)).length;
      assert.ok(copies <= 1, `round ${i}: ${copies} processes reported a copy`);
      const got = tree(target);
      if (copies === 1) {
        assert.deepStrictEqual(got, ['config.json', 'master.key', 'secrets/', 'secrets/kimi-code-plan.enc', 'secrets/minimax-token-plan.enc'], `round ${i}`);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')), SOURCE_DOC);
      } else {
        // Both found the lock busy or one saw the other's finished document:
        // whichever happened, no half-copied state may remain.
        assert.ok(got.length === 0 || got.includes('config.json'), `round ${i}: partial copy ${got}`);
      }
    }
    console.log(`  ✓ ${ROUNDS} rounds of the same command in two real processes: at most one copy, never a partial one`);

    // The two real SessionStart hook commands against the same fresh dir.
    let copiedRounds = 0;
    for (let i = 0; i < ROUNDS; i += 1) {
      const { home } = makeHome();
      const target = fresh('plugin');
      const common = ['--data-dir', target, '--claude-plugin'];
      const [a, b] = await race([...common, 'refresh', '--quiet', '--session-start'], [...common, 'session-start'], { home, target });
      const copies = [a, b].filter((r) => /copied your existing settings/.test(r.err)).length;
      assert.ok(copies <= 1, `hooks round ${i}: ${copies} copies`);
      const got = tree(target);
      const doc = JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8'));
      if (copies === 1) {
        copiedRounds += 1;
        assert.deepStrictEqual(doc, SOURCE_DOC, `hooks round ${i}`);
        assert.ok(got.includes('master.key') && got.includes('secrets/kimi-code-plan.enc'), `hooks round ${i}: vault files travelled with the document`);
      } else {
        // The vault migration published first; the copy must not have left
        // vault files next to a document that is not the user's.
        assert.deepStrictEqual(got.filter((p) => p !== 'config.json'), [], `hooks round ${i}: vault leftovers without the copied config`);
      }
    }
    console.log(`  ✓ ${ROUNDS} rounds of refresh --session-start + session-start together: at most one copy, config and vault files together or neither (${copiedRounds} copied)`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ concurrency\n    ${e.stack || e.message}`);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} standalone-import test(s) failed`); process.exit(1); }
  console.log('\nstandalone import: ok');
})();
