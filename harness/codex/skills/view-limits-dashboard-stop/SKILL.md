---
name: view-limits-dashboard-stop
description: Stop the view-limits dashboard daemon. Use when asked to shut the dashboard or the background status collector down.
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" ${VIEW_LIMITS_DATA_DIR:+--data-dir "$VIEW_LIMITS_DATA_DIR"} dashboard stop --relay
```

Relay the output above verbatim.

This asks the verified running daemon to shut itself down and removes its record.
It never signals a process from a record it could not verify: if nothing verified
is running it says so and changes nothing. To see which daemon is running and
when it last collected, run the same CLI with `dashboard status`; to bring the
page back, `dashboard open`. This is the same CLI the Claude plugin and the
OpenCode surface drive, and like them it takes no argument.
