---
name: view-limits-dashboard
description: Open the view-limits dashboard page — starts the local daemon if it is not running and prints its loopback address. Use when asked to open or show the dashboard. To stop it, or to check its state, use view-limits-dashboard-stop or view-limits-dashboard-status.
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" ${VIEW_LIMITS_DATA_DIR:+--data-dir="$VIEW_LIMITS_DATA_DIR"} dashboard open --relay
```

Relay the output above verbatim.

`dashboard open` starts the daemon when nothing verified is running and reuses
it when it is, prints `dashboard: running at <loopback url>`, and asks the
operating system to open that address in the default browser. If that request
cannot be carried out, it says so in one line and the daemon keeps running, so
treat the printed address as the result and open it yourself if no browser came
up. The address is always on `127.0.0.1` and holds no token.

To stop the daemon, or ask for its state and last collection, use the
`view-limits-dashboard-stop` and `view-limits-dashboard-status` skills: the same
CLI, one fixed call each. This is the same CLI the Claude plugin and the OpenCode
surface drive — there is no Codex-specific dashboard, no second renderer and no
second daemon. Like those surfaces, none of the three takes an argument (owner
ruling Q34-A): a skill that interpolated one would hand shell text to a command
the user has already approved.
