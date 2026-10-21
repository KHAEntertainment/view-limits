'use strict';
// Phase 1 boundary regression (Issue #40) — the invariant that the whole
// Phase 0+1 slice rests on, and that no single existing file asserts:
//
//   every harness surface is wiring only, all of them dispatch to the SAME
//   bin/vl.js, and they all read that one CLI's view model.
//
// The per-surface tests each prove this for themselves and stop there —
// cli-boundary.test.js asserts the CLI, codex-harness.test.js asserts the Codex
// surface, opencode-harness.test.js asserts the OpenCode surface. None of them
// compares across harnesses, so the failure mode this file exists to catch is
// the one where a fourth surface, or a harness-specific rendering path, is
// added and every per-surface test still passes.
//
// Two layers, both on the real bytes a harness would execute:
//
//   1. ONE SUBSTRATE — each surface's command string is resolved through `sh`
//      with a recording stub `node` first on PATH, exactly as the harness
//      would run it. All three must resolve argv[0] to the identical
//      bin/vl.js, and each must pass only its documented subcommand. Two
//      harnesses cannot have quietly grown a private CLI.
//
//   2. ONE VIEW MODEL — the cache a refreshing surface writes is observed
//      byte-identically by a cache-reading surface. Claude and OpenCode
//      dispatch `refresh`; Codex dispatches `status`. After a refresh has
//      written real facts, `status --json` over that cache must be the exact
//      same document in a fresh data dir as in the refreshed one — so a
//      harness cannot observe a *different* world than its sibling.
//
// Deliberately NOT asserted: that a refresh and a cache read produce identical
// bytes. They must not — `updatedAt` / `observedAt` / `freshUntil` legitimately
// move when the cache is rewritten. Parity is asserted over identical state,
// not across a mutation boundary.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'vl.js');
const GUARD = path.join(__dirname, 'guard.cjs');

// The root resolution each surface family documents. Claude's surfaces expand
// CLAUDE_PLUGIN_ROOT; the harness surfaces resolve the checkout themselves so
// they work outside Claude. Both must land on the same bin/vl.js.
const HARNESS_ROOT_EXPR = '${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}';

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-phase1-'));
const binDir = path.join(dir, 'stub');
const capture = path.join(dir, 'argv.txt');

// Expand the two documented root-resolution forms so the literal CLI path is
// known before execution:  "${CLAUDE_PLUGIN_ROOT}/bin/vl.js"  and
// "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js".
// We always pass the variable, so the `:-` default branch is irrelevant here
// and expanding it in JS is equivalent to what the shell would do.
function expandRoots(command, env) {
  return command
    .replace(/\$\{(\w+):-[^}]*\}/g, (m, k) => (k in env ? env[k] : m))
    .replace(/\$\{(\w+)\}/g, (m, k) => (k in env ? env[k] : m));
}

// Run a surface's command line the way its harness would: through `sh`, with
// the CLI path swapped for a stub that records the argv it was handed. This
// proves the shell really expands and resolves the line — the assertion is
// about executed bytes, not about a re-parsed copy of them.
//
// The Claude surface invokes bin/vl.js directly (it is shebang-executable),
// while the harness surfaces prefix `node`; substituting the path handles both
// without caring which launcher a surface uses.
function resolveArgv(command, { cwd = ROOT, env = {} } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, 'vl-stub');
  // Node-compatible shebang so this stub survives BOTH launch forms: Claude
  // runs the path directly, while the Codex/OpenCode surfaces prefix `node`.
  // Under either form node's argv is [node, stub, ...args], so slice(2) is the
  // argument list in both cases.
  fs.writeFileSync(stub,
    '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.CAPTURE, process.argv.slice(2).join("\\n") + "\\n");\n',
    { mode: 0o755 });
  fs.rmSync(capture, { force: true });

  const expanded = expandRoots(command, env);
  assert.ok(executableOf(expanded),
    `the surface must resolve the checkout's own bin/vl.js; got: ${expanded}`);
  const runnable = expanded.split(CLI).join(stub);

  const r = spawnSync('sh', ['-c', runnable], {
    cwd, encoding: 'utf8',
    env: { PATH: process.env.PATH, CAPTURE: capture, ...env },
  });
  assert.strictEqual(r.status, 0, `command did not resolve: ${command}\n${r.stderr}`);
  return fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean);
}

