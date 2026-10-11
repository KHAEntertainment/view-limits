'use strict';
// Relay-only shim enforcement for commands/ and skills/ (Issue #36).
//
// Decision of record (next-phase-plan → deterministic-output-contract):
// slash command and skill files are relay-only shims — an exec line that
// invokes the rendering CLI plus an instruction to relay its output verbatim.
// All formatting lives in the CLI / lib view-model; the shim never shapes a
// field. This test is the regression guard that fails if formatting logic is
// reintroduced into a shim, if the live-refresh exec changes, or if a shim
// leaves the scanned set (deleted/renamed to dodge the test).
//
// "Formatting logic" here means field-shaping CODE or agent-facing
// reformatting instructions:
//   - an exec line outside the argv allowlist (pipes, `;`, redirects,
//     subshells, sed/awk/jq/printf all fail closed by construction),
//   - text-processing tools or pipeline metacharacters in any code span, or
//     formatting tools / piping instructions in shim prose (ambiguous English
//     words such as "paste" or "cut" are excluded from the prose scan so
//     guidance like "paste the key into the form" survives; they remain
//     forbidden inside code spans),
//   - code fences (JS/formatting code has no place in a shim),
//   - prose that tells the agent to summarize/format/pipe the output, or a
//     markdown table laid out in the shim file.
// Prose that documents CLI *behavior* (workflow and security guidance such as
// "never in chat", or the credential-receipt note in skills/update) is not
// formatting and is allowed; the formatting source of truth stays in
// lib/view-model.js / lib/receipts.js.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// The shims that must exist and be scanned. Removing one to escape the test
// fails below.
const REQUIRED_SHIMS = [
  'commands/view-limits.md',
  'skills/setup/SKILL.md',
  'skills/update/SKILL.md',
];

// Exec argv allowlist: the rendering CLI, one or more plain argv tokens,
// an optional $ARGUMENTS passthrough, an optional 2>&1. Anything beyond that —
// a pipe, redirect, `;`, `&&`, quoting, a different command — fails closed.
const CLI_PREFIX = /^"[$]{1,2}\{?CLAUDE_PLUGIN_ROOT\}?\/bin\/vl\.js"/;
const EXEC_BODY_RE =
  /^"[$]{1,2}\{?CLAUDE_PLUGIN_ROOT\}?\/bin\/vl\.js"(?: [A-Za-z0-9._:@/-]+)*(?: \$ARGUMENTS)?(?: 2>&1)?$/;

// The shim must instruct verbatim relay of the injected CLI output.
const RELAY_RE = /relay the output above verbatim/i;

// Text-processing / shaping tools that must never appear in a shim's code.
const FORMAT_TOOL_RE =
  /\b(?:sed|awk|jq|grep|perl|printf|column|xargs|cut|paste|fmt|expand|tr|sort|uniq|tee|head|tail|base64|rev)\b/;

// Pipeline / command-chaining metacharacters in non-exec code spans.
const PIPE_RE = /[|;&]/;

// Agent-facing reformatting instructions in prose.
const REFORMAT_RE =
  /\b(?:summari[sz]\w*|reformat\w*|prettif\w*|markdown table|as a table|bullet list|numbered list|columns?|table|format(?:ted|ting|s)?\s+(?:the|this|as|it|output))\b/i;

// A markdown table row laid out inside the shim.
const TABLE_ROW_RE = /^[ \t]*\|[^\n]*\|[ \t]*$/m;

// [QA-Medium] Formatting-tool names that stay unambiguous in running prose.
// Ambiguous English words (paste, cut, head, tail, tr, sort, ...) are
// deliberately excluded here — they are still forbidden inside code spans
// above — so guidance prose like "paste the key into the form" is not a
// false positive. Catching novel phrasing ("Trim the output with sed") is
// why the prose scan exists at all.
const PROSE_TOOL_RE = /\b(?:sed|awk|jq|grep|perl|printf|xargs|base64|column)\b/i;

// [QA-Medium] Piping / redirect instructions in prose: a relay-only shim
// never tells the agent to transform the CLI output stream.
const PROSE_PIPE_RE =
  /\b(?:pipe|pipes|piped|piping|redirect|redirects|redirected|redirecting)\b/i;

// [QA-Low] Every exec line in the command shim must be the live refresh.
const REFRESH_EXEC_RE =
  /^"[$]{1,2}\{?CLAUDE_PLUGIN_ROOT\}?\/bin\/vl\.js" refresh(?: 2>&1)?$/;

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

