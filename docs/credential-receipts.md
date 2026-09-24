# Credential-submission receipts — Issue #19

## Overview

When a credential form submission completes (via `vl.js setup` or `vl.js update`),
the form server writes a durable, non-secret completion receipt. The next
`/view-limits` report or session-start surfaces this receipt to the driving
agent without extra prompting.

## Receipt lifecycle

1. **Write:** The detached form server (`vl.js serve`) writes a receipt when:
   - A POST submission succeeds → `outcome: 'submitted'`
   - A POST submission reaches the vault but a write fails → `outcome:
     'failed'` naming the failed routes; `detail` names any routes that were
     stored
   - A POST submission stores some routes but others were submitted empty →
     `outcome: 'submitted'` naming the stored routes; `detail` names the
     routes that still need credentials (partial success is real, kept
     behavior — each route saves independently)
   - A POST is rejected before any credential write — non-object/bad JSON
     (`detail: 'bad request'`), nonce mismatch (`detail: 'nonce mismatch'`),
     a first-request oversized body (`detail: 'payload too large'`), or no
     credentials supplied for any route (`detail: 'no credentials
     supplied'`) → `outcome: 'failed'` naming the route ids
   - The server shuts down without receiving a POST → `outcome: 'abandoned'`
   - **No receipt** when the server fails before a form session begins (bad
     arguments, vault preflight failure, port bind failure): no session
     completed, so there is no completion/abandon event to record. Absence
     stays `unknown` (`receipt-absent`) rather than a fabricated failure.
   - **No receipt** for a late request after a terminal outcome: an oversized
     POST arriving after the first request settled still gets its `413`,
     but never overwrites the first receipt or re-triggers shutdown.
   - **Publication failure fallback:** when credentials were stored but the
     outcome receipt cannot be published (`writeReceipt` returns null), the
     server makes a best-effort second publish of `outcome: 'failed'` with
     `detail: 'credentials stored; agent receipt publication failed'` —
     never an `abandoned` relabel. If the data directory is unwritable and
     even that fails, the form page warns that no filesystem-backed signal
     is possible.

2. **Read:** `vl.js report` reads the receipt file (read-only, no ack). If the
   receipt exists and is within its 10-minute TTL, it is appended as a line in
   the report output.

3. **Ack:** `vl.js session-start` reads and acknowledges the receipt (deletes
   the file) after surfacing it. This prevents stale notifications from
   repeating.

4. **Expiry:** If no consumer reads the receipt within 10 minutes, it expires
   and is treated as absent. This bounds the notification lifetime.
   `vl.js report` reads the receipt without acknowledging it (so repeated
   reports within the TTL do repeat the notification). `vl.js session-start`
   acknowledgment is what prevents further display after consumption.

## Receipt file

- **Location:** `<dataDir>/credential-receipt.json`
- **Format:** JSON object with `outcome`, `routeIds`, `timestamp`, `freshUntil`,
  and optional `detail`.
- **Security:** The receipt contains no secret material. Route ids carrying a
  known token prefix at a word boundary (start or after a non-alphanumeric
  char — `sk-`, `tok-`, `ghp_`, `xoxb-`, `xsk-`, `AKIA`, …), or shaped like a
  bare JWT, are scrubbed; ordinary ids that merely contain a prefix mid-word
  (`task-runner`, `risk-eval`, `disk-cache`) are preserved. The `detail`
  field is scrubbed of known prefixes at the same boundary, `Bearer <token>`
  forms, and bare JWT (base64url three-segment) shapes — shipped detail call
  sites are fixed literals, so the scrub is scoped to token shapes rather
  than a generic high-entropy heuristic. The receipt file is written only by
  the form server (a local-only CLI flow), never by report/refresh/gate (the
  hot path).
- **Atomicity:** The receipt is published via a same-directory temp file +
  rename, so readers never observe a torn write.

## Outcome codes

| Code | Meaning |
|------|---------|
| `submitted` | Credentials were stored in the vault — either all requested routes, or a partial set where `detail` names the routes that still need credentials. |
| `abandoned` | The server shut down without any terminal POST outcome — never written when a POST settled, even if its receipt could not be published. |
| `failed` | The submission did not complete: a request/validation failure (`bad request`, `nonce mismatch`, `payload too large`, `no credentials supplied`), a vault persistence failure, or a receipt-publication failure after credentials were stored (`detail: 'credentials stored; agent receipt publication failed'`). |

## Truthfulness contract

- A present receipt = observed fact with provenance `'observed'`.
- An absent or expired receipt = `{provenance:'unknown', reason:'receipt-absent'}`.
- The receipt is never fabricated when absent.

## CLI interaction

```sh
# Form server writes the receipt on submit (automatic).
vl.js update <routeId>

# Report surfaces the receipt (read-only, no ack).
vl.js report
# Output includes: "credentials rotated for kimi-code-plan at <time>"

# Session-start surfaces and acks the receipt (consumes it).
vl.js session-start
# Output: {"systemMessage":"view-limits: credentials rotated for kimi-code-plan at <time>."}
```

## Testing

- `test/receipts.test.js`: write/read/ack/expiry, surfacing in report,
  zero-write proof, truthfulness shape, secret exclusion, idempotence.
