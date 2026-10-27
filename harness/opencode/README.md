# OpenCode harness surface

Wiring only. This directory contains no view-limits logic: the plugin and the
command delegate to `bin/vl.js`, the same CLI the Claude plugin drives. There is
no second renderer, no second gate, and no OpenCode-specific adapter.

| File | What it is | CLI call |
| --- | --- | --- |
| `plugin/view-limits.js` | OpenCode plugin (plugin-format hooks) | `gate` |
| `command/view-limits.md` | OpenCode custom command | `view` |
| `command/dashboard.md` | OpenCode custom command for the dashboard launch (#136) | `dashboard open` |

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
   cp harness/opencode/command/view-limits.md harness/opencode/command/dashboard.md ~/.config/opencode/command/
   ```

2. **Set the root** (optional) — with the plugin referenced from the checkout,
   the CLI path resolves from the plugin file's own location, so
   `VIEW_LIMITS_ROOT` is usually unnecessary. Set it only if you copy the
   plugin file elsewhere:

   ```sh
   export VIEW_LIMITS_ROOT="$HOME/path/to/view-limits"
   ```

3. Credentials live in the same vault and cache the Claude surface uses.
   Nothing here needs `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PLUGIN_DATA`: with those
   unset the CLI falls back to `~/.view-limits`, so the gate, the view and
   refresh read the same files Claude does.

Nothing here is required — the surface is entirely opt-in. See "Known limits"
before treating the gate as a safety control.

## Behavior

- **`tool.execute.before` (task tool) → `gate`** — the same dispatch gate as the
  Claude plugin: network-free, cache-only, and it denies only a *fresh and
  unambiguously exhausted* route in `deny` mode. The plugin translates the call
  into the same PreToolUse envelope the Claude surface sends and throws when the
  CLI answers with `permissionDecision: "deny"`, which blocks the `task` call.
- **`/view-limits` command → `view`** — collects the live status through the
  shared collector and relays the CLI's rendered output verbatim, exactly like
  the Claude `/view-limits` command and the Codex skill. `vl.js status` is the
  cache-only read; both the command and `vl.js refresh` collect live, so
  neither gives you a cache-only render.
- **`/dashboard` command → `dashboard open`** — starts the dashboard daemon or
  reuses the one already running, prints its loopback address and opens that
  address in the browser (#136). OpenCode names a custom command after its file,
  so `command/dashboard.md` is `/dashboard`. `dashboard stop` and
  `dashboard status` have no command file: run the CLI, the same one.

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

So the out-of-the-box answer is: nothing to do — a default OpenCode install runs
the command file's `!` call without a prompt, and this surface ships no grant
because there is nowhere to put one.

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
