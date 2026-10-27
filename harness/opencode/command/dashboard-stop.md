---
description: Stop the view-limits dashboard daemon
---

!`node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" dashboard stop 2>&1`

Relay the output above verbatim.

This asks the verified running daemon to shut itself down and removes its record.
It never signals a process from a record it could not verify. For the state read
use `/dashboard-status`, to bring the page back `/dashboard`. Like the Claude
command it mirrors, this file passes no argument: OpenCode substitutes
`$ARGUMENTS` into the prompt as text, and a `!` line is shell.
