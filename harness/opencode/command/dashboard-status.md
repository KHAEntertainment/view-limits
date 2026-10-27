---
description: Show the view-limits dashboard state — address, uptime and the last collection
---

!`node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" dashboard status --relay 2>&1`

Relay the output above verbatim.

This reports whether a verified daemon is running, its loopback address, how long
it has been up, its interval, the last attempt and how old the newest successful
observation is. It starts nothing and reads nothing from a provider. To bring the
page up use `/dashboard`, to shut it down `/dashboard-stop`. Like the Claude
command it mirrors, this file passes no argument: OpenCode substitutes
`$ARGUMENTS` into the prompt as text, and a `!` line is shell.
