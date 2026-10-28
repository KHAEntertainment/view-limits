---
description: Open the view-limits dashboard — starts the daemon if it is not running and opens the page in your browser
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" --data-dir "${CLAUDE_PLUGIN_DATA}" --claude-plugin dashboard open --relay 2>&1`

Relay the output above verbatim.

This starts the dashboard daemon if nothing verified is running and reuses it if
it is, prints its loopback address, and asks the operating system to open that
address in the default browser. It takes no arguments: to shut the daemon down
run `/view-limits:dashboard-stop`, for its state and last collection run
`/view-limits:dashboard-status`.

The address is always on `127.0.0.1`, and nothing secret is in it. The phone
view is a separate opt-in you turn on with `vl.js dashboard lan enable` in a
terminal; this command never opens that link. Opening a browser that is not
there is reported in one line and the command still exits 0 with the daemon
running, so a headless machine keeps working.