// The CLI path a surface actually executes, taken from the expanded command
// line. Claude invokes bin/vl.js directly (no `node` prefix); the harness
// surfaces prefix it. Either way the executable is the token ending in
// /bin/vl.js, and "one substrate" means all three name the SAME file.
function executableOf(expandedCommand) {
  const tokens = expandedCommand.replace(/\s*2>&1/g, ' ').trim().split(/\s+/);
  return tokens.map((t) => t.replace(/"/g, '')).find((t) => t.endsWith('/bin/vl.js')) || null;
}

// Pull the single executable command line out of each surface file. Claude and
// OpenCode use an `!` backtick exec line; the Codex skill uses one ```sh fence.
function claudeExec() {
  const src = fs.readFileSync(path.join(ROOT, 'commands', 'view-limits.md'), 'utf8');
  const m = [...src.matchAll(/!`([^`]+)`/g)];
  assert.strictEqual(m.length, 1, 'the Claude command has exactly one exec line');
  return m[0][1].trim();
}
function codexSh() {
  const src = fs.readFileSync(
    path.join(ROOT, 'harness', 'codex', 'skills', 'view-limits', 'SKILL.md'), 'utf8');
  const m = [...src.matchAll(/```sh\n([\s\S]*?)```/g)];
  assert.strictEqual(m.length, 1, 'the Codex skill runs exactly one command');
  return m[0][1].trim();
}
function openCodeExec() {
  const src = fs.readFileSync(
    path.join(ROOT, 'harness', 'opencode', 'command', 'view-limits.md'), 'utf8');
  const m = [...src.matchAll(/!`([^`]+)`/g)];
  assert.strictEqual(m.length, 1, 'the OpenCode command has exactly one exec line');
  return m[0][1].trim();
}

// Scratch data dir with a fake vault+adapter so refresh/check can run without
// the guard blocking the vault.has they legitimately need.
function fakePreload(dataDir) {
  const p = path.join(dataDir, 'fake-preload.cjs');
  fs.writeFileSync(p, `'use strict';
    const Module = require('module');
    const load = Module._load;
    Module._load = function (id, ...args) {
      if (id.endsWith('/lib/vault')) return {
        has: () => true, get: () => 'fake-test-key',
        remove: () => true, set: () => true, assertWritable: () => {} };
      if (id.endsWith('/lib/adapters')) return {
        getAdapter: () => ({ async fetchStatus() {
          return { state: 'healthy', windows: [], balance: null, resetAt: null }; } }),
        ADAPTERS: {} };
      return load.call(this, id, ...args);
    };`);
  return p;
}

function dataDir() {
  const d = fs.mkdtempSync(path.join(dir, 'data-'));
  fs.mkdirSync(path.join(d, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' }, ttlSeconds: 300 }],
    gate: { mode: 'off' },
  }));
  return d;
}
function envFor(d, preload) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('TRAYCER_')) delete env[k];
  env.CLAUDE_PLUGIN_DATA = d;
  if (preload) env.NODE_OPTIONS = `--require=${preload}`;
  else delete env.NODE_OPTIONS;
  return env;
}
function runCli(args, d, preload) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: envFor(d, preload), encoding: 'utf8', timeout: 10000,
  });
}

// ---- 1. ONE SUBSTRATE ------------------------------------------------------

console.log('\nphase 1 boundary — every surface dispatches to the same bin/vl.js');

test('Claude, Codex and OpenCode surfaces all resolve to the identical bin/vl.js', () => {
  const claudeEnv = { CLAUDE_PLUGIN_ROOT: ROOT };
  const harnessEnv = { VIEW_LIMITS_ROOT: ROOT };
  const claude = resolveArgv(claudeExec(), { env: claudeEnv });
  const codex = resolveArgv(codexSh(), { env: harnessEnv });
  const opencode = resolveArgv(openCodeExec(), { env: harnessEnv });

  // One substrate: all three command lines name the same executable file.
  const exes = [
    executableOf(expandRoots(claudeExec(), claudeEnv)),
    executableOf(expandRoots(codexSh(), harnessEnv)),
    executableOf(expandRoots(openCodeExec(), harnessEnv)),
  ];
  for (const [label, exe] of [['Claude', exes[0]], ['Codex', exes[1]], ['OpenCode', exes[2]]])
    assert.strictEqual(exe, CLI, `${label} surface resolved ${exe}, not the one CLI`);
  assert.strictEqual(new Set(exes).size, 1, `surfaces named different binaries: ${exes}`);

  // Each surface gets the ONE subcommand it is documented to dispatch, and
  // nothing else — a harness may not grow private arguments.
  assert.deepStrictEqual(claude, ['refresh'], 'Claude dispatches exactly `refresh`');
  assert.deepStrictEqual(codex, ['status'], 'Codex dispatches exactly `status`');
  assert.deepStrictEqual(opencode, ['refresh'], 'OpenCode dispatches exactly `refresh`');
});

