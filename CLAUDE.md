# CLAUDE.md

`view-limits` is a Claude Code marketplace plugin that shows an orchestrator agent
the credit / rate-limit status of its coding-plan accounts before dispatching
sub-agents, and blocks dispatch to models whose account is exhausted. Built for
multi-harness orchestration (Traycer and similar ADEs).

## Architecture

- `lib/` — **transport-neutral core** (no Claude hook APIs):
  - `adapters/*.js` — one per provider; raw response → `NormalizedStatus`
  - `normalize.js` — the shared status shape (`state`, `windows`, `balance`, `resetAt`, `detail`)
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
  under `lib/`, `bin/`, `hooks/`, `commands/`, or `skills/`, plus `README.md`
  and `docs/`. Bump `.claude-plugin/plugin.json` `version`, then
  `claude plugin update view-limits` (restart required to apply).
  **Do not bump for tooling-only changes** — `.gitignore`, `.ignore`, CI config,
  `test/` alone, or repo housekeeping. A bump there costs a reinstall and a
  restart while changing nothing the plugin does at runtime.
- **GitHub:** push to `KHAEntertainment` only, never `Clarit-AI` (a different
  project uses that account). `origin` is pinned to
  `https://github.com/KHAEntertainment/view-limits.git`.

## Provider notes (field shapes verified live unless noted)

- **OpenRouter** — balance = `total_credits − total_usage` from `/api/v1/credits`;
  `limit` on `/api/v1/key` is a spending *cap* (notated separately), and
  `usage_daily`/`usage_weekly` are the spent-today/this-week metrics.
- **MiniMax** — quota is per-model `*_remaining_percent` under `model_remains[]`
  (the `*_usage_count` fields are 0/unused).
- **Kimi** — `/coding/v1/usages` returns `usage` (weekly) + `limits[]` (5h); no
  monthly. Needs a `sk-kimi-*` Coding Plan key (not a Moonshot `sk-*` key).
- **GLM** — `/api/monitor/usage/quota/limit` returns `data.limits[]`; base URL is
  `https://api.z.ai` (international). Fixture-only until live-verified.
- **DeepSeek** — `/user/balance` → `is_available` + `balance_infos[]`.
