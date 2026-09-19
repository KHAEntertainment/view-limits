---
description: Show coding-plan credit and rate-limit status across all routes/accounts
---

Live account status across providers:

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" report 2>&1`

Render the table above as-is. If any route shows `exhausted` or `0%` remaining,
call out which model/account is affected and when it resets. To force a fresh
read, run `"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" refresh`.
