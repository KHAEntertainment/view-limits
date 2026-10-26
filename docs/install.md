# Install

## Install

Marketplace:

```sh
claude plugin marketplace add KHAEntertainment/marketplace
claude plugin install view-limits@kha-marketplace
```

Dev / local:

```sh
claude --plugin-dir /path/to/view-limits
```

### Other harnesses

The same CLI runs under Codex and OpenCode. Those surfaces are wiring only —
there is no second renderer, gate, or adapter:

| Harness | Install guide | Surfaces |
| --- | --- | --- |
| Codex | [`harness/codex/README.md`](../harness/codex/README.md) | `hooks.json` (gate + session refresh), `view-limits` skill (status) |
| OpenCode | [`harness/opencode/README.md`](../harness/opencode/README.md) | `plugin/view-limits.js` (gate), `command/view-limits.md` (status refresh) |

Both resolve the CLI from the checkout (or `VIEW_LIMITS_ROOT`) and read the
same cache and vault as the Claude plugin, so no Claude install is required.
