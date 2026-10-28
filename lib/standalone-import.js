'use strict';
// One-time import of the standalone data dir (~/.view-limits) into the Claude
// plugin's data dir (Issue #148, owner rulings Q41-A / Q42-A).
//
// Before this, slash commands and the hooks of one install could resolve two
// different data dirs, so the settings a user made standalone were not seen by
// the plugin. When the plugin's dir has NO config.json yet and the standalone
// dir has one, the user's durable state is copied across once, on the same
// machine.
//
// Transport-neutral: the caller (bin/vl.js) decides that this is the Claude
// path (`--claude-plugin`) and has already pointed dataDir() at `target`.
//
// What is copied — durable user state only, and every name is explicit:
//
//   master.key        the file-vault master key (credential material)
//   secrets/*.enc     the file-vault ciphertexts (credential material)
//   config.json       routes, endpoints, TTLs — published LAST
//
// Keychain-backed credentials are keyed by account + the constant service name
// in config.json, not by data dir, so there is nothing to copy for them: the
// copied config.json refers to the same entries.
//
// Everything else under a data dir is runtime state that is wrong in another
// directory (a daemon's pid and port, locks, caches) or regenerated on demand,
// and is never copied. See the classification table in the PR for #148.
//
// Safety:
//   * the mutation lock (lib/lock.js) is held from the second absence check
//     until the publish, so a concurrent SessionStart hook either finds the
//     lock busy (copies nothing, retries next command) or finds config.json
//     present. Two processes can therefore copy at most once.
//   * config.json is published through saveConfig with FIRST_PUBLISH — the
//     create-only link of the #81 protocol — so a document that appears in the
//     meantime is never replaced.
//   * everything is READ and checked before anything is written; every file is
//     created exclusively (never overwrites a pre-existing target file) and
//     verified by content hash. On ANY failure the files this run created are
//     removed, vault files included, and the notice says nothing was copied.
//   * a source entry that is a symlink or not a regular file fails closed.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('./config');

const STANDALONE_DIR_NAME = '.view-limits';
const MASTER_KEY_FILE = 'master.key';
const SECRETS_DIR = 'secrets';
const VAULT_TEMP = /\.tmp-\d+-[a-f0-9]+$/;
const VAULT_FILE = /^[A-Za-z0-9._-]+\.enc$/;

// Fixed notices: no path, no errno, no credential material.
const NOTICE = Object.freeze({
  copied: 'copied your existing settings from the standalone data folder into the plugin data folder.',
  failed: 'could not copy your existing settings from the standalone data folder into the plugin data folder — nothing was copied; this retries on the next command.',
});

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function fail(reason, extra) {
  return { status: 'failed', reason, ...extra };
}

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

