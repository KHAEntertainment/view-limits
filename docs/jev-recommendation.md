# Jev profiling + advisory recommendation — Issue #11

Status as of this PR: the deterministic pipeline (typed task profile, hard
eligibility, six-dimension candidate scoring, advisory recommendation API)
ships **active**. The Jev network path ships **present but dormant** — the
readiness gate evaluates **CLOSED** on the merged evidence in
[docs/jev-readiness.md](jev-readiness.md) (items 2, 3, 11 BLOCKING; 1, 4
PARTIAL), and the pre-implementation OpenRouter catalog probe found **no**
model matching `/jev|typesafe/i` (458 catalog entries checked, zero matches —
see the PR body for the verbatim result).

## Modules

| Module | Role |
|--------|------|
| `lib/jev-readiness.js` | The eleven-item readiness gate as data + a pure evaluator. Fail-closed both directions: any non-PASS item (or unrecognized verdict) keeps the gate closed, and any required item id **absent** from an injected evidence set is synthesized `{verdict:'blocking', reason:'readiness-item-absent'}` — a torn-out checklist can never read as complete. |
| `lib/task-profile.js` | Typed, model-agnostic task profile: task kind, exploration, specification, reasoning, risk, autonomy, verification, execution style. Fact-shaped dimensions; Jev response schema validation lives here so prompt and validator share one vocabulary. |
| `lib/jev-client.js` | The complete Jev path: deterministic classifier request, model/structured-output catalog verification, response validation, confidence floor. All transports injected; no I/O of its own; **no fabricated default model or endpoint**. |
| `lib/jev-openrouter.js` | The OpenRouter wire adapter: translates the transport-neutral request document into a chat-completions call (`response_format:{type:'json_schema',json_schema:{name,schema}}`). HTTPS-only construction (a non-https baseUrl yields no transport), `redirect:'error'` on every fetch, and a deadline on the catalog read including the body. |
| `lib/score-candidates.js` | Deterministic six-dimension scoring over eligible candidates. Pure (no clock — `now` is a parameter, no I/O, no randomness). Unresolved dimensions contribute zero weight and stay visible. |
| `lib/recommend.js` | The advisory API: gate → profile → eligibility → scoring → ranked result with rationale and alternatives. |

## When the Jev gate opens

The gate opens only when **both** conditions hold:

1. Every readiness prerequisite is `PASS` — all eleven items in
   `lib/jev-readiness.js` `READINESS_ITEMS`, which mirror
   `docs/jev-readiness.md`. Updating the verdicts is a data edit made after
   new evidence lands, not a code change.
2. The configured model's structured-output support verifies via
   `verifyModelSupport` — the model id must exist in the provider catalog AND
   advertise structured output (`structured_outputs`, `response_format`, or
   `json_schema` in `supported_parameters`). Model id, endpoint, and catalog
   URL are configuration (`config.json` `jev` section); there is no built-in
   default. Unconfigured or unverifiable → `unavailable`/`unverified` with a
   stable reason code and the deterministic fallback runs.

Until both hold, `recommend()` never invokes a Jev transport — verification
is only attempted once all eleven items pass.

## Advisory boundary

The recommendation result contains advisory parameters (harness, model,
route, profile — as facts) and rationale **only**. It never spawns,
configures, or forks an agent; never silently substitutes a model (an
unproven model stays an explicit unknown fact); never queries balances
through Jev; never selects commands; never auto-dispatches; and never
bypasses eligibility — `lib/eligibility.js` verdicts are identical with Jev
applied, failed, or absent, and a Jev-suggested candidate is re-checked
through the same evaluator.

### Test-fixture cross-references

| Behavioral claim | Test file | Key test(s) |
|------------------|-----------|-------------|
| Gate CLOSED on current evidence | `test/recommend.test.js` | `gate stays closed on merged evidence` |
| Jev network path never invoked when gate is closed | `test/recommend.test.js` | `deterministic fallback without Jev` |
| Hard eligibility overrides Jev suggestion | `test/recommend.test.js` | `Jev suggestion re-checked through eligibility` |
| Candidate id uniqueness enforced | `test/recommend.test.js` | `duplicate candidate ids rejected` |
| Unresolved dimensions contribute zero weight | `test/recommend.test.js` | `scored candidates carry unresolved evidence` |
| Deterministic output (same inputs → byte-identical) | `test/recommend.test.js` | `recommend output is deterministic` |
| Zero-I/O recommend CLI | `test/recommend-cli.test.js` | `CLI recommend under guard.cjs` |
| Scoring six dimensions | `test/recommend.test.js` | `eligible candidates scored on six dimensions` |
| Policy deep-merges with strict default | `test/recommend-cli.test.js` | `F2: explicit object --policy deep-merges` |

## CLI

```sh
vl recommend --json [--task '<json>'] [--policy '<json>']
```

One configured route becomes one candidate (facts carried verbatim from the
cache-only snapshot). Default policy requires a proven, usable route
identity; `--policy` deep-merges over it — a non-object `--task`/`--policy`
document is rejected outright, and at the library level a non-object policy
falls back to the same strict default rather than dropping requirement
checks. Candidate ids must be unique: every candidate sharing an id is
rejected `candidate-id-duplicate` before eligibility, so recommendation
parameters always come from the exact object that was scored. Output is a
single JSON document. The path is zero-I/O: proven under `test/guard.cjs` in
`test/recommend-cli.test.js`.

### Policy-input asymmetry

Policy semantics differ by layer:

- **CLI layer** (`vl.js recommend`): the `--policy` flag deep-merges the
  caller-supplied JSON over the strict default
  `{ require: { route: true, usableRoute: true } }`. An explicit `{}`
  overrides nothing, so route checks remain enabled. A non-object value
  (`null`, array, number) is rejected outright.
- **Library layer** (`recommend()` function): passing `policy: {}` is the
  deliberate no-requirements choice — `{}` adds nothing to the strict
  default, but the intent is a conscious caller override. A non-object
  policy (absent, `null`, `[]`, `42`) falls back to the strict default
  at this layer too.

This split is tested in `test/recommend-cli.test.js` (`F2: explicit object
--policy deep-merges` for the CLI behavior) and `test/recommend.test.js`
(`F2: a non-object policy fails closed`, which also pins the library `{}`
semantics).
