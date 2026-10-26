# Xiaomi Token Plan

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
