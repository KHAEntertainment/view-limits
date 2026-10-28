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
const { importStandalone, noticeFor, REASONS } = require('../lib/standalone-import');
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

test('a mutation lock held elsewhere: copy nothing, still owed', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const held = lockLib.acquireMutationLock(target);
  assert.ok(held.ok);
  try {
    const r = runImport(target, home);
    assert.deepStrictEqual([r.status, r.reason, r.owed], ['skipped', 'lock-busy', true]);
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

test('stray names are ignored, never a reason to refuse: .DS_Store, notes.txt, temp files, in secrets/ and in the root', () => {
  const { home, src } = makeHome();
  write(path.join(src, 'secrets', '.DS_Store'), 'x', 0o600);
  write(path.join(src, 'secrets', 'notes.txt'), 'who knows', 0o600);
  write(path.join(src, 'secrets', 'kimi-code-plan.enc.tmp-1-abc'), 'partial', 0o600);
  write(path.join(src, '.DS_Store'), 'x', 0o600);
  write(path.join(src, 'README'), 'x', 0o600);
  fs.mkdirSync(path.join(src, 'secrets', 'subdir'));
  const target = fresh('plugin');
  const r = runImport(target, home);
  assert.strictEqual(r.status, 'copied', JSON.stringify(r));
  assert.deepStrictEqual(tree(target), ['config.json', 'master.key', 'secrets/', 'secrets/kimi-code-plan.enc', 'secrets/minimax-token-plan.enc']);
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
  assert.deepStrictEqual([r.status, r.reason, r.owed], ['failed', 'target-conflict', true]);
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
  assert.deepStrictEqual([r.status, r.reason, r.owed], ['failed', 'copy-failed', true]);
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
  assert.deepStrictEqual([r.status, r.reason, r.owed], ['failed', 'target-conflict', true]);
  assert.deepStrictEqual(tree(target), ['config.json'], 'the vault files are gone');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')).by, 'someone else',
    'and the document that appeared in the meantime is not clobbered or removed');
});


console.log('\nimport — B1: ownership starts at the exclusive create');

test('a write that fails after the file was created is rolled back, and a later run copies', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  let calls = 0;
  // The second file: the exclusive create has already happened, then ENOSPC.
  const failing = (fd, buf) => {
    calls += 1;
    if (calls === 2) { fs.writeSync(fd, buf, 0, 3); const e = new Error('no space'); e.code = 'ENOSPC'; throw e; }
    fs.writeSync(fd, buf, 0, buf.length);
  };
  const r = runImport(target, home, { writeFile: failing });
  assert.deepStrictEqual([r.status, r.reason, r.owed], ['failed', 'copy-failed', true]);
  assertNothingCopied(target, 'a partial file from a failed write');
  assert.strictEqual(runImport(target, home).status, 'copied', 'the leftover would have made this exclusive create fail');
});

test('a write that fails on the very first byte of the first file leaves nothing either', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = runImport(target, home, { writeFile: () => { throw new Error('EIO'); } });
  assert.strictEqual(r.status, 'failed');
  assertNothingCopied(target, 'an empty file from a failed first write');
});

console.log('\nimport — owed: nothing may publish over an import that is still to do');

const isRoot = !!(process.getuid && process.getuid() === 0);

