---
name: view-limits-dashboard-status
description: Show the view-limits dashboard state — the address, the uptime and the last collection. Use when asked whether the dashboard is running or when it last refreshed.
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" dashboard status --relay
```

Relay the output above verbatim.

This reports whether a verified daemon is running, its loopback address, how long
it has been up, its collection interval, the last attempt and how old the newest
successful observation is. It starts nothing and reads nothing from a provider:
the daemon collects on its own interval. To bring the page up, run the same CLI
with `dashboard open`; to shut it down, with `dashboard stop`. Like the Claude
and OpenCode surfaces this skill mirrors, it takes no argument.
