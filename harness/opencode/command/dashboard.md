---
description: Open the view-limits dashboard (starts or reuses the local daemon)
---

!`node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" dashboard open 2>&1`

Relay the output above verbatim.

`dashboard open` prints the daemon's loopback address and asks the operating
system to open it in the default browser. For the other two dashboard calls —
`dashboard stop` and `dashboard status` — run the CLI directly; this surface
wires one call and holds no logic of its own.
