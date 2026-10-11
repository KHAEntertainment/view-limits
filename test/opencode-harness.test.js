'use strict';
// OpenCode harness surface (Issue #39) — harness/opencode/*.
//
// The OpenCode surface is wiring only. This file is the regression guard for
// that claim, in three layers (mirroring test/codex-harness.test.js):
//
//   1. SHAPE   — the plugin is a loadable OpenCode plugin module (ESM, one
//                export returning hooks) exposing exactly the wired hook, and
//                the command file is a valid OpenCode command whose template
//                interpolates exactly one allowlisted CLI call.
//   2. THIN    — the plugin source imports only Node builtins and spawns a
//                bare `node <cli> gate` (argv allowlist, import allowlist, no
//                text-processing tools); the command exec line is a bare
//                `refresh` invocation with a verbatim-relay instruction and no
//                shaping. That is AC2 ("no duplicated rendering or business
//                logic") enforced structurally rather than by review.
//   3. LIVE    — the exported hook is invoked for real. A stub CLI (resolved
//                through VIEW_LIMITS_ROOT) captures the argv + stdin the
//                surface actually sends — proving the PreToolUse translation
//                byte-for-byte — and canned stdout drives the deny / allow /
//                malformed fail-open paths. Then the real CLI runs under an
//                isolated HOME (no Claude env) with the test/guard.cjs preload,
//                proving the deny is reachable through the same wiring and that
//                the default CLI resolution (VIEW_LIMITS_ROOT unset → plugin
//                file location) works.
//
// Covered: AC1 (gating + status wired to the CLI), AC2 (thin wrapper), and the
// no-Claude-fallback contract — CLAUDE_PLUGIN_DATA / CLAUDE_PLUGIN_ROOT are
// unset in every CLI invocation below, so the ~/.view-limits fallback is what
// makes the surface work outside Claude.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_PATH = path.join(ROOT, 'harness', 'opencode', 'plugin', 'view-limits.js');
const COMMAND_PATH = path.join(ROOT, 'harness', 'opencode', 'command', 'view-limits.md');
const GUARD = path.join(__dirname, 'guard.cjs');

// The one expansion the surface is allowed to interpolate in the command
// template: resolve the checkout from VIEW_LIMITS_ROOT, else from the session
// git root (the pattern the Codex surface documents).
const ROOT_EXPR = '${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}';
const COMMAND_EXEC_RE = /^node "([\s\S]+)\/bin\/vl\.js" refresh 2>&1$/;

// argv the plugin is allowed to pass to the CLI. Anything else is new logic
// creeping into the surface.
const ALLOWED_GATE_ARGV = ['gate'];

// Shaping / processing tools that must never appear in a surface file.
const FORMAT_TOOL_RE =
  /\b(?:sed|awk|jq|grep|perl|printf|column|xargs|cut|paste|fmt|expand|tr|sort|uniq|tee|head|tail|base64|rev|curl|node\s+-e)\b/;

// Imports the plugin is allowed: Node builtins only — never ../lib, never a
// second adapter, never a dependency.
const ALLOWED_IMPORTS = new Set(['node:child_process', 'node:url', 'node:path']);
const IMPORT_RE = /\bfrom\s+['"]([^'"]+)['"]/g;

const route = { id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' } };
const now = Date.parse('2026-10-10T00:00:00Z');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-opencode-'));
const home = path.join(dir, 'home');
const dataDir = path.join(home, '.view-limits');
const stubRoot = path.join(dir, 'stub-root');
const stubCapture = path.join(dir, 'stub-argv.json');
const tracePath = path.join(dir, 'trace.log');

const exhausted = () => ({
  freshUntil: new Date(now + 60000).toISOString(),
  status: { state: 'exhausted', resetAt: '2026-10-10T05:00:00Z' },
});

const DENY_STDOUT = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'view-limits: route "kimi-code-plan" is exhausted. Dispatch blocked.',
  },
});

function writeConfig(cfg) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg));
}

function writeCache(value) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'status.json'),
    JSON.stringify({ updatedAt: new Date(now).toISOString(), routes: { [route.id]: value } }),
  );
}

