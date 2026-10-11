// view-limits — OpenCode harness surface (wiring only, no logic).
//
// OpenCode loads this file as a plugin (opencode.json `plugin` entry); each
// named export is initialized with the plugin input and may return hooks.
// Exactly one hook is wired: `tool.execute.before` on OpenCode's `task`
// dispatch tool. It translates the call into the same PreToolUse envelope the
// Claude plugin sends, delegates the decision to `bin/vl.js gate` (the Phase 1
// CLI), and throws on an explicit deny so the dispatch is blocked. Every
// decision — freshness, route resolution, deny/allow — lives in the CLI; this
// file renders nothing and decides nothing.
//
// Fail-open contract (identical to the Claude and Codex surfaces):
//   - no model identity resolvable → do not consult the gate at all;
//   - spawn error / timeout / non-zero exit / unparsable output → allow;
//   - only an explicit permissionDecision "deny" throws.
//
// The CLI path is resolved from VIEW_LIMITS_ROOT (copied install), else from
// this file's location in the checkout (repo-local install), mirroring the
// Codex surface's resolution rules. Credentials and cache are shared with the
// other surfaces: with CLAUDE_PLUGIN_* unset the CLI falls back to
// ~/.view-limits.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const CLI_TIMEOUT_MS = 10000

// harness/opencode/plugin/ → checkout root is three levels up.
function cliPath() {
  const root = process.env.VIEW_LIMITS_ROOT
  if (typeof root === 'string' && root.trim() !== '') return path.join(root, 'bin', 'vl.js')
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bin', 'vl.js')
}

// OpenCode dispatch args → the model identity the gate resolves routes from.
// `task` args carry no model field today (subagent_type + prompt only), so
// this fails open — the same known limit the Codex surface documents. If a
// model identity is ever present on the call, it is forwarded verbatim.
function modelOf(args) {
  const model = args && typeof args === 'object' ? args.model : undefined
  return typeof model === 'string' && model.trim() !== '' ? model : null
}

function runGate(model) {
  const result = spawnSync(process.execPath, [cliPath(), 'gate'], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: { model } }),
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  })
  if (result.error || !result.stdout) return // spawn failure/timeout → fail open
  let decision
  try { decision = JSON.parse(result.stdout).hookSpecificOutput } catch { return } // unparsable output → fail open
  if (decision && decision.permissionDecision === 'deny') {
    throw new Error(decision.permissionDecisionReason || 'view-limits: dispatch blocked')
  }
}

export const ViewLimits = () => ({
  'tool.execute.before': async (input, output) => {
    if (!input || input.tool !== 'task') return
    const model = modelOf(output && output.args)
    if (!model) return // no dispatch identity → the gate cannot resolve a route; fail open
    runGate(model)
  },
})
