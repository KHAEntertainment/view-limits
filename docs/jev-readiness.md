# Jev readiness — cross-harness runtime evidence

Status of the eleven-item readiness gate from the approved delivery plan, as
of Issue #10. Evidence combines deterministic integration fixtures
(`test/cross-harness-readiness.test.js`), the merged slice PRs (#12–#15), and
three live caller probes (harnesses `opencode`, `codex`, `claude`) executed
against the real Traycer install.

`PASS` means explicit evidence exists. `BLOCKING` means a mandatory fact is
unobservable today — it is recorded, not smoothed over with a synthetic
default. `PARTIAL` means proven on a strict subset of the required harnesses.

## The eleven-item gate

| # | Item | Verdict | Evidence | Notes |
|---|------|---------|----------|-------|
| 1 | Reliable caller identity inside Traycer | **PARTIAL** | PASS on `claude` (probe 3): `TRAYCER_AGENT_ID`/`TRAYCER_EPIC_ID` are injected, so `ade`/`agentId` resolve `observed · traycer-env` and the live overlay resolves `harness`/`surface`/`configuredModel` `observed · traycer-cli`. BLOCKING on `opencode` + `codex` (probes 1–2): neither harness injects the identity vars; every identity field is `caller-fact-absent` and `traycer agent list` refuses to run without `TRAYCER_EPIC_ID`. | Upstream gap U1. The repo's identity path works when the env is populated; propagation is inconsistent across harnesses. |
| 2 | Effective models verified for Claude, Codex, OpenCode | **BLOCKING** on all three | No `effectiveModel` source exists on any harness: `runConfig.model` populates `configuredModel` only; `defaultModel`/`effectiveModel` stay `caller-fact-absent`; `differsFromDefault` is `model-comparison-unavailable`. Fixtures: `opencode harness + third-party configured model`, `configuredModel placeholder slug`. | Harness-vs-model separation and the no-family-inference property are proven (AC2 below); the *effective* model is unobservable upstream. |
| 3 | Relevant current profile/account identity resolved | **BLOCKING** | `selectedProfile`/`selectedAccount` are `caller-fact-absent` on all three probes; no `runConfig` profile field exists. Only `isEffectiveLastUsed` is observable, and it is correctly kept separate — fixture `selectedProfile stays unknown without a session binding`. | "Unavailable" is recorded, not fabricated. Upstream gap: no API binds a profile selection to the current session. |
| 4 | Native Traycer resource APIs evaluated and integrated where useful | **PARTIAL** | Integrated: `agent list`, `agent list-harnesses`, `agent list-profiles` (all bounded, coalesced, scoped-degrading — `lib/traycer-adapter.js`). `agent profile-rate-limits` integrated but unreliable upstream — WebSocket frame timeout at 15 s on the live probe → `traycer-read-timeout` at `rate-limits:<harness>:<profile>`; fixture `upstream timeout degrades to traycer-read-timeout`. | Upstream gaps U5, U6. |
| 5 | Existing provider adapters composed into one snapshot | **PASS** | PR #14 (`lib/runtime-snapshot.js` routes section; `test/provider-composition.test.js`). | — |
| 6 | Harness, model, route, and account separately represented | **PASS** | PR #14; confirmed by probe 3 (harness `claude` reported independently of `configuredModel`) and fixtures (`opencode harness + third-party configured model`). | No `family` key exists anywhere in the snapshot. |
| 7 | Fresh/live and cache-only modes verified | **PASS** | `test/cross-harness-readiness.test.js` — cache-only zero-I/O under `guard.cjs`; live merge with bounded reads; three live probes corroborate (`--refresh` adds only bounded reads; cache-only output unchanged otherwise). | — |
| 8 | Gate regression tests pass and the hot path stays network-free | **PASS** | `npm test` green; `test/guard.cjs` enforcement + `snapshot-cli.test.js`/`cli-gate.test.js`; this PR's `CLI cache-only under guard` test re-proves zero network/subprocess/write. | — |
| 9 | Capability registry exists | **PASS** | PR #15 (`lib/capability-registry.js`, `test/capability-registry.test.js`). | — |
| 10 | Deterministic eligibility exists | **PASS** | PR #15 (`lib/eligibility.js`, `test/eligibility.test.js`). | — |
| 11 | Semantic normalized inputs are sufficient for Jev | **BLOCKING** | **Shape PASS:** every unknown carries `{value:null, provenance:'unknown', reason}`; no `false`/`0`/`'exhausted'`/`'unavailable'` sentinels; no model-family inference — all three probes confirm. **Inputs BLOCKING:** caller identity is unobservable on 2 of 3 harnesses (U1), `effectiveModel` has no source anywhere, `selectedProfile` is never proven. | Jev can consume the shape; it cannot yet be fed sufficient facts. |

## AC mapping

| AC | Status | Evidence |
|----|--------|----------|
| AC1 read-only probes from all three callers | Probes executed (Track B): identity/model/profile fields recorded honestly per harness; unsupported fields are `caller-fact-absent` with stable reasons, never sentinel defaults. |
| AC2 non-default / third-party model backend | Separation + no-inference **proven** (opencode probe ran `minimax-coding-plan:MiniMax-M3`; fixtures pin harness≠model and zero `family` keys). Positive `effectiveModel` distinction **BLOCKING** — unobservable upstream. |
| AC3 managed/non-default profile evidence | `isEffectiveLastUsed` reported separately from `selectedProfile` (fixtures + probes). `selectedProfile` unavailable on all three harnesses → recorded as upstream gap, not synthesized. |
| AC4 cache-only/live, malformed sources, multi-window, precise balances, cross-session isolation | **PASS** — `test/cross-harness-readiness.test.js` (15 tests), incl. the `guard.cjs` zero-I/O gate. |
| AC5 eleven-item gate | This document. Items 5–10 PASS; 1 and 4 PARTIAL; 2, 3, 11 BLOCKING — every BLOCKING has a precise reason. |
| AC6 Traycer capability gaps | "Upstream gaps" below — documented for upstream; no Traycer-side work done in this repo. |

## Upstream gaps

Concrete Traycer capability gaps found by the probes. Each is described
precisely enough to file upstream; none is worked around in this repo.

| # | Gap | Detail |
|---|-----|--------|
| U1 | **Inconsistent identity-env propagation across harness surfaces** | The Claude GUI surface injects `TRAYCER_AGENT_ID` + `TRAYCER_EPIC_ID` (and `TRAYCER_CLI`, `TRAYCER_CLI_VERSION`, `TRAYCER_AGENT_CLI_SURFACE`) but no A2A vars. The OpenCode and Codex surfaces inject A2A credentials (`TRAYCER_OPENCODE_A2A_URL`/`_TOKEN`, `TRAYCER_A2A_MCP_TOKEN`) plus `TRAYCER_CLI_VERSION` but **no identity vars at all** — `traycer agent list`/`list-profiles`/`profile-rate-limits` are then unusable (`E_INVALID_ARGUMENT: epic id required`) and caller identity is unresolvable. `traycer_get_self` proves the control plane knows the identity; the harness simply does not propagate it into the subprocess environment. |
| U2 | **No surface injects `TRAYCER_SESSION_ID`** | `caller.sessionId` is `caller-fact-absent` on all three harnesses. Uniform gap. |
| U3 | **No OS-hostname ↔ Traycer `hostId` mapping exposed** | `callerContext.host` is the OS hostname (`MacBookPro.localdomain`); session/harness/profile rows key on the Traycer host UUID (`96d93dd0-…`). Nothing links them, so a cache-only snapshot cannot reconcile the caller's host with catalog rows. |
| U4 | **`runConfig.model` reports `kind:"concrete"` for the placeholder slug `"default"`** | Kind and slug disagree semantically: a consumer cannot distinguish a real concrete model from the default placeholder without special-casing the slug. The snapshot carries it verbatim (correct) — the upstream schema should mark the placeholder honestly. |
| U5 | **`agent profile-rate-limits` is unreliable** | WebSocket frame timeout at 15 s (`E_UNEXPECTED`) observed on the Claude probe for `claude --profile ambient` and `codex --profile ambient` (~21 s wall). Surfaces correctly as `traycer-read-timeout` scoped diagnostics; siblings survive. |
| U6 | **`agent list-harnesses` reports `available:false, availabilityPending:true` for every harness** | Including harnesses that are demonstrably running (they produced the probes). Pending is not unavailable — the adapter correctly normalizes the pair to `unknown('availability-pending')` (`lib/traycer-adapter.js`), and the three-case matrix is regression-pinned in `test/cross-harness-readiness.test.js`. The raw upstream report is the gap. |

## Known substrate defects (this repo — follow-up PRs, out of scope here)

| # | Defect | Detail |
|---|--------|--------|
| S1 | **`balance.available` type is adapter-dependent** | `lib/adapters/deepseek.js` passes the API's string through verbatim (`"2.08"`); `lib/adapters/openrouter.js` computes a float (`4.6689968640000075`); `lib/normalize.js` carries `balance` untouched, and the adapter itself already coerces its own output (`num(balance.available)`). Consumers cannot reliably compare/sum/threshold the field. Follow-up: coerce to a consistent numeric type (or a fact-shaped typed field) at the normalize boundary. This PR pins the mixed reality in fixtures; it does not shim it in `runtime-snapshot.js`. |

## Semantic decisions (recorded so reviewers do not flag them)

- **`caller.surface` / `caller.host` describe the `vl` invocation, not the parent agent.** Cache-only `callerContext` reports `surface:"cli"` and the OS hostname; the live `traycer-cli` overlay reports the parent agent's `surface:"gui"`. Where they differ, the CLI-verified value is authoritative for agent identity and replaces the invocation-context value with its own `source`. They are never silently equated (`cli` ≠ `gui`, hostname ≠ hostId). Fixture: `cache-only surface is the invocation context; live surface is the authoritative agent surface`.
- **`resource.freshness` is a derived display label, not a contract fact.** It is computed at request time from `freshUntil` vs the clock (`fresh`/`stale`/`unknown`, plain string). The fact-shaped siblings (`state`, `resetAt`, `observedAt`, `freshUntil`, `source`) carry the evidence; `freshness` never qualifies the verbatim `state`. `balance`/`usage`/`error` are whitelisted raw carries (normalized adapter output), intentionally not fact-shaped — a `null` there means "no such evidence in the cache entry", and the companion unknown-reason facts carry the why.
- **`isEffectiveLastUsed` is not `selectedProfile`.** A catalog's default/last-used marker never fills the caller's session selection; absent a current-session binding, `selectedProfile` stays `unknown('caller-fact-absent')`.
- **An idle harness has no single effective model.** With multiple agents on one harness, no session is arbitrarily promoted to a harness- or caller-level `effectiveModel`.

## Verification

```sh
npm test                      # all files green, incl. test/cross-harness-readiness.test.js
node --check test/cross-harness-readiness.test.js
claude plugin validate .      # only the pre-existing CLAUDE.md warning
git diff e549aaf..HEAD --stat -- lib/gate.js lib/routes.js lib/vault.js lib/refresh-owner.js lib/adapters/ lib/normalize.js lib/cache.js   # prints nothing
```

The cache-only path remains zero-network / zero-subprocess / zero-filesystem-write:
`CLI cache-only under guard: zero guard events, zero filesystem writes`
(test/cross-harness-readiness.test.js) runs `bin/vl.js snapshot --json` under
`test/guard.cjs`, which blocks+logs every fetch/http/net/tls/child_process/
provider/vault path, and asserts the dataDir tree is byte-identical before
and after.
