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
//   * the mutation locks (lib/lock.js) of BOTH dirs are held while the source
//     is snapshotted and the target is written, taken in a fixed order: the
//     source's, then the target's. A concurrent SessionStart hook either finds
//     the target lock busy (copies nothing, retries next command) or finds
//     config.json present, so two processes copy at most once; and a
//     `provider add` running in the standalone dir cannot publish a route
//     between the snapshot of its secrets/ and the read of its config.json.
//     Neither lock ever waits, so the order cannot deadlock.
//   * config.json is published through saveConfig with FIRST_PUBLISH — the
//     create-only link of the #81 protocol — so a document that appears in the
//     meantime is never replaced.
//   * everything is READ and checked before anything is written; every file is
//     created exclusively (never overwrites a pre-existing target file) and
//     verified by content hash. On ANY failure the files this run created are
//     removed, vault files included, and the notice says nothing was copied.
//   * a source entry that is a symlink or not a regular file fails closed, and
//     so does a source whose directories were swapped while they were read:
//     the identity (dev+ino) of the root and of secrets/ is captured before the
//     traversal and checked again after it, before anything is written.
//   * ownership of a file starts at its exclusive create, before the first
//     byte is written, so a write that fails halfway is still rolled back.
//
// Every non-copied outcome says whether it is TRANSIENT (`retry: true`: the same
// call can succeed later, so bin/vl.js must not run the vault migration in this
// run, or the config it publishes would disarm the import for good) or
// PERMANENT (`retry` absent: nothing will change by waiting, so the migration
// proceeds as it always did). The table is in the PR for #148.

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
  refused: 'could not copy your existing settings from the standalone data folder into the plugin data folder — nothing was copied, and this will not be retried until the standalone folder or the plugin folder is fixed.',
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

// The source was swapped for something else while it was being read. Never
// retried: a vault directory that changes under a reader is not a race to win.
class SourceChanged extends Error {}

const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