test('classification table: owed or not, and the class that picks the notice', () => {
  const outcome = (r) => [r.status, r.reason, r.owed ? 'owed' : 'not-owed', r.class || '-'].join(' ');
  const rows = [];
  // NOT owed: the caller may migrate as it always did
  let h = makeHome(); let t = fresh('plugin');
  write(path.join(t, 'config.json'), '{"routes":[]}\n', 0o600);
  rows.push(['target has config', 'skipped config-present not-owed -', outcome(runImport(t, h.home))]);
  rows.push(['no standalone dir', 'skipped no-standalone-dir not-owed -', outcome(runImport(fresh('plugin'), fresh('home')))]);
  h = makeHome(); t = fresh('plugin');
  fs.rmSync(path.join(h.src, 'config.json'));
  rows.push(['standalone dir without a config', 'skipped no-standalone-config not-owed -', outcome(runImport(t, h.home))]);
  h = makeHome();
  rows.push(['standalone dir is the target', 'skipped same-dir not-owed -', outcome(runImport(h.src, h.home))]);
  h = makeHome(); t = fresh('plugin');
  rows.push(['copied', 'copied  not-owed -', outcome(runImport(t, h.home))]);
  // OWED, notice says it retries by itself (transient)
  h = makeHome(); t = fresh('plugin');
  const heldTarget = lockLib.acquireMutationLock(t);
  rows.push(['target lock busy', 'skipped lock-busy owed -', outcome(runImport(t, h.home))]);
  heldTarget.release();
  h = makeHome(); t = fresh('plugin');
  const heldSource = lockLib.acquireMutationLock(h.src);
  rows.push(['source lock busy', 'skipped source-lock-busy owed -', outcome(runImport(t, h.home))]);
  heldSource.release();
  if (!isRoot) {
    h = makeHome(); t = fresh('plugin');
    fs.chmodSync(path.join(h.src, 'secrets', 'minimax-token-plan.enc'), 0o000);
    rows.push(['unreadable secret', 'failed source-unreadable owed transient', outcome(runImport(t, h.home))]);
    fs.chmodSync(path.join(h.src, 'secrets', 'minimax-token-plan.enc'), 0o600);
  }
  h = makeHome(); t = fresh('plugin');
  rows.push(['write fails', 'failed copy-failed owed transient', outcome(runImport(t, h.home, { writeFile: () => { throw new Error('EIO'); } }))]);
  // OWED, notice says it needs a fix (permanent) — and the caller still publishes nothing
  h = makeHome(); t = fresh('plugin');
  write(path.join(h.src, 'config.json'), '[]', 0o600);
  rows.push(['source config not an object', 'failed source-config-unreadable owed permanent', outcome(runImport(t, h.home))]);
  h = makeHome(); t = fresh('plugin');
  write(path.join(h.src, 'config.json'), '{ not json', 0o600);
  rows.push(['source config corrupt', 'failed source-config-unreadable owed permanent', outcome(runImport(t, h.home))]);
  h = makeHome(); t = fresh('plugin');
  fs.symlinkSync('/etc/hosts', path.join(h.src, 'secrets', 'evil.enc'));
  rows.push(['symlink named like a ciphertext', 'failed unsafe-source owed permanent', outcome(runImport(t, h.home))]);
  h = makeHome(); t = fresh('plugin');
  write(path.join(t, 'master.key'), 'mine', 0o600);
  rows.push(['name taken in the target', 'failed target-conflict owed permanent', outcome(runImport(t, h.home))]);
  h = makeHome(); t = fresh('plugin');
  rows.push(['source swapped while read', 'failed source-changed owed permanent', outcome(runImport(t, h.home, {
    beforeSourceRecheck: ({ source }) => { fs.renameSync(path.join(source, 'secrets'), path.join(source, 'secrets.real')); fs.symlinkSync('secrets.real', path.join(source, 'secrets')); },
  }))]);
  if (!isRoot) {
    h = makeHome(); t = fresh('plugin');
    fs.chmodSync(h.src, 0o500);
    try { rows.push(['source dir cannot hold a lock', 'failed source-lock-unavailable owed permanent', outcome(runImport(t, h.home))]); } finally { fs.chmodSync(h.src, 0o700); }
  }
  for (const [name, want, got] of rows) assert.strictEqual(got, want, name);
});

test('a source mid-publish (config.json.prev only) counts as present: it is copied, never "absent"', () => {
  const { home, src } = makeHome();
  fs.renameSync(path.join(src, 'config.json'), path.join(src, 'config.json.prev'));
  const target = fresh('plugin');
  const r = runImport(target, home);
  assert.strictEqual(r.status, 'copied', JSON.stringify(r));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')), SOURCE_DOC);
});

