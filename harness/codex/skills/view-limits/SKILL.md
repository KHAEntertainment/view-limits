---
name: view-limits
description: Show coding-plan credit and rate-limit status across all routes/accounts for the Codex harness. Use before dispatching sub-agents, or when asked for provider capacity, quota, credits, or rate limits.
---

Run exactly this command with the shell tool:

```sh
node "${VIEW_LIMITS_ROOT:-$(git rev-parse --show-toplevel)}/bin/vl.js" status
```

Relay the output above verbatim.

`status` reads the cache and never calls a provider. To pull fresh numbers
first, run `refresh` (network; it rewrites the cache), then run `status`. The
Claude surface runs `/view-limits` and `/view-limits:setup`; add those skills to
`~/.codex/skills/` for the same coverage.