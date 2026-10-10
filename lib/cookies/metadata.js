'use strict';
// Private metadata directory/file discipline for the Xiaomi fallback's
// rejected-bundle digest and key-suppression marker.
//
// Contract (F2):
//  * The metadata directory (`dataDir/xiaomi`) is created 0700 and must be an
//    owned private directory. A pre-existing symlink, non-directory, foreign
//    uid, or non-private mode (e.g. 0755) is REFUSED — never chmodded,
//    written through, or followed. We only ever set a mode at creation time.
//  * Publication temps are unique, exclusively created (`O_CREAT|O_EXCL`) and
//    `O_NOFOLLOW`, so a pre-planted temp symlink makes the write fail instead
//    of truncating an outside target. Cleanup touches ONLY a temp that THIS
//    call exclusively created (created-by-this-call flag, verified against the
//    saved dev/ino) — a pre-existing collision (symlink OR regular file,
//    whatever its owner) is never examined-and-deleted after the refusal.
//  * Reads open with `O_NOFOLLOW` after an `lstat` type check and verify the
//    fd's identity (uid, regular file, private mode, dev/ino) before trusting
//    the content; reset/unlink refuses symlinks and non-regular/foreign files.
//  * Removal reports absence as `false` and raises a classified
//    `metadata-remove-failed` for any REAL unlink failure (e.g. EACCES in a
//    read-only private dir) — a failed deletion is never silently accepted as
//    a successful reset.
//  * Publication is atomic (write temp → validate final path → rename).
//
// Honest limit: JavaScript cannot hold a directory fd for the whole
// operation (no openat), so a determined SAME-UID process racing between our
// validation and the final rename is a best-effort window, not a universally
// raceproof guarantee. Different-uid writers are refused by ownership and
// mode checks.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class MetadataError extends Error {
  constructor(code) {
    super(code); // classified enum only — never a path or OS error text
    this.code = code;
  }
}

const O_RDONLY_NOFOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const O_WRONLY_EXCL_NOFOLLOW = fs.constants.O_WRONLY | fs.constants.O_CREAT |
  fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);

function ownerUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

// "Private" = no group/other permission bits at all.
function isPrivateMode(mode) {
  return ((mode & 0o777) & 0o077) === 0;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new MetadataError('metadata-path-unreadable');
  }
}

function validateDirStat(st) {
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new MetadataError('metadata-dir-unsafe');
  const uid = ownerUid();
  if (uid !== null && st.uid !== uid) throw new MetadataError('metadata-dir-foreign');
  if (!isPrivateMode(st.mode)) throw new MetadataError('metadata-dir-not-private');
}

// Create-if-missing then validate. Never chmods an existing directory.
function ensureOwnedDir(dirPath) {
  let st = lstatOrNull(dirPath);
  if (!st) {
    try {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw new MetadataError('metadata-dir-create-failed');
    }
    st = lstatOrNull(dirPath);
  }
  validateDirStat(st); // symlinked/pre-existing-unsafe dirs refuse here
  return dirPath;
}

function validateFileStat(st) {
  if (!st || !st.isFile() || st.isSymbolicLink()) throw new MetadataError('metadata-file-unsafe');
  const uid = ownerUid();
  if (uid !== null && st.uid !== uid) throw new MetadataError('metadata-file-foreign');
  if (!isPrivateMode(st.mode)) throw new MetadataError('metadata-file-not-private');
}

/**
 * Read a JSON metadata file only when it is an owned private regular file in
 * an owned private directory. Returns the parsed object, null when the
 * directory or file does not exist, or throws MetadataError when the path is
 * unsafe (symlink/non-regular/foreign/non-private).
 */