test('a source mid-publish with its lock busy is OWED, not "no standalone config"', () => {
  const { home, src } = makeHome();
  fs.renameSync(path.join(src, 'config.json'), path.join(src, 'config.json.prev'));
  const held = lockLib.acquireMutationLock(src);
  try {
    const r = runImport(fresh('plugin'), home);
    assert.deepStrictEqual([r.status, r.reason, r.owed], ['skipped', 'source-lock-busy', true]);
  } finally { held.release(); }
});

test('a read-only (0500) secrets/ is copied: written 0700, its mode applied afterwards', { skip: isRoot }, () => {
  const { home, src } = makeHome();
  fs.chmodSync(path.join(src, 'secrets'), 0o500);
  const target = fresh('plugin');
  try {
    const r = runImport(target, home);
    assert.strictEqual(r.status, 'copied', JSON.stringify(r));
    assert.strictEqual(mode(path.join(target, 'secrets')), 0o500);
    assert.strictEqual(fs.readFileSync(path.join(target, 'secrets', 'kimi-code-plan.enc'), 'utf8'), SECRETS['kimi-code-plan.enc']);
  } finally {
    fs.chmodSync(path.join(src, 'secrets'), 0o700);
    if (fs.existsSync(path.join(target, 'secrets'))) fs.chmodSync(path.join(target, 'secrets'), 0o700);
  }
});

test('a failure AFTER the 0500 mode was applied still rolls everything back (rollback restores 0700 first)', { skip: isRoot }, () => {
  const { home, src } = makeHome();
  fs.chmodSync(path.join(src, 'secrets'), 0o500);
  const target = fresh('plugin');
  try {
    const r = runImport(target, home, { saveConfig: () => { throw new Error('boom'); } });
    assert.deepStrictEqual([r.status, r.reason, r.owed], ['failed', 'copy-failed', true]);
    assertNothingCopied(target, 'rollback of a 0500 directory');
  } finally { fs.chmodSync(path.join(src, 'secrets'), 0o700); }
});

test('an EACCES on the very first lstat of the standalone dir is a fixed outcome, never a thrown error', { skip: isRoot }, () => {
  const { home } = makeHome();
  fs.chmodSync(home, 0o000); // lstat of <home>/.view-limits now fails with EACCES
  const target = fresh('plugin');
  let r;
  try { r = runImport(target, home); } finally { fs.chmodSync(home, 0o700); }
  assert.deepStrictEqual([r.status, r.reason, r.owed], ['failed', 'source-unreadable', true]);
  assertNothingCopied(target, 'unreadable root');
});

console.log('\nimport — B3: the source lock, then the target lock');

test('a source lock held elsewhere: copy nothing, retry; the target lock is not left held', () => {
  const { home, src } = makeHome();
  const target = fresh('plugin');
  const held = lockLib.acquireMutationLock(src);
  assert.ok(held.ok);
  try {
    const r = runImport(target, home);
    assert.deepStrictEqual([r.status, r.reason, r.owed], ['skipped', 'source-lock-busy', true]);
    assert.deepStrictEqual(tree(target), []);
  } finally { held.release(); }
  const free = lockLib.acquireMutationLock(target);
  assert.ok(free.ok, 'the target lock was never taken, or was released');
  free.release();
});

test('the order is source first: a held TARGET lock with a free source ends lock-busy, partial files none, source lock released', () => {
  const { home, src } = makeHome();
  const target = fresh('plugin');
  const held = lockLib.acquireMutationLock(target);
  assert.ok(held.ok);
  try {
    const r = runImport(target, home);
    assert.deepStrictEqual([r.status, r.reason, r.owed], ['skipped', 'lock-busy', true]);
    assert.deepStrictEqual(tree(target), []);
  } finally { held.release(); }
  const free = lockLib.acquireMutationLock(src);
  assert.ok(free.ok, 'the source lock it had taken first was released on the way out');
  free.release();
});

