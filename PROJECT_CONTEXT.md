# view-limits Project Context

## Project

`view-limits` is an MIT-licensed Claude Code plugin and transport-neutral
CommonJS library for observing provider capacity and safely gating agent
dispatch. The shipped v1 command surface includes live reporting, credential
setup/rotation, provider adapters, cached normalized resource state, and a
network-free fail-open `PreToolUse` gate.

## Architecture

- `lib/` owns transport-neutral configuration, adapters, normalization, cache,
  route resolution, gate decisions, vault access, and refresh ownership.
- `bin/vl.js` is the CLI and Claude Code integration boundary.
- `hooks/`, `commands/`, and plugin manifests are thin wrappers around the core.
- `test/` contains fixture, CLI subprocess, failure-path, and concurrency tests.
- Runtime support is Node.js 18+ using CommonJS.

## Confirmed Architecture Decisions

These decisions are inherited from the user-approved v2 runtime contract and
govern the remaining implementation:

- **Auth scheme:** no application authentication layer. Provider credentials
  remain in the existing vault/OS credential mechanisms; snapshots and
  diagnostics never expose them.
- **API design:** one asynchronous, transport-neutral
  `getRuntimeSnapshot({ refresh })` function plus a versioned single-document
  JSON CLI surface. Stable safe diagnostic codes represent partial failure;
  there are no HTTP endpoints or pagination in this milestone.
- **Database schema:** none. Local JSON cache files are the persistence
  boundary; runtime facts remain scoped by host/ADE/epic/agent or by confirmed
  route/profile/account identity.
- **Migration:** preserve the existing `status.json` format and add a versioned
  `runtime.json` sidecar. Corrupt or unsupported sidecars degrade to unknown;
  no destructive data migration is permitted.
- **API contract document:** no OpenAPI document is needed because this is not
  a full-stack HTTP service. The confirmed runtime-snapshot contract and
  schema-version tests are the contract of record.
- **Code style:** Node.js 18+ CommonJS, small transport-neutral core modules,
  injectable I/O for fixtures, provider/ADE adapters instead of monolithic
  switches, and explicit unknown/provenance/freshness semantics.

## Current Initiative

The approved v2 direction evolves the plugin into a runtime-aware routing
substrate for Traycer without taking over orchestration. Traycer continues to
create, configure, fork, and manage agents. `view-limits` supplies truthful
runtime/resource facts, deterministic eligibility, and later advisory routing.

Four baseline-hardening pull requests are merged on `origin/main`: route/gate
safety, atomic cache publication and refresh ownership, adapter evidence, and
credential-rotation safety. Sprint 05 is implementing a versioned normalized
runtime snapshot in focused slices. Jev integration remains blocked until the
runtime, capability, eligibility, and readiness prerequisites pass.

## Non-negotiable Constraints

- Preserve v1 commands, route/account identity, and credential behavior.
- The dispatch gate denies only fresh, unambiguous exhaustion and remains
  network-free, deterministic, fast, and fail-open otherwise.
- Harness, configured/default/effective model, profile/account, route, and
  resource identity remain separate facts. Unknown is represented explicitly.
- Cache-only runtime snapshots perform no provider network access, Traycer RPC,
  subprocess launch, or background refresh scheduling.
- Partial adapter/runtime failures retain valid sibling facts and safe
  diagnostics without exposing credentials.
- Jev may classify tasks only after the deterministic substrate is proven; it
  never overrides hard eligibility or performs orchestration.

## Verification

- Primary suite: `rtk npm test`
- Real CLI and hook subprocess tests use isolated temporary data directories.
- Behavioral changes require regression coverage at their architectural
  boundary, independent final-head review, GitHub checks, and CodeRabbit review.
- Do not claim Node 18 execution unless it was actually run under Node 18.

## Execution Routing Policy

- Execution backend: Traycer, using receive-capable GUI child agents and
  isolated worktrees.
- Resolve `${CLAUDE_SKILL_DIR}` as `/Users/bbrenner/.claude/skills/dev` in every
  delegated `/dev` prompt.
- Keep one Issue or explicit QA/review lane per agent. Prefer serial execution
  for dependent runtime-snapshot slices; use parallel lanes only for genuinely
  independent work with explicit ownership.
- Prefer a different model family for independent QA/review. Never let an
  implementation worker review its own changes.
- All implementation and test changes follow Issue → worker worktree → PR → QA
  → independent review → external-review reconciliation → merge.

## Repository State Notes

The original workspace contains user-owned `.gitignore` and `.ignore` changes;
preserve them. The current lead worktree is an older merged baseline branch, so
new implementation work must use a fresh worktree based on verified
`origin/main`, not this branch tip.
