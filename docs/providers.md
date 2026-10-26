# Providers and custom routes

## Providers

These are the routes view-limits **offers**. A fresh install has **no provider
rows at all** — `config.json` is assembled by setup and pruned by remove, so a
route exists because you added it, never because the plugin assumed it. Until
then `vl.js provider list` shows nothing and the gate resolves no route (which
is an allow: it fails open). See
[How config.json is assembled](configuration.md#how-configjson-is-assembled).

| Route | Provider | Signal |
|---|---|---|
| `minimax-token-plan` | MiniMax Token Plan | rolling-5h + weekly quota |
| `kimi-code-plan` | Kimi Coding Plan | rolling-5h + weekly quota |
| `glm-coding-plan` | Z.ai (GLM) | % used + `nextResetTime` |
| `deepseek-direct` | DeepSeek | balance + `is_available` |
| `openrouter-main` | OpenRouter | balance + spent this month |
| `xiaomi-token-plan` | Xiaomi (experimental, opt-in) | token-plan counts; state derived from the tokens window (see [Xiaomi Token Plan](xiaomi.md)) |

Anthropic is omitted — Claude Code surfaces its own native rate-limit state.

> **Kimi note:** `kimi-code-plan` needs a `sk-kimi-*` Coding Plan key (a Moonshot
> `sk-*` key will not work). Kimi routes use the global host `https://api.kimi.ai`
> by default; China accounts must set `monitor.region: "china"` on the route
> (`monitor: { "recipe": "built-in", "region": "china" }`) to use
> `https://api.kimi.com`. A hand-typed `monitor.endpoint` on a built-in route is
> refused — use `monitor.region` instead.
>
> **GLM note:** `glm-coding-plan` uses the international host
> `https://api.z.ai` by default; China accounts can set `monitor.region: "china"`
> on the route (same `recipe: "built-in"` form) to use
> `https://open.bigmodel.cn`.

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
  A route id that carries a control character (only a hand-edited
  `config.json` can produce one) is escaped in that line, so it can never
  forge a route row.
  The gate stays fail-open: an unmonitored route never denies.
