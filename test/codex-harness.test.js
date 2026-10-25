'use strict';
// Codex harness surface (Issue #38) — harness/codex/*.
//
// The Codex surface is wiring only. This file is the regression guard for that
// claim, in three layers:
//
//   1. SHAPE   — hooks.json is a valid Codex hook config (Codex format, not
//                Claude's `{type, command, args}` array form), the events are
//                the two the surface claims, and every matcher is a string.
//   2. THIN    — every hook command, and the command in the status skill, is a
//                bare `node <cli> <allowlisted-argv>` invocation. No pipes,
//                redirects, subshells, text-processing tools, or formatting —
//                that is AC2 ("no duplicated rendering or business logic")
//                enforced structurally rather than by review. The one allowed
//                expansion is the documented root resolution, and `|| true` is
//                the only allowed shell operator (explicit fail-open).
//   3. LIVE    — the command string is resolved for real through `sh` with a
//                stub `node` that records its argv, and that captured argv is
//                then handed to the real CLI under an isolated HOME with the
//                test/guard.cjs preload. So the assertion is about the bytes
//                Codex would execute, not about a re-parsed copy of them.
//
// Covered: AC1 (gate + status wired to the CLI, running without Claude), AC2
// (thin wrapper), and the no-Claude-fallback contract — `CLAUDE_PLUGIN_DATA`
// and `CLAUDE_PLUGIN_ROOT` are both unset in every subprocess below, so the
// `~/.view-limits` fallback is what makes the surface work outside Claude.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOOKS_PATH = path.join(ROOT, 'harness', 'codex', 'hooks.json');
const SKILL_PATH = path.join(ROOT, 'harness', 'codex', 'skills', 'view-limits', 'SKILL.md');
const GUARD = path.join(__dirname, 'guard.cjs');
const hooks = require('../harness/codex/hooks.json');

// The one expansion the surface is allowed to interpolate: resolve the
// view-limits checkout from VIEW_LIMITS_ROOT, else from the session git root
// (the pattern Codex documents for repo-local hooks).
const ROOT_EXPR = '${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}';
const CLI_INVOCATION = /^node "([\s\S]+)\/bin\/vl\.js"((?: [A-Za-z0-9._:-]+)*) \|\| true$/;
// The status skill is run by the agent, not by a hook that must not block, so
// it carries no `|| true` — a real error there must stay visible.
const CLI_INVOCATION_PLAIN = /^node "([\s\S]+)\/bin\/vl\.js"((?: [A-Za-z0-9._:-]+)*)$/;

// argv each hook is allowed to pass, per hook. Anything else is new logic
// creeping into the surface.
const ALLOWED_ARGV = {
  gate: ['gate'],
  refresh: ['refresh', '--quiet', '--session-start'],
  view: ['view'],
};

// Shaping / processing tools that must never appear in a Codex surface file.
const FORMAT_TOOL_RE =
  /\b(?:sed|awk|jq|grep|perl|printf|column|xargs|cut|paste|fmt|expand|tr|sort|uniq|tee|head|tail|base64|rev|curl|node\s+-e)\b/;

const route = { id: 'kimi-code-plan', provider: 'kimi', match: { model: 'kimi' } };
const now = Date.parse('2026-10-10T00:00:00Z');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-codex-'));
const home = path.join(dir, 'home');
const dataDir = path.join(home, '.view-limits');
const capture = path.join(dir, 'argv.txt');
const tracePath = path.join(dir, 'trace.log');
const binDir = path.join(dir, 'stub');
const cli = path.join(ROOT, 'bin', 'vl.js');

// No Claude env anywhere: the surface must stand on its own.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  NODE_OPTIONS: `--require=${GUARD}`,
  REVIEW_NOW: String(now),
  REVIEW_LOG: tracePath,
};

const exhausted = () => ({
  freshUntil: new Date(now + 60000).toISOString(),
  status: { state: 'exhausted', resetAt: '2026-10-10T05:00:00Z' },
});

// The exact envelope shape Codex documents for PreToolUse: a top-level `model`
// (the session's active model slug) and a `tool_input.command`, with no
// model identity inside tool_input.
const codexBashEvent = {
  session_id: 'codex-session',
  transcript_path: null,
  cwd: ROOT,
  hook_event_name: 'PreToolUse',
  model: 'gpt-5-codex',
  turn_id: 'turn-1',
  tool_name: 'Bash',
  tool_use_id: 'tool-1',
  tool_input: { command: 'claude -p "ship it"' },
};

