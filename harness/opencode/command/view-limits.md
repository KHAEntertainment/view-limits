---
description: Show coding-plan credit and rate-limit status across all routes/accounts (refreshes live)
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" ${VIEW_LIMITS_DATA_DIR:+--data-dir "$VIEW_LIMITS_DATA_DIR"} view --relay
```

Relay the output above verbatim.

This file deliberately runs no shell command itself. OpenCode appends any
argument the user supplies to the command template and only then scans the result
for bang-backtick shell commands to execute, so a template that injects one can be
made to run a second command the user typed — see [the README](../README.md). The
root resolution is the one expansion here, and this command takes no argument.

`view` collects through the shared collector and renders the versioned view, so
the numbers are current: the same command the Claude plugin and the Codex skill
drive. `vl.js status` is the cache-only read if you want that instead.