test('both locks are held while the source is read and the target is written', () => {
  const { home, src } = makeHome();
  const target = fresh('plugin');
  let sawSourceBusy = null;
  let sawTargetBusy = null;
  const r = runImport(target, home, {
    beforeSourceRecheck: () => {
      // Another process's view: neither lock can be taken while the snapshot is open.
      const a = lockLib.acquireMutationLock(src);
      const b = lockLib.acquireMutationLock(target);
      sawSourceBusy = !a.ok; sawTargetBusy = !b.ok;
      if (a.ok) a.release();
      if (b.ok) b.release();
    },
  });
  assert.strictEqual(r.status, 'copied', JSON.stringify(r));
  assert.deepStrictEqual([sawSourceBusy, sawTargetBusy], [true, true]);
  assert.ok(lockLib.acquireMutationLock(src).ok && lockLib.acquireMutationLock(target).ok, 'both released afterwards');
});

console.log('\nimport — B4: the source directories are checked again after they are read');

test('secrets/ swapped for a symlink between the check and the recheck: copy nothing, permanent', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = runImport(target, home, {
    beforeSourceRecheck: ({ source }) => {
      const decoy = path.join(path.dirname(source), 'decoy-secrets');
      fs.mkdirSync(decoy);
      fs.renameSync(path.join(source, 'secrets'), path.join(path.dirname(source), 'moved-secrets'));
      fs.symlinkSync(decoy, path.join(source, 'secrets'));
    },
  });
  assert.deepStrictEqual([r.status, r.reason, r.owed], ['failed', 'source-changed', true]);
  assertNothingCopied(target, 'swapped secrets/');
});

test('secrets/ replaced by a different real directory (new inode) is also refused', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const r = runImport(target, home, {
    beforeSourceRecheck: ({ source }) => {
      fs.renameSync(path.join(source, 'secrets'), path.join(path.dirname(source), 'old-secrets'));
      fs.mkdirSync(path.join(source, 'secrets'));
    },
  });
  assert.strictEqual(r.reason, 'source-changed');
  assertNothingCopied(target, 'replaced secrets/');
});

test('the standalone root swapped for a symlink to a copy is refused', () => {
  const { home, src } = makeHome();
  const target = fresh('plugin');
  const r = runImport(target, home, {
    beforeSourceRecheck: ({ source }) => {
      fs.renameSync(source, `${source}.real`);
      fs.symlinkSync(`${source}.real`, src);
    },
  });
  assert.strictEqual(r.reason, 'source-changed');
  assertNothingCopied(target, 'swapped root');
});

test('secrets/ that appears during the read is refused too (absent before, present after)', () => {
  const { home, src } = makeHome({ master: null, secrets: {} });
  fs.rmSync(path.join(src, 'secrets'), { recursive: true });
  const target = fresh('plugin');
  const r = runImport(target, home, { beforeSourceRecheck: ({ source }) => fs.mkdirSync(path.join(source, 'secrets')) });
  assert.strictEqual(r.reason, 'source-changed');
  assertNothingCopied(target, 'appearing secrets/');
});

