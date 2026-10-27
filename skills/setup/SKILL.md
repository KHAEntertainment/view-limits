---
name: setup
description: Initial setup of view-limits provider credentials — opens the browser form for routes that have no key yet.
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" setup --relay 2>&1`

Relay the output above verbatim. If a form URL is shown, tell the user to paste
keys there (never in chat), then run `/view-limits` to refresh. To rotate an
existing key, use `/view-limits:update` instead.

This command takes no argument: it offers every route that still has no key. To
work on one route only, run `vl.js setup <route-id>` in a terminal.
