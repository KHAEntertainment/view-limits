'use strict';
// The shapes an injected shell command takes in a Claude Code command or skill
// file, shared by every guard so they cannot disagree about what counts as an
// exec. Verified against the current skills docs:
//
//   - the inline form `` !`<command>` ``: "The inline form is only recognized
//     when `!` appears at the start of a line or immediately after whitespace.
//     If `!` follows another character, as in ``KEY=!`cmd`​``, the placeholder is
//     left as literal text and the command does not run." So an indented or
//     mid-sentence injection RUNS, and a `!` after another character is not a
//     marker.
//   - the fenced form: "For multi-line commands, use a fenced code block opened
//     with ```! instead of the inline form." Each non-empty line inside is a
//     command.
//   - a `!`-exec on its own line, which is what today's four shims use. It is
//     just the line-initial case of the inline form.
//
// A file that carries a marker this module cannot parse is reported through
// `problems` rather than skipped: an unclosed backtick is a malformed injection,
// and a guard that reads it as "no injection" is a guard that can be evaded by
// writing the markdown badly.

const INLINE_MARKER_RE = /(?:^|(?<=\s))!`/gm;
const INLINE_EXEC_RE = /(?:^|(?<=\s))!`([^`]*)`/gm;
const FENCE_BLOCK_RE = /^[ \t]*```![^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

// → the commands this file injects, in document order. Anything unreadable is
// pushed to `problems` (caller decides how to fail on it).
function extractExecs(rel, text, problems) {
  const out = [];
  const markers = (text.match(INLINE_MARKER_RE) || []).length;
  const parsed = (text.match(INLINE_EXEC_RE) || []).length;
  for (const m of text.matchAll(INLINE_EXEC_RE)) {
    if (m[1].trim() === '') problems.push(`${rel}: an injected command is empty: ${m[0]}`);
    else out.push(m[1]);
  }
  if (parsed !== markers) {
    problems.push(`${rel}: ${markers} injected \`!\` marker(s) but only ${parsed} parsed `
      + '— an inline command with no closing backtick?');
  }
  const fenceOpens = (text.match(/^[ \t]*```!/gm) || []).length;
  const blocks = [...text.matchAll(FENCE_BLOCK_RE)];
  // An opening ```! with no closing fence is a malformed injection. Counting it
  // against the blocks actually parsed is what makes that explicit: a parser
  // that quietly skips what it cannot match turns "the guard read every
  // injection" into a claim that is only true for well-formed files.
  if (blocks.length !== fenceOpens) {
    problems.push(`${rel}: ${fenceOpens} opening \`\`\`! fence(s) but ${blocks.length} complete block(s) `
      + '— an injected command block with no closing fence?');
  }
  for (const block of blocks) {
    for (const line of block[1].split('\n')) {
      if (line.trim() === '') continue;
      out.push(line.trim());
    }
  }
  return out;
}

// The file with every injected command taken out, so prose and code-span scans
// cannot mistake an argv for formatting logic: an injected command legitimately
// carries a quoted path and `2>&1`, and the `&` in that redirect is not the
// shim piping anything. Removes the fenced blocks whole and the inline/indented
// forms by match, which is why this cannot be done with a line filter.
function withoutInjections(text) {
  return text
    .replace(FENCE_BLOCK_RE, '')
    // An unclosed block has already been reported by extractExecs. Drop its
    // marker line here so the commands inside it are still seen by the prose and
    // code-span scans — that is where the shim's "no code fences" rule catches
    // the malformed remainder, rather than the file passing on a stripped blind
    // spot.
    .replace(/^[ \t]*```![^\n]*\n/gm, '')
    .replace(INLINE_EXEC_RE, '');
}

// The program token of one injected command: its first word, quoted or not.
// Throws a plain Error on a command with no recognisable first word — a caller
// that must fail loudly lets it propagate.
function execProgram(cmd) {
  const quoted = cmd.match(/^"([^"]*)"(\s|$)/);
  if (quoted) return { token: quoted[1], wasQuoted: true };
  const bare = cmd.match(/^(\S+)(\s|$)/);
  if (!bare) throw new Error(`injected command starts with nothing recognisable: ${cmd}`);
  return { token: bare[1], wasQuoted: false };
}

// The variable a shim may substitute into its injected command, and NOTHING
// else. Owner ruling Q34-A ("no arguments in any pre-approved command") exists
// because a `!` exec is shell text: Claude Code substitutes `$ARGUMENTS` as
// typed, so an argument becomes code before the CLI ever sees it. The PR #144
// repro was `/view-limits:dashboard status; "<root>/bin/vl.js" dashboard lan
// disable`, which ran as two pre-approved vl.js calls. Quoting the substitution
// does not help — it is textual replacement, not shell quoting.
const ALLOWED_SUBSTITUTION = '${CLAUDE_PLUGIN_ROOT}';
// Issue #148: the one other substitution, which is the plugin's data directory.
// A `!` exec line cannot read CLAUDE_PLUGIN_DATA from its environment, so the
// shim receives it as inline text and passes it as `--data-dir`. It is a path
// Claude Code owns, not anything the user typed, and relay-only.test.js pins
// the exact place it may appear.
const ALLOWED_DATA_SUBSTITUTION = '${CLAUDE_PLUGIN_DATA}';

// → the substitution fragments left in a command once the plugin root is
// accounted for: `$ARGUMENTS`, `$ARGUMENTS[1]`, `$0`..`$9`, `$NAME`, any other
// `${…}`, and `$(…)`. An empty array is the only passing answer.
function findSubstitutions(cmd) {
  const rest = cmd.split(ALLOWED_SUBSTITUTION).join('').split(ALLOWED_DATA_SUBSTITUTION).join('');
  const bad = [];
  for (const m of rest.matchAll(/\$(?:\{[^}]*\}?|\([^)]*\)?|[A-Za-z_][A-Za-z0-9_]*|\d+)?/g)) bad.push(m[0]);
  return bad;
}

module.exports = { extractExecs, withoutInjections, execProgram, findSubstitutions, ALLOWED_SUBSTITUTION, ALLOWED_DATA_SUBSTITUTION, INLINE_MARKER_RE, INLINE_EXEC_RE, FENCE_BLOCK_RE };