test('secrets/ already a symlink before the traversal is refused up front', () => {
  const { home, src } = makeHome();
  fs.renameSync(path.join(src, 'secrets'), path.join(home, 'real-secrets'));
  fs.symlinkSync(path.join(home, 'real-secrets'), path.join(src, 'secrets'));
  const target = fresh('plugin');
  assert.deepStrictEqual([runImport(target, home).reason], ['unsafe-source']);
  assertNothingCopied(target, 'symlinked secrets/');
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
  fs.symlinkSync('/etc/hosts', path.join(src, 'secrets', 'evil.enc'));
  const target = fresh('plugin');
  const r = cli(['--data-dir', target, '--claude-plugin', 'config'], { home });
  assert.ok([0, 9].includes(r.status), r.stderr); // the command then runs on the unconfigured dir
  assert.match(r.stderr, /^view-limits: could not copy your existing settings .* nothing was copied.* \(reason: unsafe-source\)$/m);
  assert.ok(!r.stderr.includes(home), 'no path in the notice');
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


console.log('\nimport — B2 through the CLI: an owed import holds the vault migration back');

// The hook against a fresh dir, with the vault faked EMPTY (no Keychain read) —
// the case where the migration would publish {routes: []} and disarm the import.
const hook = (target, home, extra = {}) =>
  cli(['--data-dir', target, '--claude-plugin', 'session-start'], { home, env: { NODE_OPTIONS: `--require=${BARRIER}`, ...extra } });

test('an unreadable source secret and an empty Keychain: nothing is published, the import retries and then copies', { skip: process.getuid && process.getuid() === 0 }, () => {
  const { home, src } = makeHome();
  const target = fresh('plugin');
  const secret = path.join(src, 'secrets', 'minimax-token-plan.enc');
  fs.chmodSync(secret, 0o000);
  try {
    const r = hook(target, home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(tree(target), [], 'no config.json: the migration did not publish {routes: []}');
    assert.match(r.stderr, /could not copy your existing settings .*this retries on the next command/);
    assert.match(r.stdout, /could not copy your existing settings/, 'session-start also says so in its systemMessage');
    const again = hook(target, home);
    assert.deepStrictEqual(tree(target), [], 'still pending, still nothing published');
    assert.strictEqual(again.status, 0);
  } finally { fs.chmodSync(secret, 0o600); }
  const fixed = hook(target, home);
  assert.match(fixed.stderr, /copied your existing settings/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')), SOURCE_DOC);
});

test('a config-changing command is refused while the import is owed, with nothing written', { skip: process.getuid && process.getuid() === 0 }, () => {
  const { home, src } = makeHome();
  const target = fresh('plugin');
  const secret = path.join(src, 'secrets', 'minimax-token-plan.enc');
  fs.chmodSync(secret, 0o000);
  try {
    const r = cli(['--data-dir', target, '--claude-plugin', 'provider', 'remove', 'nope'], { home, env: { NODE_OPTIONS: `--require=${BARRIER}` } });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /have not been copied into the plugin data folder yet/);
    assert.deepStrictEqual(tree(target), []);
  } finally { fs.chmodSync(secret, 0o600); }
});

test('a hook whose import finds the TARGET lock busy does not migrate either; it copies once the lock is free', () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  const held = lockLib.acquireMutationLock(target); // another process, as the CLI sees it
  try {
    const r = hook(target, home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(tree(target), [], 'no migrated config.json');
    assert.strictEqual(r.stdout, '', 'a busy lock is another process at work: session-start says nothing');
  } finally { held.release(); }
  assert.match(hook(target, home).stderr, /copied your existing settings/);
});

test('a hook whose import finds the SOURCE lock busy does not migrate either', () => {
  const { home, src } = makeHome();
  const target = fresh('plugin');
  const held = lockLib.acquireMutationLock(src);
  try {
    const r = hook(target, home);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(tree(target), []);
    assert.strictEqual(r.stdout, '');
  } finally { held.release(); }
  assert.match(hook(target, home).stderr, /copied your existing settings/);
});

test('a PERMANENT source problem (corrupt standalone config): no migration, no publish, the refused notice; moving it aside lets migration run', () => {
  const { home, src } = makeHome();
  write(path.join(src, 'config.json'), '{ not json', 0o600);
  const target = fresh('plugin');
  const r = hook(target, home);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /Fix the standalone folder or move it aside, then rerun\. \(reason: source-config-unreadable\)/);
  assert.match(r.stdout, /\(reason: source-config-unreadable\)/, 'session-start says the same in its systemMessage');
  assert.deepStrictEqual(tree(target), [], 'nothing published over the owed import: no migrated {routes: []}');
  assert.deepStrictEqual(tree(target), [], 'and again on the next run');
  hook(target, home);
  assert.deepStrictEqual(tree(target), []);
  // The escape hatch: the user moves the standalone folder aside. The import is
  // no longer owed, and the migration runs exactly as it always did.
  fs.renameSync(src, `${src}.moved-aside`);
  const after = hook(target, home);
  assert.strictEqual(after.status, 0, after.stderr);
  assert.doesNotMatch(after.stderr, /could not copy/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'), 'utf8')), { routes: [] });
});

test('a config-changing command is refused for a PERMANENT problem too', () => {
  const { home, src } = makeHome();
  fs.symlinkSync('/etc/hosts', path.join(src, 'secrets', 'evil.enc'));
  const target = fresh('plugin');
  const r = cli(['--data-dir', target, '--claude-plugin', 'provider', 'remove', 'nope'], { home, env: { NODE_OPTIONS: `--require=${BARRIER}` } });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /have not been copied into the plugin data folder yet/);
  assert.deepStrictEqual(tree(target), []);
});

test('stray names in the standalone folder do not hold anything back: the hook copies', () => {
  const { home, src } = makeHome();
  write(path.join(src, 'secrets', '.DS_Store'), 'x', 0o600);
  write(path.join(src, 'secrets', 'notes.txt'), 'x', 0o600);
  const target = fresh('plugin');
  assert.match(hook(target, home).stderr, /copied your existing settings/);
  assert.ok(tree(target).includes('secrets/kimi-code-plan.enc'));
});

test('an unreadable HOME entry (EACCES on the first lstat) prints the fixed notice: no stack, no path', { skip: isRoot }, () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  fs.chmodSync(home, 0o000);
  let r;
  try { r = hook(target, home); } finally { fs.chmodSync(home, 0o700); }
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not copy your existing settings .*\(reason: source-unreadable\)/);
  assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at |EACCES|Error:/, 'no raw stack or errno');
  assert.ok(!(r.stderr + r.stdout).includes(home), 'no path');
  assert.deepStrictEqual(tree(target), []);
});