test('the harness surfaces resolve their own checkout outside a git repo (no Claude vars needed)', () => {
  // Run from a temp dir that is not a git repo and with no CLAUDE_* set: the
  // VIEW_LIMITS_ROOT fallback is what makes these surfaces portable.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-outside-'));
  for (const [label, cmd] of [['Codex', codexSh()], ['OpenCode', openCodeExec()]]) {
    const argv = resolveArgv(cmd, { cwd: outside, env: { VIEW_LIMITS_ROOT: ROOT } });
    assert.ok(argv.length > 0, `${label} must still resolve and dispatch from a non-repo cwd`);
    assert.strictEqual(executableOf(expandRoots(cmd, { VIEW_LIMITS_ROOT: ROOT })), CLI,
      `${label} must resolve via VIEW_LIMITS_ROOT, not git`);
  }
  assert.ok(!codexSh().includes('CLAUDE_PLUGIN_ROOT'), 'the Codex surface must not depend on Claude');
  assert.ok(!openCodeExec().includes('CLAUDE_PLUGIN_ROOT'), 'the OpenCode surface must not depend on Claude');
});

// ---- 2. ONE VIEW MODEL -----------------------------------------------------

console.log('\nphase 1 boundary — one view model observed identically by every surface');

test('a refreshing surface and a cache-reading surface observe byte-identical view models', () => {
  // Claude/OpenCode surface: dispatch `refresh` against a fake adapter, which
  // writes the cache they will hand the user.
  const refreshed = dataDir();
  const preload = fakePreload(refreshed);
  const r = runCli(['refresh', '--quiet'], refreshed, preload);
  assert.strictEqual(r.status, 0, `refresh exit ${r.status}; stderr=${r.stderr}`);
  const cachePath = path.join(refreshed, 'status.json');
  assert.ok(fs.existsSync(cachePath), 'refresh wrote the cache the surfaces read');

  // A second data dir holding a byte-identical copy of that cache is what a
  // Codex-style cache-only surface sees. No refresh runs here.
  const observed = dataDir();
  fs.copyFileSync(cachePath, path.join(observed, 'status.json'));
  const readerPreload = fakePreload(observed);

  // Same state, two surfaces: the observation must be the identical document.
  const afterRefresh = runCli(['status', '--json'], refreshed, preload);
  const cacheOnly = runCli(['status', '--json'], observed, readerPreload);
  assert.strictEqual(afterRefresh.status, 0, `exit ${afterRefresh.status}; stderr=${afterRefresh.stderr}`);
  assert.strictEqual(cacheOnly.status, 0, `exit ${cacheOnly.status}; stderr=${cacheOnly.stderr}`);
  assert.strictEqual(
    afterRefresh.stdout, cacheOnly.stdout,
    'every surface must observe the same view model for the same underlying state',
  );

  // And that document is the shared view-model envelope, not a per-harness shape.
  const doc = JSON.parse(afterRefresh.stdout);
  assert.deepStrictEqual(Object.keys(doc).sort(), ['routes', 'updatedAt']);
  assert.deepStrictEqual(Object.keys(doc.routes), ['kimi-code-plan']);
  // `configRevision` is the ADDITIVE field #58 wired refresh to publish (the
  // writer half of QA M3 from #54, which lib/gate.js now reads to refuse a
  // deny on an obsolete observation). It is pinned exactly, not matched as a
  // subset: the diagnostic JSON contract is additive-only, so a renamed or
  // removed key must still fail here. Cross-surface parity is unaffected —
  // both surfaces above produce byte-identical documents.
  assert.deepStrictEqual(
    Object.keys(doc.routes['kimi-code-plan']).sort(),
    ['configRevision', 'freshUntil', 'observedAt', 'routeId', 'source', 'status'],
  );
  assert.strictEqual(doc.routes['kimi-code-plan'].status.state, 'healthy');

  // Exactly one JSON document, pretty-printed, newline-terminated — the same
  // discipline cli-boundary pins for the CLI, re-checked through the surfaces.
  assert.strictEqual(afterRefresh.stdout, JSON.stringify(doc, null, 2) + '\n',
    'stdout is exactly one pretty JSON document');
});

