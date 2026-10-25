'use strict';
// Discover every test/*.test.js file in this directory and run it as its own
// subprocess so failures in one file do not silently corrupt another. Aggregates
// exit codes; non-zero on any failure. Run: node test/run.js
//
// [#95] Per-run scratch data dir, plus a guard that fails the run when a test
// reaches the dir it inherited.
//
// The runner used to spawn every test file with the caller's environment. An
// agent shell inside Claude Code inherits CLAUDE_PLUGIN_DATA from whichever
// plugin's hook environment it came from — on 2026-10-25 a Phase 3 lane
// inherited ~/.claude/plugins/data/codex-inline, the Codex plugin's own data
// dir — and lib/config.js dataDir() returns that variable verbatim. 20 test
// files never set CLAUDE_PLUGIN_DATA themselves, so nothing stopped the suite
// from writing into the inherited dir; the only protection was a manual
// `CLAUDE_PLUGIN_DATA=$(mktemp -d)` prefix, and a manual prefix is not a
// choke point.
//
// Two guards, both enforced from here:
//
//   1. Every child gets an EXPLICIT env: CLAUDE_PLUGIN_DATA points at a fresh
//      per-run scratch dir. The scratch tree is removed when the run ends,
//      failure or not. HOME is NOT overridden (see buildChildEnv): the Traycer
//      native read needs the real HOME, so the ~/.view-limits fallback is
//      covered by forbidding it instead of relocating it.
//
//   2. The runner snapshots the inherited dirs (paths + sizes + mtimes)
//      before and after the run and fails the run if anything changed under
//      them. This is the guard OF RECORD: it catches a write no matter how it
//      got there, including one that never went through dataDir().
//
// A third layer lives outside this file: when test/fixtures/data-dir-guard.cjs
// sits next to the runner, it is installed into every child via NODE_OPTIONS
// and makes dataDir() THROW when it resolves to an inherited dir. It wraps the
// exported dataDir only, so calls made from inside lib/config.js itself bypass
// it — which is exactly why guard 2 is the guard of record.
//
// This file stays self-contained on purpose: test/run-failure.test.js copies
// it ALONE into a temp dir and runs it there, so it must not require a sibling
// module. It is also require()-able — the helpers below are unit-tested by
// test/data-dir-isolation.test.js without spawning the suite.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const DATA_DIR_NAME = '.view-limits';
const SCRATCH_PREFIX = 'vl-test-run-';
const FORBIDDEN_ENV = 'VL_FORBIDDEN_DATA_DIRS';
const SCRATCH_ENV = 'VL_TEST_SCRATCH';

// The dirs no child may resolve to: the CLAUDE_PLUGIN_DATA this process
// inherited, and the ~/.view-limits fallback dataDir() uses when that
// variable is unset.
function inheritedTargets(env, home) {
  const targets = [];
  if (env.CLAUDE_PLUGIN_DATA) targets.push(path.resolve(env.CLAUDE_PLUGIN_DATA));
  const base = home || os.homedir();
  if (base) targets.push(path.resolve(path.join(base, DATA_DIR_NAME)));
  return [...new Set(targets)];
}

// The forbidden set inherited from a parent runner (a copied runner spawned
// by test/run-failure.test.js inherits one).
function forbiddenFromEnv(env) {
  const raw = env[FORBIDDEN_ENV];
  if (!raw) return [];
  return raw.split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
}

// The env every spawned test file receives: the scratch data dir and the
// forbidden set the preload guard enforces. The forbidden set is the union of
// what the caller passes and what a parent runner passed down, so a copied
// runner keeps forbidding everything its parent forbade.
//
// HOME is deliberately NOT overridden. dataDir() falls back to
// os.homedir()/.view-limits when CLAUDE_PLUGIN_DATA is unset, so a scratch
// home would make that fallback hermetic — but the Traycer native read
// (lib/traycer-adapter.js spawns the `traycer` CLI with the caller's env)
// needs the real HOME to find its own state, and a scratch home breaks it:
// view-cli.test.js dies with "collection failed — native-unavailable
// (traycer-read-failed)". The fallback is covered the other way round: the
// real ~/.view-limits is in the forbidden set, so a child that resolves it
// throws (read guard) and the runner watches it for writes (backstop).
function buildChildEnv(baseEnv, scratch, forbidden) {
  const env = { ...baseEnv };
  env.CLAUDE_PLUGIN_DATA = path.join(scratch, 'data');
  env[SCRATCH_ENV] = scratch;
  const all = [...new Set([...forbidden, ...forbiddenFromEnv(baseEnv)].map((p) => path.resolve(p)))];
  env[FORBIDDEN_ENV] = all.join(path.delimiter);
  return env;
}

