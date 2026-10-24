# Codex harness surface

Wiring only. This directory contains no view-limits logic: every hook and the
skill delegate to `bin/vl.js`, which is the same CLI the Claude plugin drives.
There is no second renderer, no second gate, and no Codex-specific adapter.

| File | What it is | CLI call |
| --- | --- | --- |
| `hooks.json` | Codex hook config (Codex format, not Claude's) | `gate`, `refresh --quiet --session-start` |
| `skills/view-limits/SKILL.md` | Codex skill for the status surface | `view` |

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
     && cp -R harness/codex/skills/view-limits .codex/skills/
   ```

   **Global (installed checkout)** — copy both into `~/.codex/` and point
   `VIEW_LIMITS_ROOT` at the view-limits checkout so the hooks work from any
   directory:

   ```sh
   cp harness/codex/hooks.json ~/.codex/hooks.json
   mkdir -p ~/.codex/skills && cp -R harness/codex/skills/view-limits ~/.codex/skills/
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
  surfaces use. `vl.js status` remains the cache-only read if you want it.
- **Codex hooks are unavailable on Windows.**