---
name: update
description: Rotate/update existing view-limits provider credentials — opens the browser form for configured routes. Pass a route id to rotate one, e.g. /view-limits:update kimi-code-plan.
argument-hint: [route-id]
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" update $ARGUMENTS 2>&1`

Relay the output above verbatim. If a form URL is shown, tell the user to paste
the new key there (never in chat), then run `/view-limits` to refresh. Update
never imports a native credential; it always requests a replacement.

After the user submits credentials through the form, the next `/view-limits`
report or session-start will mention which routes were rotated and when
(e.g. 'credentials rotated for kimi-code-plan at <time>'). This confirmation
appears automatically without extra prompting; it expires after 10 minutes.
