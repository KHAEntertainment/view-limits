---
name: view-limits
description: Show coding-plan credit and rate-limit status across all routes/accounts for the Codex harness. Use before dispatching sub-agents, or when asked for provider capacity, quota, credits, or rate limits.
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" view
```

Relay the output above verbatim.

`view` is the same CLI the Claude plugin drives: it collects the live status
through the shared collector and renders the versioned view, so the numbers
are current. The Claude surface runs `/view-limits` and `/view-limits:setup`;
add those skills to `~/.codex/skills/` for the same coverage.
