# Codex harness surface

Wiring only. This directory contains no view-limits logic: every hook and the
skill delegate to `bin/vl.js`, which is the same CLI the Claude plugin drives.
There is no second renderer, no second gate, and no Codex-specific adapter.

| File | What it is | CLI call |
| --- | --- | --- |
| `hooks.json` | Codex hook config (Codex format, not Claude's) | `gate`, `refresh --quiet --session-start` (no `--relay`: a hook contract keeps its exit code) |
| `skills/view-limits/SKILL.md` | Codex skill for the status surface | `view --relay` |
| `skills/view-limits-dashboard/SKILL.md` | Codex skill for the dashboard launch (#136) | `dashboard open --relay` |
| `skills/view-limits-dashboard-stop/SKILL.md` | Codex skill for shutting the daemon down (#136, Q34-A) | `dashboard stop --relay` |
| `skills/view-limits-dashboard-status/SKILL.md` | Codex skill for the daemon state read (#136, Q34-A) | `dashboard status --relay` |
| `skills/view-limits-setup-xiaomi/SKILL.md` | Codex skill for the Xiaomi route setup (#136 follow-up, Q36-A) | `setup xiaomi-token-plan --relay` |

## Install

Codex merges every `hooks.json` it finds, so pick one mode.

1. Enable the feature flag in `~/.codex/config.toml` (or the repo's config):

   ```toml
   [features]
   codex_hooks = true
   ```

2. Install the surface.

   **Repo-local** — copy `hooks.json` to `<repo>/.codex/hooks.json` and the skill
   to `<repo>/.codex/skills/view-limits/`. With `VIEW_LIMITS_ROOT` unset the CLI
   path resolves from the session git root, which is the pattern Codex documents
   for repo-local hooks:

   ```sh
   mkdir -p .codex/skills && cp -R harness/codex/hooks.json .codex/ \
     && cp -R harness/codex/skills/view-limits harness/codex/skills/view-limits-dashboard \
        harness/codex/skills/view-limits-dashboard-stop harness/codex/skills/view-limits-dashboard-status \
        harness/codex/skills/view-limits-setup-xiaomi .codex/skills/
   ```

   **Global (installed checkout)** — copy both into `~/.codex/` and point
   `VIEW_LIMITS_ROOT` at the view-limits checkout so the hooks work from any
   directory:

   ```sh
   cp harness/codex/hooks.json ~/.codex/hooks.json
   mkdir -p ~/.codex/skills && cp -R harness/codex/skills/view-limits harness/codex/skills/view-limits-dashboard \
     harness/codex/skills/view-limits-dashboard-stop harness/codex/skills/view-limits-dashboard-status \
     harness/codex/skills/view-limits-setup-xiaomi ~/.codex/skills/
   export VIEW_LIMITS_ROOT="$HOME/path/to/view-limits"
   ```

3. Credentials live in the same vault and cache the Claude surface uses.
   Nothing here needs `CLAUDE_PLUGIN_ROOT` or `CLAUDE_PLUGIN_DATA`: with those
   unset the CLI falls back to `~/.view-limits`, so the view, the gate, and
   refresh all read the same files Claude does.

Nothing here is required — the surface is entirely opt-in, and no hook in it can
block a session. See "Known limits" below.

## Behavior

- **`PreToolUse` → `gate`** — the same dispatch gate as the Claude plugin:
  network-free, cache-only, and it denies only a *fresh and unambiguously
  exhausted* route in `deny` mode. Deny is reported in the shape both harnesses
  read: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`.
- **`SessionStart` → `refresh --quiet --session-start`** — refreshes the cache
  when `refreshOnSessionStart` is enabled. Silent by default; it is off unless
  you turn it on.
- **`|| true`** on both commands is deliberate fail-open. A missing checkout, a
  missing `node`, or a crash must never block a Codex session. It cannot hide a
  deny: the gate exits `0` and prints its decision on stdout, so `|| true` only
  swallows the "nothing installed" case.
- **`view-limits-dashboard` skill → `dashboard open`** — starts the dashboard
  daemon or reuses the one already running, prints its loopback address, and
  opens that address in the browser (#136).
- **`view-limits-dashboard-stop` / `-status` skills → `dashboard stop` /
  `dashboard status`** — shut the daemon down, and read its address, uptime and
  last collection. Three skills rather than one that takes a word, by owner
  ruling Q34-A: each file names one fixed call, so nothing a user types can
  become shell text in a command the surface has already approved.
- **`view-limits-setup-xiaomi` skill → `setup xiaomi-token-plan`** — the Xiaomi
  route's own setup (owner ruling Q36-A). That route reads Chrome console cookies
  rather than a stored key, so it is not part of the missing-key form the plain
  setup offers, and the route id is a literal inside this call instead of an
  argument another command would have to take. The profile and console-source
  options stay in the terminal: `vl.js setup xiaomi-token-plan --profile "Profile 1"`.

## Known limits

- **The gate currently fails open under Codex, always.** Codex's `PreToolUse`
  matcher only intercepts `Bash`, and a Bash hook event carries
  `tool_input.command` — not a model identity. `vl.js gate` resolves its route
  from a model identity and exits silently when it cannot find one, so the deny
  path is unreachable today. The wiring is real and correct; the CLI-side
  mapping from a Codex dispatch event to a model identity does not exist yet and
  is tracked separately. Until then this hook costs one `node` spawn per Bash
  call and changes nothing. Do not treat it as a safety control yet.
- **No session-start notice.** The Claude surface also runs `vl.js session-start`
  to surface a fresh credential receipt. Codex renders only plain stdout (or
  `additionalContext`) from a `SessionStart` hook, and that command emits a
  `systemMessage` JSON field, so the notice would be invisible. The hook is
  omitted rather than shipped as a no-op; credential receipts are still shown by
  `view` and `refresh`.
- **`view` is live.** The skill runs `vl.js view`, which collects through the
  shared collector and then renders — the same command the Claude and OpenCode
  surfaces use. `vl.js status` remains the cache-only read if you want it. On
  this surface the model runs the command itself, so a non-zero exit is simply
  reported; the `--relay` waiver is there for parity with the surfaces that
  cannot read an exit code.
- **Codex hooks are unavailable on Windows.**

## The `--relay` flag on the skill calls

Every skill above ends its command with `--relay`, the shim-only exit waiver
([CLI reference](../../docs/cli-reference.md#the--relay-exit-waiver-shim-only)): the
surface shows the command's output, and its own state answers (`status` on a
stopped daemon exits `3`, `stop` on nothing running exits `1`) should not read as
a failed run. The output is byte-identical with or without it, the flag is
refused by every other command, and the hooks deliberately do NOT carry it — a
hook contract keeps its exit code. Codex does not abort on a non-zero shell
result the way a Claude shim does, so on this surface the flag is for parity in
what the surfaces print, not a fix for a failure mode.

## Approval prompts (Issue #142): this surface needs no `allowed-tools`

The Claude plugin's command and skill files carry
`allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)`, because Claude Code
runs a shim's `` !`…` `` exec itself while the file renders and, outside auto
mode, aborts the whole invocation when that injected command matches no allow
rule ([skills](https://code.claude.com/docs/en/skills),
[permissions](https://code.claude.com/docs/en/permissions)).

Codex has no such step, so there is nothing here to pre-approve. Verified
against the current Codex docs:

- A Codex skill is instructions, not an injected command. The skill page lists
  no shell-injection syntax and no `allowed-tools` field; the only skill
  metadata is `agents/openai.yaml`, whose fields are `interface`,
  `policy.allow_implicit_invocation` and `dependencies.tools`
  ([build skills](https://learn.chatgpt.com/docs/build-skills)). Our skill tells
  the model to run one command; the model runs it through its own shell tool.
- That shell call is governed by approval policy, permission profiles
  (`default_permissions` / `[permissions]`, or the older `sandbox_mode`) and,
  for commands run outside the sandbox, `prefix_rule` entries in a `rules/`
  file ([permissions](https://learn.chatgpt.com/docs/permissions),
  [rules](https://learn.chatgpt.com/docs/agent-configuration/rules) — rules are
  documented as experimental).

So a plugin file cannot and should not carry a Codex grant. If you want
`vl.js dashboard open` to stop prompting, approve it once in the TUI — Codex
then writes the prefix rule for you into `~/.codex/rules/default.rules` — or
add one yourself, e.g.
`prefix_rule(pattern = ["node", "<path-to-checkout>/bin/vl.js", "dashboard", "open"], decision = "allow")`.
A `pattern` is an exact argv prefix, so keep it as narrow as that.