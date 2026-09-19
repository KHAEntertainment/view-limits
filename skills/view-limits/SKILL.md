---
name: view-limits
description: Check coding-plan credit and rate-limit status across providers (MiniMax, Kimi, GLM, DeepSeek, OpenRouter) before dispatching sub-agents. Use when deciding which model/account to dispatch a sub-agent to, or when a dispatch may be blocked by an exhausted account.
---

## Account status

!`"${CLAUDE_PLUGIN_ROOT}/bin/vl.js" refresh 2>&1`

## Instructions

1. If the output says **no credentials are configured**, tell the user to run
   `/view-limits:setup`. Stop.
2. Relay the status output above verbatim. Never dispatch a sub-agent with a model
   whose route is `exhausted` or `0%` remaining.
