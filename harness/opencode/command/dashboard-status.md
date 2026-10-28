---
description: Show the view-limits dashboard state — address, uptime and the last collection
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" ${VIEW_LIMITS_DATA_DIR:+--data-dir "$VIEW_LIMITS_DATA_DIR"} dashboard status --relay
```

Relay the output above verbatim.

This file runs no shell command of its own: OpenCode appends any argument the user
supplies to the command template and only then scans the result for
bang-backtick shell commands to execute, so an injected template can be made to
run a second command the user typed. The root resolution is the one expansion
here, and this command takes no argument.

`dashboard status` reports whether a verified daemon is running, its loopback
address, how long it has been up, its collection interval, the last attempt and
how old the newest successful observation is. It starts nothing and reads nothing
from a provider. To bring the page up use `/dashboard`, to shut it down
`/dashboard-stop`.
