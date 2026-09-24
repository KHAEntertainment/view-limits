# Credential-submission receipts — Issue #19

## Overview

When a credential form submission completes (via `vl.js setup` or `vl.js update`),
the form server writes a durable, non-secret completion receipt. The next
`/view-limits` report or session-start surfaces this receipt to the driving
agent without extra prompting.

## Receipt lifecycle

1. **Write:** The detached form server (`vl.js serve`) writes a receipt when:
   - A POST submission succeeds → `outcome: 'submitted'`
   - A POST submission partially succeeds (all-or-nothing pinned by PR #17/#18)
     with vault write failure → `outcome: 'failed'`
   - The server shuts down without receiving a POST → `outcome: 'abandoned'`

2. **Read:** `vl.js report` reads the receipt file (read-only, no ack). If the
   receipt exists and is within its 10-minute TTL, it is appended as a line in
   the report output.

3. **Ack:** `vl.js session-start` reads and acknowledges the receipt (deletes
   the file) after surfacing it. This prevents stale notifications from
   repeating.

4. **Expiry:** If no consumer reads the receipt within 10 minutes, it expires
   and is treated as absent. This provides an automatic idempotence guarantee.

## Receipt file

- **Location:** `<dataDir>/credential-receipt.json`
- **Format:** JSON object with `outcome`, `routeIds`, `timestamp`, `freshUntil`,
  and optional `detail`.
- **Security:** The receipt contains no secret material. Route ids prefixed with
  `sk-` or `tok-` are scrubbed. The `detail` field is scrubbed of any
  `sk-*` patterns. The receipt file is written only by the form server
  (a local-only CLI flow), never by report/refresh/gate (the hot path).

## Outcome codes

| Code | Meaning |
|------|---------|
| `submitted` | Credentials were successfully stored in the vault. |
| `abandoned` | The form was closed without a POST submission. |
| `failed` | The vault write failed (credential storage error). |

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
