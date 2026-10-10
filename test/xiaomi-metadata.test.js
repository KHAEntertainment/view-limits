'use strict';
// F2 regression tests for the Xiaomi private-metadata discipline: owned
// private dirs, exclusively-created unique temps, and symlink/foreign/
// non-regular refusal on read, write and reset. Synthetic files only — no
// Keychain fixtures, no Chrome, no helper.
//
// Honest scope (mirrors lib/cookies/metadata.js): these checks prove the
// refusal of planted paths and the preservation of external sentinels. A
// determined SAME-UID race between validation and the final rename is a
// documented best-effort window, not a universally raceproof guarantee.
//
// Run: node test/xiaomi-metadata.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  MetadataError, ensureOwnedDir, readOwnedJson, writeOwnedJson, removeOwnedFile,
} = require('../lib/cookies/metadata');
const fingerprint = require('../lib/cookies/fingerprint');
const session = require('../lib/xiaomi-session');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}
const codeOf = (fn) => {
  try { const v = fn(); return v && typeof v.then === 'function' ? v : null; }
  catch (e) { return e && e.code; }
};
const acode = async (fn) => {
  try { await fn(); return null; } catch (e) { return e && e.code; }
};

function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vl-xiaomi-meta-${name}-`));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return { root, dataDir, metaDir: path.join(dataDir, 'xiaomi') };
}

const DIGEST = 'a'.repeat(64);

(async () => {
  console.log('xiaomi metadata — owned-private discipline (F2)');

  await test('write publishes a private 0600 file in a 0700 dir; content round-trips', async () => {
    const s = scratch('happy');
    try {
      const file = path.join(s.metaDir, 'rejected.json');
      assert.strictEqual(fingerprint.writeRejected(s.dataDir, DIGEST), true);
      assert.strictEqual(fingerprint.readRejected(s.dataDir), DIGEST);
      assert.strictEqual(fs.statSync(s.metaDir).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.ok(!fs.lstatSync(file).isSymbolicLink());
      // No temp litter remains after publication.
      assert.deepStrictEqual(fs.readdirSync(s.metaDir), ['rejected.json']);
      assert.strictEqual(fingerprint.clearRejected(s.dataDir), true);
      assert.strictEqual(fingerprint.readRejected(s.dataDir), null);
      assert.strictEqual(fingerprint.clearRejected(s.dataDir), false, 'idempotent when absent');
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('planted temp symlink: exclusive unique temp refuses, external sentinel untouched', async () => {
    const s = scratch('temp-symlink');
    const origRandom = crypto.randomBytes;
    try {
      const sentinel = path.join(s.root, 'sentinel');
      fs.writeFileSync(sentinel, 'UNCHANGED', { mode: 0o644 });
      fs.mkdirSync(s.metaDir, { recursive: true, mode: 0o700 });
      // Force the temp name so we can plant a symlink at it — proving the
      // O_CREAT|O_EXCL|O_NOFOLLOW open refuses instead of truncating the
      // symlink target (the reviewer's repro).
      crypto.randomBytes = () => Buffer.alloc(8, 7);
      const hex = Buffer.alloc(8, 7).toString('hex');
      const plantedRejected = path.join(s.metaDir, `.rejected.json.${hex}.tmp`);
      const plantedSuppressed = path.join(s.metaDir, `.key-suppressed.json.${hex}.tmp`);
      fs.symlinkSync(sentinel, plantedRejected);
      fs.symlinkSync(sentinel, plantedSuppressed);
      const e1 = codeOf(() => fingerprint.writeRejected(s.dataDir, DIGEST));
      assert.strictEqual(e1, 'metadata-temp-exists', 'exclusively-created temp refuses a planted path');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED', 'sentinel must never be written through');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8').includes(DIGEST), false);
      assert.ok(!fs.existsSync(path.join(s.metaDir, 'rejected.json')), 'nothing published on refusal');
      assert.ok(fs.lstatSync(plantedRejected).isSymbolicLink(), 'planted temp link is left alone, not deleted');
      // The same discipline applies to the suppression writer.
      const e2 = codeOf(() => session.writeSuppressed(s.dataDir, 'denied'));
      assert.strictEqual(e2, 'metadata-temp-exists');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED');
    } finally {
      crypto.randomBytes = origRandom;
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('final-path symlink: write refuses, read refuses, reset refuses, sentinel untouched', async () => {
    const s = scratch('final-symlink');
    try {
      const sentinel = path.join(s.root, 'victim');
      fs.writeFileSync(sentinel, 'UNCHANGED', { mode: 0o644 });
      fs.mkdirSync(s.metaDir, { recursive: true, mode: 0o700 });
      const file = path.join(s.metaDir, 'rejected.json');
      fs.symlinkSync(sentinel, file);

      assert.strictEqual(codeOf(() => fingerprint.writeRejected(s.dataDir, DIGEST)), 'metadata-file-unsafe');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED');
      // N3: the temp THIS call created before the final-path refusal is still
      // cleaned up — cleanup is restricted to own temps, not disabled.
      assert.deepStrictEqual(fs.readdirSync(s.metaDir).filter((f) => f.endsWith('.tmp')), [],
        'own temp created by the refused write is cleaned up');
      assert.strictEqual(codeOf(() => fingerprint.readRejected(s.dataDir)), 'metadata-file-unsafe');
      assert.strictEqual(codeOf(() => fingerprint.clearRejected(s.dataDir)), 'metadata-file-unsafe');
      assert.ok(fs.lstatSync(file).isSymbolicLink(), 'refused reset must not unlink the symlink');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED');

      // Session-level: the unsafe SUPPRESSION marker (read first, before any
      // Chrome access) refuses the whole operation with one fixed message.
      fs.symlinkSync(sentinel, path.join(s.metaDir, 'key-suppressed.json'));
      const cfg = { xiaomi: { chromeSource: s.root, chromeProfile: 'Profile 46' } };
      const st = await session.fetchStatus(cfg, {}, { xiaomiDeps: { dataDir: s.dataDir } });
      assert.strictEqual(st.detail.error, session.message('metadata-unsafe'));
      assert.deepStrictEqual(st.windows, []);
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED');
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('symlinked metadata DIRECTORY: write refuses; outside dir mode/content unchanged', async () => {
    const s = scratch('dir-symlink');
    try {
      const outside = path.join(s.root, 'outside');
      fs.mkdirSync(outside, { mode: 0o755 });
      fs.mkdirSync(s.dataDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(outside, s.metaDir);

      const e1 = codeOf(() => fingerprint.writeRejected(s.dataDir, DIGEST));
      assert.strictEqual(e1, 'metadata-dir-unsafe');
      assert.deepStrictEqual(fs.readdirSync(outside), [], 'no file created through the symlinked dir');
      assert.strictEqual(fs.statSync(outside).mode & 0o777, 0o755, 'outside dir mode unchanged (never chmodded)');
      assert.strictEqual(codeOf(() => fingerprint.readRejected(s.dataDir)), 'metadata-dir-unsafe');
      assert.strictEqual(codeOf(() => fingerprint.clearRejected(s.dataDir)), 'metadata-dir-unsafe');
      const e2 = codeOf(() => session.writeSuppressed(s.dataDir, 'denied'));
      assert.strictEqual(e2, 'metadata-dir-unsafe');
      assert.deepStrictEqual(fs.readdirSync(outside), []);
      assert.strictEqual(fs.statSync(outside).mode & 0o777, 0o755);
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('pre-existing 0755 metadata dir is refused and never chmodded', async () => {
    const s = scratch('wide-dir');
    try {
      fs.mkdirSync(s.metaDir, { recursive: true, mode: 0o755 });
      fs.chmodSync(s.metaDir, 0o755); // defeat any umask narrowing
      assert.strictEqual(codeOf(() => fingerprint.writeRejected(s.dataDir, DIGEST)), 'metadata-dir-not-private');
      assert.strictEqual(fs.statSync(s.metaDir).mode & 0o777, 0o755, 'refused dir keeps its mode — no chmod');
      assert.deepStrictEqual(fs.readdirSync(s.metaDir), [], 'nothing written into the unsafe dir');
      assert.strictEqual(codeOf(() => fingerprint.readRejected(s.dataDir)), 'metadata-dir-not-private');
      assert.strictEqual(codeOf(() => fingerprint.clearRejected(s.dataDir)), 'metadata-dir-not-private');
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('foreign-uid and non-regular files are refused on read/write/reset', async () => {
    const s = scratch('foreign');
    try {
      fs.mkdirSync(s.metaDir, { recursive: true, mode: 0o700 });
      const file = path.join(s.metaDir, 'rejected.json');
      // FIFO (non-regular): must be refused BEFORE any open (no blocking).
      const { spawnSync } = require('child_process');
      spawnSync('/usr/bin/mkfifo', [file]);
      assert.ok(fs.lstatSync(file).isFIFO());
      assert.strictEqual(codeOf(() => fingerprint.readRejected(s.dataDir)), 'metadata-file-unsafe');
      assert.strictEqual(codeOf(() => fingerprint.clearRejected(s.dataDir)), 'metadata-file-unsafe');
      assert.strictEqual(codeOf(() => fingerprint.writeRejected(s.dataDir, DIGEST)), 'metadata-file-unsafe');
      fs.unlinkSync(file);
      // Non-private regular file (e.g. 0644 published by an older writer).
      fs.writeFileSync(file, JSON.stringify({ digest: DIGEST }), { mode: 0o644 });
      fs.chmodSync(file, 0o644);
      assert.strictEqual(codeOf(() => fingerprint.readRejected(s.dataDir)), 'metadata-file-not-private');
      assert.strictEqual(codeOf(() => fingerprint.clearRejected(s.dataDir)), 'metadata-file-not-private');
      // Foreign uid (only meaningful when we are not root).
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        fs.chmodSync(file, 0o600);
        try {
          fs.chownSync(file, process.getuid() + 1, process.getgid());
        } catch { /* chown to another uid needs privilege; skip gracefully */ }
        const st = fs.lstatSync(file);
        if (st.uid !== process.getuid()) {
          assert.strictEqual(codeOf(() => fingerprint.readRejected(s.dataDir)), 'metadata-file-foreign');
        }
      }
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('generic metadata helpers validate dir type and never follow symlinks', async () => {
    const s = scratch('helpers');
    try {
      const file = path.join(s.metaDir, 'thing.json');
      // Dir path is a regular file → refused.
      fs.rmSync(s.metaDir, { recursive: true, force: true });
      fs.writeFileSync(s.metaDir, 'not-a-dir');
      assert.strictEqual(codeOf(() => writeOwnedJson(file, s.metaDir, { a: 1 })), 'metadata-dir-unsafe');
      // Missing dir: read/reset are benign null/false (nothing stored).
      fs.rmSync(s.metaDir, { force: true });
      assert.strictEqual(readOwnedJson(file, s.metaDir), null);
      assert.strictEqual(removeOwnedFile(file, s.metaDir), false);
      // Happy path via ensureOwnedDir creates 0700 exactly once.
      ensureOwnedDir(s.metaDir);
      assert.strictEqual(fs.statSync(s.metaDir).mode & 0o777, 0o700);
      assert.strictEqual(writeOwnedJson(file, s.metaDir, { a: 1 }), true);
      assert.deepStrictEqual(readOwnedJson(file, s.metaDir), { a: 1 });
      assert.strictEqual(removeOwnedFile(file, s.metaDir), true);
      // Malformed content is absent (null), not an error.
      fs.writeFileSync(file, 'not-json', { mode: 0o600 });
      assert.strictEqual(readOwnedJson(file, s.metaDir), null);
      // MetadataError is the refusal type, always carrying an enum code.
      const err = codeOf(() => { throw new MetadataError('metadata-file-unsafe'); });
      assert.strictEqual(err, 'metadata-file-unsafe');
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('resetXiaomiState propagates refusal (setup/update/remove surface it)', async () => {
    const s = scratch('reset');
    try {
      fs.mkdirSync(s.metaDir, { recursive: true, mode: 0o700 });
      const sentinel = path.join(s.root, 'sentinel');
      fs.writeFileSync(sentinel, 'UNCHANGED', { mode: 0o644 });
      fs.symlinkSync(sentinel, path.join(s.metaDir, 'rejected.json'));
      const e = codeOf(() => session.resetXiaomiState(s.dataDir));
      assert.strictEqual(e, 'metadata-file-unsafe');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED');
      assert.ok(fs.lstatSync(path.join(s.metaDir, 'rejected.json')).isSymbolicLink());
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('refused temp collision with a PLANTED REGULAR FILE: pre-existing file never deleted (N3)', async () => {
    const s = scratch('temp-regular');
    const origRandom = crypto.randomBytes;
    try {
      fs.mkdirSync(s.metaDir, { recursive: true, mode: 0o700 });
      // Same forced suffix as the symlink regression, but plant a 0600
      // REGULAR file — same uid + private establishes user ownership, NOT
      // ownership by this write. Refusal must not delete another writer's file.
      crypto.randomBytes = () => Buffer.alloc(8, 9);
      const hex = Buffer.alloc(8, 9).toString('hex');
      const plantedRejected = path.join(s.metaDir, `.rejected.json.${hex}.tmp`);
      const plantedSuppressed = path.join(s.metaDir, `.key-suppressed.json.${hex}.tmp`);
      fs.writeFileSync(plantedRejected, 'PRE-EXISTING-WRITER', { mode: 0o600 });
      fs.writeFileSync(plantedSuppressed, 'PRE-EXISTING-WRITER-2', { mode: 0o600 });
      const inoRejected = fs.lstatSync(plantedRejected).ino;
      const inoSuppressed = fs.lstatSync(plantedSuppressed).ino;

      assert.strictEqual(codeOf(() => fingerprint.writeRejected(s.dataDir, DIGEST)), 'metadata-temp-exists');
      assert.ok(fs.existsSync(plantedRejected), 'refusal must NOT delete a pre-existing regular file');
      assert.strictEqual(fs.readFileSync(plantedRejected, 'utf8'), 'PRE-EXISTING-WRITER');
      assert.strictEqual(fs.lstatSync(plantedRejected).ino, inoRejected, 'same file object survives the refusal');
      assert.ok(!fs.existsSync(path.join(s.metaDir, 'rejected.json')), 'nothing published on refusal');
      assert.deepStrictEqual(fs.readdirSync(s.metaDir).filter((f) => f.endsWith('.tmp')).sort(),
        [`.key-suppressed.json.${hex}.tmp`, `.rejected.json.${hex}.tmp`].sort(),
        'both planted collision files remain byte-for-byte in place');

      const e2 = codeOf(() => session.writeSuppressed(s.dataDir, 'denied'));
      assert.strictEqual(e2, 'metadata-temp-exists');
      assert.strictEqual(fs.readFileSync(plantedSuppressed, 'utf8'), 'PRE-EXISTING-WRITER-2');
      assert.strictEqual(fs.lstatSync(plantedSuppressed).ino, inoSuppressed);
    } finally {
      crypto.randomBytes = origRandom;
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('read-only private dir (0500): unlink failure is classified, never a silent success (N1)', async () => {
    const s = scratch('unlink-eacces');
    try {
      fs.mkdirSync(s.metaDir, { recursive: true, mode: 0o700 });
      const suppressed = path.join(s.metaDir, 'key-suppressed.json');
      fs.writeFileSync(suppressed, JSON.stringify({ code: 'denied', at: 'x' }), { mode: 0o600 });
      fs.chmodSync(s.metaDir, 0o500); // owned + private (passes validation), but not writable

      // Absence is still absence: a path that is not there reports false.
      assert.strictEqual(removeOwnedFile(path.join(s.metaDir, 'rejected.json'), s.metaDir), false,
        'genuinely absent file stays false even in a read-only dir');
      // A REAL unlink failure raises the classified metadata error.
      assert.strictEqual(codeOf(() => removeOwnedFile(suppressed, s.metaDir)), 'metadata-remove-failed');
      assert.ok(fs.existsSync(suppressed), 'undeletable file must remain');
      // The full state reset propagates it — setup/update/remove refuse on this.
      assert.strictEqual(codeOf(() => session.resetXiaomiState(s.dataDir)), 'metadata-remove-failed');
      assert.ok(fs.existsSync(suppressed), 'failed reset never pretends the suppression is gone');
      // The classified code carries its own actionable fixed message.
      assert.match(session.message('metadata-remove-failed'), /could not be cleared/);
      assert.notStrictEqual(session.message('metadata-remove-failed'), session.message('metadata-unsafe'));
      assert.strictEqual(session.message('unknown-code-x'), 'console status unavailable');
    } finally {
      fs.chmodSync(s.metaDir, 0o700); // restore the mode so cleanup can unlink
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('opened-read identity: an fd that is not the object validated at the path is refused', async () => {
    const s = scratch('read-identity');
    try {
      fs.mkdirSync(s.metaDir, { recursive: true, mode: 0o700 });
      const file = path.join(s.metaDir, 'rejected.json');
      fs.writeFileSync(file, JSON.stringify({ digest: DIGEST }), { mode: 0o600 });
      const decoy = path.join(s.root, 'decoy.json');
      fs.writeFileSync(decoy, JSON.stringify({ digest: 'b'.repeat(64) }), { mode: 0o600 });
      const realOpenSync = fs.openSync;
      fs.openSync = function swappedOpen(target, ...rest) {
        return realOpenSync.call(fs, String(target) === file ? decoy : target, ...rest);
      };
      try {
        // Simulated validation-to-open swap: the fd carries a different dev/ino
        // than the lstat'd path object, so the content must never be trusted.
        assert.strictEqual(codeOf(() => fingerprint.readRejected(s.dataDir)), 'metadata-file-changed');
      } finally {
        fs.openSync = realOpenSync;
      }
      assert.strictEqual(fingerprint.readRejected(s.dataDir), DIGEST, 'the unchanged path still reads normally');
    } finally {
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  if (failures) {
    console.error(`\n${failures} xiaomi metadata test(s) failed`);
    process.exit(1);
  }
  console.log('\nall xiaomi metadata tests passed');
})();
