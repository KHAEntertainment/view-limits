# CLAUDE.md

`view-limits` is a Claude Code marketplace plugin that shows an orchestrator agent
the credit / rate-limit status of its coding-plan accounts before dispatching
sub-agents, and blocks dispatch to models whose account is exhausted. Built for
multi-harness orchestration (Traycer and similar ADEs).

## Session continuity

**Epic ID: `f969ebca-201d-4beb-bad5-620d1a5f0d7e`**

The v2 work (runtime snapshot, Traycer adapter, eligibility, Jev
recommendation, credential receipts) was planned and tracked as a Traycer epic.
Traycer has been failing to reload an epic into a new ADE session even though the
artifacts are intact on disk — so **treat this ID as the entry point**, not the
ADE's own reload. To pick the work back up:

```sh
# list the epic's artifacts (plans, reviews, tickets, handoffs)
ls ~/.traycer/epics/f969ebca-201d-4beb-bad5-620d1a5f0d7e/artifacts/
```

Key entry points: `backlog-state-2026-09-25` (route health + GLM on-hold
decision), `v2-delivery-plan`, `v2-delivery-handoff`, `pr20-review-2d49b59`
(final independent review), `tickets/`.

Live open work is tracked as GitHub issues on this repo — check `gh issue list`
before starting anything new.

### Secondary fallback — the session that closed out the epic

**Claude session: `4bdedd32-797d-452e-86c4-fad89a611b65`** (captured 2026-09-25)

If Traycer's epic reload is unusable, this transcript is the next-best record of
how the v2 work landed. **It is a transcript to read, not a session to resume** —
that session is closed.

```sh
# read it directly (3 MB of jsonl)
less ~/.claude/projects/-Users-bbrenner--traycer-worktrees-khaentertainment--view-limits-autobuild-baseline-cache-refresh/4bdedd32-797d-452e-86c4-fad89a611b65.jsonl

# or resume it in Claude Code
claude --resume 4bdedd32-797d-452e-86c4-fad89a611b65
```

To find the *current* session instead of this stale one, list the transcripts by
recency — the live session is the file being appended to right now:

```sh
ls -lt ~/.claude/projects/*autobuild-baseline-cache-refresh*/*.jsonl | head
```

Note that this pointer goes stale the moment that session ends; the epic ID
above is the durable entry point, and the GitHub issues are the durable backlog.


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