console.log('\nnotices — owner ruling Q43-A, pinned byte for byte');

const FINAL = {
  copied: 'copied your existing settings from the standalone data folder into the plugin data folder.',
  failed: 'could not copy your existing settings from the standalone data folder into the plugin data folder — nothing was copied; this retries on the next command.',
  refused: 'could not copy your existing settings from the standalone data folder into the plugin data folder — nothing was copied. Fix the standalone folder or move it aside, then rerun.',
  pending: 'not run: your existing settings have not been copied into the plugin data folder yet, and this command would change the configuration before they are. Nothing was written. Rerun this command in a moment; if this keeps happening, run /view-limits to see why the copy failed.',
};

test('1. copied: exact text, no reason code', () => {
  assert.strictEqual(noticeFor('copied'), FINAL.copied);
  assert.strictEqual(noticeFor('copied', 'copy-failed'), FINAL.copied);
});

test('2. failed (retries) and 3. refused (permanent): exact text + " (reason: <code>)" for EVERY reason the importer can return', () => {
  assert.ok(REASONS.length >= 9);
  for (const code of REASONS) {
    assert.match(code, /^[a-z]+(-[a-z]+)*$/, 'a reason code is a fixed slug, never a path or errno');
    assert.strictEqual(noticeFor('failed', code), `${FINAL.failed} (reason: ${code})`);
    assert.strictEqual(noticeFor('refused', code), `${FINAL.refused} (reason: ${code})`);
  }
  assert.strictEqual(noticeFor('failed', '/tmp/x/.view-limits: EIO'), `${FINAL.failed} (reason: source-unreadable)`,
    'anything that is not a known code collapses to a fixed one');
});