// A regular file read without following a symlink, or a throw.
function readRegular(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    return { buf: fs.readFileSync(fd), mode: st.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

// What to copy, read fully into memory, or a refusal. Nothing is written here.
function readSource(source) {
  const items = [];
  const key = lstatOrNull(path.join(source, MASTER_KEY_FILE));
  if (key) {
    if (!key.isFile()) return { refuse: 'unsafe-source' };
    items.push({ rel: MASTER_KEY_FILE, ...readRegular(path.join(source, MASTER_KEY_FILE)) });
  }
  const secrets = lstatOrNull(path.join(source, SECRETS_DIR));
  let secretsMode = 0o700;
  if (secrets) {
    if (!secrets.isDirectory()) return { refuse: 'unsafe-source' };
    secretsMode = secrets.mode & 0o777;
    for (const name of fs.readdirSync(path.join(source, SECRETS_DIR)).sort()) {
      if (VAULT_TEMP.test(name)) continue; // a writer's leftover temp: not a credential
      if (!VAULT_FILE.test(name)) return { refuse: 'unexpected-source-entry' };
      const rel = path.join(SECRETS_DIR, name);
      const st = lstatOrNull(path.join(source, rel));
      if (!st || !st.isFile()) return { refuse: 'unsafe-source' };
      items.push({ rel, ...readRegular(path.join(source, rel)) });
    }
  }
  const cfg = readRegular(path.join(source, 'config.json'));
  let doc;
  try { doc = JSON.parse(cfg.buf.toString('utf8')); } catch { return { refuse: 'source-config-unreadable' }; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { refuse: 'source-config-unreadable' };
  return { items, secretsMode, doc, hasSecretsDir: !!secrets };
}

/**
 * @param {{target:string, home?:string}} options  target is the plugin data dir;
 *   dataDir() MUST already resolve to it. home is injectable for tests.
 * @param {{saveConfig?:Function, acquireMutationLock?:Function}} [deps]  test seam
 * @returns {{status:'copied'|'skipped'|'failed', reason?:string, retry?:boolean, copied?:string[]}}
 */
function importStandalone(options, deps = {}) {
  const target = path.resolve(options.target);
  const home = options.home || os.homedir();
  const source = path.join(home, STANDALONE_DIR_NAME);
  const saveConfig = deps.saveConfig || config.saveConfig;
  // lib/lock.js is required only by lib/config.js and lib/provider-lifecycle.js
  // (test/empty-defaults.test.js pin 8), so the lock comes through the latter.
  const acquireMutationLock = deps.acquireMutationLock || require('./provider-lifecycle').acquireMutationLock;

  // The publish and the presence checks resolve their directory through
  // dataDir(); refuse rather than copy into one dir and publish into another.
  if (path.resolve(config.dataDir()) !== target) return fail('target-mismatch');
  if (path.resolve(source) === target) return { status: 'skipped', reason: 'same-dir' };

  // Cheap exit, and the common one after the first run: one stat.
  const before = config.configPresence();
  if (before === 'present') return { status: 'skipped', reason: 'config-present' };
  if (before !== 'absent') return fail('config-unreadable');

  let sourceStat;
  try { sourceStat = lstatOrNull(source); } catch { return fail('unsafe-source'); }
  if (!sourceStat) return { status: 'skipped', reason: 'no-standalone-dir' };
  if (!sourceStat.isDirectory()) return fail('unsafe-source');
  let hasSourceConfig;
  try {
    const st = lstatOrNull(path.join(source, 'config.json'));
    hasSourceConfig = !!st;
    if (st && !st.isFile()) return fail('unsafe-source');
  } catch { return fail('unsafe-source'); }
  if (!hasSourceConfig) return { status: 'skipped', reason: 'no-standalone-config' };

  const held = acquireMutationLock(target);
  if (!held.ok) return { status: 'skipped', reason: 'lock-busy', retry: true };

  const createdFiles = [];
  const createdDirs = [];
  try {
    // A hook that won the lock before us has published a document: that is the
    // user's state now.
    const now = config.configPresence();
    if (now === 'present') return { status: 'skipped', reason: 'config-present' };
    if (now !== 'absent') return fail('config-unreadable');

    let plan;
    try { plan = readSource(source); } catch { return fail('source-unreadable'); }
    if (plan.refuse) return fail(plan.refuse);

    try {
      if (plan.items.length) fs.mkdirSync(target, { recursive: true });
      if (plan.hasSecretsDir && plan.items.some((i) => i.rel.startsWith(SECRETS_DIR + path.sep))) {
        const dir = path.join(target, SECRETS_DIR);
        const existed = lstatOrNull(dir);
        if (!existed) {
          fs.mkdirSync(dir, { mode: plan.secretsMode });
          createdDirs.push(dir);
        } else if (!existed.isDirectory()) {
          throw new Error('secrets is not a directory');
        }
      }
      for (const item of plan.items) {
        const file = path.join(target, item.rel);
        // 'wx': never overwrites a file that is already there, and the mode is
        // re-applied because the process umask would otherwise narrow it.
        fs.writeFileSync(file, item.buf, { flag: 'wx', mode: item.mode });
        createdFiles.push(file);
        fs.chmodSync(file, item.mode);
        const back = readRegular(file);
        if (sha(back.buf) !== sha(item.buf) || back.mode !== item.mode) throw new Error('verify failed');
      }
      // The document goes last: until it exists the target still reads as
      // "never set up", so a half-finished copy is never mistaken for state.
      const cfgFile = path.join(target, 'config.json');
      saveConfig(plan.doc, { capability: config.FIRST_PUBLISH });
      // Recorded only once it exists: a refused create-only publish must not
      // make the rollback remove a document this run did not write.
      createdFiles.push(cfgFile);
      const published = JSON.parse(readRegular(cfgFile).buf.toString('utf8'));
      if (JSON.stringify(published) !== JSON.stringify(plan.doc)) throw new Error('verify failed');
    } catch {
      rollback(createdFiles, createdDirs);
      return fail('copy-failed');
    }
    return { status: 'copied', copied: plan.items.map((i) => i.rel).concat('config.json') };
  } finally {
    held.release();
  }
}

// Removes exactly what this run created, newest first. The caller holds the
// mutation lock, so no in-protocol writer can be using these names.
function rollback(files, dirs) {
  for (const f of files.reverse()) {
    try { fs.unlinkSync(f); } catch { /* never created, or already gone */ }
  }
  for (const d of dirs.reverse()) {
    try { fs.rmdirSync(d); } catch { /* not empty: someone else's file is in it */ }
  }
}

module.exports = { importStandalone, NOTICE, STANDALONE_DIR_NAME };
