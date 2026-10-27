---
description: Open the view-limits dashboard, or stop it and ask how it is running
argument-hint: [stop|status]
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" dashboard slash $ARGUMENTS 2>&1`

Relay the output above verbatim.

With no argument this starts the dashboard daemon if it is not already running,
reuses it if it is, prints its loopback address, and asks the operating system
to open that address in the default browser. Pass `stop` to shut the daemon
down, or `status` for its state, its address and the last collection. Any other
argument prints the usage.

The address is always on `127.0.0.1`, and nothing secret is in it. The phone
view is a separate opt-in you turn on with `vl.js dashboard lan enable` on a
terminal; this command never opens that link. Opening a browser that is not
there is reported in one line and the command still exits 0 with the daemon
running, so a headless machine keeps working.
