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
// OWED. The import is owed when the target has no config.json AND the source
// has one. "The source has one" is proven with the #81 strict reader
// (config.readConfigTextIn, which also knows config.json.prev, the document of a
// swap in flight) under the SOURCE's mutation lock — never by a bare stat. The
// source is absent only when that reader proves it under the lock.
//
// While the import is owed and did not complete, for ANY reason, the caller
// (bin/vl.js) runs no vault migration and no config-writing command: whatever
// they published would make the target "present" and disarm the import for
// good. Nothing is published over an owed import. The way out is to fix the
// standalone folder or move it aside (the source is then absent, the import is
// not owed, and the migration runs as it always did). Each outcome carries
// `owed`, and a `class` that only picks which notice is printed.
//
// What is copied — durable user state only, and every name is explicit:
//
//   master.key        the file-vault master key (credential material)
//   secrets/*.enc     the file-vault ciphertexts (credential material)
//   config.json       routes, endpoints, TTLs — published LAST
//
// Every other name, in the root and in secrets/ alike (.DS_Store, notes, a
// writer's temp file, runtime state), is ignored — never copied and never a
// reason to refuse. Keychain-backed credentials are keyed by account + the
// constant service name in config.json, not by data dir, so there is nothing to
// copy for them: the copied config.json refers to the same entries.
//
// Safety:
//   * the mutation locks (lib/lock.js) of BOTH dirs are held while the source
//     is snapshotted and the target is written, taken in a fixed order: the
//     source's, then the target's. A concurrent SessionStart hook either finds
//     a lock busy (copies nothing, retries next command) or finds config.json
//     present, so two processes copy at most once; and a `provider add`
//     running in the standalone dir cannot publish a route between the
//     snapshot of its secrets/ and the read of its config.json. Neither lock
//     ever waits, so the order cannot deadlock.
//   * config.json is published through saveConfig with FIRST_PUBLISH — the
//     create-only link of the #81 protocol — so a document that appears in the
//     meantime is never replaced.
//   * everything is READ and checked before anything is written; every file is
//     created exclusively (never overwrites a pre-existing target file),
//     owned from that create, and verified by content hash and mode. On ANY
//     failure the files and directories this run created are removed, vault
//     files included.
//   * target directories are created 0700 and the source's mode is applied
//     AFTER their files are written, so a read-only (0500) source secrets/ does
//     not make every run fail; rollback restores 0700 before it unlinks.
//   * a copied entry that is a symlink or not a regular file fails closed.
//
// DOCUMENTED LIMIT. The source directories are lstat'd (a symlink is refused),
// the files are opened with O_NOFOLLOW and checked against the inode that was
// lstat'd, and the root and secrets/ identities are compared again before
// anything is written. That is hygiene, not a boundary: a swap-read-restore of
// secrets/ passes it, and Node has no openat to anchor the traversal. It adds
// no security boundary to close it, because a process able to swap
// ~/.view-limits/secrets runs as the same user and can already write those
// files, the master key and the config itself.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('./config');

const STANDALONE_DIR_NAME = '.view-limits';
const MASTER_KEY_FILE = 'master.key';
const SECRETS_DIR = 'secrets';
const VAULT_FILE = /^[A-Za-z0-9._-]+\.enc$/;

// ---- notices ---------------------------------------------------------------------
//
// Fixed text (owner ruling Q43-A): no path, no errno, no credential material.
// The two failure notices end with `(reason: <code>)`, and <code> is always one
// of REASONS below — never free text.
const NOTICE_TEXT = Object.freeze({
  copied: 'copied your existing settings from the standalone data folder into the plugin data folder.',
  failed: 'could not copy your existing settings from the standalone data folder into the plugin data folder — nothing was copied; this retries on the next command.',
  refused: 'could not copy your existing settings from the standalone data folder into the plugin data folder — nothing was copied. Fix the standalone folder or move it aside, then rerun.',
});

// Every `reason` a failed outcome can carry.
const REASONS = Object.freeze([
  'source-unreadable', 'copy-failed', 'config-unreadable', 'source-config-unreadable',
  'unsafe-source', 'source-changed', 'target-conflict', 'source-lock-unavailable', 'target-mismatch',
]);

