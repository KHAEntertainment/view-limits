# CLI reference

## What it does

- **`/view-limits`** — renders a live view of each configured route's balance /
  quota / reset time, with this month's spend where available. The Claude,
  Codex and OpenCode surfaces all resolve the same `vl.js view` command.
- **`/view-limits:setup`** — initial setup: opens a local browser form for routes
  that have no key yet (auto-imports MiniMax from `~/.mmx/config.json`).
- **`/view-limits:update [route-id]`** — rotate existing keys: opens the form for
  configured routes, or one route, e.g. `/view-limits:update kimi-code-plan`.
  Rotation always requests a replacement; it never reimports a native key.
- **`vl.js provider add|update|remove|list`** — the custom-provider lifecycle:
  validate, probe the quota source read-only, then persist. Headless, with
  stable statuses and exit codes. See
  [Adding a custom provider](providers.md#adding-updating-and-removing-a-custom-provider).
- An optional **`PreToolUse` hook** resolves sub-agent dispatch (`Agent`/`Task`,
  Traycer `create_agent`/`configure_agent`/`fork_agent`) to a route/account. It is
  off by default; advisory and deny modes are available under [Hooks](configuration.md#hooks).

The hook is **network-free and fail-open**: it reads a cached status file
synchronously, never the provider API, so unknown/stale/unmapped state can never
cause a false-positive block. SessionStart cache refresh is also off by default.
The separate first-run credential notice stays enabled.

## CLI reference

```sh
vl.js gate                        # PreToolUse hook (stdin JSON → deny / context)
vl.js refresh [--quiet]           # query configured routes, write cache
vl.js status [--json]             # alias of `report`; same output, same exit code
vl.js report [--json]             # render cached status
vl.js check <routeId>             # live-check one route (JSON)
vl.js setup [<routeId>]           # initial setup (missing keys / one route)
vl.js update [<routeId>]          # rotate existing keys
vl.js remove <routeId>            # delete a credential (+ its stale cache row)
vl.js provider add|update|remove|list   # custom-provider lifecycle (validate →
                                  #   read-only probe → persist); stable
                                  #   headless statuses and exit codes
vl.js config                      # effective config (secrets masked)
vl.js snapshot --json [--refresh] # diagnostic runtime snapshot
vl.js view [--condensed] [--json] # the versioned view schema: text or JSON
vl.js recommend --json            # advisory recommendation (Jev-dormant by default)
vl.js dashboard start|stop|status # persistent loopback dashboard daemon (Issue #61)
vl.js dashboard open [--no-open]  #   start or reuse it and open the page (#136)
vl.js dashboard slash [stop|status] #  the /view-limits:dashboard argument mapper
vl.js dashboard lan enable|disable|rotate|url  # opt-in read-only LAN view (#62)
```

### Exit codes

| Subcommand | Success | Error |
| --- | --- | --- |
| `gate` | `0` (always — fail-open dispatch contract) | n/a (never exits non-zero) |
| `refresh` | `0` | `0` on contention ("refresh already in progress"); `0` when no credentials configured (print guidance); per-adapter failures downgrade the entry to `unknown` and do not raise the exit code; `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr. The SessionStart warm-up (`refresh --quiet --session-start`) exits `0` silently in both cases instead: the `session-start` hook reports them |
| `status` / `report` | `0` (`--json` writes one pretty JSON document to stdout) | n/a — always exits `0` (unknown flags are ignored; with no configured routes it prints the no-credentials guidance, `config unreadable mid-write; retry` when config.json could not be confirmed, or `config.json could not be read or parsed …` when it is unreadable or malformed) |
| `check <routeId>` | `0` (one JSON `NormalizedStatus` on stdout) | `1` on unknown route, missing credential, or classified adapter error (one-line `view-limits: check <id> failed: …` on stderr; never a stack trace); `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr |
| `snapshot --json` | `0` (one pretty JSON envelope on stdout) | `1` when `--json` is missing or any other flag is passed |
| `view [--condensed] [--json]` | `0` (the text layout, or one always-valid JSON envelope on stdout) | `1` on an unknown flag (usage on stderr); `8` config.json has never been published (the one-time vault→routes migration has not resolved — a rerun cannot fix it): `No configuration yet: run /view-limits:setup to add a provider, or start a new session to finish first-run setup` on stderr; `9` config.json could not be confirmed (another process was replacing it, or it exists but could not be read): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr. `--json` still prints exactly one valid envelope (`routes: []`, the status and the reason code) in every refusing case |
| `dashboard start\|stop\|status` | `0` (`status`: running and verified) | `1` refused or failed; `2` usage; `3` `status` with nothing verified running; `9` / `10` config.json refused, as for `view` — see [the dashboard daemon](dashboard.md#the-dashboard-daemon-vljs-dashboard) |
| `dashboard open` | `0` — including the case where the browser could not be opened (the address is printed and one diagnostic line follows). Reuse of a verified running daemon and recovery of a stale record both exit `0` | `1` the same refusals `start` gives (an unverified record, or another start holding the ownership lock) with the same message, and no browser opened; `2` usage (a bad flag); `9` / `10` config.json refused, as for `start` |
| `dashboard slash` | `0` — it runs `open` (no argument), `stop` or `status`, so it carries that subcommand's own exit code, `3` included | `2` usage: more than one argument, or any argument that is not `stop` or `status`. It never reaches `start`, `lan`, `open --no-open` or `__daemon` |
| `recommend --json` | `0` (one pretty JSON envelope on stdout) | `1` on bad args; non-object `--task`/`--policy` JSON exits `1` (no fallback document) |
| `setup` / `update` / `remove` | `0` | `1` on bad args, credential-storage failure, or a stored credential whose route row was not added; `8` migration pending ([how config.json is assembled](configuration.md#how-configjson-is-assembled)); `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr |
| `provider add\|update\|remove\|list` | `0` (`ok`, or `cache-stale-warning` when only the cache row failed) | `1` bad args; `2` retention choice required; `3` id collision; `4` invalid route / unsupported recipe; `5` vault unavailable / persist failed; `6` lock busy; `7` not found; `8` migration pending ([how config.json is assembled](configuration.md#how-configjson-is-assembled)); `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr — see [the lifecycle section](providers.md#adding-updating-and-removing-a-custom-provider) |
| `session-start` | `0` | `0` (purely advisory; surface failures via the receipt/sidecar or its `systemMessage` instead) |
| `config` | `0` | `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr (never the built-in defaults presented as the configuration) |
| unknown command | n/a | `1` with the full usage line on stderr |

`report` always exits `0`, and `refresh` exits `0` for everything except an
unconfirmed config.json, because partial-failure rendering is the data plane,
not an error condition. Diagnose via the rendered text or `status --json`.
Exit `9` from any command means config.json could not be confirmed: rerun
it. Exit `10` means config.json exists but could not be read or parsed (a
read error, invalid JSON, or JSON that is not an object): a rerun reads the
same file, so fix it or move it aside first. Neither falls back to the
built-in defaults, because config.json holds your routes and your vault
backend. A command refuses before acting, with one exception: `setup <id>` that
stored a credential and then could not confirm its route says so ("stored
credential for …"), and the rerun confirms the route. Other failure modes (bad args, classified
provider errors, credential-storage failures) raise `exit 1` with a one-line
message on stderr.