// A stub CLI that records the argv + stdin the surface hands it and prints
// canned stdout — so the assertion is about the bytes the surface sends.
function installStubCli(stdout) {
  fs.mkdirSync(path.join(stubRoot, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(stubRoot, 'bin', 'vl.js'),
    "const fs = require('fs');\n"
    + 'fs.writeFileSync(process.env.STUB_CAPTURE, JSON.stringify({'
    + " argv: process.argv.slice(2), stdin: fs.readFileSync(0, 'utf8') }));\n"
    + "process.stdout.write(process.env.STUB_STDOUT || '');\n",
  );
  process.env.STUB_STDOUT = stdout;
}

const resetCapture = () => fs.rmSync(stubCapture, { force: true });
const readCapture = () => JSON.parse(fs.readFileSync(stubCapture, 'utf8'));
const captureExists = () => fs.existsSync(stubCapture);
const resetLog = () => fs.rmSync(tracePath, { force: true });
const readLog = () =>
  (fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim() : '')
    .split('\n').filter(Boolean).map(JSON.parse);

// The environment the CLI subprocesses run under: isolated HOME (so the
// ~/.view-limits fallback is used — no Claude env anywhere), deterministic
// clock, and the guard preload that blocks every network/credential channel.
// VIEW_LIMITS_ROOT / STUB_* are removed unless a test sets them explicitly.
function cliEnv(options = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    NODE_OPTIONS: `--require=${GUARD}`,
    REVIEW_NOW: String(now),
    REVIEW_LOG: tracePath,
  };
  for (const key of ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'VIEW_LIMITS_ROOT', 'STUB_STDOUT', 'STUB_CAPTURE']) {
    if (options[key] !== undefined) env[key] = options[key];
  }
  return env;
}

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try { return fn(); } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function assertNoNetworkOrCredentials(log, label) {
  const bad = log.filter((e) => /fetch|http|net|tls|provider|vault/.test(e.kind));
  assert.deepStrictEqual(bad, [], `${label}: no network / no credential read, got ${JSON.stringify(bad)}`);
}

