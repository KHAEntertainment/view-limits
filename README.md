# view-limits

A Claude Code plugin that lets an orchestrator agent see the credit / rate-limit
status of its coding-plan accounts **before** dispatching sub-agents, and blocks
dispatch of models whose account is exhausted.

Built for multi-harness orchestration (Traycer and similar ADEs), where one
orchestrator fans work out across models on different provider accounts.

## What it does

- **`/view-limits`** (slash command + skill) renders a live table of every
  route/account's remaining quota, balance, and next reset time.
- A **`PreToolUse` hook** fires on sub-agent dispatch (`Agent`/`Task`, and
  Traycer's `create_agent`/`configure_agent`/`fork_agent`). It resolves the
  dispatched model to a **route/account**, reads cached state, and:
  - **blocks** (`permissionDecision: "deny"`) only when the route is *freshly*
    and *unambiguously* `exhausted`, or
  - **injects** a one-line status so the orchestrator can pick a healthier route.

The hook is **network-free and fail-open**: it reads a cached status file
synchronously, never the provider API. Unknown, stale, unmapped, or malformed
state can never cause a false-positive block. A `SessionStart` hook warms the
cache; stale reads trigger a single-flight background refresh.

## Providers (routes)

| Route | Provider | Endpoint | Signal |
|---|---|---|---|
| `minimax-token-plan` | MiniMax | `/v1/token_plan/remains` | interval + weekly quota |
| `kimi-code-plan` | Kimi Code | `/coding/v1/usages` | 5h + weekly (no monthly) |
| `glm-coding-plan` | GLM / Zhipu | `/api/monitor/usage/quota/limit` | % + `nextResetTime` |
| `deepseek-direct` | DeepSeek | `/user/balance` | `is_available` + balance |
| `openrouter-main` | OpenRouter | `/api/v1/key` | `limit_remaining` + `limit_reset` |

Anthropic is omitted — Claude Code surfaces its own native rate-limit state.

> **Kimi note:** `kimi-code-plan` needs a `sk-kimi-*` Coding Plan key (a Moonshot
> `sk-*` key will not work). Base URL defaults to `https://api.kimi.com/coding/v1`
> (configurable to `api.kimi.ai` for intl).

## Install

Dev / local:

```sh
claude --plugin-dir /path/to/view-limits
```

Marketplace (once published):

```sh
/plugin marketplace add <owner>/<marketplace-repo>
/plugin install view-limits@<marketplace>
```

## Configuration

### 1. Credentials (never in chat)

Run in your own terminal:

```sh
node bin/vl.js setup            # audit → auto-import → local form for the rest
node bin/vl.js setup deepseek-direct    # set one route, key from stdin
echo "$KEY" | node bin/vl.js setup kimi-code-plan
op read "op://..." | node bin/vl.js setup deepseek-direct   # one-time, your choice
```

- **Auto-import**: MiniMax's key is read once from `~/.mmx/config.json`.
- **Storage**: macOS Keychain (generic password, no biometric prompt) by default;
  AES-256-GCM encrypted file (keyed by `VIEW_LIMITS_MASTER_KEY`) elsewhere.
- **No runtime password-manager calls** — keys are read silently from the vault on
  every refresh.

### 2. Non-secret config

Defaults are baked in and written to `~/.claude/plugins/data/*/config.json` (the
`CLAUDE_PLUGIN_DATA` dir) on first run. Edit to add routes, model/harness match
rules, per-route TTLs, and thresholds. `node bin/vl.js config` shows effective
config (secrets masked).

- `routes[]` — `{ id, provider, account, match:{model,harness}, ttlSeconds }`.
- `gate.constrainedThreshold` — a window below this fraction marks a route `constrained`.
- `gate.refreshLockSeconds` — single-flight window for background refreshes.

## Architecture

```
PreToolUse hook ─▶ bin/vl.js gate ─▶ lib/routes.js + lib/cache.js + lib/gate.js ─▶ deny / context
SessionStart hook ▶ bin/vl.js refresh ▶ lib/adapters/* → lib/normalize.js → lib/cache.js
slash command / skill ▶ bin/vl.js report ▶ cache
credentials ▶ bin/vl.js setup ▶ lib/vault.js (Keychain | encrypted file)
```

The core (`lib/adapters`, `lib/normalize.js`, `lib/routes.js`, `lib/cache.js`,
`lib/gate.js`) is transport-neutral — no dependency on Claude hook APIs. `bin/vl.js`,
`hooks/`, `commands/`, `skills/` are thin wrappers, so the same library can later
serve an MCP or other-harness surface.

## CLI reference

```sh
node bin/vl.js gate                       # hook gate (reads hook JSON on stdin)
node bin/vl.js refresh [--quiet]           # query all routes, write cache
node bin/vl.js report [--json]             # render cached table
node bin/vl.js check <routeId>             # live-check one route (JSON)
node bin/vl.js setup [<routeId>] [--key K] # collect/import credentials
node bin/vl.js remove <routeId>            # delete a credential
node bin/vl.js config                      # effective config (masked)
```

## Testing

```sh
# CLI sanity (no credentials needed)
node bin/vl.js config
node bin/vl.js report

# gate: unmapped model → fail open (no output)
echo '{"tool_name":"Agent","tool_input":{"model":"claude-sonnet-5"}}' | node bin/vl.js gate

# gate: mapped model with empty cache → inject refresh note (no block)
echo '{"tool_name":"Agent","tool_input":{"model":"deepseek-chat"}}' | node bin/vl.js gate

# validate manifests
node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json'))" && \
node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json'))"
```

For a full end-to-end test: add a real credential, `node bin/vl.js refresh`, then
confirm `report` shows a table and `gate` blocks a route whose status is
`exhausted`.

## Calibration (first live run)

Some endpoints are undocumented; verify field names with curl before trusting the
adapter output:

```sh
curl -s https://api.deepseek.com/user/balance -H "Authorization: Bearer $KEY"
curl -s https://openrouter.ai/api/v1/key -H "Authorization: Bearer $KEY"
curl -s https://www.minimax.io/v1/token_plan/remains -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"
curl -s https://open.bigmodel.cn/api/monitor/usage/quota/limit -H "Authorization: Bearer $KEY"
curl -s https://api.kimi.com/coding/v1/usages -H "Authorization: Bearer $KEY" -H "User-Agent: KimiCLI/1.6"
```
