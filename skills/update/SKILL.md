---
name: update
description: Rotate/update existing view-limits provider credentials — opens the browser form for configured routes. Pass a route id to rotate one, e.g. /view-limits:update kimi-code-plan.
argument-hint: [route-id]
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" update $ARGUMENTS 2>&1`

Relay the output above verbatim. If a form URL is shown, tell the user to paste
the new key there (never in chat), then run `/view-limits` to refresh.
