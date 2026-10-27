---
description: Show coding-plan credit and rate-limit status across all routes/accounts (refreshes live)
---

!`node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" view --relay 2>&1`

Relay the output above verbatim.
