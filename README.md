# view-limits

A Claude Code plugin that shows an orchestrator agent the credit / rate-limit
status of its coding-plan accounts **before** dispatching sub-agents, and blocks
dispatch to models whose account is exhausted.

Built for multi-harness orchestration (Traycer and similar ADEs), where one
orchestrator fans work out across models on different provider accounts.

## What it does

- **`/view-limits`** — renders a live report of each configured route's balance /
  quota / reset time, with spent-today/this-week where available.
- **`/view-limits:setup`** — initial setup: opens a local browser form for routes
  that have no key yet (auto-imports MiniMax from `~/.mmx/config.json`).
- **`/view-limits:update [route-id]`** — rotate existing keys: opens the form for
  configured routes, or one route, e.g. `/view-limits:update kimi-code-plan`.
- A **`PreToolUse` hook** fires on sub-agent dispatch (`Agent`/`Task`, Traycer
  `create_agent`/`configure_agent`/`fork_agent`), resolves the model to a
  route/account, and **denies** only a *freshly + unambiguously* exhausted route —
  otherwise it injects a one-line status.

The hook is **network-free and fail-open**: it reads a cached status file
synchronously, never the provider API, so unknown/stale/unmapped state can never
cause a false-positive block. A `SessionStart` hook warms the cache and nudges
"set up credentials" on first run.

## Providers

| Route | Provider | Signal |
|---|---|---|
| `minimax-token-plan` | MiniMax Token Plan | rolling-5h + weekly quota |
| `kimi-code-plan` | Kimi Coding Plan | rolling-5h + weekly quota |
| `glm-coding-plan` | Z.ai (GLM) | % used + `nextResetTime` |
| `deepseek-direct` | DeepSeek | balance + `is_available` |
| `openrouter-main` | OpenRouter | balance + spent today/week |

Anthropic is omitted — Claude Code surfaces its own native rate-limit state.

> **Kimi note:** `kimi-code-plan` needs a `sk-kimi-*` Coding Plan key (a Moonshot
> `sk-*` key will not work). Base URL defaults to `https://api.kimi.com/coding/v1`.

## Install

Marketplace:

```sh
claude plugin marketplace add KHAEntertainment/kha-marketplace
claude plugin install view-limits@kha-marketplace
```

Dev / local:

```sh
claude --plugin-dir /path/to/view-limits
```

## Configuration

Credentials are managed **in-CLI**, never pasted into chat:

- `/view-limits:setup` — add missing keys (browser form).
- `/view-limits:update <route-id>` — rotate a key (browser form).

Storage: macOS Keychain (generic password, no biometric prompt) by default;
AES-256-GCM encrypted file (keyed by `VIEW_LIMITS_MASTER_KEY`) elsewhere. No
runtime password-manager calls.

Non-secret config lives in `~/.claude/plugins/data/*/config.json` (endpoints,
routes, TTLs, thresholds). `node bin/vl.js config` shows it (secrets masked).

## Architecture

See [CLAUDE.md](./CLAUDE.md). The core `lib/` is transport-neutral; `bin/vl.js`,
hooks, commands, and skills are thin Claude Code wrappers over it.

## CLI reference

```sh
vl.js gate                        # PreToolUse hook (stdin JSON → deny / context)
vl.js refresh [--quiet]           # query configured routes, write cache
vl.js report [--json]             # render cached status
vl.js check <routeId>             # live-check one route (JSON)
vl.js setup [<routeId>]           # initial setup (missing keys / one route)
vl.js update [<routeId>]          # rotate existing keys
vl.js remove <routeId>            # delete a credential
vl.js config                      # effective config (secrets masked)
```

## Testing

```sh
node test/adapters.test.js        # adapter fixture tests (no network/credentials)
claude plugin validate .          # manifest validation
node bin/vl.js refresh            # live smoke test
```

## Version

v0.1.14
