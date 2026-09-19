---
name: view-limits
description: Check coding-plan credit and rate-limit status across providers (MiniMax, Kimi, GLM, DeepSeek, OpenRouter) before dispatching sub-agents. Use when deciding which model/account to dispatch a sub-agent to, or when a dispatch may be blocked by an exhausted account.
---

## Live account status

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" report 2>&1`

## Instructions

1. Read the table above.
2. Never dispatch a sub-agent with a model whose route is `exhausted` or `0%`
   remaining. Prefer a route showing `healthy` with comfortable quota.
3. If status is stale or empty, refresh first:
   `"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" refresh`
4. To add or rotate a credential, run **in your own terminal** (never paste the
   key into chat):
   - `"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" setup` — opens a local form for missing keys.
   - `"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" setup <routeId>` — set one route (pipes from stdin).

Routes: `minimax-token-plan`, `kimi-code-plan`, `glm-coding-plan`,
`deepseek-direct`, `openrouter-main`.
