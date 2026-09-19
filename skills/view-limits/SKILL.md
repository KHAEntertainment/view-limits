---
name: view-limits
description: Check coding-plan credit and rate-limit status across providers (MiniMax, Kimi, GLM, DeepSeek, OpenRouter) before dispatching sub-agents. Use when deciding which model/account to dispatch a sub-agent to, or when a dispatch may be blocked by an exhausted account.
---

## Live account status

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" refresh 2>&1`

## Instructions

1. If the output above says **no credentials are configured**, set them up:
   run `"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" setup` yourself (a Bash tool call). It
   auto-imports MiniMax and opens a local browser form for the remaining keys —
   tell the user to paste their keys there (never in chat), then rerun this skill.
   Stop here.
2. Read the table. Never dispatch a sub-agent with a model whose route is
   `exhausted` or `0%` remaining — prefer a `healthy` route.