function readOwnedJson(filePath, dirPath) {
  const dirStat = lstatOrNull(dirPath);
  if (!dirStat) return null; // nothing stored yet
  validateDirStat(dirStat);
  const pre = lstatOrNull(filePath);
  if (!pre) return null;
  validateFileStat(pre); // refuse symlinks/FIFOs before opening (no blocking)
  let fd = null;
  try {
    fd = fs.openSync(filePath, O_RDONLY_NOFOLLOW); // ELOOP if swapped to symlink
    const st = fs.fstatSync(fd);
    validateFileStat(st);
    // Identity retention: the fd must be the same object we validated.
    if (st.ino !== pre.ino || st.dev !== pre.dev) throw new MetadataError('metadata-file-changed');
    const raw = fs.readFileSync(fd, 'utf8');
    try {
      const doc = JSON.parse(raw);
      return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
    } catch {
      return null; // malformed content is absent, not unsafe
    }
  } catch (e) {
    if (e instanceof MetadataError) throw e;
    if (e && (e.code === 'ELOOP' || e.code === 'ENOTDIR' || e.code === 'EISDIR' || e.code === 'EACCES')) {
      throw new MetadataError('metadata-file-unsafe');
    }
    throw new MetadataError('metadata-file-unreadable');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Atomically publish a JSON metadata object. The temp file is unique and
 * exclusively created (no-follow), the final path is validated (owned private
 * regular file, or absent) right before rename, and cleanup touches only the
 * temp this call created. Returns true, or throws MetadataError on refusal.
 */
function writeOwnedJson(filePath, dirPath, value) {
  ensureOwnedDir(dirPath);
  const temp = path.join(
    dirPath,
    `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  let fd = null;
  let published = false;
  // N3: cleanup eligibility. Set ONLY after the exclusive open succeeded —
  // same-uid+private at the collision path establishes user ownership, not
  // ownership by THIS write, so a refused write must not delete it.
  let createdByThisCall = false;
  let createdDev = null;
  let createdIno = null;
  try {
    fd = fs.openSync(temp, O_WRONLY_EXCL_NOFOLLOW, 0o600); // refuses planted temps
    createdByThisCall = true;
    const created = fs.fstatSync(fd); // identity of the temp WE created
    createdDev = created.dev;
    createdIno = created.ino;
    const payload = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      payload.fill(0);
    }
    fs.closeSync(fd);
    fd = null;

    const finalStat = lstatOrNull(filePath);
    if (finalStat) validateFileStat(finalStat); // refuse symlink/foreign/non-private
    fs.renameSync(temp, filePath); // atomic; rename does not follow the final component
    published = true;
    return true;
  } catch (e) {
    if (e instanceof MetadataError) throw e;
    // O_EXCL refuses any existing path (EEXIST); O_NOFOLLOW may surface ELOOP
    // for a planted symlink first — both mean "temp path already taken".
    if (e && (e.code === 'EEXIST' || e.code === 'ELOOP')) throw new MetadataError('metadata-temp-exists');
    throw new MetadataError('metadata-write-failed');
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    if (!published && createdByThisCall) {
      // Own-temp cleanup only: unlink the exact unique temp THIS call
      // created — and only while the path is still that same file (dev/ino
      // match), an owned private regular file. Anything else at the path
      // now is not ours to delete.
      try {
        const st = fs.lstatSync(temp);
        const uid = ownerUid();
        const sameFile = createdIno === null ||
          (st.ino === createdIno && st.dev === createdDev);
        if (st.isFile() && !st.isSymbolicLink() && (uid === null || st.uid === uid) &&
            isPrivateMode(st.mode) && sameFile) {
          fs.unlinkSync(temp);
        }
      } catch { /* already gone */ }
    }
  }
}

/**
 * Remove a metadata file after refusing anything that is not an owned
 * private regular file. Returns true when removed, false when genuinely
 * absent (ENOENT at lstat or at unlink). Any OTHER unlink failure (e.g.
 * EACCES inside an owned but read-only 0500 dir) throws a classified
 * MetadataError — a failed deletion is never reported as absence/success.
 * Unsafe paths throw too (a symlink is never unlinked).
 */
function removeOwnedFile(filePath, dirPath) {
  const dirStat = lstatOrNull(dirPath);
  if (!dirStat) return false; // nothing stored
  validateDirStat(dirStat);
  const st = lstatOrNull(filePath);
  if (!st) return false;
  validateFileStat(st);
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    // N1: false means ABSENT. ENOENT here is a genuine (raced) absence;
    // everything else is a real failure that callers must refuse on.
    if (e && e.code === 'ENOENT') return false;
    throw new MetadataError('metadata-remove-failed');
  }
  return true;
}

module.exports = {
  MetadataError, ensureOwnedDir, readOwnedJson, writeOwnedJson, removeOwnedFile,
  isPrivateMode, ownerUid,
};
