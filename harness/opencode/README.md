# OpenCode harness surface

Wiring only. This directory contains no view-limits logic: the plugin and the
command delegate to `bin/vl.js`, the same CLI the Claude plugin drives. There is
no second renderer, no second gate, and no OpenCode-specific adapter.

| File | What it is | The call it names |
| --- | --- | --- |
| `plugin/view-limits.js` | OpenCode plugin (plugin-format hooks) | `gate` |
| `command/view-limits.md` | OpenCode custom command | `view --relay` |
| `command/dashboard.md` | OpenCode custom command for the dashboard launch (#136) | `dashboard open --relay` |
| `command/dashboard-stop.md` | OpenCode custom command for shutting the daemon down (#136, Q34-A) | `dashboard stop --relay` |
| `command/dashboard-status.md` | OpenCode custom command for the daemon state read (#136, Q34-A) | `dashboard status --relay` |
| `command/setup-xiaomi.md` | OpenCode custom command for the Xiaomi route setup (Q36-A) | `setup xiaomi-token-plan --relay` |

Each command file is plain instructions, not an injected shell call: it tells the
model to run the one fixed command with its shell tool and relay the output
verbatim. Why that matters is in
["The commands inject nothing"](#the-commands-inject-nothing) below.

## Install

OpenCode loads plugins and commands from its config directory (`~/.config/opencode`
by default; `$XDG_CONFIG_HOME/opencode` when set). Pick one mode.

1. **Repo-local** — point the plugin entry at the checkout and copy the command:

   ```json
   // ~/.config/opencode/opencode.json
   {
     "plugin": ["file:///absolute/path/to/view-limits/harness/opencode/plugin/view-limits.js"]
   }
   ```

   ```sh
   cp harness/opencode/command/view-limits.md harness/opencode/command/dashboard.md \
     harness/opencode/command/dashboard-stop.md harness/opencode/command/dashboard-status.md \
     harness/opencode/command/setup-xiaomi.md ~/.config/opencode/command/
   ```

2. **Set the root** (optional) — with the plugin referenced from the checkout,
   the CLI path resolves from the plugin file's own location, so
   `VIEW_LIMITS_ROOT` is usually unnecessary. Set it only if you copy the
   plugin file elsewhere:

   ```sh
   export VIEW_LIMITS_ROOT="$HOME/path/to/view-limits"
   ```

3. To share state with the Claude plugin, set `VIEW_LIMITS_DATA_DIR` to the
   Claude plugin's data folder. Left unset, the CLI uses `~/.view-limits`.

Nothing here is required — the surface is entirely opt-in. See "Known limits"
before treating the gate as a safety control.

## Behavior

- **`tool.execute.before` (task tool) → `gate`** — the same dispatch gate as the
  Claude plugin: network-free, cache-only, and it denies only a *fresh and
  unambiguously exhausted* route in `deny` mode. The plugin translates the call
  into the same PreToolUse envelope the Claude surface sends and throws when the
  CLI answers with `permissionDecision: "deny"`, which blocks the `task` call.
- **`/view-limits` command → `view`** — the model runs the fixed call and relays
  the CLI's rendered output verbatim, exactly like the Claude `/view-limits`
  command and the Codex skill. `vl.js status` is the cache-only read; the command
  and `vl.js refresh` both collect live, so neither gives you a cache-only
  render.
- **`/dashboard` command → `dashboard open`** — starts the dashboard daemon or
  reuses the one already running, prints its loopback address and opens that
  address in the browser (#136). OpenCode names a custom command after its file,
  so `command/dashboard.md` is `/dashboard`.
- **`/dashboard-stop` and `/dashboard-status` → `dashboard stop` / `dashboard
  status`** — shut the daemon down, and read its address, uptime and last
  collection. Three command files rather than one that takes a word, by owner
  ruling Q34-A, and none of the four injects shell at all: OpenCode merges the
  user's arguments into the template before it looks for shell spans, so an
  injected template would let an argument add a second command — see
  ["The commands inject nothing"](#the-commands-inject-nothing).
  `test/opencode-harness.test.js` pins each file to one fixed call with no
  argument placeholder and no shell span anywhere in it.
- **`/setup-xiaomi` command → `setup xiaomi-token-plan`** — the Xiaomi route’s own
  setup (Q36-A). It reads Chrome console cookies rather than a stored key, so it
  is not in the missing-key form the plain setup offers; the route id is a literal
  inside the fixed call, which is why it is a command of its own rather than an
  argument to another one.

## Fail-open contract

Identical to the other two surfaces: a missing checkout, a missing `node`, a
crash, a timeout, or unparsable CLI output must never block an OpenCode
session. The only thing that blocks is an explicit deny returned by the wired
CLI.

## Known limits

- **The gate currently fails open under OpenCode, always.** OpenCode's `task`
  tool arguments carry no model identity (`subagent_type`, `description`,
  `prompt` only — the subagent's model lives in agent config, not on the call),
  and the plugin never reads config: `vl.js gate` resolves its route from a
  model identity and the plugin skips the CLI entirely when it cannot find one.
  The wiring is real and the deny path is exercised by the test suite through a
  model-bearing envelope, but a real OpenCode `task` call carries no model, so
  the deny is unreachable in practice. The CLI-side mapping from an OpenCode
  dispatch event to a model identity does not exist yet and is tracked
  separately. Do not treat the gate as a safety control on OpenCode today.
- **No session-start refresh.** OpenCode has no `SessionStart` hook equivalent,
  so the Claude/Codex cache warm-up has no wiring point here; run the
  `/view-limits` command (which refreshes) or `vl.js refresh` yourself.
- **`status` reads the cache.** It renders the cache and does no provider I/O.
  The command itself collects live.

## The commands inject nothing

OpenCode custom commands support a bang-backtick line that runs a shell command
and folds its output into the prompt. These four files deliberately do not use
it, because of the order OpenCode expands a command in. In v1.19.4
[`SessionPrompt.command`](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/prompt.ts#L1390)
replaces the argument placeholders in the template — text substituted into prose
counts too — or, when the template has no placeholder, **appends the arguments the
user passed**, and only then does
[`markdown.ts`](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/config/markdown.ts#L6)
scan the result for bang-backtick spans and execute every match. So an argument
like a bang-backtick span around any shell command, supplied to
`/dashboard-status`, becomes a second shell command running next to ours, and
nothing inside the file can reject text before that expansion happens. Quoting
the substitution is not a fix: it is textual.

A file with no shell span of its own contributes none. What is left is the
user's own text reaching OpenCode's documented shell-command path, which is what
the user could have typed in the TUI anyway; the surface adds no command, and the
fixed call is the only one the file mentions. `test/opencode-harness.test.js`
pins that: every command file must contain no bang-backtick sequence anywhere,
no `$` of any kind once the documented root resolution is set aside, exactly one
`sh` block, and that block must be the one fixed CLI call.

The consequence for you: output now arrives because the model ran the command and
relayed it, not because the renderer substituted it, so it is relayed rather than
injected — same bytes from `vl.js`, one extra hop. The user's own
`permission.bash` rule is what pre-approves the call (see below), and OpenCode
does not abort a command the way a Claude shim does.

## The `--relay` flag on the command calls

Each fixed call carries `--relay`, the shim-only exit waiver
([CLI reference](../../docs/cli-reference.md#the--relay-exit-waiver-shim-only)):
the state answers of these commands are not failures — `dashboard status` exits
`3` when nothing is running and `dashboard stop` exits `1` — and the surface
shows output rather than reading an exit code. Output is byte-identical with or
without the flag, it is refused by every other command, and the gate in
`plugin/view-limits.js` deliberately does not carry it: that call's exit code is
part of how the plugin decides to fail open.

## Approval prompts (Issue #142): the grant is config-side, and the default needs none

A Claude shim carries `allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)`
because Claude Code runs the shim's `` !`…` `` exec itself and aborts the whole
invocation outside auto mode when the injected command matches no allow rule
([skills](https://code.claude.com/docs/en/skills),
[permissions](https://code.claude.com/docs/en/permissions)).

OpenCode has no per-command pre-approval field. Verified against the current
OpenCode docs:

- A command file's frontmatter is `description`, `agent` and `model`; the body is
  the prompt template, and `` !`command` `` injects shell output into it. Commands
  run in the project's root directory
  ([commands](https://opencode.ai/docs/commands)). There is no `allowed-tools`
  equivalent to put in `dashboard.md`.
- The gate is the `permission` config, keyed by tool: `bash` is "running shell
  commands (matches parsed commands like `git status --porcelain`)", each rule
  resolving to `allow`, `ask` or `deny`, "Rules are evaluated by pattern match,
  with the last matching rule winning", and "Most permissions default to
  `allow`" ([permissions](https://opencode.ai/docs/permissions)).

So the out-of-the-box answer is: nothing to do — a default OpenCode install lets
the model run that shell call without a prompt, and this surface ships no grant
because there is nowhere per-command to put one.

If you have tightened `bash` to `ask` or `deny` and want view-limits through
anyway, add a narrow pattern of your own, naming the checkout you installed:

```json title="opencode.json"
{
  "permission": {
    "bash": {
      "*": "ask",
      "node *<checkout>/bin/vl.js dashboard open": "allow"
    }
  }
}
```

Write it against how the command actually reads: OpenCode matches the parsed
command text, and its docs note that a command with arguments needs the wildcard
(`"grep *"` allows `grep pattern file.txt`, while `"grep"` alone would block it),
so keep the pattern on the CLI path you mean and nothing wider. `<checkout>` is a
placeholder — put your own path there. If that pattern doesn't take, answer the
prompt with **always** once and read the pattern it offers: "The set of patterns
that `always` would approve is provided by the tool"
([permissions](https://opencode.ai/docs/permissions)) — that is the exact shape
OpenCode expects, rather than one guessed from here.
