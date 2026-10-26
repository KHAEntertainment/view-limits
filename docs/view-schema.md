# The view schema (`vl.js view`)


`vl.js view` renders the shared, versioned view schema — the structured quota,
balance and reauth facts every surface (text, JSON, the dashboard) reads. The
schema and its renderers are pure: they perform no I/O. The `view` COMMAND,
however, is live: it runs the shared collector first — which reads the
credential store, calls providers and writes the cache — and only after the
configuration is confirmed. Only the `gate`, `snapshot` and `status`
commands are cache-only.

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
- **`refusal` is additive and nullable** (Issue #120): a built-in route the
  region/endpoint policy refused (Issue #113) carries `{ reason, fix }` —
  the stable code (`built-in-endpoint-refused` or `unknown-region`) plus a
  short human fix built only from the provider's region table. Every other
  route has `refusal: null`; an older consumer that ignores the field is
  unaffected.

The JSON envelope always has `schemaVersion`, `generatedAt`, `status`
(`ok` | `empty` | `pending` | `failed` | `not-configured`), `reasonCodes` and
`routes` — the empty, pending and failed envelopes are valid documents too.

The condensed layout lists **the same routes** as the expanded one: a route
with no measurement at all (an unknown state, no windows, no balance) still
appears, with its state and no bar.

The refusing configuration states are all handled BEFORE the collector: when
config.json has never been published — the one-time vault→routes migration
has not resolved — `view` refuses with exit `8` and the hint that names the
action, because a rerun cannot fix an absent document. A refused
configuration never reaches a provider and never writes the cache.


## The view (`vl.js view`)

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
