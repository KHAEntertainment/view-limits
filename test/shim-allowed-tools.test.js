'use strict';
// Issue #142 — every command/skill shim that injects a `!` exec must pre-approve
// exactly the plugin's own CLI in its frontmatter.
//
// Why this is a test and not a review note: an injected command never prompts.
// Claude Code checks it against the permission rules while the file renders, and
// outside auto mode ANY result other than allow aborts the whole invocation
// ("Shell command permission check failed"). An un-matched rule is therefore not
// a prompt the user can wave through — it is a command that does not run. Both
// halves have to be right, so both halves are pinned here:
//
//   1. the frontmatter value, from ONE constant, so switching the shipped form
//      (quoted vs unquoted path) is a one-line change in this file;
//   2. each file's own exec line, whose program token must be the same path the
//      rule names — so the rule can never drift away from the command it
//      approves, which is what makes the match hold.
//
// Scanned set: every commands/*.md and skills/*/SKILL.md that carries a `!` exec
// (discovered, not listed, so a new shim is covered the moment it appears).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = '${CLAUDE_PLUGIN_ROOT}/bin/vl.js';

// THE ONE PLACE. Quoted, to match the exec lines, which quote the path so a
// plugin root containing a space stays one argument. If the real-session check
// says a quoted rule does not match, this becomes `Bash(${path} *)` and the
// derivation below enforces the unquoted exec form everywhere.
const ALLOWED_TOOLS = 'Bash("${CLAUDE_PLUGIN_ROOT}/bin/vl.js" *)';

// The two shapes the rule is allowed to take, and the exec-line form each one
// approves. The quoted rule goes with a quoted command; the bare rule goes with
// a bare one. Nothing else is a match-by-construction pair.
const PAIRS = {
  quoted: { rule: 'Bash("' + CLI_PATH + '" *)', execQuoted: true },
  bare: { rule: 'Bash(' + CLI_PATH + ' *)', execQuoted: false },
};

// Split a YAML flow-ish value on whitespace that is NOT inside parentheses, so
// `Bash(a b)` is one entry and `Bash(a) Read(x)` is two.
function splitTopLevel(value) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ' ' && depth === 0) {
      if (cur !== '') out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur !== '') out.push(cur);
  assert.ok(depth === 0, `unbalanced parentheses in an allowed-tools value: ${value}`);
  return out;
}

// The frontmatter block as raw lines, or null when the file has none.
function frontmatterLines(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  assert.ok(end > 0, 'frontmatter opened with --- but was never closed');
  return lines.slice(1, end);
}

// `key: value`, and the `- value` list form the docs also allow for this field.
function frontmatterValue(fm, key) {
  const i = fm.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (i === -1) return undefined;
  const inline = fm[i].replace(new RegExp(`^${key}:`), '').trim();
  if (inline !== '') return inline;
  const items = [];
  for (let j = i + 1; j < fm.length; j += 1) {
    const m = fm[j].match(/^\s*-\s*(.+)$/);
    if (!m) break;
    items.push(m[1].trim());
  }
  return items.join(' ');
}

function listShims() {
  const found = [];
  const commandsDir = path.join(ROOT, 'commands');
  for (const f of fs.readdirSync(commandsDir).sort()) {
    if (f.endsWith('.md')) found.push(path.join('commands', f));
  }
  const skillsDir = path.join(ROOT, 'skills');
  for (const d of fs.readdirSync(skillsDir).sort()) {
    const rel = path.join('skills', d, 'SKILL.md');
    if (fs.existsSync(path.join(ROOT, rel))) found.push(rel);
  }
  return found;
}

// The program token of a shim's `!` exec lines: the first word, quoted or not.
function execPrograms(text) {
  const execs = [...text.matchAll(/^!`(.+)`$/gm)];
  assert.ok(execs.length >= 1, 'no `!` exec line');
  return execs.map((m) => {
    const quoted = m[1].match(/^"([^"]+)"(\s|$)/);
    if (quoted) return { token: quoted[1], wasQuoted: true };
    const bare = m[1].match(/^(\S+)(\s|$)/);
    assert.ok(bare, `exec line starts with nothing recognisable: ${m[1]}`);
    return { token: bare[1], wasQuoted: false };
  });
}

const shims = listShims();
assert.ok(shims.length >= 4, `expected the four known shims, discovered ${shims.length}: ${shims.join(', ')}`);
const pair = PAIRS.quoted;
assert.strictEqual(pair.rule, ALLOWED_TOOLS,
  'the shipped rule must be the pair this test derives from: to switch between the quoted and the bare form, point ALLOWED_TOOLS at the PAIRS entry you want — the exec lines have to move with it');

let withExec = 0;
for (const rel of shims) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const fm = frontmatterLines(text);
  let programs;
  try {
    programs = execPrograms(text);
  } catch {
    continue; // no `!` exec — nothing to pre-approve
  }
  withExec += 1;
  assert.ok(fm, `${rel}: no frontmatter block, so no allowed-tools grant for its \`!\` exec`);

  const value = frontmatterValue(fm, 'allowed-tools');
  assert.ok(value !== undefined && value !== '',
    `${rel}: a shim that injects a \`!\` command must declare allowed-tools — an un-matched exec aborts the whole invocation outside auto mode`);

  const entries = splitTopLevel(value);
  assert.strictEqual(entries.length, 1,
    `${rel}: allowed-tools must be exactly one entry, never wider (got ${entries.length}: ${entries.join(' | ')})`);
  assert.strictEqual(entries[0], ALLOWED_TOOLS,
    `${rel}: allowed-tools must be the plugin CLI rule, byte for byte`);

  // Never wider, structurally: a Bash rule whose program is the plugin CLI and
  // whose only wildcard is the single trailing ` *`.
  const m = entries[0].match(/^Bash\((.*)\)$/);
  assert.ok(m, `${rel}: the entry must be a Bash(...) rule: ${entries[0]}`);
  assert.doesNotMatch(m[1], /(^|\S)\*(?!\s*\*$)/, `${rel}: no wildcard except the single trailing one`);
  assert.match(m[1], / \*$/, `${rel}: the rule must end with ' *'`);
  assert.strictEqual(m[1].replace(/ \*$/, '').replace(/^"|"$/g, ''), CLI_PATH,
    `${rel}: the rule must name only ${CLI_PATH}`);
  assert.strictEqual(m[1].replace(/ \*$/, '').includes('"'), pair.execQuoted,
    `${rel}: the rule's quoting must be the pair of the exec line's quoting`);

  for (const p of programs) {
    assert.strictEqual(p.token, CLI_PATH,
      `${rel}: the exec line runs ${p.token}, which the rule does not name`);
    assert.strictEqual(p.wasQuoted, pair.execQuoted,
      `${rel}: exec line quoting (${p.wasQuoted ? 'quoted' : 'bare'}) does not pair with the ${ALLOWED_TOOLS} rule`);
  }
}

assert.ok(withExec >= 4, `expected at least four exec-carrying shims, found ${withExec}`);
console.log(`shim allowed-tools: ok (${withExec} exec-carrying file(s) pinned to ${ALLOWED_TOOLS})`);
