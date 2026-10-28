---
description: Stop the view-limits dashboard daemon
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" ${VIEW_LIMITS_DATA_DIR:+--data-dir "$VIEW_LIMITS_DATA_DIR"} dashboard stop --relay
```

Relay the output above verbatim.

This file runs no shell command of its own: OpenCode appends any argument the user
supplies to the command template and only then scans the result for
bang-backtick shell commands to execute, so an injected template can be made to
run a second command the user typed. The root resolution is the one expansion
here, and this command takes no argument.

`dashboard stop` asks the verified running daemon to shut itself down and removes
its record. It never signals a process from a record it could not verify: if
nothing verified is running, it says so and changes nothing. For the state read
use `/dashboard-status`, to bring the page back `/dashboard`.
