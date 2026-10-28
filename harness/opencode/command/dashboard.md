---
description: Open the view-limits dashboard (starts or reuses the local daemon, opens the page)
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" ${VIEW_LIMITS_DATA_DIR:+--data-dir="$VIEW_LIMITS_DATA_DIR"} dashboard open --relay
```

Relay the output above verbatim.

This file runs no shell command of its own: OpenCode appends any argument the user
supplies to the command template and only then scans the result for
bang-backtick shell commands to execute, so an injected template can be made to
run a second command the user typed. The root resolution is the one expansion
here, and this command takes no argument.

`dashboard open` starts the daemon if nothing verified is running, reuses it if
something is, prints the loopback address and opens it in the default browser.
For the other two calls use `/dashboard-stop` and `/dashboard-status`.