const resetLog = () => fs.rmSync(tracePath, { force: true });
const readLog = () =>
  (fs.existsSync(tracePath) ? fs.readFileSync(tracePath, 'utf8').trim() : '')
    .split('\n').filter(Boolean).map(JSON.parse);

// Resolve a hook's `command` string the way Codex would: through a shell, with
// a stub `node` first on PATH that records the argv it was handed. Returns the
// argv, so the rest of the test exercises the real command line.
function resolveArgv(command, options = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, 'node'),
    '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$CAPTURE"\n',
    { mode: 0o755 },
  );
  fs.rmSync(capture, { force: true });
  const result = spawnSync('sh', ['-c', command], {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      CAPTURE: capture,
      ...(options.env || {}),
    },
  });
  assert.strictEqual(result.status, 0, result.stderr || String(result.error));
  return fs.readFileSync(capture, 'utf8').split('\n').filter(Boolean);
}

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

function runCli(argv, options = {}) {
  const result = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 10000,
    input: options.input,
  });
  assert.strictEqual(result.status, 0, result.stderr || String(result.error));
  return result;
}

function assertNoNetworkOrCredentials(log, label) {
  const bad = log.filter((e) => /fetch|http|net|tls|provider|vault/.test(e.kind));
  assert.deepStrictEqual(bad, [], `${label}: no network / no credential read, got ${JSON.stringify(bad)}`);
}

