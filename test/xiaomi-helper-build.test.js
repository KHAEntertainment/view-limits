'use strict';
// User-invoked helper build tests: fake compiler seam (tempdir, never
// executes the artifact) plus one real compile-only check that never runs
// the produced binary. Run: node test/xiaomi-helper-build.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildHelper, helperPathFor, nativeSourceSha256, HelperInstallError } = require('../lib/helper-install');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
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
const code = async (fn) => {
  try { await fn(); return null; } catch (e) { return e && e.code; }
};
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vl-helper-build-'));

(async () => {
  console.log('xiaomi helper install — fake seam + compile-only real build');

  await test('fake compiler seam installs 0700 binary and never executes it', async () => {
    const root = scratch();
    try {
      const pluginRoot = path.join(root, 'plugin');
      const dataDir = path.join(root, 'data');
      fs.mkdirSync(path.join(pluginRoot, 'native'), { recursive: true });
      const executed = path.join(root, 'EXECUTED');
      const runCalls = [];
      const run = async ({ command, args, cwd }) => {
        runCalls.push({ command, args, cwd });
        // Fake "compiler": emit a synthetic executable that WOULD leave a
        // marker if anyone ever ran it.
        fs.mkdirSync(path.join(pluginRoot, 'build'), { recursive: true });
        fs.writeFileSync(path.join(pluginRoot, 'build', 'kh-helper'),
          `#!/bin/sh\ntouch "${executed}"\nexit 0\n`, { mode: 0o755 });
        return { status: 0 };
      };
      const result = await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(runCalls.length, 1);
      assert.strictEqual(runCalls[0].command, 'make');
      assert.ok(runCalls[0].args.includes('compile-real'));
      assert.ok(runCalls[0].args.some((a) => String(a).endsWith('Makefile')));
      assert.strictEqual(runCalls[0].cwd, pluginRoot);
      const target = helperPathFor(dataDir);
      assert.strictEqual(result.helperPath, target);
      assert.ok(fs.existsSync(target));
      assert.strictEqual(fs.statSync(target).mode & 0o777, 0o700, 'installed helper must be 0700');
      assert.ok(!fs.existsSync(executed), 'buildHelper must never run the produced binary');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('toolchain failure, missing artifact and platform guard classify without paths', async () => {
    const root = scratch();
    try {
      const pluginRoot = path.join(root, 'plugin');
      const dataDir = path.join(root, 'data');
      fs.mkdirSync(path.join(pluginRoot, 'native'), { recursive: true });

      assert.strictEqual(await code(() => buildHelper({
        pluginRoot, dataDir, platform: 'darwin', run: async () => ({ status: 2 }),
      })), 'helper-build-failed');
      assert.strictEqual(await code(() => buildHelper({
        pluginRoot, dataDir, platform: 'darwin', run: async () => ({ status: 0 }), // no artifact written
      })), 'helper-install-failed');
      assert.strictEqual(await code(() => buildHelper({
        pluginRoot, dataDir, platform: 'linux', run: async () => ({ status: 0 }),
      })), 'unsupported-platform');
      assert.strictEqual(await code(() => buildHelper({
        pluginRoot: '', dataDir, platform: 'darwin', run: async () => ({ status: 0 }),
      })), 'plugin-root-missing');
      assert.strictEqual(await code(() => buildHelper({
        pluginRoot, dataDir: '', platform: 'darwin', run: async () => ({ status: 0 }),
      })), 'data-dir-missing');
      // No partial target left behind.
      assert.ok(!fs.existsSync(helperPathFor(dataDir)));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('real compile-only build produces the reviewed helper; the binary is never executed', async () => {
    if (process.platform !== 'darwin') {
      console.log('    (not macOS — real compile check skipped)');
      return;
    }
    const make = spawnSync('make', ['--version'], { encoding: 'utf8' });
    const cc = spawnSync('cc', ['--version'], { encoding: 'utf8' });
    if (make.status !== 0 || cc.status !== 0) {
      console.log('    (toolchain unavailable — real compile check skipped)');
      return;
    }
    const root = scratch();
    const cp = require('child_process');
    const originalSpawn = cp.spawn;
    const originalSpawnSync = cp.spawnSync;
    const commands = [];
    try {
      const dataDir = path.join(root, 'data');
      // Spy every process launch during the real build: the ONLY allowed
      // command is `make` — the compiled kh-helper is copied, never run.
      cp.spawnSync = (cmd, ...rest) => { commands.push(String(cmd)); return originalSpawnSync(cmd, ...rest); };
      cp.spawn = (cmd, ...rest) => { commands.push(String(cmd)); return originalSpawn(cmd, ...rest); };

      const result = await buildHelper({ pluginRoot: PLUGIN_ROOT, dataDir });
      assert.strictEqual(result.ok, true);
      const artifact = path.join(PLUGIN_ROOT, 'build', 'kh-helper');
      assert.ok(fs.existsSync(artifact), 'real compile must produce build/kh-helper');
      assert.ok(fs.statSync(artifact).size > 0);
      // Mach-O 64-bit executable magic (little-endian 0xfeedfacf).
      const magic = fs.readFileSync(artifact).subarray(0, 4);
      assert.deepStrictEqual([...magic], [0xcf, 0xfa, 0xed, 0xfe], 'expected a Mach-O 64-bit binary');
      assert.ok(commands.includes('make'), 'the build runs make');
      for (const cmd of commands) {
        assert.ok(!cmd.includes('kh-helper'), 'the compiled helper must never be spawned');
      }
      assert.ok(fs.existsSync(result.helperPath), 'installed copy exists');
      assert.strictEqual(fs.statSync(result.helperPath).mode & 0o777, 0o700);
      assert.ok(!fs.existsSync(path.join(dataDir, 'bin', 'EXECUTED')), 'binary never executed');
    } finally {
      cp.spawn = originalSpawn;
      cp.spawnSync = originalSpawnSync;
      fs.rmSync(root, { recursive: true, force: true });
      // Leave the repo as it was: remove the compile-only artifact.
      spawnSync('make', ['-f', path.join('native', 'Makefile'), 'clean'], { cwd: PLUGIN_ROOT });
      if (fs.existsSync(path.join(PLUGIN_ROOT, 'build'))) {
        try { fs.rmSync(path.join(PLUGIN_ROOT, 'build'), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });

  // ---- round 4: identity-preserving skip --------------------------------------
  const writeNative = (nativeDir) => {
    fs.mkdirSync(nativeDir, { recursive: true });
    fs.writeFileSync(path.join(nativeDir, 'Makefile'), 'compile-real:\n\t@true\n');
    fs.writeFileSync(path.join(nativeDir, 'kh_fake.c'), 'int main(void){return 0;}\n');
    fs.writeFileSync(path.join(nativeDir, 'kh_fake.h'), '#pragma once\n');
  };
  const fakeRun = (pluginRoot, calls) => async ({ command, args, cwd }) => {
    calls.push({ command, args, cwd });
    fs.mkdirSync(path.join(pluginRoot, 'build'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'build', 'kh-helper'),
      '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return { status: 0 };
  };

  await test('R4 unchanged native sources: make NOT invoked, installed binary identity preserved', async () => {
    const root = scratch();
    try {
      const pluginRoot = path.join(root, 'plugin');
      const dataDir = path.join(root, 'data');
      writeNative(path.join(pluginRoot, 'native'));
      const calls = [];
      const run = fakeRun(pluginRoot, calls);

      const first = await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.skippedRebuild, false, 'first build always compiles');
      assert.strictEqual(calls.length, 1, 'first build runs make once');
      const target = helperPathFor(dataDir);
      const before = fs.lstatSync(target);
      assert.strictEqual(before.mode & 0o777, 0o700);

      // Same sources: the rebuild is skipped — make is never invoked and the
      // installed binary object is untouched (cdhash/ACL stays valid).
      const second = await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      assert.strictEqual(second.ok, true);
      assert.strictEqual(second.skippedRebuild, true, 'identical sources reuse the installed helper');
      assert.strictEqual(calls.length, 1, 'unchanged source hash must NOT invoke make');
      const after = fs.lstatSync(target);
      assert.strictEqual(after.ino, before.ino, 'installed binary inode preserved (no copy)');
      assert.strictEqual(after.mtimeMs, before.mtimeMs, 'installed binary mtime preserved (no rewrite)');

      // The identity sidecar is private 0600 and records the source hash.
      const sidecar = `${target}.srcsha256`;
      assert.strictEqual(fs.statSync(sidecar).mode & 0o777, 0o600);
      const doc = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      assert.strictEqual(doc.sha256, nativeSourceSha256(path.join(pluginRoot, 'native')));

      // Missing installed helper → rebuild even with a matching sidecar.
      fs.unlinkSync(target);
      const third = await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      assert.strictEqual(third.skippedRebuild, false);
      assert.strictEqual(calls.length, 2, 'a missing helper forces make');
      assert.ok(fs.existsSync(target));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('R4/R5 non-executable installed helper (0601) is never skipped; executable still skips', async () => {
    const root = scratch();
    try {
      const pluginRoot = path.join(root, 'plugin');
      const dataDir = path.join(root, 'data');
      writeNative(path.join(pluginRoot, 'native'));
      const calls = [];
      const run = fakeRun(pluginRoot, calls);
      const target = helperPathFor(dataDir);

      await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run }); // calls = 1
      // Round 5 (P2-3): matching sidecar but the OWNER execute bit cleared —
      // the old `mode & 0o111` check accepted this (some other exec bit) and
      // skipped; accessSync(X_OK) must force a rebuild.
      fs.chmodSync(target, 0o601);
      const rebuilt = await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      assert.strictEqual(rebuilt.skippedRebuild, false, '0601 must not report a usable helper identity');
      assert.strictEqual(calls.length, 2, 'make re-runs for a non-executable install');
      assert.strictEqual(fs.statSync(target).mode & 0o777, 0o700, 'rebuild restores a usable 0700 helper');

      // A proper owned-executable helper still skips, identity preserved.
      const before = fs.lstatSync(target);
      const skipped = await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      assert.strictEqual(skipped.skippedRebuild, true);
      assert.strictEqual(calls.length, 2, 'no make when the install is executable again');
      const after = fs.lstatSync(target);
      assert.strictEqual(after.ino, before.ino, 'inode preserved across the skip');
      assert.strictEqual(after.mtimeMs, before.mtimeMs, 'mtime preserved across the skip');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('R4 changed native source: make re-runs and sidecar + binary identity update', async () => {
    const root = scratch();
    try {
      const pluginRoot = path.join(root, 'plugin');
      const dataDir = path.join(root, 'data');
      const nativeDir = path.join(pluginRoot, 'native');
      writeNative(nativeDir);
      const calls = [];
      const run = fakeRun(pluginRoot, calls);
      const target = helperPathFor(dataDir);
      const sidecar = `${target}.srcsha256`;

      await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      const firstIno = fs.lstatSync(target).ino;
      const firstHash = JSON.parse(fs.readFileSync(sidecar, 'utf8')).sha256;

      fs.appendFileSync(path.join(nativeDir, 'kh_fake.c'), '/* changed */\n');
      const rebuilt = await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      assert.strictEqual(rebuilt.skippedRebuild, false, 'changed sources must rebuild (new helper identity)');
      assert.strictEqual(calls.length, 2, 'make re-runs after a source change');
      assert.notStrictEqual(JSON.parse(fs.readFileSync(sidecar, 'utf8')).sha256, firstHash, 'sidecar records the new hash');
      assert.strictEqual(JSON.parse(fs.readFileSync(sidecar, 'utf8')).sha256, nativeSourceSha256(nativeDir));
      assert.notStrictEqual(fs.lstatSync(target).ino, firstIno, 'a rebuilt helper replaces the installed file');
      assert.strictEqual(fs.statSync(target).mode & 0o777, 0o700);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('R4 unsafe identity sidecar: planted symlink never followed, degrades to rebuild', async () => {
    const root = scratch();
    try {
      const pluginRoot = path.join(root, 'plugin');
      const dataDir = path.join(root, 'data');
      const nativeDir = path.join(pluginRoot, 'native');
      writeNative(nativeDir);
      const calls = [];
      const run = fakeRun(pluginRoot, calls);
      const target = helperPathFor(dataDir);
      const sidecar = `${target}.srcsha256`;

      await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      const sentinel = path.join(root, 'sentinel');
      fs.writeFileSync(sentinel, 'UNCHANGED', { mode: 0o644 });
      fs.unlinkSync(sidecar);
      fs.symlinkSync(sentinel, sidecar);
      fs.appendFileSync(path.join(nativeDir, 'kh_fake.c'), '/* changed */\n');

      const rebuilt = await buildHelper({ pluginRoot, dataDir, platform: 'darwin', run });
      assert.strictEqual(rebuilt.ok, true, 'an unsafe sidecar degrades to a rebuild, never a failure');
      assert.strictEqual(rebuilt.skippedRebuild, false, 'the planted sidecar cannot fake a source match');
      assert.strictEqual(calls.length, 2, 'make re-runs');
      assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'UNCHANGED', 'sidecar target never written through');
      assert.ok(fs.lstatSync(sidecar).isSymbolicLink(), 'planted sidecar left alone — never followed, never deleted');
      assert.ok(fs.existsSync(target));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  if (failures) {
    console.error(`\n${failures} helper build test(s) failed`);
    process.exit(1);
  }
  console.log('\nall helper build tests passed');
})();