// A regular file read without following a symlink, or a throw. When `expect`
// (the lstat taken before the open) is given, the opened file must be that very
// inode: O_NOFOLLOW only guards the final path component.
function readRegular(file, expect) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new SourceChanged('not a regular file');
    if (expect && !sameFile(st, expect)) throw new SourceChanged('file replaced');
    return { buf: fs.readFileSync(fd), mode: st.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

// A directory that is still the directory (same dev+ino, not a symlink) that
// was captured before the traversal.
function sameDirectory(dir, before) {
  const now = lstatOrNull(dir);
  if (before === null) return now === null;
  return !!now && now.isDirectory() && !now.isSymbolicLink() && sameFile(now, before);
}

// What to copy, read fully into memory, or a refusal. Nothing is written here.
// Refusals: { refuse, retry? } — retry marks the transient ones.
function readSource(source, deps) {
  const rootBefore = lstatOrNull(source);
  if (!rootBefore || !rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return { refuse: 'unsafe-source' };
  const secretsDir = path.join(source, SECRETS_DIR);
  const secretsBefore = lstatOrNull(secretsDir);
  if (secretsBefore && (!secretsBefore.isDirectory() || secretsBefore.isSymbolicLink())) return { refuse: 'unsafe-source' };

  const items = [];
  const readItem = (rel) => {
    const file = path.join(source, rel);
    const st = lstatOrNull(file);
    if (!st) throw new SourceChanged('file vanished');
    if (!st.isFile()) return null;
    return { rel, ...readRegular(file, st) };
  };
  try {
    const key = lstatOrNull(path.join(source, MASTER_KEY_FILE));
    if (key) {
      const item = readItem(MASTER_KEY_FILE);
      if (!item) return { refuse: 'unsafe-source' };
      items.push(item);
    }
    if (secretsBefore) {
      for (const name of fs.readdirSync(secretsDir).sort()) {
        if (VAULT_TEMP.test(name)) continue; // a writer's leftover temp: not a credential
        if (!VAULT_FILE.test(name)) return { refuse: 'unexpected-source-entry' };
        const item = readItem(path.join(SECRETS_DIR, name));
        if (!item) return { refuse: 'unsafe-source' };
        items.push(item);
      }
    }
    const cfgStat = lstatOrNull(path.join(source, 'config.json'));
    if (!cfgStat || !cfgStat.isFile()) return { refuse: 'unsafe-source' };
    const cfg = readRegular(path.join(source, 'config.json'), cfgStat);
    let doc;
    try { doc = JSON.parse(cfg.buf.toString('utf8')); } catch { return { refuse: 'source-config-unreadable' }; }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { refuse: 'source-config-unreadable' };

    if (deps.beforeSourceRecheck) deps.beforeSourceRecheck({ source });
    // Everything has been read and nothing is written yet: the directories must
    // still be the ones that were checked, or what was read is not trusted.
    if (!sameDirectory(source, rootBefore) || !sameDirectory(secretsDir, secretsBefore)) {
      return { refuse: 'source-changed' };
    }
    return { items, secretsMode: secretsBefore ? secretsBefore.mode & 0o777 : 0o700, doc, hasSecretsDir: !!secretsBefore };
  } catch (e) {
    if (e instanceof SourceChanged || (e && e.code === 'ELOOP')) return { refuse: 'source-changed' };
    return { refuse: 'source-unreadable', retry: true }; // I/O error, permission, a file gone mid-read
  }
}

// Lock errors that no amount of waiting fixes: the directory cannot be written
// to at all. A source like that must not hold the vault migration back forever.
const LOCK_UNFIXABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR']);

/**
 * @param {{target:string, home?:string}} options  target is the plugin data dir;
 *   dataDir() MUST already resolve to it. home is injectable for tests.
 * @param {{saveConfig?:Function, acquireMutationLock?:Function, writeFile?:Function,
 *   beforeSourceRecheck?:Function}} [deps]  test seams
 * @returns {{status:'copied'|'skipped'|'failed', reason?:string, retry?:boolean, copied?:string[]}}
 *   `retry: true` marks a transient outcome (see the header).
 */
function importStandalone(options, deps = {}) {
  const target = path.resolve(options.target);
  const home = options.home || os.homedir();
  const source = path.join(home, STANDALONE_DIR_NAME);
  const saveConfig = deps.saveConfig || config.saveConfig;
  const writeFile = deps.writeFile || writeAll;
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
  if (before !== 'absent') return fail('config-unreadable', { retry: true });

  let sourceStat;
  try { sourceStat = lstatOrNull(source); } catch { return fail('source-unreadable', { retry: true }); }
  if (!sourceStat) return { status: 'skipped', reason: 'no-standalone-dir' };
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return fail('unsafe-source');
  let hasSourceConfig;
  try {
    const st = lstatOrNull(path.join(source, 'config.json'));
    hasSourceConfig = !!st;
    if (st && !st.isFile()) return fail('unsafe-source');
  } catch { return fail('source-unreadable', { retry: true }); }
  if (!hasSourceConfig) return { status: 'skipped', reason: 'no-standalone-config' };

  // The import is owed from here. Lock order is FIXED: the source's mutation
  // lock, then the target's. No other code path holds two data-dir locks (each
  // process locks only dataDir()), and neither acquire waits, so this cannot
  // deadlock. Holding the source's lock keeps a `provider add` there from
  // publishing a route between the snapshot of secrets/ and the read of
  // config.json.
  const sourceLock = acquireMutationLock(source);
  if (!sourceLock.ok) {
    if (sourceLock.error === 'held') return { status: 'skipped', reason: 'source-lock-busy', retry: true };
    return fail('source-lock-unavailable', LOCK_UNFIXABLE.has(sourceLock.error) ? {} : { retry: true });
  }
  try {
    const held = acquireMutationLock(target);
    if (!held.ok) return { status: 'skipped', reason: 'lock-busy', retry: true };

    const createdFiles = [];
    const createdDirs = [];
    try {
      // A hook that won the lock before us has published a document: that is
      // the user's state now.
      const now = config.configPresence();
      if (now === 'present') return { status: 'skipped', reason: 'config-present' };
      if (now !== 'absent') return fail('config-unreadable', { retry: true });

      const plan = readSource(source, deps);
      if (plan.refuse) return fail(plan.refuse, plan.retry ? { retry: true } : {});

      try {
        if (plan.items.length) fs.mkdirSync(target, { recursive: true });
        if (plan.hasSecretsDir && plan.items.some((i) => i.rel.startsWith(SECRETS_DIR + path.sep))) {
          const dir = path.join(target, SECRETS_DIR);
          const existed = lstatOrNull(dir);
          if (!existed) {
            fs.mkdirSync(dir, { mode: plan.secretsMode });
            createdDirs.push(dir);
          } else if (!existed.isDirectory()) {
            throw new TargetConflict('secrets is not a directory');
          }
        }
        for (const item of plan.items) {
          const file = path.join(target, item.rel);
          // O_EXCL: never overwrites a file that is already there. Ownership
          // starts HERE, before the first byte, so a write that fails halfway
          // still leaves a file the rollback knows to remove. The mode is
          // re-applied because the process umask would otherwise narrow it.
          let fd;
          try {
            fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
              | (fs.constants.O_NOFOLLOW || 0), item.mode);
          } catch (e) {
            if (e && e.code === 'EEXIST') throw new TargetConflict('target file exists');
            throw e;
          }
          createdFiles.push(file);
          try {
            writeFile(fd, item.buf);
            fs.fchmodSync(fd, item.mode);
          } finally {
            fs.closeSync(fd);
          }
          const back = readRegular(file);
          if (sha(back.buf) !== sha(item.buf) || back.mode !== item.mode) throw new Error('verify failed');
        }
        // The document goes last: until it exists the target still reads as
        // "never set up", so a half-finished copy is never mistaken for state.
        const cfgFile = path.join(target, 'config.json');
        try {
          saveConfig(plan.doc, { capability: config.FIRST_PUBLISH });
        } catch (e) {
          if (e && (e.code === 'EEXIST' || e.code === 'CONFIG_LINK_UNSUPPORTED')) throw new TargetConflict('publish refused');
          throw e;
        }
        // Recorded only once it exists: a refused create-only publish must not
        // make the rollback remove a document this run did not write.
        createdFiles.push(cfgFile);
        const published = JSON.parse(readRegular(cfgFile).buf.toString('utf8'));
        if (JSON.stringify(published) !== JSON.stringify(plan.doc)) throw new Error('verify failed');
      } catch (e) {
        rollback(createdFiles, createdDirs);
        // A name already taken in the target, or a filesystem that cannot link,
        // is the same on every retry; anything else (ENOSPC, EIO, a failed
        // verify) may not be.
        return e instanceof TargetConflict ? fail('target-conflict') : fail('copy-failed', { retry: true });
      }
      return { status: 'copied', copied: plan.items.map((i) => i.rel).concat('config.json') };
    } finally {
      held.release();
    }
  } finally {
    sourceLock.release();
  }
}

class TargetConflict extends Error {}

// fs.writeSync may write less than asked.
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
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
