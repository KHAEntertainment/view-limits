# Configuration

## Configuration

Credentials are managed **in-CLI**, never pasted into chat:

- `/view-limits:setup` — add missing keys (browser form). Takes no argument;
  one route is `vl.js setup <route-id>` in a terminal.
- `/view-limits:update` — rotate a key (browser form), for the configured routes
  that already have one. A configured Xiaomi route is revalidated in place first,
  with no form, and a configured route with no key yet is setup's job, not this
  one's. Takes no argument; one route is `vl.js update <route-id>` in a terminal.
- `/view-limits:setup-xiaomi` — the Xiaomi route only (Q36-A). It reads Chrome
  console cookies rather than a stored key, so it is not in the missing-key form
  above and has its own command, which builds the background key helper and saves
  the Chrome profile. Takes no argument; the options are terminal-only:
  `vl.js setup xiaomi-token-plan --profile "Profile 1"`.

Storage: macOS Keychain (generic password, no biometric prompt) by default;
AES-256-GCM encrypted file (keyed by `VIEW_LIMITS_MASTER_KEY`) elsewhere. No
runtime password-manager calls. The file backend requires
`VIEW_LIMITS_MASTER_KEY` (or an already provisioned `master.key`) before setup;
view-limits does not generate master keys.

Non-secret config lives in `~/.claude/plugins/data/*/config.json` (endpoints,
routes, TTLs, thresholds). `node bin/vl.js config` shows it (secrets masked).

### How config.json is assembled

There are no default provider rows. The five built-ins in the table in [Providers](providers.md) are a
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

### One settings folder for Traycer and terminal sessions

A plugin installed from a marketplace keeps its settings in one folder,
`~/.claude/plugins/data/view-limits-<marketplace>` (for example
`view-limits-kha-marketplace`). Traycer starts every Claude session with
`--plugin-dir` pointing at the install cache, and Claude Code then calls the
plugin `view-limits@inline` and exports a different folder,
`~/.claude/plugins/data/view-limits-inline`. Before 0.1.56 that meant a Traycer
session and a terminal session on the same install read and wrote two sets of
settings, so a key added in one did not show in the other.

From 0.1.56 both use the install's own folder. view-limits maps `view-limits-inline`
to `view-limits-<marketplace>` only when the code that is running sits in the
install cache of that same Claude directory (`…/plugins/cache/<marketplace>/view-limits/<version>`).
In every other case the folder Claude exported is used exactly as it is:

- A source checkout loaded with `--plugin-dir` (development) keeps its own
  `view-limits-inline` folder.
- Codex, OpenCode and standalone use keep `~/.view-limits`.
- A marketplace name that Claude would rewrite (anything but letters, digits, `_`
  and `-`) is not guessed at; the `-inline` folder stays in use.

What happens to the folders you already have:

- **Nothing is deleted, renamed or overwritten.** The `view-limits-inline` folder
  is never changed after the switch. (While settings are being copied out of it, a
  `provider-mutations/` lock folder can appear in it, as it does in any data
  folder; no file you own is touched.)
- **The install folder has no `config.json` yet:** your settings are copied once
  from `view-limits-inline` (the same copy as the standalone one below: config,
  master key and ciphertexts, nothing else). If `view-limits-inline` has none,
  `~/.view-limits` is tried next.
- **Both folders have a `config.json`:** the install folder wins and
  `view-limits-inline` is left alone. If it holds routes the install folder lacks,
  the next session start prints one line naming them and suggesting
  `/view-limits:setup`; it is shown once and recorded in the install folder
  (`inline-notice.json`).
- **A copy from `view-limits-inline` that cannot finish holds setup.** It does not
  skip to `~/.view-limits` and does not carry on with an empty folder: either would
  leave the Traycer settings behind for good. The notice names the Traycer folder
  and ends with the `(reason: …)` code.

A dashboard that is already running when you upgrade keeps running from the folder
it was started in, so `/view-limits:dashboard-status` (which now looks in the
install folder) may report it as not running. Stop it before upgrading, or end the
old process once; the next `/view-limits:dashboard` starts one in the install folder.

### When first-run setup does not finish

The Claude plugin copies your existing settings from `~/.view-limits` into its own data folder once, when that folder has no `config.json` yet. While the copy cannot finish, nothing is written to the plugin data folder and the setup commands stop with "your existing settings have not been copied into the plugin data folder yet". Three cases hold it:

- `~/.view-limits` is a symlink.
- `~/.view-limits` is read-only.
- A file inside `~/.view-limits` cannot be read.

Fix the standalone folder or move it aside, then rerun. The notice ends with a `(reason: …)` code that names the case.

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
