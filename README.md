<div align="center">

[![View-Limits](https://ascii.rest/banner/View-Limits.svg?color=3be858,ea2f1a&font=tall&shadow=heavy&effect=glint)](https://ascii.rest/banner/)

### Know what's left on your coding plans before you dispatch

[![License](https://img.shields.io/github/license/KHAEntertainment/view-limits)](LICENSE) [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/KHAEntertainment/view-limits) ![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/KHAEntertainment/view-limits?logo=CodeRabbit&logoColor=%23FFFFFF&color=%23FF570A)

**See how much is left on your coding plans before your agents start new work.**

[Quick start](#quick-start) | [Works with](#works-with) | [Dashboard](docs/dashboard.md) | [CLI reference](docs/cli-reference.md)

</div>

## The problem

You run an orchestrator that fans work out across models on different accounts: Kimi for one task, GLM for the next, MiniMax for a third. One of those accounts runs out of quota. The orchestrator can't tell, so it keeps sending sub-agents there, and each one fails on a quota error instead of doing the work.

Claude Code shows its own rate-limit state, but nothing shows the others in one place. Every provider keeps its numbers in its own console, in its own shape: a rolling 5-hour window plus a weekly one for MiniMax and Kimi, a percent used for GLM, a balance for DeepSeek and OpenRouter.

## The solution

view-limits asks each provider how much is left, normalizes the answer to one shape (a state, the windows or balance, and the reset time), and caches it in a local `status.json`. `/view-limits` renders that as a live view. One CLI, `vl.js`, does all of it, so Claude Code, Codex and OpenCode show the same thing.

There's an optional gate too. A `PreToolUse` hook resolves each sub-agent dispatch (`Agent`/`Task`, and Traycer's `create_agent`, `configure_agent` and `fork_agent`) to a route and can deny it when that account is exhausted. It's off by default, and it's built not to be wrong in the annoying direction:

- It reads the cached `status.json` synchronously and never calls a provider API.
- It denies only a route whose status is fresh and unambiguously exhausted. Unknown, stale, unmapped and ambiguous routes are allowed.
- Anything unreadable in its own config counts as `off`.

An optional dashboard daemon keeps the status fresh in the background and serves a page on `127.0.0.1`, with an opt-in, read-only view for your phone. Built-in provider rows show the provider's logo (bundled with the plugin, nothing is fetched), and custom providers get a generic icon. `/view-limits:dashboard` brings it up: it starts the daemon if it isn't running, reuses it if it is, and opens the page in your browser, so you never have to go to a terminal to look at your limits.

Your keys stay out of chat. `/view-limits:setup` opens a local browser form, and the keys go to the macOS Keychain, or to an AES-256-GCM encrypted file on other systems.

## Quick start

1. Add the marketplace and install the plugin:

   ```bash
   claude plugin marketplace add KHAEntertainment/marketplace
   claude plugin install view-limits@kha-marketplace
   ```

2. Run `/view-limits:setup`. It opens a local browser form for the providers you want to monitor. Paste your keys there, not in chat. A fresh install has no providers until you add them (it imports a MiniMax key from `~/.mmx/config.json` if it finds one).

3. Run `/view-limits`.

You'll see one block per route you added: its state, the quota windows or balance, and when it resets. A route whose numbers can't be proven fresh shows `unknown`, never `healthy`.

Optional: run `/view-limits:dashboard` to keep that view in a page instead. It starts the background daemon if it isn't running, reuses it if it is, and opens `http://127.0.0.1:<port>/` in your browser. `/view-limits:dashboard-stop` shuts it down and `/view-limits:dashboard-status` reports what it last collected; `vl.js dashboard open --no-open` prints the address and opens nothing. The three commands take no arguments — a command that passes one would be handing shell text to a pre-approved call.

Nothing is blocked yet. The gate starts off, and the cache refreshes when you run `/view-limits` (set `refreshOnSessionStart` to warm it at session start). To get advice in the model's context, or to turn blocking on, see [Hooks](docs/configuration.md#hooks).

Codex and OpenCode run the same `vl.js view` command: [Codex setup](harness/codex/README.md), [OpenCode setup](harness/opencode/README.md). To run from a checkout, use `claude --plugin-dir /path/to/view-limits`. More in [Install](docs/install.md).

Every command here runs its CLI without asking you first: each one declares
`allowed-tools: Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)`, which pre-approves
this plugin's own `vl.js` and nothing else. Claude Code checks a command file's
injected `` !`…` `` call against your permission rules while the file renders,
and outside auto mode anything that is not allowed aborts the whole invocation,
so the grant is what makes `/view-limits` print instead of failing. One honest
caveat: the docs state that substitution inside `allowed-tools` for a plugin
*skill*, and a plugin *command* file accepting the same field is documented
adjacent to that, not spelled out — the first real session settles it.

Those commands take no arguments, and that is deliberate rather than an
oversight. A `!` exec is shell text, and Claude Code substitutes `$ARGUMENTS` as
typed, so an argument in one of those files would be code running under the very
grant above — not data for the CLI to read. So the surfaces that need a second
verb got a second command (`/view-limits:dashboard-stop`,
`/view-limits:dashboard-status`), and the things that genuinely take a route id
are terminal commands: `vl.js setup <route-id>`, `vl.js update <route-id>`,
`vl.js dashboard lan enable --interface <ip>`. `test/relay-only.test.js` and
`test/shim-allowed-tools.test.js` pin the one fixed call per file and reject any
substitution but `${CLAUDE_PLUGIN_ROOT}`.

Each of those injected calls also carries `--relay`, because Claude Code aborts a
command whose injected exec exits non-zero — and "the dashboard is not running"
is a normal answer, not a failure (`dashboard status` exits `3`, `dashboard stop`
exits `1`). The flag waives the exit code and nothing else: same bytes out, and
every exit code in a terminal, in a hook and for the gate is unchanged. It is
refused by any other command. See [the CLI
reference](docs/cli-reference.md#the--relay-exit-waiver-shim-only).

## Works with

| Route | Provider | What it reads |
|---|---|---|
| `minimax-token-plan` | MiniMax Token Plan | rolling 5-hour and weekly quota |
| `kimi-code-plan` | Kimi Coding Plan | rolling 5-hour and weekly quota |
| `glm-coding-plan` | Z.ai (GLM) | percent used and next reset |
| `deepseek-direct` | DeepSeek | balance and availability |
| `openrouter-main` | OpenRouter | balance and this month's spend |

> **Roadmap, not shipped:** Cloudflare Workers AI as a built-in provider ([#117](https://github.com/KHAEntertainment/view-limits/issues/117)), and adding providers from the dashboard ([#64](https://github.com/KHAEntertainment/view-limits/issues/64)).

Also supported:

- **Your own OpenAI- or Anthropic-compatible route.** Wire compatibility doesn't give you a quota API, so view-limits reads only the documented rate-limit headers from one read-only `GET` you point it at. Verified with documented-format fixtures, not a live account.
- **Xiaomi Token Plan.** Experimental and opt-in, macOS only. Set it up with `/view-limits:setup-xiaomi` — its own command, because it reads Xiaomi's console through your Chrome session rather than a stored key. Two of three live acceptance checks have passed.
- **Alibaba Cloud Coding Plan and StepFun Step Plan.** Implemented, not live-tested (awaiting owner accounts, [#53](https://github.com/KHAEntertainment/view-limits/issues/53)). StepFun documents no quota API, so that route is shown as unmonitored and never denies.
- **GLM.** Authentication and error handling are verified live; the quota fields are still checked against fixtures only ([#1](https://github.com/KHAEntertainment/view-limits/issues/1)).

Kimi needs a `sk-kimi-*` Coding Plan key; a Moonshot `sk-*` key won't work. Kimi and GLM default to their international hosts, and China accounts set `monitor.region: "china"` on the route (see [Providers](docs/providers.md)). Anthropic isn't a route, because Claude Code surfaces its own state.

## Want the details?

- [Providers and custom routes](docs/providers.md): the route catalog, regions for Kimi and GLM, compatible routes, the `vl.js provider` lifecycle, Alibaba, StepFun.
- [Xiaomi Token Plan](docs/xiaomi.md): requirements, setup, what the numbers mean, fixing access errors.
- [Install](docs/install.md): the marketplace and checkout installs, and the Codex and OpenCode harnesses.
- [Configuration](docs/configuration.md): credential storage, how `config.json` is assembled, hooks and gate modes.
- [Dashboard](docs/dashboard.md): the daemon, the loopback page, the phone view, and `/view-limits:dashboard`.
- [The view and its schema](docs/view-schema.md): `vl.js view`, the JSON envelope, what it guarantees.
- [CLI reference](docs/cli-reference.md): every command and exit code.
- [Development](docs/development.md): architecture, refresh and locking, tests, how releases are cut. Also see [credential receipts](docs/credential-receipts.md) (the first-run notice), [Jev recommendation](docs/jev-recommendation.md) and [Jev readiness](docs/jev-readiness.md) (the advisory model recommendation and its readiness gate).

## Credits

Built for orchestration in Traycer and similar ADEs, where one orchestrator fans work out across models on different provider accounts. The View-Limits banner is drawn by [ascii.rest](https://ascii.rest/banner/). The dashboard bundles the Geist fonts (SIL OFL 1.1) and fetches nothing from outside your machine. The Alibaba route reads usage through the official Bailian CLI, and the Xiaomi route reads a console that Xiaomi doesn't document.

## License

MIT. See [LICENSE](LICENSE).
