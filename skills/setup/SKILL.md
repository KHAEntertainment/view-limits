---
name: setup
description: Add or rotate view-limits provider credentials — opens the local browser form.
---

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" setup 2>&1`

Tell the user the credential form opened in their browser and to paste their
provider keys there (never in chat). After they save, run
`/view-limits:update-providers` to refresh.
