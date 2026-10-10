# view-limits

A Claude Code plugin that shows an orchestrator agent the credit / rate-limit
status of its coding-plan accounts **before** dispatching sub-agents, with an
optional gate for models whose account is exhausted.

Built for multi-harness orchestration (Traycer and similar ADEs), where one
orchestrator fans work out across models on different provider accounts.

## What it does

- **`/view-limits`** — renders a live report of each configured route's balance /
  quota / reset time, with spent-today/this-week where available.
- **`/view-limits:setup`** — initial setup: opens a local browser form for routes
  that have no key yet (auto-imports MiniMax from `~/.mmx/config.json`).
- **`/view-limits:update [route-id]`** — rotate existing keys: opens the form for
  configured routes, or one route, e.g. `/view-limits:update kimi-code-plan`.
  Rotation always requests a replacement; it never reimports a native key.
- An optional **`PreToolUse` hook** resolves sub-agent dispatch (`Agent`/`Task`,
  Traycer `create_agent`/`configure_agent`/`fork_agent`) to a route/account. It is
  off by default; advisory and deny modes are available under [Hooks](#hooks).

The hook is **network-free and fail-open**: it reads a cached status file
synchronously, never the provider API, so unknown/stale/unmapped state can never
cause a false-positive block. SessionStart cache refresh is also off by default.
The separate first-run credential notice stays enabled.

Refreshes publish `status.json` by replacing it with a complete file; a failed
write leaves the previous cache intact. Manual, SessionStart and gate-triggered
refreshes share worker ownership. A competing manual refresh displays the last
cache and reports that a refresh is already in progress.

`gate.refreshLockSeconds` remains the gate's spawn throttle (default 60 seconds),
not a timeout on a running worker. The gate never waits for a worker. Ownership
records under `refresh-workers/` are unique to each invocation and ordered before
provider reads; only records with a provably absent process can be recovered.
Live or uncertain owners are retained, including when process inspection is
denied. This coordination assumes a local filesystem and one host; it is not a
distributed lock. The legacy timestamp-only `refresh.lock` is no longer used.

## Providers

| Route | Provider | Signal |
|---|---|---|
| `minimax-token-plan` | MiniMax Token Plan | rolling-5h + weekly quota |
| `kimi-code-plan` | Kimi Coding Plan | rolling-5h + weekly quota |
| `glm-coding-plan` | Z.ai (GLM) | % used + `nextResetTime` |
| `deepseek-direct` | DeepSeek | balance + `is_available` |
| `openrouter-main` | OpenRouter | balance + spent today/week |
| `xiaomi-token-plan` | Xiaomi (experimental, opt-in) | token-plan counts; route state stays `unknown` (see below) |

Anthropic is omitted — Claude Code surfaces its own native rate-limit state.

> **Kimi note:** `kimi-code-plan` needs a `sk-kimi-*` Coding Plan key (a Moonshot
> `sk-*` key will not work). Base URL defaults to `https://api.kimi.com/coding/v1`.

## Experimental: Xiaomi Token Plan (Chrome cookie fallback)

> **Experimental — not released; K1 and R1 live-accepted, C1 pending.** This
> route depends on an undocumented private console API, a read-only Chrome
> cookie store, and a locally built unsigned Keychain helper. Live acceptance
> (2026-10-09/10) confirmed nonprompting background reads (**K1 passed**) and
> expiry → dashboard login → automatic cookie pickup (**R1 passed**); the strict
> minimal-cookie `/detail` probe (**C1**) is unrun and the final installed-helper
> identity is still unverified. Synthetic test success is not provider or OS
> acceptance. Automatic SSO renewal does not exist in this codebase.

`xiaomi-token-plan` reports current token-plan counts from Xiaomi's console
JSON endpoints using session cookies read **read-only** from one explicit
Chrome profile. It is fully opt-in: the route is absent from the built-in
defaults, no Xiaomi key is ever pasted or stored in the vault, and cookie
values live only in memory for a single operation.

### Requirements

- **macOS only** (Chrome cookie decryption is macOS-specific in this build).
- **Node ≥ 22.5** for live Xiaomi checks — the cookie read needs Node's
  built-in `node:sqlite`. `lib/cookies/chrome.js` lazy-loads it, so plugin
  installs on older Node keep working: Xiaomi checks then report the fixed
  `node:sqlite (22.5+)` capability error instead of crashing.
- **Xcode command line tools** (`clang`/`make`) to build the background key
  helper during setup.

### Commands

```sh
vl.js setup xiaomi-token-plan [--chrome-source PATH] [--profile "Profile 46"]
vl.js update xiaomi-token-plan [--chrome-source PATH] [--profile "Profile 46"]
vl.js remove xiaomi-token-plan
vl.js report | report --json | check xiaomi-token-plan | refresh | snapshot --json
```

- **`setup`** appends the opt-in route, saves the selected Chrome source and
  profile (known working selection: **Profile 46**, display name
  `khaentertainment.com`), and builds the non-interactive key helper into the
  plugin data directory — only when you invoke setup. It then prompts **once**
  for Chrome key access: choose **"Always Allow"** (not the one-shot "Allow")
  in the macOS dialog, because "Allow" persists nothing and the next
  background read would be denied again. When the native helper sources are
  unchanged, setup reuses the installed helper instead of rebuilding it — a
  rebuild changes the helper's identity and would prompt again. Route,
  source/profile and private state are committed only after the helper is in
  place **and** the key grant succeeds, so a failed toolchain install or a
  denied dialog preserves whatever worked before.
- **`update`** revalidates or changes the source/profile (no paste form, no
  vault access) and repeats the same interactive key grant.
- **Background reads never prompt**: `report`, `check`, `refresh`, and
  `session-start` rely on the saved "Always Allow" grant only; a missing or
  denied grant surfaces as a classified key error with setup guidance, never
  as a macOS dialog.
- **`remove`** disables the route; removing the **final** Xiaomi route also
  deletes the saved source/profile, the pinned provider entry, and the private
  state, while preserving unrelated configuration. Shared metadata is kept as
  long as another Xiaomi route still needs it.

### Fresh reports vs. diagnostic snapshots

- `report` (text and `--json`), `check`, and `refresh` are **live**: each
  operation reads the selected profile's console cookies **once** and makes at
  most **one usage/detail request pair** (all Xiaomi route aliases share that
  single observation). On any failure — contended refresh, network, auth,
  helper, unsafe state — they render pending/unknown/classified errors with
  **no cached Xiaomi counts substituted**, in text or JSON.
- `snapshot --json` is the explicitly **diagnostic** view: it never fetches and
  keeps timestamped historical Xiaomi observations with explicit freshness
  labels (always stale once written, because the route uses `ttlSeconds: 0`).
- The dispatch gate stays fail-open: an `unknown` Xiaomi route never denies.

### What the numbers mean

Valid `plan_total_token` counts display as one `tokens` window while the route
**state stays `unknown`**, because compensation-pool consumption, reset-date
parsing, and plan tier/status semantics are unresolved by evidence — no
exhaustion/constraint verdict, reset time, compensation window, or tier label
is ever inferred. An explicitly expired plan shows `unknown` with no windows.
There is no SSO or automatic-renewal code: an invalid session renders
`session unavailable — open https://platform.xiaomimimo.com/ in Chrome
(profile Profile 46)…` for a **manual login in the selected profile**; the next
refresh picks up new cookies when Chrome supplies them.

### If access fails

| Fixed message | Recovery |
|---|---|
| `chrome cookie store unreadable` | The selected profile's cookie store is missing/unreadable — check `--profile`/`--chrome-source`. |
| `Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan` | Helper missing or denied. Setup rebuilds it; deterministic helper failures are not retried until setup/update runs. |
| `console cookies missing — open … and log in` | Open the Xiaomi dashboard in the selected Chrome profile and log in. |
| `Xiaomi private state is unsafe — …` | Delete the `xiaomi` folder under the view-limits data directory, then rerun setup (symlinked/foreign state is refused, never followed). |
| `Xiaomi private state could not be cleared — …` | The `xiaomi` state folder exists but is not writable. Make it writable or delete it, then rerun setup. (Stricter than the old reset: an empty read-only `0500` folder is refused here too.) |
| `Node with node:sqlite (22.5+) is required…` | Run live Xiaomi checks on Node ≥ 22.5. |
| `helper build failed — install the Xcode command line tools…` | `xcode-select --install`, then rerun setup. |

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
runtime password-manager calls. The file backend requires
`VIEW_LIMITS_MASTER_KEY` (or an already provisioned `master.key`) before setup;
view-limits does not generate master keys.

Non-secret config lives in `~/.claude/plugins/data/*/config.json` (endpoints,
routes, TTLs, thresholds). `node bin/vl.js config` shows it (secrets masked).

## Hooks

Add these non-secret settings to the view-limits plugin's
`~/.claude/plugins/data/*/config.json` (the directory exported as
`CLAUDE_PLUGIN_DATA`). Standalone CLI use falls back to
`~/.view-limits/config.json`. These are the defaults:

```json
{
  "gate": { "mode": "off", "injectContext": false },
  "refreshOnSessionStart": false
}
```

| Setting | Behavior |
|---|---|
| `gate.mode: "off"` | Every dispatch matcher exits 0 silently, without reading status or scheduling refresh. |
| `gate.mode: "advisory"` | Never denies. With `injectContext: true`, adds context only for a fresh, unambiguously exhausted route: “prefer another plan.” |
| `gate.mode: "deny"` | Preserves dispatch blocking for fresh, unambiguously exhausted routes. Stale, unknown, unmapped, and ambiguous routes remain allowed. |
| `gate.injectContext: false` | No allow path writes `additionalContext`, including advisory mode. Set to `true` to opt in; context suggests preferring another plan rather than waiting for a reset. |
| `refreshOnSessionStart: false` | The async SessionStart refresh exits 0 silently before accessing credentials, providers, or refresh locks. Set to `true` to warm the cache on session start. |

Traycer Model Routing tries interchangeable models when a model is unavailable.
A gate denial prevents dispatch from reaching that routing, so the gate defaults
to off. Leave it off when Model Routing handles failover. To enable advice, use
`"mode": "advisory"` and `"injectContext": true`; to opt in to the previous gate
behavior, use `"mode": "deny"` (and enable context separately if wanted).

Each intrusive hook reads config synchronously. Missing or unreadable config,
invalid JSON, a non-object config or gate, and invalid mode values fail open as
`off`. Boolean settings enable behavior only for the JSON value `true`;
missing or malformed values become `false`. `vl.js config` shows the effective
values of all three settings.

Enabled gates still schedule a detached refresh when status is stale, subject
to `gate.refreshLockSeconds`. `/view-limits` and `/view-limits:update` keep their
on-demand refresh workflow regardless of these settings. The separate
`session-start` notice hook still reports first-run guidance and credential
receipts.

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

The version of record is `.claude-plugin/plugin.json` → `version`. Every bump
merged to `main` is tagged `v<version>` and published as a
[GitHub release](https://github.com/KHAEntertainment/view-limits/releases) by
`.github/workflows/tag-on-bump.yml`. For a local checkout, run
`git describe --tags`.