try {
  // ---- 1. SHAPE: a valid Codex hook config ---------------------------------
  assert.ok(fs.existsSync(HOOKS_PATH), 'harness/codex/hooks.json must exist');
  assert.ok(fs.existsSync(SKILL_PATH), 'harness/codex/skills/view-limits/SKILL.md must exist');
  assert.ok(hooks.hooks && typeof hooks.hooks === 'object' && !Array.isArray(hooks.hooks));
  assert.deepStrictEqual(
    Object.keys(hooks.hooks).sort(),
    ['PreToolUse', 'SessionStart'],
    'the Codex surface wires exactly the gate and the session refresh',
  );

  const handlers = [];
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    assert.ok(Array.isArray(groups) && groups.length > 0, `${event}: matcher groups required`);
    for (const group of groups) {
      assert.strictEqual(typeof group.matcher, 'string', `${event}: matcher must be a regex string`);
      assert.ok(Array.isArray(group.hooks) && group.hooks.length > 0, `${event}: handlers required`);
      for (const handler of group.hooks) {
        assert.strictEqual(handler.type, 'command', `${event}: Codex handler type`);
        // Codex passes a shell string; the Claude `{command, args}` array form
        // would silently not run here.
        assert.strictEqual(typeof handler.command, 'string', `${event}: command must be a shell string`);
        assert.ok(!Array.isArray(handler.args), `${event}: Codex has no argv array`);
        assert.ok(Number.isFinite(handler.timeout) && handler.timeout > 0, `${event}: positive timeout`);
        assert.ok(handler.timeout <= 60, `${event}: a hook must stay well under the 600s default`);
        handlers.push({ event, matcher: group.matcher, ...handler });
      }
    }
  }
  assert.deepStrictEqual(handlers.map((h) => h.event).sort(), ['PreToolUse', 'SessionStart']);
  // Codex only intercepts Bash on PreToolUse; a matcher for any other tool
  // would be dead config.
  assert.deepStrictEqual(
    handlers.filter((h) => h.event === 'PreToolUse').map((h) => h.matcher),
    ['Bash'],
  );

  // ---- 2. THIN: bare CLI invocations, nothing else -------------------------
  for (const handler of handlers) {
    const match = handler.command.match(CLI_INVOCATION);
    assert.ok(match, `${handler.event}: not a bare CLI invocation: ${handler.command}`);
    assert.strictEqual(match[1], ROOT_EXPR, `${handler.event}: unexpected root resolution`);
    const argv = match[2].trim().split(/\s+/);
    const key = argv[0];
    assert.ok(Object.hasOwn(ALLOWED_ARGV, key), `${handler.event}: subcommand ${key} is not part of the surface`);
    assert.deepStrictEqual(argv, ALLOWED_ARGV[key], `${handler.event}: unexpected argv`);
    // The only shell operators allowed are the fail-open `|| true` and the one
    // documented root resolution — no pipes, redirects, `;`, `&&`, backticks.
    // Checked with the expansion stripped, which is asserted identical to
    // ROOT_EXPR above, so `git rev-parse` is not mistaken for the `rev` tool.
    const withoutRoot = handler.command.split(ROOT_EXPR).join('ROOT');
    assert.doesNotMatch(withoutRoot, FORMAT_TOOL_RE, `${handler.event}: no text-processing tools`);
    // `|| true` is required by the CLI_INVOCATION shape above; strip it so the
    // operator scan sees nothing else — no pipes, redirects, `;`, `&&`, `$(...)`.
    assert.doesNotMatch(
      withoutRoot.replace(/\s*\|\|\s*true$/, ''),
      /[|;&<>`]/,
      `${handler.event}: no shell operators besides '|| true'`,
    );
    assert.strictEqual((handler.command.match(/\$\(/g) || []).length, 1, `${handler.event}: one expansion only`);
  }

  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.match(skill, /^---\nname: view-limits\ndescription: .+\n---\n/, 'skill frontmatter');
  const skillCommands = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  assert.strictEqual(skillCommands.length, 1, 'the skill runs exactly one command');
  const skillMatch = skillCommands[0].match(CLI_INVOCATION_PLAIN);
  assert.ok(skillMatch, `skill: not a bare CLI invocation: ${skillCommands[0]}`);
  assert.strictEqual(skillMatch[1], ROOT_EXPR, 'skill: unexpected root resolution');
  assert.deepStrictEqual(
    skillMatch[2].trim().split(/\s+/),
    ALLOWED_ARGV.view,
    'skill: the status surface wires to `vl.js view`',
  );
  assert.doesNotMatch(skill.split(ROOT_EXPR).join('ROOT'), FORMAT_TOOL_RE, 'skill: no text-processing tools');
  assert.doesNotMatch(skill, /^\|/m, 'skill: no markdown table — the CLI renders the table');
  assert.match(skill, /relay/i);
  assert.doesNotMatch(skill, /summar|reformat|extract the|rebuild/i,
    'skill: instruct verbatim relay, never reshaping');

  // ---- 3. LIVE: the real command lines, against the real CLI ----------------
  const gateArgv = resolveArgv(handlers.find((h) => h.event === 'PreToolUse').command);
  const refreshArgv = resolveArgv(handlers.find((h) => h.event === 'SessionStart').command);
  for (const argv of [gateArgv, refreshArgv]) {
    assert.strictEqual(argv[0], path.join(ROOT, 'bin', 'vl.js'), 'resolves to the real CLI');
    assert.ok(fs.existsSync(argv[0]));
  }
  assert.deepStrictEqual(gateArgv.slice(1), ALLOWED_ARGV.gate);
  assert.deepStrictEqual(refreshArgv.slice(1), ALLOWED_ARGV.refresh);

  // VIEW_LIMITS_ROOT must win over the git-root fallback, or the global
  // install mode documented in harness/codex/README.md would not work.
  const overrideRoot = path.join(dir, 'elsewhere');
  fs.mkdirSync(path.join(overrideRoot, 'bin'), { recursive: true });
  const overrideArgv = resolveArgv(handlers[0].command, {
    cwd: os.tmpdir(), // not a git repo — the fallback must not be what resolves it
    env: { VIEW_LIMITS_ROOT: overrideRoot },
  });
  assert.strictEqual(overrideArgv[0], path.join(overrideRoot, 'bin', 'vl.js'));
  assert.deepStrictEqual(overrideArgv.slice(1), ALLOWED_ARGV.gate);

  // No Claude env is set in `env`, so the CLI resolves ~/.view-limits on its
  // own — the contract that lets this surface run without Claude.
  writeConfig({ routes: [route], gate: { mode: 'deny', injectContext: true } });
  assert.deepStrictEqual(
    (() => { const e = { ...env }; delete e.CLAUDE_PLUGIN_DATA; delete e.CLAUDE_PLUGIN_ROOT; return e; })(),
    env,
    'the subprocess env must not carry Claude variables',
  );

  // A Codex PreToolUse event cannot deny: the envelope has no model identity in
  // tool_input, so the gate fails open and stays silent. That is the documented
  // limit (harness/codex/README.md "Known limits") — assert it so it cannot
  // silently change, and so the hook is proven never to block a session.
  writeCache(exhausted());
  resetLog();
  const codexGate = runCli(gateArgv, { input: JSON.stringify(codexBashEvent) });
  assert.strictEqual(codexGate.stdout, '', 'the gate stays silent on a Codex Bash envelope');
  assert.strictEqual(codexGate.stderr, '', 'the gate must never write to stderr (stderr blocks)');
  assertNoNetworkOrCredentials(readLog(), 'codex gate');

  // Malformed / empty stdin must fail open exactly the same way.
  for (const input of ['', 'null', '{broken', JSON.stringify({})]) {
    resetLog();
    const result = runCli(gateArgv, { input });
    assert.strictEqual(result.stdout, '', `empty/malformed gate input fails open: ${input}`);
    assert.strictEqual(result.stderr, '');
    assertNoNetworkOrCredentials(readLog(), 'malformed gate input');
  }

  // The deny path IS reachable through the same wired argv when the dispatch
  // event carries a model identity — proving the wiring is functional, not
  // decorative, and that the shape emitted is the one Codex reads.
  const dispatchGate = runCli(gateArgv, {
    input: JSON.stringify({
      session_id: 'codex-session',
      cwd: ROOT,
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { model: 'kimi-k2' },
    }),
  });
  const decision = JSON.parse(dispatchGate.stdout).hookSpecificOutput;
  assert.strictEqual(decision.hookEventName, 'PreToolUse');
  assert.strictEqual(decision.permissionDecision, 'deny');
  assert.ok(decision.permissionDecisionReason, 'a deny carries a reason');
  assertNoNetworkOrCredentials(readLog(), 'deny gate');

  // Stale evidence must not deny: the gate denies only a *fresh* exhaustion.
  // With injectContext on it may still emit the advisory additionalContext.
  writeCache({ ...exhausted(), freshUntil: new Date(now - 1000).toISOString() });
  const stale = runCli(gateArgv, {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: { model: 'kimi-k2' } }),
  });
  if (stale.stdout) {
    const staleDecision = JSON.parse(stale.stdout).hookSpecificOutput;
    assert.strictEqual(staleDecision.hookEventName, 'PreToolUse');
    assert.notStrictEqual(staleDecision.permissionDecision, 'deny', 'stale exhaustion fails open');
  }

  // A disabled gate exits before it even reads stdin, and changes nothing.
  writeConfig({ routes: [route], gate: { mode: 'off' } });
  const before = fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8');
  resetLog();
  const off = runCli(gateArgv, { input: JSON.stringify(codexBashEvent) });
  assert.strictEqual(off.stdout, '');
  assert.strictEqual(off.stderr, '');
  assert.deepStrictEqual(readLog(), [], 'a disabled gate touches nothing');
  assert.strictEqual(fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8'), before);

  // The session refresh stays inert unless refreshOnSessionStart is on, and
  // never blocks a session even when the data dir is unwritable.
  writeConfig({ routes: [route], gate: { mode: 'off' }, refreshOnSessionStart: false });
  const cached = fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8');
  for (const value of [undefined, null, false, 'true', 1, {}]) {
    if (value === undefined) {
      writeConfig({ routes: [route], gate: { mode: 'off' } });
    } else {
      writeConfig({ routes: [route], gate: { mode: 'off' }, refreshOnSessionStart: value });
    }
    resetLog();
    const result = runCli(refreshArgv);
    assert.strictEqual(result.stdout, '', `disabled session refresh is silent: ${JSON.stringify(value)}`);
    assert.strictEqual(result.stderr, '');
    assert.deepStrictEqual(readLog(), [], 'a disabled session refresh calls no provider');
    assert.strictEqual(fs.readFileSync(path.join(dataDir, 'status.json'), 'utf8'), cached);
    assert.ok(!fs.existsSync(path.join(dataDir, 'refresh-workers')), 'no refresh worker lock taken');
  }

  // Missing credentials still produce a report rather than a failure.
  fs.rmSync(path.join(dataDir, 'status.json'), { force: true });
  writeConfig({ routes: [], gate: { mode: 'off' } });
  const bare = runCli([cli, 'status']);
  assert.strictEqual(bare.status, 0);
  assert.match(bare.stdout, /view-limits/i, 'status reports even with no credentials configured');

  console.log('codex hooks shape, thin-invocation allowlist, VIEW_LIMITS_ROOT resolution, '
    + 'Claude-free gate fail-open/deny reachability, disabled session refresh: PASS');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}