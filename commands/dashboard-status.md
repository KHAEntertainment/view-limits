---
description: Show the view-limits dashboard state — the address, the uptime and the last collection
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" dashboard status --relay 2>&1`

Relay the output above verbatim.

This reports whether a verified daemon is running, its loopback address, how long
it has been up, its collection interval, the last attempt and how old the newest
successful observation is. It takes no arguments, and it never starts anything:
to bring the page up run `/view-limits:dashboard`, to shut it down
`/view-limits:dashboard-stop`.

Nothing here reads a provider. The daemon collects on its own interval, and this
command only reads what it has recorded.
