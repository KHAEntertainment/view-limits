# REVIEW.md

Repository review policy for `view-limits`, a Claude Code plugin and
transport-neutral library that observes coding-plan credit/rate-limit state and
gates sub-agent dispatch.

## What matters in this repository

- **The gate is network-free and fail-open.** `decide()` (`lib/gate.js:13`)
  denies *only* when a cached entry is fresh **and** `exhausted`; no route, no
  entry, stale, `healthy`, `constrained`, and `unknown` all return `allow`. A
  stale read schedules a refresh instead of blocking. Do not harden this into
  deny-on-error; a false deny strands the orchestrator.
- **Freshness parsing is stricter than `Date.parse` on purpose.**
  `parseStrictIsoTimestamp` (`lib/gate.js:123`) checks the calendar *before*
  parsing, so `Sept 31`, `Feb 29` non-leap, and month 13 are rejected instead of
  normalizing into a different instant.
- **The truthfulness contract spans the whole substrate.** Every fact is
  `{ value, provenance, source, observedAt, freshUntil, reason }`; `unknown` is
  `value: null` + provenance `unknown` + a stable reason, never a sentinel
  (`false`/`0`/`'exhausted'`). This binds `lib/runtime-snapshot.js`,
  `lib/eligibility.js`, `lib/capability-registry.js`, `lib/task-profile.js`,
  `lib/recommend.js`; the `configured` / `observed` / `unknown` provenances stay
  distinct.
- **A cache-only snapshot performs no I/O.** `getRuntimeSnapshot({ refresh:
  false })` (`lib/runtime-snapshot.js:540`) does no subprocess, RPC, provider
  request, write, refresh scheduling, or worker acquisition; live reads happen
  only on `refresh: true`.
- **Eligibility is three-valued and never collapsed.** `evaluate()`
  (`lib/eligibility.js:304`) returns `ineligible` / `unresolved` / `eligible`;
  `unresolved` is never folded into a neighbour, a violated hard constraint
  outranks everything, and a capability is never guessed.
- **`lib/capability-registry.js` is the only home for capability and family
  knowledge.** Availability lives in runtime observations, policy with the
  eligibility caller, protocol knowledge in `lib/adapters/`. A new entry must
  never require an adapter or discovery edit; family aliases resolve there.
- **The Jev gate is fail-closed and Jev never overrides eligibility.**
  `evaluateReadiness()` (`lib/jev-readiness.js:91`) opens only when every item
  passes **and** structured-output support verifies, else it stays
  dormant. In `lib/recommend.js`, an ineligible candidate stays ineligible at
  any classifier confidence, and `unresolved` candidates are never scored.
- **Cache, vault, and receipt writes are atomic: same-directory temp file, then
  `fs.renameSync`, writer's own temp unlinked on failure.** `lib/cache.js:56`
  also uses `flag: 'wx'` and `mode: 0o600`. A direct write to the destination,
  or a temp surviving a failed rename, is a regression.
- **Receipt writes never throw and reads fail closed.** `writeReceipt`
  (`lib/receipts.js:85`) returns `null` for an invalid `dataDir`; callers treat
  `null` as "not published" and fall back. A missing or unparseable `freshUntil`
  is expired (`lib/receipts.js:128`). A 409 double-submit writes exactly one
  receipt; the first outcome is immutable (`test/receipts.test.js:950`).
- **Token scrubbing is boundary-aware, not prefix-based.** `SECRET_ID_RE` uses a
  lookbehind so `prod-ghp_abc` and `xsk-embedded` scrub while ordinary ids like
  `task-runner` survive; a bare JWT is token material anywhere. If
  all ids scrub, the receipt records `['redacted']`.
- **Reason codes must be live-coupled to a registry.** New literals belong in
  `TASK_PROFILE_REASONS` / `RECOMMEND_REASONS` / `READINESS_REASONS` /
  `RECEIPT_REASONS` / `SCORE_FALLBACK_REASONS` so `allDeclaredReasons()` and
  `REASON_SUMMARIES` cover them; a raw literal silently escapes lookup.
- **`.claude-plugin/plugin.json` `version` is the only version of record.**
  `package.json` must not carry one, and
  `.github/workflows/tag-on-bump.yml` tags `v<version>` from it. Behavior
  changes under `lib/`, `bin/`, `hooks/`, `commands/`, `skills/`, plus
  `README.md` and `docs/`, need a bump; tooling-only changes do not.

## Severity calibration

**Critical** — can leak a credential, corrupt another process's read, or falsely
deny dispatch: a token surviving into a receipt or CLI output; a non-atomic
write to `status.json` or a `.enc` file; the gate denying on a stale or absent
entry; `unresolved` silently collapsed into `eligible`.

**Warning** — contract drift invisible at runtime: a reason literal outside a
registry, a `detail` dropped before `formatReceipt`, a fact using a sentinel
instead of explicit `unknown`, a doc claim the code no longer supports, a test
that would still pass after the behavior is reverted.

**Do not flag:**

- **Style, formatting, naming.** This repo has no linter, formatter, or type
  checker (no ESLint, Prettier, or `tsconfig`), so the reviewer is the only
  quality gate. Do not request one inside a feature change.
- **The release workflow's scope.** `.github/workflows/tag-on-bump.yml` exists
  only to tag `v<version>` and cut a release; it does not run the test suite. Do
  not demand it run tests in a feature change.
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
- **Xiaomi's `unknown` route state.** `xiaomi-token-plan` reports token counts
  while the route state stays `unknown` — compensation/reset/tier semantics are
  unresolved by evidence. Do not infer an exhaustion verdict for it.
- **`[#N]` finding markers** in comments (`lib/receipts.js` `[#13]`, `[#16]`,
  `[#22]`) — they pin a resolved review finding in place.

## Verification expectations

- Run `node test/run.js` (`npm test`). The suite is 34 files and must print
  `all test files passed`.
- **Every behavior change needs a test that fails without it.** Revert the
  change in a scratch copy and watch the new test go red; a test passing both
  before and after is not coverage.
- **Assert exact strings, not loose containment.** A regex with an `OR` masked a
  dropped field; that defect shipped behind a green suite.
- Tests inject an isolated scratch `dataDir` and a frozen clock, and must not
  touch `~/.view-limits`, the macOS Keychain, a real browser, or a credential.
  Prefer real HTTP over mocks. Do not claim Node 18 execution unless it was run.

## Security and performance

- Credentials live only in `lib/vault.js` (AES-256-GCM, `0o600`) or the macOS
  Keychain. No secret, token, or live key in the repo, fixtures beyond obvious
  sentinels, or commit messages. Curl examples use `$KEY` placeholders.
- Any change to `SECRET_ID_RE`, `SECRET_DETAIL_RE`, or `JWT_RE` is
  security-critical. Check both directions: a token embedded mid-string is
  scrubbed, an ordinary route id is preserved.
- Rotation is out-of-band by design — a localhost form. Do not propose reading,
  echoing, or logging a key in-process.
- Keep `decide()` free of network and filesystem work; refresh happens detached.

## Review summary and comment style

Lead with the finding, its file and line, then the concrete failure it causes.
This repo's history is dominated by overstated claims — comments, docs, and test
names asserting behavior the code did not have — so verify any asserted
guarantee against the code and say plainly when it fails. Prioritize by whether
a claim is false, not diff size.
