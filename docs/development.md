# Development

## Architecture

See [CLAUDE.md](../CLAUDE.md). The core `lib/` is transport-neutral, and one
transport-neutral CLI (`bin/vl.js`) is the single substrate every surface
drives. `hooks/`, `commands/` and `skills/` are thin Claude Code wrappers over
it; `harness/codex/` and `harness/opencode/` are the equivalent wiring for the
Codex and OpenCode harnesses. Each surface file delegates to the CLI and
relays its output verbatim — all rendering lives in `lib/view-model.js`.


## Refresh, cache and locking


Refreshes publish `status.json` by replacing it with a complete file; a failed
write leaves the previous cache intact. Manual, SessionStart and gate-triggered
refreshes share worker ownership, and so does the view. A competing manual
refresh displays the last cache and reports that a refresh is already in
progress.

A route whose fetch **fails** keeps its **prior** cached observation, with its
**unchanged age**: a failed fetch never writes a fresh timestamp over old
facts, so the route keeps ageing out on its own clock instead of looking
current. A successful sibling is published independently in the same write.

`gate.refreshLockSeconds` remains the gate's spawn throttle (default 60 seconds),
not a timeout on a running worker. The gate never waits for a worker. Ownership
records under `refresh-workers/` are unique to each invocation and ordered before
provider reads; only records with a provably absent process can be recovered.
Live or uncertain owners are retained, including when process inspection is
denied. This coordination assumes a local filesystem and one host; it is not a
distributed lock. The legacy timestamp-only `refresh.lock` is no longer used.

## Testing

```sh
node test/adapters.test.js        # adapter fixture tests (no network/credentials)
claude plugin validate .          # manifest validation
node bin/vl.js refresh            # live smoke test
node test/cli-boundary.test.js    # CLI-boundary regression coverage (Issue #37)
node test/phase1-boundary.test.js # cross-surface parity: one CLI, one view model (Issue #40)
node test/compat-adapters.test.js # openai-/anthropic-compat recipes: auth, parsing, truthfulness (Issue #55)
node test/bounded-http.test.js    # bounded transport: https, redirects, timeouts, body cap (Issue #55)
node test/compat-cli.test.js      # custom routes through the real refresh/check CLI (Issue #55)
node test/alibaba-coding-plan.test.js # Bailian CLI recipe: parsing, truthfulness, argv allowlist (Issue #56)
node test/alibaba-cli.test.js      # Alibaba route through the real refresh/check CLI (Issue #56)
node test/step-plan.test.js        # stepfun-plan unmonitored classification, CLI (Issue #57)
node test/provider-lifecycle.test.js     # lifecycle service: ordering, retention gate, recovery (Issue #58)
node test/provider-lifecycle-cli.test.js # add/update/remove through the real CLI, no native logout (Issue #58)
node test/config-revision.test.js        # configRevision writer + gate reader, depth-2 secret rejection (Issue #58)
node test/dashboard-lib.test.js          # daemon lock, record, listener, scheduler, view runner (Issue #61)
node test/dashboard-cli.test.js          # real daemons: concurrent start, stale/PID reuse, crash, stop, gate warmth (Issue #61)
node test/dashboard-tick.test.js         # interval collection end to end (Issue #61)
```

## Version

The version of record is `.claude-plugin/plugin.json` → `version`. Every bump
merged to `main` is tagged `v<version>` and published as a
[GitHub release](https://github.com/KHAEntertainment/view-limits/releases) by
`.github/workflows/tag-on-bump.yml`. For a local checkout, run
`git describe --tags`.
