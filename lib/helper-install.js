'use strict';
// User-invoked helper build for `vl setup xiaomi-token-plan`.
//
// Contract:
//  * Runs ONLY when the user invokes setup — never during refresh, report,
//    hooks, or any background path.
//  * Compiles the reviewed native source (`make compile-real` in the plugin's
//    native/ directory) and installs the resulting binary into the
//    application dataDir/bin with mode 0700. It NEVER executes the helper.
//  * Round 4: an installed helper whose recorded native-SOURCE hash still
//    matches is REUSED — the rebuild (which changes the helper's cdhash and
//    would invalidate the user's Keychain "Always Allow" grant) is skipped.
//  * Platform/toolchain failures are classified enum codes — no tool output,
//    no directory paths.
//  * The `run` seam exists so tests can drive the flow with a fake compiler
//    and a tempdir; production always uses spawnSync('make', …).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readOwnedJson, writeOwnedJson } = require('./cookies/metadata');

const HELPER_NAME = 'kh-helper';
// Sidecar next to the installed helper records which native sources produced
// it. Owned-file discipline: 0700 dir, 0600 file, symlink refusal on read and
// write; a planted/unsafe sidecar is never followed (degrades to a rebuild).
const SOURCE_HASH_SUFFIX = '.srcsha256';

/**
 * Stable identity hash over the native helper inputs (`native/*.c`,
 * `native/*.h`, `native/Makefile`, name-sorted, content-delimited). Build
 * outputs never participate. Returns null when the directory is unreadable
 * (callers then take the always-safe rebuild path).
 */
function nativeSourceSha256(nativeDir) {
  let names;
  try {
    names = fs.readdirSync(nativeDir)
      .filter((n) => n === 'Makefile' || n.endsWith('.c') || n.endsWith('.h'))
      .sort();
  } catch {
    return null;
  }
  if (!names.length) return null;
  const hash = crypto.createHash('sha256');
  for (const name of names) {
    hash.update(`${name}\0`);
    try {
      hash.update(fs.readFileSync(path.join(nativeDir, name)));
    } catch {
      return null; // unreadable source → rebuild path classifies the failure
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

class HelperInstallError extends Error {
  constructor(code) {
    super(code); // classified enum only
    this.code = code;
  }
}

function helperPathFor(dataDir) {
  return path.join(dataDir, 'bin', HELPER_NAME);
}

function defaultRun({ command, args, cwd }) {
  // Looked up at call time (not destructured at load) so the surrounding
  // process — and the test seams — see one consistent child_process module.
  const { spawnSync } = require('child_process');
  let result;
  try {
    result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  } catch {
    return { status: -1 };
  }
  if (result && result.error) return { status: -1 };
  return { status: typeof result.status === 'number' ? result.status : -1 };
}

/**
 * Compile the native helper and install it under dataDir/bin. Never runs it.
 *
 * @param {{pluginRoot:string, dataDir:string, nativeDir?:string,
 *          platform?:string, run?:Function}} options
 * @returns {Promise<{ok:true, helperPath:string}>}
 * @throws {HelperInstallError} unsupported-platform | plugin-root-missing |
 *   data-dir-missing | helper-build-failed | helper-install-failed.
 */
async function buildHelper(options = {}) {
  const platform = options.platform === undefined ? process.platform : options.platform;
  if (platform !== 'darwin') throw new HelperInstallError('unsupported-platform');
  if (typeof options.pluginRoot !== 'string' || !options.pluginRoot) {
    throw new HelperInstallError('plugin-root-missing');
  }
  if (typeof options.dataDir !== 'string' || !options.dataDir) {
    throw new HelperInstallError('data-dir-missing');
  }
  const nativeDir = typeof options.nativeDir === 'string' && options.nativeDir
    ? options.nativeDir
    : path.join(options.pluginRoot, 'native');
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const target = helperPathFor(options.dataDir);
  const sidecar = `${target}${SOURCE_HASH_SUFFIX}`;

  // Identity-preserving skip: identical native sources produce an identical
  // helper, and rebuilding would only churn the cdhash the user's "Always
  // Allow" grant is pinned to. Reuse the installed helper (no make, no copy,
  // no chmod) when the recorded source hash matches AND the installed file
  // is an owned, executable regular file — never a symlink. Any read problem
  // (absent/unsafe sidecar or helper) degrades to a rebuild, which is safe.
  const sourceHash = nativeSourceSha256(nativeDir);
  if (sourceHash !== null) {
    try {
      const saved = readOwnedJson(sidecar, path.dirname(target));
      const installed = fs.lstatSync(target);
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (saved && saved.sha256 === sourceHash &&
          installed.isFile() && !installed.isSymbolicLink() &&
          (uid === null || installed.uid === uid)) {
        // Round 5 (P2-3): require REAL execute permission for THIS process —
        // any-exec-bit (`mode & 0o111`) accepts a 0601 install whose owner
        // bit is cleared; accessSync(X_OK) reflects what can actually run.
        // Not executable → fall through to the rebuild below.
        fs.accessSync(target, fs.constants.X_OK);
        return { ok: true, helperPath: target, skippedRebuild: true };
      }
    } catch { /* absent/unsafe/non-executable sidecar or helper → rebuild */ }
  }

  // The Makefile lives in native/ but its paths (native/*.c, build/) resolve
  // against the plugin root, so run it from there with an explicit -f.
  const makefile = path.join(nativeDir, 'Makefile');
  const result = await run({ command: 'make', args: ['-f', makefile, 'compile-real'], cwd: options.pluginRoot });
  if (!result || result.status !== 0) throw new HelperInstallError('helper-build-failed');

  const built = path.join(options.pluginRoot, 'build', HELPER_NAME);
  const temp = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(built, temp);
    fs.chmodSync(temp, 0o700);
    fs.renameSync(temp, target);
  } catch {
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
    throw new HelperInstallError('helper-install-failed');
  }
  // Best-effort identity record (round 4): a failed write only costs a
  // rebuild on the next setup — always safe — and the owned-file writer
  // refuses any planted path instead of following it.
  if (sourceHash !== null) {
    try {
      writeOwnedJson(sidecar, path.dirname(target), { sha256: sourceHash });
    } catch { /* degrade to a rebuild next time */ }
  }
  return { ok: true, helperPath: target, skippedRebuild: false };
}

module.exports = {
  buildHelper, helperPathFor, nativeSourceSha256, HelperInstallError, HELPER_NAME,
};