test('every failed outcome the importer actually returns carries a known reason code', () => {
  const seen = new Set();
  const note = (r) => { if (r.status === 'failed') seen.add(r.reason); };
  let h = makeHome(); let t = fresh('plugin');
  fs.symlinkSync('/etc/hosts', path.join(h.src, 'secrets', 'evil.enc')); note(runImport(t, h.home));
  h = makeHome(); t = fresh('plugin'); write(path.join(h.src, 'config.json'), '[]', 0o600); note(runImport(t, h.home));
  h = makeHome(); t = fresh('plugin'); write(path.join(t, 'master.key'), 'x', 0o600); note(runImport(t, h.home));
  h = makeHome(); t = fresh('plugin'); note(runImport(t, h.home, { writeFile: () => { throw new Error('EIO'); } }));
  h = makeHome(); t = fresh('plugin');
  note(runImport(t, h.home, { beforeSourceRecheck: ({ source }) => { fs.renameSync(path.join(source, 'secrets'), path.join(source, 's.real')); fs.symlinkSync('s.real', path.join(source, 'secrets')); } }));
  if (!isRoot) {
    h = makeHome(); t = fresh('plugin'); fs.chmodSync(h.home, 0o000);
    try { note(runImport(t, h.home)); } finally { fs.chmodSync(h.home, 0o700); }
    h = makeHome(); t = fresh('plugin'); fs.chmodSync(h.src, 0o500);
    try { note(runImport(t, h.home)); } finally { fs.chmodSync(h.src, 0o700); }
  }
  for (const code of seen) assert.ok(REASONS.includes(code), `${code} is not in REASONS`);
  assert.ok(seen.size >= (isRoot ? 5 : 7), `exercised ${[...seen].join(', ')}`);
});

test('4. the pending refusal is exact text on the CLI, and each printed failure line ends in its reason code', () => {
  const { home, src } = makeHome();
  fs.symlinkSync('/etc/hosts', path.join(src, 'secrets', 'evil.enc'));
  const target = fresh('plugin');
  const r = cli(['--data-dir', target, '--claude-plugin', 'provider', 'remove', 'nope'], { home, env: { NODE_OPTIONS: `--require=${BARRIER}` } });
  const lines = r.stderr.split('\n');
  assert.ok(lines.includes(`view-limits: ${FINAL.refused} (reason: unsafe-source)`), r.stderr);
  assert.ok(lines.includes(`view-limits: ${FINAL.pending}`), r.stderr);
});

test('the transient CLI line is the exact "failed" text with its reason code', { skip: isRoot }, () => {
  const { home } = makeHome();
  const target = fresh('plugin');
  fs.chmodSync(home, 0o000);
  let r;
  try { r = hook(target, home); } finally { fs.chmodSync(home, 0o700); }
  assert.ok(r.stderr.split('\n').includes(`view-limits: ${FINAL.failed} (reason: source-unreadable)`), r.stderr);
});

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
      // The loser's import found a lock busy (or the finished document), and a
      // process whose import is still owed does not run the vault migration, so
      // there is always exactly one copy and never a migrated {routes: []}.
      assert.strictEqual(copies, 1, `hooks round ${i}: expected exactly one copy, got ${copies}\n${a.err}\n${b.err}`);
      copiedRounds += 1;
      assert.deepStrictEqual(doc, SOURCE_DOC, `hooks round ${i}`);
      assert.ok(got.includes('master.key') && got.includes('secrets/kimi-code-plan.enc'), `hooks round ${i}: vault files travelled with the document`);
    }
    console.log(`  ✓ ${ROUNDS} rounds of refresh --session-start + session-start together: exactly one copy, config and vault files together, no migration published in its place (${copiedRounds}/${ROUNDS})`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ concurrency\n    ${e.stack || e.message}`);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} standalone-import test(s) failed`); process.exit(1); }
  console.log('\nstandalone import: ok');
})();