// kind: 'copied' | 'failed' (retries by itself) | 'refused' (needs a fix).
function noticeFor(kind, reason) {
  if (kind === 'copied') return NOTICE_TEXT.copied;
  const code = REASONS.includes(reason) ? reason : 'source-unreadable';
  return `${NOTICE_TEXT[kind]} (reason: ${code})`;
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- outcomes --------------------------------------------------------------------

const notOwed = (reason) => ({ status: 'skipped', reason, owed: false });
const owedSkip = (reason) => ({ status: 'skipped', reason, owed: true });
// class: 'transient' (a later run can succeed by itself) or 'permanent' (it
// needs a fix). It selects the notice and nothing else.
const owedFail = (reason, cls = 'transient') => ({ status: 'failed', reason, owed: true, class: cls });

function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

// The source was swapped for something else while it was being read.
class SourceChanged extends Error {}
// A name is already taken in the target, or the publish was refused: the same on
// every retry until somebody fixes the plugin dir.
class TargetConflict extends Error {}

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

// The files to copy, read fully into memory, or a refusal. Nothing is written
// here. Every lstat, readdir and open of the source is in this function's error
// boundary: whatever throws becomes a fixed outcome, never a raw stack.
function readSource(source, deps) {
  try {
    const rootBefore = lstatOrNull(source);
    if (!rootBefore || !rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return { refuse: 'unsafe-source', cls: 'permanent' };
    const secretsDir = path.join(source, SECRETS_DIR);
    const secretsBefore = lstatOrNull(secretsDir);
    if (secretsBefore && (!secretsBefore.isDirectory() || secretsBefore.isSymbolicLink())) return { refuse: 'unsafe-source', cls: 'permanent' };

    const items = [];
    const readItem = (rel) => {
      const file = path.join(source, rel);
      const st = lstatOrNull(file);
      if (!st) throw new SourceChanged('file vanished');
      if (!st.isFile()) return null;
      return { rel, ...readRegular(file, st) };
    };

    if (lstatOrNull(path.join(source, MASTER_KEY_FILE))) {
      const item = readItem(MASTER_KEY_FILE);
      if (!item) return { refuse: 'unsafe-source', cls: 'permanent' };
      items.push(item);
    }
    if (secretsBefore) {
      for (const name of fs.readdirSync(secretsDir).sort()) {
        if (!VAULT_FILE.test(name)) continue; // not a ciphertext: ignored, never a refusal
        const item = readItem(path.join(SECRETS_DIR, name));
        if (!item) return { refuse: 'unsafe-source', cls: 'permanent' };
        items.push(item);
      }
    }

    if (deps.beforeSourceRecheck) deps.beforeSourceRecheck({ source });
    // Everything has been read and nothing is written yet: the directories must
    // still be the ones that were checked, or what was read is not trusted.
    if (!sameDirectory(source, rootBefore) || !sameDirectory(secretsDir, secretsBefore)) {
      return { refuse: 'source-changed', cls: 'permanent' };
    }
    return { items, secretsMode: secretsBefore ? secretsBefore.mode & 0o777 : 0o700, hasSecretsDir: !!secretsBefore };
  } catch (e) {
    if (e instanceof SourceChanged || (e && e.code === 'ELOOP')) return { refuse: 'source-changed', cls: 'permanent' };
    return { refuse: 'source-unreadable', cls: 'transient' }; // I/O error, permission, a file gone mid-read
  }
}

// Lock errors that no amount of waiting fixes: the directory cannot be written
// to at all. Only the notice differs; the import stays owed either way.
const LOCK_UNFIXABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR']);

// fs.writeSync may write less than asked.
function writeAll(fd, buf) {
  let off = 0;
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
}

/**
 * @param {{target:string, home?:string}} options  target is the plugin data dir;
 *   dataDir() MUST already resolve to it. home is injectable for tests.
 * @param {{saveConfig?:Function, acquireMutationLock?:Function, writeFile?:Function,
 *   beforeSourceRecheck?:Function}} [deps]  test seams
 * @returns {{status:'copied'|'skipped'|'failed', reason?:string, owed:boolean,
 *   class?:'transient'|'permanent', copied?:string[]}}
 *   `owed: true` means the import is still to be done: the caller publishes nothing.
 */
function importStandalone(options, deps = {}) {
  try {
    return runImport(options, deps);
  } catch {
    // Anything the steps below did not map themselves: one fixed outcome, no
    // stack and no path. The import stays owed.
    return owedFail('source-unreadable');
  }
}

function runImport(options, deps) {
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
  if (path.resolve(config.dataDir()) !== target) return owedFail('target-mismatch', 'permanent');
  if (path.resolve(source) === target) return notOwed('same-dir');

  // Cheap exit, and the common one after the first run: one stat.
  const before = config.configPresence();
  if (before === 'present') return notOwed('config-present');
  if (before !== 'absent') return owedFail('config-unreadable');

  // A standalone dir that does not exist cannot hold a lock or a config. (One
  // that is created a moment later is picked up by the next command, as long as
  // nothing was published over it meanwhile.)
  const sourceStat = lstatOrNull(source);
  if (!sourceStat) return notOwed('no-standalone-dir');
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return owedFail('unsafe-source', 'permanent');

  // Lock order is FIXED: the source's mutation lock, then the target's. No other
  // code path holds two data-dir locks (each process locks only dataDir()) and
  // neither acquire waits, so this cannot deadlock.
  const sourceLock = acquireMutationLock(source);
  if (!sourceLock.ok) {
    if (sourceLock.error === 'held') return owedSkip('source-lock-busy');
    return owedFail('source-lock-unavailable', LOCK_UNFIXABLE.has(sourceLock.error) ? 'permanent' : 'transient');
  }
  try {
    // Is there a source document? Decided by the #81 strict reader, under the
    // source lock we now hold: config.json, or config.json.prev while a swap is
    // in flight, and absent only when that is proven (ENOENT).
    let text;
    try {
      text = config.readConfigTextIn(source, { strict: true });
    } catch (e) {
      if (e && e.code === 'ENOENT') return notOwed('no-standalone-config');
      return owedFail('source-unreadable');
    }
    for (const name of ['config.json', 'config.json.prev']) {
      const st = lstatOrNull(path.join(source, name));
      if (st && !st.isFile()) return owedFail('unsafe-source', 'permanent');
    }
    let doc;
    try { doc = JSON.parse(text); } catch { return owedFail('source-config-unreadable', 'permanent'); }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return owedFail('source-config-unreadable', 'permanent');

    const held = acquireMutationLock(target);
    if (!held.ok) return owedSkip('lock-busy');

    const createdFiles = [];
    const createdDirs = [];
    try {
      // A hook that won the lock before us has published a document: that is
      // the user's state now.
      const now = config.configPresence();
      if (now === 'present') return notOwed('config-present');
      if (now !== 'absent') return owedFail('config-unreadable');

      const plan = readSource(source, deps);
      if (plan.refuse) return owedFail(plan.refuse, plan.cls);

      try {
        if (plan.items.length) fs.mkdirSync(target, { recursive: true });
        let madeSecretsDir = null;
        if (plan.items.some((i) => i.rel.startsWith(SECRETS_DIR + path.sep))) {
          const dir = path.join(target, SECRETS_DIR);
          const existed = lstatOrNull(dir);
          if (!existed) {
            // 0700 whatever the source says: a 0500 directory could not be
            // written into. The source's mode is applied after its files.
            fs.mkdirSync(dir, { mode: 0o700 });
            fs.chmodSync(dir, 0o700);
            createdDirs.push(dir);
            madeSecretsDir = dir;
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
        if (madeSecretsDir) {
          fs.chmodSync(madeSecretsDir, plan.secretsMode);
          if ((fs.lstatSync(madeSecretsDir).mode & 0o777) !== plan.secretsMode) throw new Error('verify failed');
        }
        // The document goes last: until it exists the target still reads as
        // "never set up", so a half-finished copy is never mistaken for state.
        const cfgFile = path.join(target, 'config.json');
        try {
          saveConfig(doc, { capability: config.FIRST_PUBLISH });
        } catch (e) {
          if (e && (e.code === 'EEXIST' || e.code === 'CONFIG_LINK_UNSUPPORTED')) throw new TargetConflict('publish refused');
          throw e;
        }
        // Recorded only once it exists: a refused create-only publish must not
        // make the rollback remove a document this run did not write.
        createdFiles.push(cfgFile);
        const published = JSON.parse(readRegular(cfgFile).buf.toString('utf8'));
        if (JSON.stringify(published) !== JSON.stringify(doc)) throw new Error('verify failed');
      } catch (e) {
        rollback(createdFiles, createdDirs);
        return e instanceof TargetConflict ? owedFail('target-conflict', 'permanent') : owedFail('copy-failed');
      }
      return { status: 'copied', owed: false, copied: plan.items.map((i) => i.rel).concat('config.json') };
    } finally {
      held.release();
    }
  } finally {
    sourceLock.release();
  }
}

// Removes exactly what this run created, newest first. The caller holds the
// mutation lock, so no in-protocol writer can be using these names. A directory
// whose source mode was already applied (0500) is made writable again first.
function rollback(files, dirs) {
  for (const d of dirs) {
    try { fs.chmodSync(d, 0o700); } catch { /* never created, or already gone */ }
  }
  for (const f of files.reverse()) {
    try { fs.unlinkSync(f); } catch { /* never created, or already gone */ }
  }
  for (const d of dirs.reverse()) {
    try { fs.rmdirSync(d); } catch { /* not empty: someone else's file is in it */ }
  }
}

module.exports = { importStandalone, noticeFor, NOTICE_TEXT, REASONS, STANDALONE_DIR_NAME };
