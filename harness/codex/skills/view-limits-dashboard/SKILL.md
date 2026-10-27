---
name: view-limits-dashboard
description: Open the view-limits dashboard page — starts the local daemon if it is not running and prints its loopback address. Use when asked to open, show, stop, or check the state of the dashboard.
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" dashboard open
```

Relay the output above verbatim.

`dashboard open` starts the daemon when nothing verified is running and reuses
it when it is, prints `dashboard: running at <loopback url>`, and asks the
operating system to open that address in the default browser. The address is
always on `127.0.0.1` and holds no token. A browser that cannot be opened is
reported in one line and the command still exits 0 with the daemon running.

To stop the daemon, or ask for its state and last collection, run the same
command with `dashboard stop` or `dashboard status`. This is the same CLI the
Claude plugin and the OpenCode surface drive: there is no Codex-specific
dashboard, no second renderer and no second daemon.