// Install the read guard (test/fixtures/data-dir-guard.cjs) into the child
// env. A copied runner has no sibling fixtures/ dir, so it leaves NODE_OPTIONS
// alone and relies on the inherited one instead.
function installPreload(env, testDir) {
  const preload = path.join(testDir, 'fixtures', 'data-dir-guard.cjs');
  if (!fs.existsSync(preload)) return env;
  const flag = `--require="${preload}"`;
  return { ...env, NODE_OPTIONS: env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${flag}` : flag };
}

// A fingerprint of a directory tree: relative path -> type, size and mtime.
// Used to prove the inherited dirs were not touched during the run.
function snapshotTree(dir) {
  const snap = new Map();
  const walk = (current, rel) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { return; } // vanished or unreadable
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        snap.set(relPath, { type: 'dir' });
        walk(abs, relPath);
        continue;
      }
      let st = null;
      try { st = fs.statSync(abs); } catch { /* raced away */ }
      snap.set(relPath, { type: 'file', size: st ? st.size : null, mtimeMs: st ? st.mtimeMs : null });
    }
  };
  walk(path.resolve(dir), '');
  return snap;
}

// What changed between two snapshots: added, removed or modified entries.
function diffSnapshots(before, after) {
  const changes = [];
  for (const [p, a] of before) {
    if (!after.has(p)) { changes.push({ path: p, change: 'removed' }); continue; }
    const b = after.get(p);
    if (a.type !== b.type) { changes.push({ path: p, change: 'type-changed' }); continue; }
    if (a.type === 'file' && (a.size !== b.size || a.mtimeMs !== b.mtimeMs)) {
      changes.push({ path: p, change: 'modified' });
    }
  }
  for (const p of after.keys()) if (!before.has(p)) changes.push({ path: p, change: 'added' });
  return changes;
}

function main() {
  const testDir = __dirname;
  const files = fs.readdirSync(testDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

  if (!files.length) {
    console.error('no test files found under', testDir);
    process.exit(1);
  }

  // One fresh scratch tree per run: data/ is the CLAUDE_PLUGIN_DATA every
  // child sees.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), SCRATCH_PREFIX));
  fs.mkdirSync(path.join(scratch, 'data'), { recursive: true });

  const forbidden = [...new Set([
    ...inheritedTargets(process.env, os.homedir()),
    ...forbiddenFromEnv(process.env),
  ])];
  const before = forbidden.map((dir) => ({ dir, snap: snapshotTree(dir) }));

  const childEnv = installPreload(buildChildEnv(process.env, scratch, forbidden), testDir);
  console.log(`scratch CLAUDE_PLUGIN_DATA: ${childEnv.CLAUDE_PLUGIN_DATA}`);

  let failed = 0;
  try {
    for (const f of files) {
      console.log(`\n=== ${f} ===`);
      // [#4] Per-file timeout: hung async tests must fail the suite, not silently
      // disappear.  60s is generous for fixture tests; anything longer is a hang.
      const r = spawnSync(process.execPath, [path.join(testDir, f)], { stdio: 'inherit', timeout: 60_000, env: childEnv });
      if (r.error) {
        if (r.error.code === 'ETIMEDOUT') {
          console.error(`  TIMEOUT after 60s — test file hung (likely deadlocked async test)`);
        } else {
          console.error(`  spawn error: ${r.error.message}`);
        }
        failed += 1;
        continue;
      }
      if (r.status !== 0) failed += 1;
    }
  } finally {
    // The scratch tree goes away whether the run passed or failed.
    try { fs.rmSync(scratch, { recursive: true, force: true }); }
    catch { /* best effort — a leftover temp dir must not fail the suite */ }
  }

  // [#95] Guard of record: nothing under the inherited dirs may have changed.
  const changes = [];
  for (const { dir, snap } of before) {
    for (const c of diffSnapshots(snap, snapshotTree(dir))) changes.push({ dir, ...c });
  }
  if (changes.length) {
    console.error('\n[#95] the inherited data dir changed during the run — failing:');
    for (const c of changes) console.error(`  ${c.change}: ${c.dir}/${c.path}`);
    failed += 1;
  }

  if (failed) {
    console.error(`\n${failed} test file(s) failed`);
    process.exit(1);
  }
  console.log('\nall test files passed');
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    DATA_DIR_NAME, FORBIDDEN_ENV, SCRATCH_ENV,
    inheritedTargets, forbiddenFromEnv, buildChildEnv, installPreload,
    snapshotTree, diffSnapshots, main,
  };
}
