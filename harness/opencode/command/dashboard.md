---
description: Open the view-limits dashboard (starts or reuses the local daemon)
---

!`node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" dashboard open 2>&1`

Relay the output above verbatim.

`dashboard open` prints the daemon's loopback address and asks the operating
system to open it in the default browser. For the other two dashboard calls use
`/dashboard-stop` and `/dashboard-status`. Each of these three files wires one
fixed call and holds no logic of its own, and none of them takes an argument:
OpenCode substitutes `$ARGUMENTS` into the prompt as text, and a `!` line is
shell.
