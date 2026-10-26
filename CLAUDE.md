# CLAUDE.md

`view-limits` is a Claude Code marketplace plugin that shows an orchestrator agent
the credit / rate-limit status of its coding-plan accounts before dispatching
sub-agents, and blocks dispatch to models whose account is exhausted. Built for
multi-harness orchestration (Traycer and similar ADEs).

Maintainers keep session-continuity notes (tracker IDs, transcript pointers) in a local, untracked `CLAUDE.local.md`.

## Architecture

- `lib/` — **transport-neutral core** (no Claude hook APIs):
  - `adapters/*.js` — one per provider; raw response → `NormalizedStatus`
  - `normalize.js` — the shared status shape (`state`, `windows`, `balance`, `resetAt`, `detail`, optional `basis`)
  - `routes.js` — route/account resolution (`resolveRoute(model, context)`)
  - `cache.js` — `status.json` read/write + freshness + single-flight refresh lock
  - `gate.js` — pure deny / allow / context decision
  - `vault.js` — macOS Keychain / AES-256-GCM secret store
  - `config.js` — routes, endpoints, TTLs, `importMap`
- `bin/vl.js` — thin CLI wrapper: `gate | refresh | report | check | setup | update | remove | config | serve | session-start`
- `hooks/hooks.json` — `PreToolUse` gate + `SessionStart` warm/nudge
- `commands/view-limits.md` — `/view-limits` (status)
- `skills/setup/`, `skills/update/` — `/view-limits:setup`, `/view-limits:update`

The gate is **network-free and fail-open**: it reads cached status, never the
provider API, and denies only on a *fresh + unambiguously exhausted* route.

## Commands

```sh
node test/adapters.test.js   # adapter fixture tests (no network/credentials)
claude plugin validate .     # manifest validation
node bin/vl.js refresh       # live smoke test
node bin/vl.js check <routeId>  # live-check one route (JSON)
```

## Conventions

- **No secrets in the repo.** Credentials live in the local vault (macOS Keychain
  or an AES-256-GCM file); curl examples use `$KEY` placeholders.
- **Keep `lib/` transport-neutral** — no Claude hook APIs in core; `bin/`, hooks,
  commands, and skills are the only Claude-specific surface (so the same library
  can later serve an MCP / other-harness interface).
- **Bump the version on every change that ships plugin behavior** — anything
  under `lib/`, `bin/`, `hooks/`, `commands/`, `skills/`, or `harness/`, plus `README.md`
  and `docs/`. Bump `.claude-plugin/plugin.json` `version` — it is the only
  version of record (`package.json` carries none; `test/version.test.js`
  enforces this).
  **Do not bump for tooling-only changes** — `.gitignore`, `.ignore`, CI config,
  `test/` alone, `CLAUDE.md`, or repo housekeeping. A bump there cuts a release
  and costs a reinstall and a restart while changing nothing the plugin does at
  runtime.
- **A bump ships in three steps — merging it is not enough:**
  1. Merge to `main`. `.github/workflows/tag-on-bump.yml` tags the merge commit
     `v<version>` and publishes a GitHub release. Published tags are immutable:
     never reuse a version; if the workflow fails because the tag exists, bump
     again.
  2. Open a PR in `KHAEntertainment/marketplace` setting the `view-limits`
     entry's `source.ref` in `.claude-plugin/marketplace.json` to the new tag.
     In the same PR, bring view-limits' entry in that repo's README up to date
     with the release: its summary line, what it does, the install command and
     the "After install" line. That README lists no current or pinned
     versions, so there is no version pin to change there. That repo's
     `verify-catalog` check confirms the tag resolves. Until this merges,
     users stay on the previous pin.
  3. After it merges: `claude plugin marketplace update kha-marketplace`, then
     `claude plugin update view-limits@kha-marketplace` (restart required).
- **GitHub:** push to `KHAEntertainment` only, never `Clarit-AI` (a different
  project uses that account). `origin` is pinned to
  `https://github.com/KHAEntertainment/view-limits.git`.

## Provider notes (field shapes verified live unless noted)

- **OpenRouter** — balance = `total_credits − total_usage` from `/api/v1/credits`;
  `limit` on `/api/v1/key` is a spending *cap* (notated separately), and
  only `usage_monthly` (this month's spend) is surfaced; `usage_daily`/`usage_weekly`
  were seen returning false zeros on a live account (Issue #22), so they are not reported.
- **MiniMax** — quota is per-model `*_remaining_percent` under `model_remains[]`
  (the `*_usage_count` fields are 0/unused).
- **Kimi** — `/coding/v1/usages` returns `usage` (weekly) + `limits[]` (5h); no
  monthly. Needs a `sk-kimi-*` Coding Plan key (not a Moonshot `sk-*` key).
- **GLM** — `/api/monitor/usage/quota/limit` returns `data.limits[]`; base URL is
  `https://api.z.ai` (international). Auth (`Bearer`) and the error envelope are
  live-verified (2026-10-03): failures are HTTP 200 + `{code, msg, success:false}`
  — 1000/1001 auth, 500 "no coding plan". The `limits[]` fields are still
  fixture-only (needs an active plan; Issue #1).
- **DeepSeek** — `/user/balance` → `is_available` + `balance_infos[]`.
