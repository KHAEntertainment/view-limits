# view-limits

A Claude Code plugin that shows an orchestrator agent the credit / rate-limit
status of its coding-plan accounts **before** dispatching sub-agents, with an
optional gate for models whose account is exhausted.

Built for multi-harness orchestration (Traycer and similar ADEs), where one
orchestrator fans work out across models on different provider accounts.

## What it does

- **`/view-limits`** — renders a live view of each configured route's balance /
  quota / reset time, with spent-today/this-week where available. The Claude,
  Codex and OpenCode surfaces all resolve the same `vl.js view` command.
- **`/view-limits:setup`** — initial setup: opens a local browser form for routes
  that have no key yet (auto-imports MiniMax from `~/.mmx/config.json`).
- **`/view-limits:update [route-id]`** — rotate existing keys: opens the form for
  configured routes, or one route, e.g. `/view-limits:update kimi-code-plan`.
  Rotation always requests a replacement; it never reimports a native key.
- **`vl.js provider add|update|remove|list`** — the custom-provider lifecycle:
  validate, probe the quota source read-only, then persist. Headless, with
  stable statuses and exit codes. See
  [Adding a custom provider](#adding-updating-and-removing-a-custom-provider).
- An optional **`PreToolUse` hook** resolves sub-agent dispatch (`Agent`/`Task`,
  Traycer `create_agent`/`configure_agent`/`fork_agent`) to a route/account. It is
  off by default; advisory and deny modes are available under [Hooks](#hooks).

The hook is **network-free and fail-open**: it reads a cached status file
synchronously, never the provider API, so unknown/stale/unmapped state can never
cause a false-positive block. SessionStart cache refresh is also off by default.
The separate first-run credential notice stays enabled.

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

## Providers

These are the routes view-limits **offers**. A fresh install has **no provider
rows at all** — `config.json` is assembled by setup and pruned by remove, so a
route exists because you added it, never because the plugin assumed it. Until
then `vl.js provider list` shows nothing and the gate resolves no route (which
is an allow: it fails open). See
[How config.json is assembled](#how-configjson-is-assembled).

| Route | Provider | Signal |
|---|---|---|
| `minimax-token-plan` | MiniMax Token Plan | rolling-5h + weekly quota |
| `kimi-code-plan` | Kimi Coding Plan | rolling-5h + weekly quota |
| `glm-coding-plan` | Z.ai (GLM) | % used + `nextResetTime` |
| `deepseek-direct` | DeepSeek | balance + `is_available` |
| `openrouter-main` | OpenRouter | balance + spent today/week |
| `xiaomi-token-plan` | Xiaomi (experimental, opt-in) | token-plan counts; state derived from the tokens window (see below) |

Anthropic is omitted — Claude Code surfaces its own native rate-limit state.

> **Kimi note:** `kimi-code-plan` needs a `sk-kimi-*` Coding Plan key (a Moonshot
> `sk-*` key will not work). Base URL defaults to `https://api.kimi.com/coding/v1`.

## Custom OpenAI- / Anthropic-compatible routes

A third-party plan that speaks the OpenAI or Anthropic wire format can be
added as a custom route. **Wire compatibility does not give you a quota API.**
view-limits reads only the documented rate-limit headers that one explicit,
read-only `GET` endpoint returns. It never sends an inference request on
refresh, check or the gate.

```json
{
  "id": "custom-acme",
  "provider": "anthropic-compat",
  "match": { "model": "acme" },
  "monitor": {
    "endpoint": "https://api.acme.example",
    "recipe": "anthropic-compat",
    "recipeOptions": { "path": "/v1/models", "scope": "diagnostic" }
  }
}
```

| | `openai-compat` | `anthropic-compat` |
|---|---|---|
| Auth sent | `Authorization: Bearer <key>` | `x-api-key` + `anthropic-version` (never a Bearer token) |
| Headers read | `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` | `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}` |
| Reset format | `resetEncoding`: `duration` (`6m0s`, default), `epoch-seconds` or `rfc3339` | RFC 3339 |

`recipeOptions` (each recipe accepts only its declared options):

- `path` (required): the read-only source, appended to `endpoint`. There is no
  default, so view-limits never quietly falls back to `GET /models`.
- `scope`: what the headers describe. One of `diagnostic` (default),
  `account`, `model` or `organization`. **A non-diagnostic scope is your
  explicit assertion** that this endpoint's headers report the quota pool the
  route dispatches against. Under `diagnostic`, the route stays `unknown` and
  the numbers are shown only as `detail.throughput`.
- `anthropicVersion` (Anthropic only): `2023-06-01`. Any other value fails
  closed as `unsupported-anthropic-version`.
- `timeoutMs`: 1000–15000 (default 8000). Changing it does not invalidate
  cached status. Changing `path`, `scope` or `resetEncoding` does.

What the result means:

- Windows are request/token **throughput**, labelled `signal: "throughput"`.
  They are never plan credits, and `balance` is always `null`.
- `exhausted` needs a declared scope, a window with `remaining` 0, and a valid
  future reset. The cached entry expires at that reset, so the gate cannot
  keep denying after the provider said the limit recovers. Without a known
  reset the route is `unknown` (`exhaustion-without-recovery`).
- A 429, an auth failure, a redirect, a timeout, an oversized body, or
  malformed, partial or contradictory headers all produce `unknown` with a
  stable `detail.reason`. They never produce `healthy` or `exhausted`.

Requests are HTTPS-only. Redirects are refused, and the body (64 KiB) and time
are capped. Provider error text is never surfaced. `recipeOptions` that look
like credentials, by name or value, are rejected. The key lives in the vault
under the route `id` like any other route. A route without a key is skipped as
unmonitored. Guided add / probe / remove is
[the provider lifecycle](#adding-updating-and-removing-a-custom-provider)
(no discovery-time inference request is performed — see
[Why there is no inference probe](#why-there-is-no-inference-probe)).
These adapters are verified with documented-format fixtures only, not against a
live provider account.

## Adding, updating and removing a custom provider

`vl.js provider` is one lifecycle service shared by the CLI today and any later
management surface. Every operation **validates, then probes the quota source
read-only, then persists** — in that order, so a source that cannot be read
never reaches `config.json` and never disturbs a route that already works.

```sh
# add: the label becomes the route id `custom-<slug>`
vl.js provider add --label acme-plan --recipe openai-compat \
  --endpoint https://api.acme.example --option path=/v1/models \
  --option scope=account --match-model acme --key "$KEY" --json

vl.js provider list --json                      # what is configured, and whether
                                                # a cached row still matches it
vl.js provider update custom-acme-plan --key "$NEW_KEY" --json
vl.js provider remove custom-acme-plan --json
```

Flags: `--label` (add) or a route id (update / remove); `--recipe`, `--provider`,
`--endpoint`, `--model`, `--account`, `--profile`, `--region`;
`--option k=v` (repeatable, the recipe's declared `recipeOptions`);
`--match-model`, `--match-harness`, `--ttl`; `--key`; `--keep-unmonitored` /
`--clear-credential`; `--json`.

**Identity.** The id is `custom-<slug>` derived from a validated label. A label
that normalizes onto an existing id is **refused, never overwritten**, and a
label that would impersonate a built-in family (`kimi-`, `glm-`, `stepfun-`, …)
is rejected up front. The identity survives an endpoint, model, account or key
change — `id`, `provider` and `recipe` are immutable, because a different recipe
is a different quota source and therefore a different route.

**The probe is the recipe's own read-only fetch** — the same call `refresh` and
`check` make, resolved through the same resolver. One `GET` for a compat recipe,
one bounded CLI read for `alibaba-coding-plan`, and no request at all for
`stepfun-plan`. Never an inference request.

**Nothing to monitor requires an explicit choice.** When the probe reports no
usable capacity signal — an unmonitored recipe, a diagnostic-only scope, an
auth failure, a timeout — the command **persists nothing** and exits
`retention-choice-required`. It never prompts and never waits on stdin. Rerun
with one of:

- `--keep-unmonitored` — register the route anyway. It is marked
  `retention: "keep-unmonitored"` at route level (never inside `monitor`, so
  the flag cannot change a cached observation's validity) and `report` names it
  explicitly, so the probe's verdict stays visible instead of looking like an
  ordinary unknown row. The flag records **what the probe found at setup
  time**; it is not a state policy. The route stays configured, `refresh` and
  `check` still read it, and if the source later does report real capacity that
  observation is published like any other — an annotation never invents a
  state, and never suppresses a genuine one. A route whose *recipe* documents
  no quota source (`stepfun-plan`) can never report capacity, but that comes
  from the recipe's `monitorable: false` capability, not from this flag.
- `--clear-credential` — abandon it. On `add` nothing was ever stored; on
  `update` the credential, the route and its cached row are all removed.

> **`--key` is visible in the process list and your shell history.** It is the
> same trade-off as `vl.js setup <routeId> --key`, and the value goes straight
> into the vault — but on a shared machine prefer adding the route first with a
> source that needs no credential, or rotate afterwards from a shell whose
> history is off. A mistyped `--key=value` (one token) is rejected as unknown
> syntax with its value redacted, so the key is not echoed back.

**Partial writes are recoverable.** Persistence is vault → config → cache and
each stage is reported:

| Fails | Result | State afterwards |
| --- | --- | --- |
| vault | `persist-failed`, stage `vault` | nothing written |
| config | `persist-failed`, stage `config` | the credential is rolled back — removed on an add, restored to the previous key on a rotation. A rotation whose previous value is unreadable says so rather than claiming a rollback |
| cache | `cache-stale-warning`, exit `0` | route and credential stand; the next refresh replaces the stale row |

Rerunning the same command finishes the job. Mutations are serialized by a
`provider-lifecycle.lock` in the data dir (exclusive create, with a single
takeover of a lock whose holder died), so two concurrent commands cannot
interleave a read-modify-write of `config.json`; the loser exits `lock-busy`.

**Removal clears only what view-limits owns**: the route entry (for a custom
route), the vault key (only when the recipe keeps one with us), and the cached
row. **No native logout is ever performed** — the lifecycle spawns no
subprocess and reads no other tool's credential store, so a recipe that
authenticates through its own CLI (`alibaba-coding-plan`) keeps that CLI's
session exactly as it was. `vl.js remove <built-in>` is unchanged apart from
also dropping the stale cache row: the credential goes, the configured route
stays.

**Revision checks.** Every mutation publishes the route's `configRevision`, and
`refresh` stamps it onto each cache entry. A cached observation whose revision
no longer matches the configured route is *config-obsolete*: `provider list`
reports it, and the gate treats it exactly like a stale entry — allow, schedule
a refresh, never deny. So editing a route's endpoint, account, profile, region
or a revision-bearing recipe option cannot leave an old `exhausted` reading
blocking dispatch. Ephemeral options (`timeoutMs`) do not invalidate the cache,
and an entry written before this field existed keeps time-only freshness.

Statuses and exit codes (one JSON document under `--json`):

| Status | Exit | Meaning |
| --- | --- | --- |
| `ok` | `0` | the operation completed |
| `cache-stale-warning` | `0` | completed; only the cache row could not be updated |
| `retention-choice-required` | `2` | nothing to monitor; nothing persisted, choose a retention flag |
| `id-collision` | `3` | that id exists; nothing was overwritten |
| `invalid-route` | `4` | rejected by validation (label, endpoint, option, immutable field) |
| `unsupported-recipe` | `4` | the recipe id is not in the fixed registry |
| `vault-unavailable` | `5` | the credential store could not be written |
| `persist-failed` | `5` | a write failed; see `stage`, `rollback` and `recovery` |
| `lock-busy` | `6` | another mutation is in progress |
| `not-found` | `7` | no such route |

Exit `1` stays reserved for bad arguments, as everywhere else in the CLI.

### Why there is no inference probe

The design allowed one explicitly opted-in, bounded inference request at
discovery time *where provider terms permit it*. **It is deliberately not
implemented**, and this is a decision rather than an omission: no recipe in the
fixed registry has terms that clearly permit it. Alibaba's Coding Plan policy
restricts inference to interactive coding tools, `stepfun-plan` documents no
quota source at all, and `openai-compat` / `anthropic-compat` point at
user-supplied endpoints whose terms view-limits cannot know. Shipping an unwired
opt-in would be dead code carrying a standing invitation to attach it to a
refresh path later. There is therefore no inference endpoint, no discovery
transport and no opt-in flag anywhere in `lib/`.

## Alibaba Cloud Coding Plan (Bailian CLI)

The Coding Plan caps **model calls** — up to 6,000 per rolling 5 hours, 45,000
per week and 90,000 per month, all three applying simultaneously — and
Alibaba documents no quota HTTP endpoint for it. The supported machine-readable
source is the official Bailian CLI, so this recipe runs one bounded,
read-only subprocess instead of a request:

```json
{
  "id": "bailian-coding-plan",
  "provider": "alibaba-cloud",
  "match": { "model": "qwen" },
  "monitor": {
    "recipe": "alibaba-coding-plan",
    "region": "cn-beijing",
    "recipeOptions": { "site": "domestic" }
  }
}
```

| | |
|---|---|
| Command | `bl usage coding-plan --output json` (needs `bl` on PATH, `bl 1.15.0`+) |
| Also run | `bl auth status --output json` — read-only preflight, tokens masked |
| Windows | `rolling-5h` / `weekly` / `monthly` requests, tagged `signal: "quota"` |
| `balance` | always `null` — this is a call quota, not credit |

`recipeOptions`:

- `site`: `domestic` (default) or `international` — the documented commodity.
- `binary`: `bl` (default) or `bailian`. An enum on purpose: a free-form path
  in `config.json` would turn a persisted recipe into "run this executable".
- `timeoutMs`: 1000–30000 (default 10000). Changing it does not invalidate
  cached status. Changing `site` does.

What the result means:

- `region` is **required** and is a declaration, not an observation. The CLI's
  JSON payload echoes no region, so `detail.regionVerified` is always `false`;
  a region of an undocumented shape is refused as `unsupported-region`.
- A window appears only when the CLI reported **both** `usedQuota` and a
  positive `totalQuota`. Missing fields are dropped, not guessed, and the
  CLI's derived `percentage` is never read.
- `exhausted` needs `remaining` 0 **and** a valid future reset. The 5-hour
  quota rolls off minute by minute, so a missing reset means "recovery time
  unknown" — which stays `unknown` (`exhaustion-without-recovery`), never
  `exhausted`.

**Auth is the CLI's own.** `bl usage coding-plan` authenticates with the
console credential, which the CLI resolves only from its own config file —
view-limits neither injects nor stores a secret for this route, and never
reads that file. Authenticate once yourself:

```sh
bl auth login --console
```

Refresh runs no login, no profile switch and no inference: it never invokes
`bl auth login|logout` or `bl config use|set`, and never passes
`--console-switch-agent`. Profile selection uses the global `--config`, which
applies to one invocation only. The child process is spawned with `shell:
false` and an environment allowlist, so no vault or harness secret crosses
over, and its stdout/stderr never reach a status.

**Implemented — not live-tested (awaiting owner account).** The fixtures are
built from the published CLI JSON contract and the documented Coding Plan
policy. No live Alibaba account was used, and no authenticated read was
performed. Live verification is tracked in
[#53](https://github.com/KHAEntertainment/view-limits/issues/53) and is not a
release blocker.

## StepFun Step Plan (unmonitored)

> **Implemented — not live-tested (awaiting owner account).** Classification
> below is documentation-based (StepFun's published docs), not a live probe.
> Live verification is tracked in
> [#53](https://github.com/KHAEntertainment/view-limits/issues/53) and is not a
> release blocker.

StepFun's Step Plan is a credit-based subscription. The published
documentation (`platform.stepfun.ai/step-plan`, `/step-code`, and the API
reference) documents **no read-only quota API** for subscription Credits. The
only documented endpoint, `GET https://api.stepfun.ai/v1/accounts`, reports
Open Platform **cash** balance — a different system from Step Plan Credits —
so view-limits never reads it and never conflates the two numbers.

```json
{
  "id": "stepfun-plan-main",
  "provider": "stepfun-plan",
  "match": { "model": "stepfun" },
  "monitor": { "recipe": "stepfun-plan" }
}
```

- **Supported:** declare the route; view-limits classifies it truthfully.
  `refresh` and `check` send **no request** (no quota source is documented),
  need **no credential** (nothing is keyed in the vault), and write a stable
  cache entry: `state: "unknown"`, empty windows, `balance: null`,
  `detail.reason: "unmonitored-no-documented-quota-source"`.
- **Unsupported (deliberately):** any Credit headroom number. Subscription
  Credits (monthly, cleared, no rollover) are not Open Platform cash, and
  Step Plan has no RPM/TPM windows — view-limits reports none of these for
  StepFun rather than guessing.
- `vl.js report` prints the explicit line:
  `    <routeId>: unmonitored — no documented quota source`.
  The gate stays fail-open: an unmonitored route never denies.

## Experimental: Xiaomi Token Plan (Chrome cookie fallback)

> **Experimental — not released; K1 and R1 live-accepted, C1 pending.** This
> route depends on an undocumented private console API, a read-only Chrome
> cookie store, and a locally built unsigned Keychain helper. Live acceptance
> (2026-10-09/10) confirmed nonprompting background reads (**K1 passed**) and
> expiry → dashboard login → automatic cookie pickup (**R1 passed**); the strict
> minimal-cookie `/detail` probe (**C1**) is unrun and the final installed-helper
> identity is still unverified. Synthetic test success is not provider or OS
> acceptance. Automatic SSO renewal does not exist in this codebase.

`xiaomi-token-plan` reports current token-plan counts from Xiaomi's console
JSON endpoints using session cookies read **read-only** from one explicit
Chrome profile. It is fully opt-in: the route is absent from the built-in
defaults, no Xiaomi key is ever pasted or stored in the vault, and cookie
values live only in memory for a single operation.

### Requirements

- **macOS only** (Chrome cookie decryption is macOS-specific in this build).
- **Node ≥ 22.5** for live Xiaomi checks — the cookie read needs Node's
  built-in `node:sqlite`. `lib/cookies/chrome.js` lazy-loads it, so plugin
  installs on older Node keep working: Xiaomi checks then report the fixed
  `node:sqlite (22.5+)` capability error instead of crashing.
- **Xcode command line tools** (`clang`/`make`) to build the background key
  helper during setup.

### Commands

```sh
vl.js setup xiaomi-token-plan [--chrome-source PATH] [--profile "Profile 1"]
vl.js update xiaomi-token-plan [--chrome-source PATH] [--profile "Profile 1"]
vl.js remove xiaomi-token-plan
vl.js report | report --json | check xiaomi-token-plan | refresh | snapshot --json
vl.js view | view --condensed | view --json
```

- **`setup`** appends the opt-in route, saves the selected Chrome source and
  profile, and builds the non-interactive key helper into the plugin data
  directory — only when you invoke setup. There is **no hardcoded profile**:
  an explicit `--profile` wins, otherwise your previously saved selection is
  kept, otherwise `Default` is used. To find your profile directory, open
  `chrome://version` in the Chrome profile you actually use and read
  **Profile Path** — its last path component is the profile name (for example
  `Default` or `Profile 1`). Setup then prompts **once**
  for Chrome key access: choose **"Always Allow"** (not the one-shot "Allow")
  in the macOS dialog, because "Allow" persists nothing and the next
  background read would be denied again. When the native helper sources are
  unchanged, setup reuses the installed helper instead of rebuilding it — a
  rebuild changes the helper's identity and would prompt again. Route,
  source/profile and private state are committed only after the helper is in
  place **and** the key grant succeeds, so a failed toolchain install or a
  denied dialog preserves whatever worked before.
- **`update`** revalidates or changes the source/profile (no paste form, no
  vault access) and repeats the same interactive key grant.
- **Background reads never prompt**: `report`, `check`, `refresh`, and
  `session-start` rely on the saved "Always Allow" grant only; a missing or
  denied grant surfaces as a classified key error with setup guidance, never
  as a macOS dialog.
- **`remove`** disables the route; removing the **final** Xiaomi route also
  deletes the saved source/profile, the pinned provider entry, and the private
  state, while preserving unrelated configuration. Shared metadata is kept as
  long as another Xiaomi route still needs it.

### The view (`vl.js view`)

`vl.js view` is the explicit, human-facing status surface. It runs the
**shared collector** — the same one `refresh` uses — with a bounded wait, then
renders what the collection published (or what it kept).

```sh
vl.js view              # the expanded text layout
vl.js view --condensed  # the one-line-per-measurement table
vl.js view --json       # exactly one versioned envelope
```

- **`view --json` prints exactly one envelope**, always: success, no
  credentials, a busy collector and a partial failure each get their own
  envelope, never two documents and never a diagnostic mixed into stdout.
  The envelope carries `schemaVersion` (the shared view schema), the routes
  and profiles, and an additive `collection` block that says what the
  collection did (`completed`, `partial`, `in-progress`, `failed`,
  `no-credentials`, `not-run`) and what happened to each route.
- **Unknown or stale is never healthy or eligible.** A route whose freshness
  cannot be proven reads `unknown`, and the quota eligibility is the gate's
  own decision on the same cached entries the gate reads.
- **Diagnostics go to stderr.** The text layout and the JSON envelope stay
  clean; a partial collection, a busy collector or a failed collection is
  reported on stderr as well as in the envelope.
- **Exit codes**: `0` for a completed, partial, in-progress or
  no-credentials collection; `1` when the collection failed (the lock
  errored, the publish failed, or every attempted route failed); `8`/`9`/`10`
  for the refusing configuration states, which happen *before* any collection
  — a refused configuration never reaches a provider and never writes the
  cache.
- The **gate** and `snapshot` stay cache-only and fail-open: they never
  perform provider I/O.

### Fresh reports vs. diagnostic snapshots

- `report` (text and `--json`), `check`, and `refresh` are **live**: each
  operation reads the selected profile's console cookies **once** and makes at
  most **one usage/detail request pair** (all Xiaomi route aliases share that
  single observation). On any failure — contended refresh, network, auth,
  helper, unsafe state — they render pending/unknown/classified errors with
  **no cached Xiaomi counts substituted**, in text or JSON.
- `snapshot --json` is the explicitly **diagnostic** view: it never fetches and
  keeps timestamped historical Xiaomi observations with explicit freshness
  labels (always stale once written, because the route uses `ttlSeconds: 0`).
- The dispatch gate follows the shared rules: an `unknown` or stale Xiaomi
  route stays fail-open (never denies), while a fresh `exhausted` Xiaomi route
  denies in `deny` mode exactly like every other exhausted provider.

### What the numbers mean

Valid `plan_total_token` counts display as one `tokens` window and the route
state is derived **only** from the tokens window itself: `exhausted` at 0
remaining, `constrained` below the configured `gate.constrainedThreshold`
(default 0.2 — 20%), `healthy` at or above it — the status carries the
measurement basis `token-count`, so
`check`/`report` JSON and report text always say which evidence the verdict
came from (`healthy · tokens 75% (token count)`). Compensation-pool
consumption, reset-date parsing, and plan tier/status semantics remain
unresolved by evidence: no reset time, compensation window, or tier label is
ever inferred, and an explicitly expired plan (or unrecognized payload) shows
`unknown` with `basis: none` and no windows — never a healthy-looking
measurement. The console's `currentPeriodEnd` is disclosed as observed
evidence (`plan period ends <date> (reported)` in text, `detail.currentPeriodEnd`
in JSON) and is never promoted into `resetAt`.
There is no SSO or automatic-renewal code: an invalid session renders
`session unavailable — open https://platform.xiaomimimo.com/ in Chrome
(profile Profile 1)…` for a **manual login in the selected profile**; the next
refresh picks up new cookies when Chrome supplies them.

### If access fails

| Fixed message | Recovery |
|---|---|
| `chrome cookie store unreadable` | The selected profile's cookie store is missing/unreadable — check `--profile`/`--chrome-source`. |
| `Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan` | Helper missing or denied. Setup rebuilds it; deterministic helper failures are not retried until setup/update runs. |
| `console cookies missing — open … and log in` | Open the Xiaomi dashboard in the selected Chrome profile and log in. |
| `Xiaomi private state is unsafe — …` | Delete the `xiaomi` folder under the view-limits data directory, then rerun setup (symlinked/foreign state is refused, never followed). |
| `Xiaomi private state could not be cleared — …` | The `xiaomi` state folder exists but is not writable. Make it writable or delete it, then rerun setup. (Stricter than the old reset: an empty read-only `0500` folder is refused here too.) |
| `Node with node:sqlite (22.5+) is required…` | Run live Xiaomi checks on Node ≥ 22.5. |
| `helper build failed — install the Xcode command line tools…` | `xcode-select --install`, then rerun setup. |

## Install

Marketplace:

```sh
claude plugin marketplace add KHAEntertainment/kha-marketplace
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
| Codex | [`harness/codex/README.md`](./harness/codex/README.md) | `hooks.json` (gate + session refresh), `view-limits` skill (status) |
| OpenCode | [`harness/opencode/README.md`](./harness/opencode/README.md) | `plugin/view-limits.js` (gate), `command/view-limits.md` (status refresh) |

Both resolve the CLI from the checkout (or `VIEW_LIMITS_ROOT`) and read the
same cache and vault as the Claude plugin, so no Claude install is required.

## Configuration

Credentials are managed **in-CLI**, never pasted into chat:

- `/view-limits:setup` — add missing keys (browser form).
- `/view-limits:update <route-id>` — rotate a key (browser form).

Storage: macOS Keychain (generic password, no biometric prompt) by default;
AES-256-GCM encrypted file (keyed by `VIEW_LIMITS_MASTER_KEY`) elsewhere. No
runtime password-manager calls. The file backend requires
`VIEW_LIMITS_MASTER_KEY` (or an already provisioned `master.key`) before setup;
view-limits does not generate master keys.

Non-secret config lives in `~/.claude/plugins/data/*/config.json` (endpoints,
routes, TTLs, thresholds). `node bin/vl.js config` shows it (secrets masked).

### How config.json is assembled

There are no default provider rows. The five built-ins in the table above are a
catalog of what setup can add:

- **Setup assembles.** Storing a credential for a built-in writes its row —
  `vl.js setup kimi-code-plan --key …`, the browser form, the headless prompt
  and the native-config import all do it, so "has a credential" and
  "configured" cannot drift apart. `vl.js provider add` does the same for a
  custom route. If the row cannot be written after the credential is stored
  (another provider change holds the lock, or `config.json` is unreadable),
  a bare `vl.js setup` adds it on the next run, and it reports "all
  credentials present" only once every stored credential has its row.
  Setup is the only command that *offers* the catalog: the
  browser form accepts a built-in with no row yet and creates the row when you
  submit a key. `update`, `check` and `provider update` work only on routes
  that are already configured.
- **Remove prunes.** `vl.js provider remove <id>` deletes the row for a route
  the lifecycle owns — a custom route, meaning a non-built-in recipe and a
  non-shipped id. A **shipped** built-in keeps its configured row and loses only
  its credential and cached status, because `config.json` merges route arrays by
  replacement and a shipped id must stay re-addable by setup.
- **Upgrades migrate once.** Before this, the five built-ins were present in
  every config whether or not you had credentials for them. So an install with
  **no `config.json` at all** plus credentials in the vault is an upgrade, not a
  fresh install: on the first command that assembles or refreshes state
  (`setup`, `update`, `provider`, `remove`, `refresh`, `check`,
  `session-start`), rows are materialized for exactly those providers whose
  credentials are stored. Providers without one get no row. The written document
  is what stops it running again.

  A **fresh install** is resolved the same way, on first use: with no
  `config.json` and no stored credentials, the first of those commands writes
  `{"routes": []}`, and from then on it is an ordinary empty config that setup
  adds rows to.

  If the vault **cannot be read** at that moment (the Keychain is locked or
  unavailable, or the file vault's `secrets/` is not accessible), the migration
  writes nothing at all — not an empty list and not a partial one — prints a
  one-line notice, and tries again on the next such command. A credential that
  cannot be read is never treated as absent, because the document it would
  write is what disables the migration for good.

  For the same reason, **only the migration creates `config.json`.** The rule is
  enforced on the write itself, under the provider mutation lock: every other
  publish first moves the current file aside and then links the new one in
  create-only, so it can replace the file but never create it — even if
  `config.json` is deleted while the command runs. That command is then refused
  (exit `8`) and the next command runs the migration. On top of
  that, while the migration is unresolved (the vault could not be read, the
  lock was busy, or the write failed), every command that could write
  `config.json` — `setup`, `update`, `remove`, `provider add|update|remove`
  and the credential form server — stops early with exit `8` and writes
  nothing. Publishing any document then would disable the migration and leave
  the stored credentials without routes. Your credentials are untouched; make
  the vault accessible and rerun. Read-only and cache-only commands
  (`refresh`, `check`, `session-start`, `report`, `status`,
  `snapshot`, `recommend`, `gate`, `provider list`) keep running.

  The migration takes the same mutation lock as `provider add|update|remove`
  and setup, and re-checks that `config.json` is still absent once it holds the
  lock. A concurrent `provider add` that lands first is therefore never
  overwritten; if the lock is busy the migration is skipped with a notice and
  retried on the next command. The lock is released before the command itself
  runs.

  The trigger is deliberately narrow — `config.json` must be genuinely absent. A
  config that exists and holds `routes: []` is a choice, and is never
  resurrected from an old vault. An unparseable config is also present, so it is
  refused and left exactly as it is rather than overwritten. The write goes
  through the atomic publish, so either the migrated document lands or nothing
  does.

  `gate`, `report`, `status`, `snapshot` and `recommend` deliberately do **not**
  migrate: they are cache-only reads that write nothing under the data dir. On a
  fresh or freshly upgraded install they therefore show zero rows until one of
  the commands above runs — in practice at most one session, since
  `session-start` is in that list.

## Hooks

Add these non-secret settings to the view-limits plugin's
`~/.claude/plugins/data/*/config.json` (the directory exported as
`CLAUDE_PLUGIN_DATA`). Standalone CLI use falls back to
`~/.view-limits/config.json`. These are the defaults:

```json
{
  "gate": { "mode": "off", "injectContext": false },
  "refreshOnSessionStart": false
}
```

| Setting | Behavior |
|---|---|
| `gate.mode: "off"` | Every dispatch matcher exits 0 silently, without reading status or scheduling refresh. |
| `gate.mode: "advisory"` | Never denies. With `injectContext: true`, adds context only for a fresh, unambiguously exhausted route: “prefer another plan.” |
| `gate.mode: "deny"` | Preserves dispatch blocking for fresh, unambiguously exhausted routes. Stale, unknown, unmapped, and ambiguous routes remain allowed. |
| `gate.injectContext: false` | No allow path writes `additionalContext`, including advisory mode. Set to `true` to opt in; context suggests preferring another plan rather than waiting for a reset. |
| `refreshOnSessionStart: false` | The async SessionStart refresh exits 0 silently before accessing credentials, providers, or refresh locks. Set to `true` to warm the cache on session start. |

Traycer Model Routing tries interchangeable models when a model is unavailable.
A gate denial prevents dispatch from reaching that routing, so the gate defaults
to off. Leave it off when Model Routing handles failover. To enable advice, use
`"mode": "advisory"` and `"injectContext": true`; to opt in to the previous gate
behavior, use `"mode": "deny"` (and enable context separately if wanted).

Each intrusive hook reads config synchronously. Missing or unreadable config,
invalid JSON, a non-object config or gate, and invalid mode values fail open as
`off`. Boolean settings enable behavior only for the JSON value `true`;
missing or malformed values become `false`. `vl.js config` shows the effective
values of all three settings. Only the hooks fail open this way: `vl.js config`
and every command that acts on the configuration refuse an unreadable or
invalid config.json (exit `10`) rather than use the defaults in its place.

Enabled gates still schedule a detached refresh when status is stale, subject
to `gate.refreshLockSeconds`. `/view-limits` and `/view-limits:update` keep their
on-demand refresh workflow regardless of these settings. The separate
`session-start` notice hook still reports first-run guidance and credential
receipts.

## Architecture

See [CLAUDE.md](./CLAUDE.md). The core `lib/` is transport-neutral, and one
transport-neutral CLI (`bin/vl.js`) is the single substrate every surface
drives. `hooks/`, `commands/` and `skills/` are thin Claude Code wrappers over
it; `harness/codex/` and `harness/opencode/` are the equivalent wiring for the
Codex and OpenCode harnesses. Each surface file delegates to the CLI and
relays its output verbatim — all rendering lives in `lib/view-model.js`.

## The view schema (`vl.js view`)

`vl.js view` renders the shared, versioned view schema — the structured quota,
balance and reauth facts every surface (text, JSON, the dashboard) reads. It
is **cache-only**: it reads the cached snapshot and the configuration, and
never performs a provider request, a refresh, a subprocess or a write.

```sh
vl.js view                 # the expanded text layout
vl.js view --condensed     # one line per measurement
vl.js view --json          # one always-valid JSON envelope (schemaVersion 1)
```

The text and the JSON come from the SAME object, so they can never disagree:
the text renderer never re-derives a fact the schema does not carry.

What the schema guarantees:

- **Nothing is fabricated.** A missing fact is `null`, never `0`, `false` or
  `healthy`. A window that reports only a percentage keeps `remaining` and
  `limit` null; a balance is never inferred from windows; a window's `unit`
  is `null` (with a `window-unit-unavailable` reason code) unless the source
  declares one.
- **The adapter's state is the only state.** The view never derives a state
  from a measurement: a route the adapter called `unknown` stays `unknown`
  (with its raw counts shown and no bar), whatever its numbers say.
- **Stale is never healthy.** A route whose observation is no longer fresh is
  serialized as `unknown` with the reason code `stale-observation`; its
  last-known facts stay visible, marked `(last seen …)`.
- **`quotaEligibility` is the gate's own decision** (`eligible`,
  `ineligible`, `unresolved`), so the view and the dispatch gate can never
  disagree about a route.
- **`reauth` is structured and validated.** The URL must be https, carry no
  userinfo and no query string; a URL that fails becomes `null` plus the
  reason code `reauth-url-invalid`.

The JSON envelope always has `schemaVersion`, `generatedAt`, `status`
(`ok` | `empty` | `pending` | `failed` | `not-configured`), `reasonCodes` and
`routes` — the empty, pending and failed envelopes are valid documents too.

The condensed layout lists **the same routes** as the expanded one: a route
with no measurement at all (an unknown state, no windows, no balance) still
appears, with its state and no bar.

`view` never touches the credential store, and it never writes. When
config.json has never been published — the one-time vault→routes migration
has not resolved — it refuses with exit `8` and the hint that names the
action, because a rerun cannot fix an absent document.

## CLI reference

```sh
vl.js gate                        # PreToolUse hook (stdin JSON → deny / context)
vl.js refresh [--quiet]           # query configured routes, write cache
vl.js status [--json]             # alias of `report`; same output, same exit code
vl.js report [--json]             # render cached status
vl.js check <routeId>             # live-check one route (JSON)
vl.js setup [<routeId>]           # initial setup (missing keys / one route)
vl.js update [<routeId>]          # rotate existing keys
vl.js remove <routeId>            # delete a credential (+ its stale cache row)
vl.js provider add|update|remove|list   # custom-provider lifecycle (validate →
                                  #   read-only probe → persist); stable
                                  #   headless statuses and exit codes
vl.js config                      # effective config (secrets masked)
vl.js snapshot --json [--refresh] # diagnostic runtime snapshot
vl.js view [--condensed] [--json] # the versioned view schema: text or JSON
vl.js recommend --json            # advisory recommendation (Jev-dormant by default)
```

### Exit codes

| Subcommand | Success | Error |
| --- | --- | --- |
| `gate` | `0` (always — fail-open dispatch contract) | n/a (never exits non-zero) |
| `refresh` | `0` | `0` on contention ("refresh already in progress"); `0` when no credentials configured (print guidance); per-adapter failures downgrade the entry to `unknown` and do not raise the exit code; `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr. The SessionStart warm-up (`refresh --quiet --session-start`) exits `0` silently in both cases instead: the `session-start` hook reports them |
| `status` / `report` | `0` (`--json` writes one pretty JSON document to stdout) | n/a — always exits `0` (unknown flags are ignored; with no configured routes it prints the no-credentials guidance, `config unreadable mid-write; retry` when config.json could not be confirmed, or `config.json could not be read or parsed …` when it is unreadable or malformed) |
| `check <routeId>` | `0` (one JSON `NormalizedStatus` on stdout) | `1` on unknown route, missing credential, or classified adapter error (one-line `view-limits: check <id> failed: …` on stderr; never a stack trace); `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr |
| `snapshot --json` | `0` (one pretty JSON envelope on stdout) | `1` when `--json` is missing or any other flag is passed |
| `view [--condensed] [--json]` | `0` (the text layout, or one always-valid JSON envelope on stdout) | `1` on an unknown flag (usage on stderr); `8` config.json has never been published (the one-time vault→routes migration has not resolved — a rerun cannot fix it): `No configuration yet: run /view-limits:setup to add a provider, or start a new session to finish first-run setup` on stderr; `9` config.json could not be confirmed (another process was replacing it, or it exists but could not be read): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr. `--json` still prints exactly one valid envelope (`routes: []`, the status and the reason code) in every refusing case |
| `recommend --json` | `0` (one pretty JSON envelope on stdout) | `1` on bad args; non-object `--task`/`--policy` JSON exits `1` (no fallback document) |
| `setup` / `update` / `remove` | `0` | `1` on bad args, credential-storage failure, or a stored credential whose route row was not added; `8` migration pending ([how config.json is assembled](#how-configjson-is-assembled)); `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr |
| `provider add\|update\|remove\|list` | `0` (`ok`, or `cache-stale-warning` when only the cache row failed) | `1` bad args; `2` retention choice required; `3` id collision; `4` invalid route / unsupported recipe; `5` vault unavailable / persist failed; `6` lock busy; `7` not found; `8` migration pending ([how config.json is assembled](#how-configjson-is-assembled)); `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr — see [the lifecycle section](#adding-updating-and-removing-a-custom-provider) |
| `session-start` | `0` | `0` (purely advisory; surface failures via the receipt/sidecar or its `systemMessage` instead) |
| `config` | `0` | `9` config.json could not be confirmed (another process was replacing it, or it does not exist): `config unreadable mid-write; retry` on stderr — rerun; `10` config.json exists but could not be read or parsed: `config.json could not be read or parsed — fix it or move it aside, then rerun` on stderr (never the built-in defaults presented as the configuration) |
| unknown command | n/a | `1` with the full usage line on stderr |

`report` always exits `0`, and `refresh` exits `0` for everything except an
unconfirmed config.json, because partial-failure rendering is the data plane,
not an error condition. Diagnose via the rendered text or `status --json`.
Exit `9` from any command means config.json could not be confirmed: rerun
it. Exit `10` means config.json exists but could not be read or parsed (a
read error, invalid JSON, or JSON that is not an object): a rerun reads the
same file, so fix it or move it aside first. Neither falls back to the
built-in defaults, because config.json holds your routes and your vault
backend. A command refuses before acting, with one exception: `setup <id>` that
stored a credential and then could not confirm its route says so ("stored
credential for …"), and the rerun confirms the route. Other failure modes (bad args, classified
provider errors, credential-storage failures) raise `exit 1` with a one-line
message on stderr.

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
```

## Version

The version of record is `.claude-plugin/plugin.json` → `version`. Every bump
merged to `main` is tagged `v<version>` and published as a
[GitHub release](https://github.com/KHAEntertainment/view-limits/releases) by
`.github/workflows/tag-on-bump.yml`. For a local checkout, run
`git describe --tags`.
