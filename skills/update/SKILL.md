---
name: update
description: Rotate/update existing view-limits provider credentials — opens the browser form for the configured routes that already have a stored key.
allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" --data-dir "${CLAUDE_PLUGIN_DATA}" --claude-plugin update --relay 2>&1`

Relay the output above verbatim. If a form URL is shown, tell the user to paste
the new key there (never in chat), then run `/view-limits` to refresh. Update
never imports a native credential; it always requests a replacement.

This command takes no argument, and it does not offer every configured route.
It revalidates a configured Xiaomi route's Chrome source first, in place and
without a form, and then opens the form only for the configured routes that
already have a stored key. A route that is configured but has no key yet is the
other command's job: `/view-limits:setup`. To rotate one route only, run
`vl.js update <route-id>` in a terminal.

After the user submits credentials through the form, the next `/view-limits`
report or session-start will mention the outcome: successful storage shows
'credentials rotated for <routes> at <time>'; failed storage shows
'credential storage failed for <routes> at <time>: <reason>'. This
confirmation appears automatically without extra prompting; it expires
after 10 minutes.
