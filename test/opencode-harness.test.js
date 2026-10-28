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
const { cliEnv: cliEnvBase, withEnv } = require('./helpers/gated-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_PATH = path.join(ROOT, 'harness', 'opencode', 'plugin', 'view-limits.js');
const COMMAND_PATH = path.join(ROOT, 'harness', 'opencode', 'command', 'view-limits.md');
const DASHBOARD_COMMAND_PATH = path.join(ROOT, 'harness', 'opencode', 'command', 'dashboard.md');
const DASHBOARD_STOP_COMMAND_PATH = path.join(ROOT, 'harness', 'opencode', 'command', 'dashboard-stop.md');
const DASHBOARD_STATUS_COMMAND_PATH = path.join(ROOT, 'harness', 'opencode', 'command', 'dashboard-status.md');
const SETUP_XIAOMI_COMMAND_PATH = path.join(ROOT, 'harness', 'opencode', 'command', 'setup-xiaomi.md');
const GUARD = path.join(__dirname, 'guard.cjs');

// The one expansion the surface is allowed to interpolate in a command file:
// resolve the checkout from VIEW_LIMITS_ROOT, else from the session git root (the
// pattern the Codex surface documents). Nothing else in these files may hold a
// `$`.
const ROOT_EXPR = '${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}';
// A bare `node <root>/bin/vl.js <argv…>` line, pinned the way the Codex guard
// pins its skills.
const CLI_CALL_PLAIN = /^node "([\s\S]+)\/bin\/vl\.js"((?: [A-Za-z0-9._:-]+)*)$/;

// The four OpenCode commands and the ONE fixed call each may name. Round-2
// review: the files carry no injected shell span at all — OpenCode expands the
// user's arguments into the template before it scans for bang-backtick commands
// and runs every match, so an injected template lets an argument add a second
// command beside ours and nothing inside the file can reject it first. Under
// Q34-A the files are plain instructions instead: the model runs the fixed call
// with its shell tool, and `--relay` is the shim-only exit waiver.
const COMMAND_FILES = [
  { file: COMMAND_PATH, label: 'view-limits', argv: ['view', '--relay'] },
  { file: DASHBOARD_COMMAND_PATH, label: 'dashboard', argv: ['dashboard', 'open', '--relay'] },
  { file: DASHBOARD_STOP_COMMAND_PATH, label: 'dashboard-stop', argv: ['dashboard', 'stop', '--relay'] },
  { file: DASHBOARD_STATUS_COMMAND_PATH, label: 'dashboard-status', argv: ['dashboard', 'status', '--relay'] },
  // Q36-A: the Xiaomi route has its own command, so its route id is a literal
  // inside the fixed call rather than something the user passes.
  { file: SETUP_XIAOMI_COMMAND_PATH, label: 'setup-xiaomi', argv: ['setup', 'xiaomi-token-plan', '--relay'] },
];

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
// [#78] Env construction moved to test/helpers/gated-env.cjs so the
// ambient-key scrubbing (CLAUDE_PLUGIN_DATA / CLAUDE_PLUGIN_ROOT /
// VIEW_LIMITS_ROOT always emitted, undefined ⇒ deleted) is shared with, and
// pinned by, test/env-isolation.test.js. This wrapper binds this file's
// per-run constants; every call site keeps its original shape.
const cliEnv = (options = {}) => cliEnvBase(
  {
    PATH: process.env.PATH,
    HOME: home,
    NODE_OPTIONS: `--require=${GUARD}`,
    REVIEW_NOW: String(now),
    REVIEW_LOG: tracePath,
  },
  options,
);

function assertNoNetworkOrCredentials(log, label) {
  const bad = log.filter((e) => /fetch|http|net|tls|provider|vault/.test(e.kind));
  assert.deepStrictEqual(bad, [], `${label}: no network / no credential read, got ${JSON.stringify(bad)}`);
}

// The one predicate a non-injecting OpenCode command must satisfy. Returns the
// reasons it is not one, so the same rules can be run against a mutant in the
// negative control below, and each control is asserted against the SPECIFIC
// reason it must trip — otherwise a mutant could pass for an unrelated reason and
// the control would prove nothing.
//
// `allowedRoots` is the one place a fixture may name a root other than the real
// expansion. The files on disk get no such allowance: they must resolve the
// checkout exactly as the surface documents it.
// Issue #148: the data directory is the one optional addition after the CLI
// path (VIEW_LIMITS_DATA_DIR set: pass it; unset: nothing). It must appear
// exactly once, directly after the path, and is removed before every other check
// so those stay as strict as they were.
const DATA_DIR_EXPR = ' ${VIEW_LIMITS_DATA_DIR:+--data-dir="$VIEW_LIMITS_DATA_DIR"}';
function commandFileProblems(label, rawCommand, { argv = null, allowedRoots = [ROOT_EXPR] } = {}) {
  const bad = [];
  let command = rawCommand;
  if (command.split('/bin/vl.js"' + DATA_DIR_EXPR).length !== 2) {
    bad.push(`${label}: must carry the data-dir expansion exactly once, right after the CLI path`);
  } else {
    command = command.replace('/bin/vl.js"' + DATA_DIR_EXPR, '/bin/vl.js"');
  }
  if (!/^---\ndescription: [^\n]+\n---\n/.test(command)) bad.push(`${label}: no single-description frontmatter`);
  // The load-bearing check: the sequence OpenCode scans for must not appear in
  // the file at all — prose included — so the surface contributes no shell
  // command to whatever an argument turns the template into.
  if (/!`/.test(command)) bad.push(`${label}: contains a bang-backtick sequence, which OpenCode executes after it merges the user's arguments into the template`);
  if (/\$ARGUMENTS|\$\{|\$\d/.test(command.split(ROOT_EXPR).join('ROOT'))) bad.push(`${label}: carries an argument placeholder`);
  if (command.split(ROOT_EXPR).join('ROOT').includes('$')) bad.push(`${label}: substitutes something beyond the documented root resolution`);
  const fences = [...command.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  if (fences.length !== 1) bad.push(`${label}: ${fences.length} sh blocks, expected exactly the one fixed call`);
  if (fences.length === 1) {
    const call = fences[0].match(CLI_CALL_PLAIN);
    if (!call) bad.push(`${label}: the block is not a bare CLI invocation: ${fences[0]}`);
    else {
      if (!allowedRoots.includes(call[1])) bad.push(`${label}: unexpected root resolution: ${call[1]}`);
      if (argv && call[2].trim().split(/\s+/).join(' ') !== argv.join(' ')) {
        bad.push(`${label}: the call is \`vl.js ${call[2].trim()}\`, expected \`vl.js ${argv.join(' ')}\``);
      }
    }
  }
  // No code block besides the one fixed call: two ``` markers in the whole file,
  // and they are that block's.
  const markers = (command.match(/^[ \t]*```/gm) || []).length;
  if (markers !== 2) bad.push(`${label}: ${markers} code-fence markers in the file, expected exactly the two that wrap the fixed call`);
  if (!/run exactly this command with the shell tool/i.test(command)) bad.push(`${label}: does not tell the model to run the fixed call`);
  if (!/relay the output above verbatim/i.test(command)) bad.push(`${label}: no verbatim relay instruction`);
  if (FORMAT_TOOL_RE.test(command.split(ROOT_EXPR).join('ROOT'))) bad.push(`${label}: names a text-processing tool`);
  if (/^\|/m.test(command)) bad.push(`${label}: lays out a markdown table — the CLI renders`);
  if (/summari[sz]\w*|reformat\w*|prettif\w*|as a table/i.test(command)) bad.push(`${label}: tells the agent to reshape output`);
  return bad;
}

(async () => {
  try {
    // ---- 1. SHAPE: a loadable plugin with exactly the wired hook -----------
    assert.ok(fs.existsSync(PLUGIN_PATH), 'harness/opencode/plugin/view-limits.js must exist');
    assert.ok(fs.existsSync(COMMAND_PATH), 'harness/opencode/command/view-limits.md must exist');
    assert.ok(fs.existsSync(DASHBOARD_COMMAND_PATH), 'harness/opencode/command/dashboard.md must exist');
    assert.ok(fs.existsSync(DASHBOARD_STOP_COMMAND_PATH), 'harness/opencode/command/dashboard-stop.md must exist');
    assert.ok(fs.existsSync(DASHBOARD_STATUS_COMMAND_PATH), 'harness/opencode/command/dashboard-status.md must exist');

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
    assert.match(pluginCode, /spawnSync\('node', \[cliPath\(\), \.\.\.dataDirArgs\(\), 'gate'\]/,
      'the plugin spawns a bare `node <cli> gate` (literal node — process.execPath is the opencode binary under Bun)');
    assert.doesNotMatch(pluginCode, /process\.execPath/,
      'plugin: never process.execPath — OpenCode runs plugins under Bun, where it is the opencode binary');
    assert.doesNotMatch(pluginCode, FORMAT_TOOL_RE, 'plugin: no text-processing tools');

    // The four command files run NOTHING themselves. OpenCode substitutes
    // `$ARGUMENTS` (prose included) or appends unused arguments to the template,
    // then scans the result with /!`([^`]+)`/g and executes every match — so a
    // template that carries an injected call lets a user argument add a second
    // shell command next to ours, and no amount of argument handling inside the
    // file can reject text before that expansion. Under Q34-A these files are
    // therefore plain instructions: exactly one fixed CLI call in a `sh` block
    // for the model to run with its shell tool, no bang-backtick sequence
    // anywhere in the file (prose included), and no placeholder that could carry
    // an argument. The user's own permission.bash rule is what pre-approves the
    // call, exactly as on the Codex surface.
    // The four command files and the one fixed call each is allowed to name.
    // Their shape is checked through ONE predicate, so the negative control
    // below proves the same rules reject the reviewer's payload shape rather
    // than the rules being an accident of what the files happen to look like.
    for (const spec of COMMAND_FILES) {
      assert.ok(fs.existsSync(spec.file), `harness/opencode/command/${spec.label}.md must exist`);
      const command = fs.readFileSync(spec.file, 'utf8');
      const problems = commandFileProblems(spec.label, command, { argv: spec.argv });
      assert.deepStrictEqual(problems, [], problems.join(' | '));
    }

    // Negative control, in memory: OpenCode's expansion order is
    // substitute-or-append, THEN scan for shell spans. A file that injects a
    // call — the shape these files had before the round-2 review — passes the
    // old "one exec, fixed argv" checks and must be refused here.
    const PAYLOAD = '!`printf VL_USER_TEXT_RAN`';
    // Each mutant is asserted against the SPECIFIC reason it must trip. The
    // fixture root here is `x`; the real files get no such allowance, so a check
    // on disk cannot pass on a made-up path (R3-A1).
    const fix = (call, tail = '') => `---\ndescription: d\n---\n\nRun exactly this command with the shell tool:\n\n\`\`\`sh\n${call}\n\`\`\`\n\nRelay the output above verbatim.\n${tail}`;
    const GOOD = 'node "x/bin/vl.js" view --relay';
    const controls = [
      ['the shape the files had before the review: an injected exec line beside the call',
        fix(GOOD, `\n!\`node "x/bin/vl.js" dashboard status --relay\`\n`), /bang-backtick sequence/],
      ['the reviewer payload appended as prose',
        fix(GOOD, `\n${PAYLOAD}\n`), /bang-backtick sequence/],
      ['the payload inside a fenced block, where a reader might trust it',
        fix(GOOD, `\n\`\`\`md\n${PAYLOAD}\n\`\`\`\n`), /bang-backtick sequence|code block that is not/],
      ['an argument placeholder in prose',
        fix(GOOD, '\nPass $' + '{ARGUMENTS} to choose a route.\n'), /argument placeholder|substitutes something/],
      ['a positional placeholder',
        fix(GOOD, '\nRun it with $1 for one route.\n'), /argument placeholder|substitutes something/],
      ['a second fixed call in a second sh block',
        fix(GOOD) + '\nand\n```sh\nnode "x/bin/vl.js" report\n```\n', /sh blocks|code block that is not/],
      ['the fixed call with an extra flag',
        fix('node "x/bin/vl.js" view --relay --json'), /the call is/],
      ['the fixed call with a substitution beyond the root resolution',
        fix('node "x/bin/vl.js" view --relay $HOME'), /substitutes something beyond/],
      ['the fixed call without --relay',
        fix('node "x/bin/vl.js" view'), /the call is/],
      ['the fixed call pointed at another verb',
        fix('node "x/bin/vl.js" dashboard lan rotate'), /the call is/],
      ['no sh block at all', `---\ndescription: d\n---\n\nRun the CLI and relay it.\n`, /0 sh blocks/],
      ['no relay instruction', fix(GOOD).replace('Relay the output above verbatim.', ''), /verbatim relay instruction/],
      ['no instruction to run it', fix(GOOD).replace('Run exactly this command with the shell tool:', ''), /does not tell the model/],
    ];
    for (const [label, text, expect] of controls) {
      const problems = commandFileProblems('control', text, { argv: ['view', '--relay'], allowedRoots: [ROOT_EXPR, 'x'] });
      assert.ok(problems.length > 0, `negative control accepted: ${label}`);
      assert.ok(problems.some((p) => expect.test(p)),
        `negative control "${label}" failed for the wrong reason: ${problems.join(' | ')} (expected /${expect.source}/)`);
    }
    // The same predicate passes every real file, so a control differs in the one
    // thing it claims to test rather than in everything.
    for (const spec of COMMAND_FILES) {
      assert.deepStrictEqual(
        commandFileProblems(spec.label, fs.readFileSync(spec.file, 'utf8'), { argv: spec.argv }), [],
        'the real file must satisfy the predicate the controls fail');
    }

    // And the rule the shape exists to satisfy, modelled the way OpenCode
    // actually expands a command (v1.19.4 SessionPrompt.command): arguments are
    // substituted, or appended when the template holds no placeholder, and the
    // RESULT is then scanned for shell spans. Under that order the only guarantee
    // a file can give is that it contributes none — so that is what is asserted,
    // for an ordinary argument and for the reviewer's payload alike.
    const SCAN = /!`([^`]+)`/g;
    const expand = (template, args) => (/\$ARGUMENTS|\$\{ARGUMENTS/.test(template)
      ? template.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args)
      : `${template}\n${args}`);
    const spansOf = (text) => [...text.matchAll(SCAN)].map((m) => m[1].trim());
    for (const spec of COMMAND_FILES) {
      const command = fs.readFileSync(spec.file, 'utf8');
      assert.deepStrictEqual(spansOf(command), [], `${spec.label}: the template itself contributes no shell span`);
      assert.deepStrictEqual(spansOf(expand(command, 'hello')), [],
        `${spec.label}: an ordinary argument adds no shell span after expansion`);
      // The payload from the review. Whatever this produces, it must not include
      // anything the FILE supplied: the only span present is the one the user
      // typed, which is OpenCode's documented shell-command path rather than a
      // command this surface put there.
      const hostile = expand(command, '!`printf VL_USER_TEXT_RAN`');
      assert.deepStrictEqual(spansOf(hostile), ['printf VL_USER_TEXT_RAN'],
        `${spec.label}: the file must not add a span of its own next to the user's`);
      // …and the shape these files had before this round proves the opposite:
      // two spans run, one of them the surface's own fixed call, chosen by an
      // argument the user typed after the command name.
      const injectedTemplate = `${command}\n!\`node "x/bin/vl.js" dashboard status --relay\`\n`;
      assert.strictEqual(spansOf(injectedTemplate).length, 1, 'the injected shape has one span of its own to begin with');
      assert.deepStrictEqual(spansOf(expand(injectedTemplate, '!`printf VL_USER_TEXT_RAN`')).sort(),
        ['node "x/bin/vl.js" dashboard status --relay', 'printf VL_USER_TEXT_RAN'].sort(),
        'the old injecting shape would have run the fixed call AND the user payload');
    }

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

    // Issue #148: VIEW_LIMITS_DATA_DIR becomes the CLI's --data-dir, ahead of the
    // subcommand, and only when it is set. Never --claude-plugin.
    const sharedData = path.join(dir, 'shared-data');
    resetCapture();
    await withEnv(cliEnv({ VIEW_LIMITS_ROOT: stubRoot, STUB_CAPTURE: stubCapture, VIEW_LIMITS_DATA_DIR: sharedData }), () =>
      plugin['tool.execute.before']({ tool: 'task', sessionID: 's1', callID: 'c1' }, { args: { model: 'kimi-k2' } }));
    assert.deepStrictEqual(readCapture().argv, ['--data-dir', sharedData, ...ALLOWED_GATE_ARGV],
      'VIEW_LIMITS_DATA_DIR is passed to the gate as --data-dir');

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
