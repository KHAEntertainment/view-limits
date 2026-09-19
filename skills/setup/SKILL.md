---
name: setup
description: Initial setup of view-limits provider credentials — opens the browser form for routes that have no key yet. Pass a route id to add one, e.g. /view-limits:setup glm-coding-plan.
argument-hint: [route-id]
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" setup $ARGUMENTS 2>&1`

Relay the output above verbatim. If a form URL is shown, tell the user to paste
keys there (never in chat), then run `/view-limits` to refresh. To rotate an
existing key, use `/view-limits:update` instead.
