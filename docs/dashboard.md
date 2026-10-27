# The dashboard daemon (`vl.js dashboard`)


A persistent daemon that keeps the view fresh in the background (Issue #61)
and serves the dashboard page (#62) on loopback, plus an opt-in, read-only
LAN view for a phone.

```sh
vl.js dashboard start [--port N] [--host 127.0.0.1] [--interval SECONDS]
vl.js dashboard open [--port N] [--host 127.0.0.1] [--interval SECONDS] [--no-open]
vl.js dashboard status [--json]
vl.js dashboard stop
vl.js dashboard lan enable --interface IP [--port N]   # LAN view on (off by default)
vl.js dashboard lan disable
vl.js dashboard lan rotate                             # new read token; old links stop working
vl.js dashboard lan url                                # prints the phone link (the only place the token appears)
```

- **One per data directory.** `start` refuses a verified running instance and
  returns once the daemon is listening, printing its URL. The listener binds
  port `0` (a free port) unless `--port` is given; the bound port is recorded.
  An occupied `--port` is a clean error and publishes nothing.
- **`open` — start or reuse, then show it (Issue #136).** With nothing verified
  running it does exactly what `start` does (same config, port and interval
  rules, same stale-record recovery); with a verified instance running it
  reuses it and starts nothing. Either way it prints
  `dashboard: running at <loopback url>` and asks the operating system to open
  that address in the default browser — `open` on macOS, `xdg-open` on Linux,
  `cmd /c start "" <url>` on Windows, always as an argument array and never
  through a shell string. `--no-open` prints the address and launches nothing,
  which is the headless form.
  - **The URL is the loopback page URL, and that is all it is.** Never the LAN
    link, never the LAN read token, never the control nonce: nothing secret
    rides in the URL, the argv or the output, even with the LAN view enabled.
  - **A browser that cannot be opened is not a failed command.** The address is
    printed, one line says the browser could not be opened and why, the daemon
    keeps running, and the exit is `0`.
  - **A refusal is still a refusal.** An unverified record, or a lock held by
    another start, prints the message `start` prints for it, opens no browser,
    and exits nonzero like `start` does.
- **From inside a harness — three argument-free commands (owner ruling Q34-A).**
  Claude: `/view-limits:dashboard` runs `dashboard open`,
  `/view-limits:dashboard-stop` runs `dashboard stop` and
  `/view-limits:dashboard-status` runs `dashboard status`. Each command file
  injects exactly one fixed CLI call and passes the user nothing: an injected
  command is shell text, so a substituted argument would be code running under
  that file's own permission grant rather than data for the CLI to read. To work
  on one route, or to pass a dashboard option, use the terminal forms. The Codex
  skills `view-limits-dashboard`, `view-limits-dashboard-stop` and
  `view-limits-dashboard-status`, and the OpenCode commands `/dashboard`,
  `/dashboard-stop` and `/dashboard-status`, name the same three verbs. The
  Claude files inject their one fixed call; the Codex and OpenCode files carry no
  injection at all and tell the model to run the call and relay the output,
  because OpenCode merges the user's arguments into the template before it looks
  for shell spans ([OpenCode surface README](../harness/opencode/README.md#the-commands-inject-nothing)).
  Both Claude guards pin the rule: `test/relay-only.test.js` requires each shim's
  single injected call to match and allows exactly one of them, and
  `test/shim-allowed-tools.test.js` refuses any substitution but
  `${CLAUDE_PLUGIN_ROOT}`.
- **`--relay` is for the surfaces, not for you.** Each of those calls carries it:
  a shim's injected exec aborts the whole command on any non-zero exit, and
  `status` / `stop` legitimately exit `3` / `1` when nothing is running. The flag
  waives the exit code and nothing else — same bytes out, same daemon behavior —
  and in a terminal you still get the real codes. See
  [the CLI reference](cli-reference.md#the--relay-exit-waiver-shim-only).
- **Collection.** On start, then every `--interval` seconds (default 30; flag >
  `config.json` `{"dashboard": {"intervalSeconds": N}}` > 30; allowed 15–3600). Each
  collection is the same `vl.js view --json` run, so it uses the shared
  collector and refresh-worker ownership and writes `status.json` exactly as a
  manual run does. A slow tick is skipped, never overlapped; failures keep the
  successful routes and never renew an old observation. The PreToolUse gate
  stays cache-only and fail-open: a running daemon only keeps `status.json`
  fresh, so the gate inherits it.
- **`GET http://127.0.0.1:<port>/api/status`** returns the latest view with
  `status` (`pending` before the first result, `ok`, `stale`, `unavailable`),
  the last attempt and its outcome, and the observation age. Polling it never
  triggers a provider read.
- **`status`** confirms the instance over loopback and by process identity
  before reporting (URL, uptime, last attempt, age). **`stop`** asks the
  verified instance to shut itself down with a per-instance secret; it never
  signals a PID taken from a record, and a stale or unverifiable record is
  reported, not trusted. A crashed daemon leaves a stale record that the next
  `start` recovers.
- **The page: `http://127.0.0.1:<port>/`** (the URL `start` prints). One
  page with no build step and nothing fetched from outside this machine (the
  Geist fonts are bundled, SIL OFL 1.1). It polls `/api/status` at the
  daemon's interval, so it never triggers a provider read, and it renders
  from the view schema's fields only. Wide windows get a card per route in
  configuration order under a "needs attention" strip; a narrow pane gets one
  line per route (tap to expand). The page's **Refresh** asks for a
  collection now; it carries a refresh-only token, which cannot stop the
  daemon. Each built-in provider's card has an icon button to that provider's
  own dashboard (local view only). `/?view=lan` previews the phone layout on
  loopback; it is a preview, not the LAN view.
- **Loopback control listener.** `--host` accepts `127.0.0.1`, `localhost` or
  `::1` only. The daemon's runtime files (`dashboard.json`, `dashboard.log`,
  `dashboard-lock/`) live in the data directory; `dashboard.json` is private
  (`0600`) because it holds the control secret.
- **LAN view (opt-in, read-only).** Off by default.
  `lan enable --interface IP` picks the address a phone reaches: a LAN or
  Tailscale IP of this machine (loopback, wildcard addresses and hostnames
  are refused). It saves `{"dashboard": {"lan": {"enabled": true, "interface":
  "IP", "port": N}}}` in `config.json`; without `--port` a free port is picked
  once and kept, so a bookmark survives restarts. `enable` and `disable` take
  effect at the next `dashboard start` (the command says so when a daemon is
  running); `disable` keeps the address, port and token for a later
  re-enable.
  - **Read token.** A random token in `dashboard-lan-token` in the data
    directory (`0600`; never in `config.json`, never logged, never in a
    process's arguments). `lan url` prints the link that carries it; the
    phone's page keeps it for that address and removes it from the address
    bar. `lan rotate` issues a new one and the old link stops working at
    once, even with the daemon running.
  - **What the phone sees.** A separate listener on that address only
    (exact `Host`, `GET` only). The page and its files carry no data; the
    status needs the token and is **redacted by the daemon** before it is
    sent: labels, states, usage, balances and resets, but no account,
    profile, session or host identifiers, no route ids, no login links ("log
    in again on your Mac"), no provider error text and no buttons.
  - **Refusals.** A bad `dashboard.lan` value or an address that is not on
    this machine refuses `start` (exit `1`) and names the fix; a missing,
    malformed or non-private token refuses with exit `10` ("run `vl.js
    dashboard lan rotate`"); a LAN port that cannot be bound fails `start`
    and publishes nothing.

Exit codes: `0` ok; `1` refused or failed (already running, occupied port,
invalid flag value or config value, LAN interface not on this machine, LAN
bind failure, stop refused); `2` usage; `3` `status` when nothing verified is
running; `9` / `10` config.json could not be confirmed / could not be read
(the same refusal as `view`; no default interval is guessed); `10` also for an
unusable LAN read token.
