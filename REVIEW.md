# REVIEW.md

Repository review policy for `view-limits`, a Claude Code plugin that gates
sub-agent dispatch on coding-plan credit and rate limits.

## What matters in this repository

- **The gate is network-free and fail-open.** `decide()` (`lib/gate.js:13`)
  denies *only* when a cached entry is fresh **and** its state is `exhausted`.
  No route, no entry, a stale entry, and `healthy` / `constrained` / `unknown`
  all return `allow` — a stale read schedules a refresh instead of blocking.
  Do not harden this into deny-on-error; a false deny strands the orchestrator.
- **Freshness parsing is stricter than `Date.parse` on purpose.**
  `parseStrictIsoTimestamp` (`lib/gate.js:105`) validates the calendar *before*
  parsing so `Sept 31`, `Feb 29` non-leap, and month 13 are rejected instead of
  normalizing into a different valid instant. Keep the calendar check first.
- **Cache, vault, and receipt writes are atomic: same-directory temp file, then
  `fs.renameSync`, writer's own temp unlinked on failure.** `lib/cache.js:56`
  also uses `flag: 'wx'` and `mode: 0o600`. A direct write to the destination,
  or a temp surviving a failed rename, is a regression in `lib/cache.js`,
  `lib/receipts.js`, and `lib/vault.js`.
- **`writeReceipt` must never throw** (`lib/receipts.js:85`): an invalid
  `dataDir` returns `null` before any path construction. Callers treat `null`
  as "not published" and fall back; they do not catch.
- **Receipt reads fail closed on freshness** (`lib/receipts.js:128`): a missing
  or unparseable `freshUntil` is expired, because the writer always emits one.
- **A 409 double-submit writes exactly one receipt; the first outcome is
  immutable** (pinned in `test/receipts.test.js:950`).
- **Token scrubbing is boundary-aware, not prefix-based.** `SECRET_ID_RE` uses a
  lookbehind so `prod-ghp_abc` and `xsk-embedded` scrub while ordinary ids like
  `task-runner` survive; a bare-JWT shape is token material wherever it sits.
  If all ids scrub, the receipt records `['redacted']`.
- **Partial credential saves are the contract, not a defect.** `serve` persists
  each route independently; a mixed outcome is `submitted` with a `detail`
  naming the routes still needed. Do not report this as missing atomicity.
- **Reason codes must be live-coupled to a registry.** New literals belong in
  `TASK_PROFILE_REASONS` / `RECOMMEND_REASONS` / `READINESS_REASONS` /
  `RECEIPT_REASONS` / `SCORE_FALLBACK_REASONS` so `allDeclaredReasons()` and
  `REASON_SUMMARIES` cover them. A raw string literal silently escapes summary
  lookup — that drift shipped once and surfaced only under mutation testing.
- **`lib/` stays transport-neutral** — no Claude hook APIs in core. `bin/`,
  `hooks/`, `commands/`, `skills/` are the only Claude-specific surface.
- **`readCache` discards invalid route containers** (`lib/cache.js:33`) while
  keeping valid siblings, so one corrupt entry cannot blank the report.

## Severity calibration

**Critical** — can leak a credential, corrupt another process's read, or
falsely deny dispatch. A token surviving into a receipt or CLI output; a
non-atomic write to `status.json` or a `.enc` file; the gate denying on a stale
or absent entry.

**Warning** — contract drift invisible at runtime: a new reason literal outside
a registry, a `detail` dropped before it reaches `formatReceipt`, a doc claim
the code no longer supports, a test that would still pass after the behavior is
reverted.

**Do not flag:**

- **Style, formatting, naming.** This repo has no linter, formatter, or type
  checker — no ESLint, Prettier, or `tsconfig` — so the reviewer is the only
  quality gate. Do not request one inside a feature change.
- **The absence of CI.** There is no `.github/` directory. That is the current
  state, not a gap in this change.
- **Intentional empty `catch` blocks.** Load-bearing fail-open behavior in
  `lib/gate.js`, `lib/cache.js`, `lib/receipts.js`. Flag a swallow only when it
  hides a failure the user must see.
- **`spawnSync` / per-file subprocesses in `test/run.js`.** Each file runs in
  its own child so one failure cannot corrupt another.
- **The `test/guard.cjs` preload.** It blocks `fetch`, `net`, `tls`, the `exec`
  family, and vault/adapter access in the gate's child — the runtime proof of
  the network-free contract, not a test smell.
- **GLM's fixture-only adapter.** `lib/adapters/glm.js` parsing `data.limits[]`
  is unverified against live `api.z.ai` by design; there is no key. Do not
  demand live verification or call it untested.
- **`[#N]` finding markers** in comments (`lib/receipts.js` `[#13]`, `[#16]`,
  `[#22]`) — they pin a resolved review finding in place.
- **A missing `claude plugin update`.** The committed artifact is the version
  bump in `.claude-plugin/plugin.json`; installing is a separate local step.

## Verification expectations

- Run `node test/run.js` (`npm test`). The suite is 24 files and must print
  `all test files passed`.
- **Every behavior change needs a test that fails without it.** Revert the
  change in a scratch copy and watch the new test go red. A test passing both
  before and after is not coverage.
- **Assert exact strings, not loose containment.** A regex with an `OR` masked a
  dropped field; that defect shipped behind a green suite.
- Tests inject an isolated scratch `dataDir` and a frozen clock, and must not
  touch `~/.view-limits`, the macOS Keychain, a real browser, or a credential.
- Prefer real HTTP against a spawned server over mocks for concurrency and
  receipt-lifecycle tests.

## Security and performance

- Credentials live only in `lib/vault.js` (AES-256-GCM, `0o600`) or the macOS
  Keychain. No secret, token, or live key in the repo, fixtures beyond obvious
  sentinels, or commit messages. Curl examples use `$KEY` placeholders.
- Any change to `SECRET_ID_RE`, `SECRET_DETAIL_RE`, or `JWT_RE` is
  security-critical. Check both directions: a token embedded mid-string is
  scrubbed, an ordinary route id is preserved.
- Rotation is out-of-band by design — a localhost form. Do not propose reading,
  echoing, or logging a key in-process.
- The gate runs on every dispatch; keep `decide()` free of network and
  filesystem work. Refresh happens detached.

## Review summary and comment style

Lead with the finding, its file and line, then the concrete failure it causes.
This repo's history is dominated by overstated claims — comments, docs, and test
names asserting behavior the code did not have — so verify any asserted
guarantee against the code and say plainly when it does not hold. Prioritize by
whether a claim is false, not by diff size.
