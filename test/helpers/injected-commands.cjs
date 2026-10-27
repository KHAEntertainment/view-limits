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
  for (const block of text.matchAll(FENCE_BLOCK_RE)) {
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
  return text.replace(FENCE_BLOCK_RE, '').replace(INLINE_EXEC_RE, '');
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

module.exports = { extractExecs, withoutInjections, execProgram, INLINE_MARKER_RE, INLINE_EXEC_RE, FENCE_BLOCK_RE };
