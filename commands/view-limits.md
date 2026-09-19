---
description: Show coding-plan credit and rate-limit status across all routes/accounts (refreshes live)
---

Live account status across providers:

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" refresh 2>&1`

If the output says **no credentials are configured**, tell the user to run
`/view-limits:setup`. Otherwise render the table, calling out any `exhausted`
route and when it resets.
