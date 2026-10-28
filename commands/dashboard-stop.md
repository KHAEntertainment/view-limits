---
description: Stop the view-limits dashboard daemon
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" --data-dir "${CLAUDE_PLUGIN_DATA}" --claude-plugin dashboard stop --relay 2>&1`

Relay the output above verbatim.

This asks the verified running daemon to shut itself down and removes its record.
It takes no arguments and never signals a process from a record it could not
verify: if nothing verified is running it says so and changes nothing. To see
which daemon is running and when it last collected, run
`/view-limits:dashboard-status`; to bring the page back, `/view-limits:dashboard`.