function listShims() {
  const found = [];
  const commandsDir = path.join(root, 'commands');
  if (fs.existsSync(commandsDir)) {
    for (const f of fs.readdirSync(commandsDir).sort()) {
      if (f.endsWith('.md')) found.push(path.join('commands', f));
    }
  }
  const skillsDir = path.join(root, 'skills');
  if (fs.existsSync(skillsDir)) {
    for (const d of fs.readdirSync(skillsDir).sort()) {
      const rel = path.join('skills', d, 'SKILL.md');
      if (fs.existsSync(path.join(root, rel))) found.push(rel);
    }
  }
  return found;
}

const shims = listShims();

// [AC3] the scanned set cannot shrink without failing: the known shims must
// exist, and there must be at least one shim overall.
check(shims.length > 0, 'no command/skill shim files discovered');
for (const required of REQUIRED_SHIMS) {
  check(shims.includes(required), `${required}: required shim missing (renaming or deleting a shim must not escape the relay-only test)`);
}

for (const rel of shims) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  const lines = text.split('\n');

  // [AC1] relay source: at least one `!` exec line, each strictly allowlisted
  // so the shim only invokes the rendering CLI and never shapes its output.
  const execLines = lines.filter((l) => l.startsWith('!'));
  check(execLines.length >= 1, `${rel}: no \`!\` exec line — a relay-only shim must invoke bin/vl.js`);
  for (const line of execLines) {
    const m = line.match(/^!`(.+)`$/);
    check(!!m, `${rel}: exec line is not \`!\`<command>\` form: ${line.trim()}`);
    if (!m) continue;
    check(CLI_PREFIX.test(m[1]), `${rel}: exec line does not invoke the rendering CLI (bin/vl.js): ${m[1]}`);
    check(EXEC_BODY_RE.test(m[1]),
      `${rel}: exec argv outside the relay allowlist (CLI + plain args + optional $ARGUMENTS + optional 2>&1 only — no pipes, redirects, subshells, or other commands): ${m[1]}`);
  }

  // [AC3] relay-only property: the verbatim-relay instruction must be present,
  // so a future edit cannot quietly turn the shim into "summarize/format it".
  check(RELAY_RE.test(text),
    `${rel}: missing the verbatim-relay instruction ("Relay the output above verbatim")`);

  // [AC1] no formatting logic: code fences, shaping tools, or pipeline
  // metacharacters anywhere in the shim's code. Exec lines are already
  // argv-allowlisted above, so they are excluded from these scans.
  const body = lines.filter((l) => !l.startsWith('!')).join('\n');
  check(!text.includes('```'),
    `${rel}: code fences are not allowed in a relay-only shim (formatting code belongs in the CLI / view model)`);
  const spans = body.match(/`[^`\n]+`/g) || [];
  for (const span of spans) {
    check(!FORMAT_TOOL_RE.test(span),
      `${rel}: text-processing tool in code span (formatting belongs in the CLI / view model): ${span}`);
    check(!PIPE_RE.test(span),
      `${rel}: pipeline / chaining metacharacter in code span: ${span}`);
  }

  // [AC1] no agent-facing reformatting instructions or laid-out tables in prose.
  check(!REFORMAT_RE.test(body),
    `${rel}: reformatting instruction in the shim (relay verbatim; do not format)`);
  check(!TABLE_ROW_RE.test(body),
    `${rel}: markdown table laid out in the shim (field layout belongs in the CLI / view model)`);
  const proseTool = body.match(PROSE_TOOL_RE);
  check(!proseTool,
    `${rel}: formatting tool named in shim prose (transform output in the CLI / view model, not the shim): ${proseTool ? proseTool[0] : ''}`);
  const prosePipe = body.match(PROSE_PIPE_RE);
  check(!prosePipe,
    `${rel}: piping/redirect instruction in shim prose (relay the CLI output untransformed): ${prosePipe ? prosePipe[0] : ''}`);

  // [AC2] /view-limits stays a live refresh: EVERY exec line in the command
  // shim must run `vl.js refresh` — a second "extra" exec line must not
  // smuggle in a cache-only display path such as `vl.js report`.
  if (rel === 'commands/view-limits.md') {
    for (const line of execLines) {
      const m = line.match(/^!`(.+)`$/);
      if (!m) continue; // malformed form already failed above
      check(REFRESH_EXEC_RE.test(m[1]),
        `${rel}: every exec must remain a live refresh — expected \`vl.js refresh\`, found: ${m[1]}`);
    }
  }
}

if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\n${failures.length} relay-only check(s) failed`);
  process.exit(1);
}
console.log(`relay-only shims: ok (${shims.length} file(s) scanned: ${shims.join(', ')})`);