test('every surface observation is exit 0 and emits a single JSON document', () => {
  const d = dataDir();
  const preload = fakePreload(d);
  runCli(['refresh', '--quiet'], d, preload);
  for (const argv of [['status', '--json'], ['report', '--json']]) {
    const r = runCli(argv, d, preload);
    assert.strictEqual(r.status, 0, `${argv.join(' ')} exit ${r.status}`);
    assert.strictEqual(r.stderr, '', `${argv.join(' ')} must not write to stderr`);
    // A second document concatenated onto stdout would still parse as JSON, so
    // assert the parse consumed the whole stream.
    assert.doesNotThrow(() => JSON.parse(r.stdout), `${argv.join(' ')} emits parseable JSON`);
    assert.strictEqual(r.stdout, JSON.stringify(JSON.parse(r.stdout), null, 2) + '\n',
      `${argv.join(' ')} emits exactly one document`);
  }
});

test('the cache-only observation every surface shares reaches no provider and no network', () => {
  // Scope this honestly. The shared observation path DOES touch two local,
  // non-network things:
  //   - the vault, via reportCmd's `vault.has` check on each configured route,
  //     which decides between the no-credential message and a real view; and
  //   - on macOS that vault read shells out to the `security` Keychain CLI
  //     (lib/vault.js), i.e. execFileSync.
  // Neither is a provider call, but the keychain one must not run against the
  // developer's REAL keychain from a test, so the vault is faked here — which
  // also makes the subprocess claim exact rather than approximate.
  //
  // What is left to prove is the one Phase 1 actually asserted: the shared
  // observation path reaches no provider and opens no socket.
  const d = dataDir();
  const preload = fakePreload(d);
  runCli(['refresh', '--quiet'], d, preload);

  const trace = path.join(d, 'net-events.log');
  const netGuard = path.join(d, 'net-guard.cjs');
  fs.writeFileSync(netGuard, `'use strict';
    const fs = require('fs');
    const log = (k) => fs.appendFileSync(process.env.NET_LOG, k + '\\n');
    const blocked = (k) => function () { log(k); throw new Error('blocked ' + k); };
    global.fetch = blocked('fetch');
    for (const m of ['http', 'https']) {
      for (const k of ['request', 'get']) { try { require(m)[k] = blocked(m + '.' + k); } catch {} }
    }
    for (const k of ['connect', 'createConnection']) {
      try { require('net')[k] = blocked('net.' + k); } catch {}
    }
    try { require('tls').connect = blocked('tls.connect'); } catch {}
    const cp = require('child_process');
    for (const k of ['exec', 'execFile', 'execSync', 'execFileSync']) cp[k] = blocked('cp.' + k);
    const Module = require('module');
    const load = Module._load;
    Module._load = function (id, ...a) {
      if (typeof id === 'string' && id.endsWith('/lib/vault')) {
        return { has: () => true, get: () => 'fake-test-key',
                 remove: () => true, set: () => true, assertWritable: () => {} };
      }
      if (typeof id === 'string' && id.endsWith('/lib/adapters')) {
        return { ...load.call(this, id, ...a), getAdapter: blocked('provider.getAdapter') };
      }
      return load.call(this, id, ...a);
    };`);

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('TRAYCER_')) delete env[k];
  env.CLAUDE_PLUGIN_DATA = d;
  env.NODE_OPTIONS = `--require=${netGuard}`;
  env.NET_LOG = trace;

  const r = spawnSync(process.execPath, [CLI, 'status', '--json'], {
    env, encoding: 'utf8', timeout: 10000,
  });
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  const events = fs.existsSync(trace)
    ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean)
    : [];
  assert.deepStrictEqual(events, [],
    `a cache-only observation must reach no provider and no network: ${JSON.stringify(events)}`);
});

test('the view model a surface observes carries no credential material', () => {
  const d = dataDir();
  const preload = fakePreload(d);   // vault returns the literal 'fake-test-key'
  runCli(['refresh', '--quiet'], d, preload);
  const r = runCli(['status', '--json'], d, preload);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr=${r.stderr}`);
  assert.ok(r.stdout.includes('kimi-code-plan'), 'the view model shows the route');
  assert.doesNotMatch(r.stdout, /fake-test-key|sk-|Bearer|token/i,
    'the observed view model must never carry credential material');
});

fs.rmSync(dir, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} phase-1 boundary test(s) failed`);
  process.exit(1);
}
console.log('\nphase 1 boundary: one CLI, one view model, three surfaces — ok');