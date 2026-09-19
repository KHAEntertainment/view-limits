---
name: setup
description: Add or rotate view-limits provider credentials — opens the local browser form. Pass a route id to rotate just one, e.g. /view-limits:setup kimi-code-plan.
argument-hint: [route-id]
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" setup $ARGUMENTS 2>&1`

Relay the output above verbatim. If a form URL is shown, tell the user to paste
keys there (never in chat), then run `/view-limits:update-providers`.