(async () => {
  try {
    // ---- 1. SHAPE: a loadable plugin with exactly the wired hook -----------
    assert.ok(fs.existsSync(PLUGIN_PATH), 'harness/opencode/plugin/view-limits.js must exist');
    assert.ok(fs.existsSync(COMMAND_PATH), 'harness/opencode/command/view-limits.md must exist');

    const mod = await import(pathToFileURL(PLUGIN_PATH).href);
    assert.strictEqual(typeof mod.ViewLimits, 'function', 'the plugin exports one initializer');
    assert.deepStrictEqual(Object.keys(mod), ['ViewLimits'], 'exactly one plugin export');
    const hooks = mod.ViewLimits({ client: {} });
    assert.ok(hooks && typeof hooks === 'object' && !Array.isArray(hooks));
    assert.deepStrictEqual(Object.keys(hooks), ['tool.execute.before'],
      'the OpenCode surface wires exactly the dispatch gate');
    assert.strictEqual(typeof hooks['tool.execute.before'], 'function');

    // ---- 2. THIN: bare CLI invocations, nothing else -----------------------
    const pluginSource = fs.readFileSync(PLUGIN_PATH, 'utf8');
    // Structural checks run on code only: the file's comments legitimately
    // name the forbidden idiom while explaining why it is forbidden.
    const pluginCode = pluginSource.replace(/\/\/.*$/gm, '');
    for (const match of pluginCode.matchAll(IMPORT_RE)) {
      assert.ok(ALLOWED_IMPORTS.has(match[1]), `plugin: import ${match[1]} is not a Node builtin`);
    }
    assert.doesNotMatch(pluginCode, /require\s*\(/, 'plugin: ESM only, no CJS require');
    assert.doesNotMatch(pluginCode, /\.\.\/lib|\blib\//, 'plugin: never imports lib/ — the CLI owns all logic');
    assert.match(pluginCode, /spawnSync\('node', \[cliPath\(\), 'gate'\]/,
      'the plugin spawns a bare `node <cli> gate` (literal node — process.execPath is the opencode binary under Bun)');
    assert.doesNotMatch(pluginCode, /process\.execPath/,
      'plugin: never process.execPath — OpenCode runs plugins under Bun, where it is the opencode binary');
    assert.doesNotMatch(pluginCode, FORMAT_TOOL_RE, 'plugin: no text-processing tools');

    const command = fs.readFileSync(COMMAND_PATH, 'utf8');
    assert.match(command, /^---\ndescription: .+\n---\n/, 'command frontmatter');
    const execs = [...command.matchAll(/!`([^`]+)`/g)].map((m) => m[1]);
    assert.strictEqual(execs.length, 1, 'the command interpolates exactly one shell call');
    const exec = execs[0].match(COMMAND_EXEC_RE);
    assert.ok(exec, `command: not a bare CLI invocation: ${execs[0]}`);
    assert.strictEqual(exec[1], ROOT_EXPR, 'command: unexpected root resolution');
    assert.match(command, /relay the output above verbatim/i, 'command: verbatim relay instruction');
    assert.doesNotMatch(command.split(ROOT_EXPR).join('ROOT'), FORMAT_TOOL_RE, 'command: no text-processing tools');
    assert.doesNotMatch(command, /^\|/m, 'command: no markdown table — the CLI renders');
    assert.doesNotMatch(command, /```/, 'command: no code fences — a relay shim holds no code');
    assert.doesNotMatch(command, /summari[sz]\w*|reformat\w*|prettif\w*|as a table/i,
      'command: instruct verbatim relay, never reshaping');

    // ---- 3. LIVE: the real hook, against a capturing stub CLI --------------
    const plugin = mod.ViewLimits({ client: {} });
    const invoke = (tool, args) =>
      withEnv(cliEnv({ VIEW_LIMITS_ROOT: stubRoot, STUB_CAPTURE: stubCapture }), () =>
        plugin['tool.execute.before']({ tool, sessionID: 's1', callID: 'c1' }, { args }));

    // Translation is exact: the envelope sent to the CLI is the one the
    // Claude surface sends — tool_name "Agent" with the model identity.
    installStubCli('');
    resetCapture();
    await invoke('task', { subagent_type: 'plan', model: 'kimi-k2' });
    assert.deepStrictEqual(readCapture(), {
      argv: ALLOWED_GATE_ARGV,
      stdin: JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }),
    }, 'the surface sends the PreToolUse envelope to `vl.js gate`');

    // Deny: an explicit permissionDecision "deny" throws with the CLI's reason.
    installStubCli(DENY_STDOUT);
    await assert.rejects(() => invoke('task', { model: 'kimi-k2' }), /kimi-code-plan.*exhausted/);

    // Allow: empty or allow-deciding stdout never blocks.
    for (const stdout of ['', '{"hookSpecificOutput":{"permissionDecision":"allow"}}', 'null', '{}']) {
      installStubCli(stdout);
      await invoke('task', { model: 'kimi-k2' });
    }

    // Fail open: unparsable CLI output never blocks.
    installStubCli('{broken');
    await invoke('task', { model: 'kimi-k2' });

    // No dispatch identity, no other tool, no args → the CLI is never consulted.
    installStubCli(DENY_STDOUT);
    for (const [tool, args] of [
      ['task', { subagent_type: 'plan' }],        // task args carry no model today
      ['task', { model: '' }],                    // empty identity is absent, not a signal
      ['task', { model: '   ' }],                 // whitespace-only is absent
      ['task', { model: 42 }],                    // non-string identity is absent
      ['task', undefined],                        // no args at all
      ['bash', { model: 'kimi-k2' }],             // never wired for other tools
      [undefined, { model: 'kimi-k2' }],          // malformed input
    ]) {
      resetCapture();
      await invoke(tool, args);
      assert.ok(!captureExists(), `CLI must not be consulted: ${tool} ${JSON.stringify(args)}`);
    }

    // ---- 3b. LIVE: the real CLI, no Claude env, guard preload --------------
    // VIEW_LIMITS_ROOT unset: the plugin resolves bin/vl.js from its own file
    // location in the checkout — the repo-local install path.
    writeConfig({ routes: [route], gate: { mode: 'deny', injectContext: true } });
    writeCache(exhausted());
    resetLog();
    await withEnv(cliEnv(), () => plugin['tool.execute.before'](
      { tool: 'task', sessionID: 's1', callID: 'c1' },
      { args: { model: 'kimi-k2' } },
    )).then(
      () => assert.fail('a fresh exhausted route must deny through the wired CLI'),
      (e) => assert.match(e.message, /kimi-code-plan.*exhausted/),
    );
    assertNoNetworkOrCredentials(readLog(), 'real deny gate');

    // Stale exhaustion must not deny: the gate denies only *fresh* evidence.
    writeCache({ ...exhausted(), freshUntil: new Date(now - 1000).toISOString() });
    resetLog();
    await withEnv(cliEnv(), () => plugin['tool.execute.before'](
      { tool: 'task', sessionID: 's1', callID: 'c1' },
      { args: { model: 'kimi-k2' } },
    ));
    assertNoNetworkOrCredentials(readLog(), 'stale gate');

    // A disabled gate exits before reading stdin and changes nothing.
    writeConfig({ routes: [route], gate: { mode: 'off' } });
    writeCache(exhausted());
    const before = fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8');
    resetLog();
    await withEnv(cliEnv(), () => plugin['tool.execute.before'](
      { tool: 'task', sessionID: 's1', callID: 'c1' },
      { args: { model: 'kimi-k2' } },
    ));
    assert.deepStrictEqual(readLog(), [], 'a disabled gate touches nothing');
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8'), before);

    // A missing checkout (unwritable/nonexistent CLI) must fail open, never
    // block — the fail-open contract of the whole family of surfaces.
    await withEnv(cliEnv({ VIEW_LIMITS_ROOT: path.join(dir, 'nowhere') }), () =>
      plugin['tool.execute.before'](
        { tool: 'task', sessionID: 's1', callID: 'c1' },
        { args: { model: 'kimi-k2' } },
      ));

    console.log('opencode plugin shape, thin-invocation allowlist, exact envelope translation, '
      + 'deny/allow/fail-open paths, Claude-free CLI resolution: PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(`  ✗ ${e.stack || e.message}`);
  process.exit(1);
});
