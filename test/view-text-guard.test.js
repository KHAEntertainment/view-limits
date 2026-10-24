'use strict';
// Guard test (Issue #59, fix batch 2): the view TEXT renderers may not
// interpolate a provider- or config-derived field directly.
//
// The scan is static: it reads lib/view-model.js, extracts the source of the
// renderers that build a rendered line, and checks every template
// interpolation and every string concatenation in them.
//
// The ALLOWED forms are named explicitly below. A value that reaches a
// rendered line must be
//   * textCell(...)        - the one sanitizer, at the text boundary, or
//   * a numeric formatter   - barFor, formatCount, Math.round, Math.max,
//                             or a numeric toFixed/repeat expression, or
//   * a fixed-vocabulary lookup - ownLookup, whose result is one of a
//                             fixed set of labels, or
//   * a bare local or an element access of one - a value that was already
//                             sanitized where it was produced.
//
// Anything else - `route.provider`, `w.type`, `balance.currency`, a
// template of a raw field - is a finding: it would put a provider string
// into the text unescaped, where a newline could fabricate a route line.
//
// This is a tripwire, not the proof: the exhaustive proof that every field
// is sanitized is the table-driven test in test/view-schema.test.js, which
// injects a control character into EVERY string field of the fixture and
// asserts both layouts keep their line count and never show the raw
// character. This guard catches the common mistake at the source level.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'view-model.js'), 'utf8');

// The renderers that build a rendered line, and the helpers they call.
const SCANNED = [
  'renderViewText',  // both layouts' line assembly
  'expandedRows',    // the expanded layout's rows
  'condensedRows',   // the condensed layout's rows
  'summaryLine',     // the summary line
  'viewNote',        // the note cell
  'formatResetAt',   // the reset cell
  'countsText',      // the raw counts cell
  'balanceText',     // the money cell
  'percentText',     // the percentage-only cell
  'withLastSeen',    // the last-seen suffix
  'barFor',          // the bar
  'formatCount',     // the count formatter
  'pctLabel',        // the percentage formatter
  'windowLabel',     // the window label
  'providerLabel',   // the display name
];

// The allowed interpolation forms, named explicitly.
//
// The rule is on the WHOLE expression, not on a prefix: an operand is
// allowed only when the expression IS one of these forms. A bare local is
// NOT allowed - a provider string bound to a local first would slip through
// - and neither is a `+` composite (`textCell('') + route.stateReason`).
const ALLOWED = [
  [/^textCell\([\s\S]*\)(?:\.(?:padEnd|padStart|toUpperCase|repeat)\([\s\S]*\))?$/, 'the one sanitizer'],
  [/^balanceText\([\s\S]*\)(?:\.(?:padEnd|padStart|toUpperCase)\([\s\S]*\))?$/, 'the money cell, which sanitizes the currency'],
  [/^barFor\([\s\S]*\)(?:\.(?:padEnd|padStart)\([\s\S]*\))?$/, 'the numeric bar formatter'],
  [/^formatCount\([\s\S]*\)(?:\.(?:padEnd|padStart)\([\s\S]*\))?$/, 'the numeric count formatter'],
  [/^Math\.(?:round|max)\([\s\S]*\)(?:\.(?:padEnd|padStart|toFixed)\([\s\S]*\))?$/, 'a numeric formatter'],
  [/^ownLookup\([\s\S]*\)(?:\.(?:padEnd|padStart)\([\s\S]*\))?$/, 'a fixed-vocabulary lookup'],
  [/^'[^']*'\.(?:repeat|padEnd|padStart)\([\s\S]*\)$/, 'a fixed literal'],
  [/^\([\s\S]*\)\.toFixed\(\d\)$/, 'a numeric formatter'],
];

// Skip a line or block comment starting at `i` (which is the first `/`).
// Returns the index just past it.
function skipComment(source, i) {
  if (source[i + 1] === '/') {
    const end = source.indexOf('\n', i);
    return end === -1 ? source.length : end + 1;
  }
  const end = source.indexOf('*/', i);
  return end === -1 ? source.length : end + 2;
}

// Skip a quoted string starting at `i` (which is the quote). Returns the
// index just past it.
function skipString(source, i) {
  const quote = source[i];
  i += 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

// Read a `${ ... }` expression body starting at `i` (the `{`). The braces
// are balanced; the strings and the nested templates inside are skipped.
function readExpression(source, i) {
  let depth = 1;
  let j = i + 1;
  while (j < source.length && depth > 0) {
    const c = source[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '/' && (source[j + 1] === '/' || source[j + 1] === '*')) { j = skipComment(source, j); continue; }
    if (c === "'" || c === '"') { j = skipString(source, j); continue; }
    if (c === '`') { j = skipTemplate(source, j); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    j += 1;
  }
  return { expression: source.slice(i + 1, j - 1).trim(), end: j };
}

// Skip a template literal starting at `i` (the backtick), including any
// `${ ... }` expression inside it. Returns the index just past it.
function skipTemplate(source, i) {
  let j = i + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '/' && (source[j + 1] === '/' || source[j + 1] === '*')) { j = skipComment(source, j); continue; }
    if (c === '`') return j + 1;
    if (c === '$' && source[j + 1] === '{') { j = readExpression(source, j + 1).end; continue; }
    j += 1;
  }
  return j;
}

// Every `${...}` expression in a source, including the ones nested in a
// template inside another expression.
function collectInterpolations(source, out = []) {
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) { i = skipComment(source, i); continue; }
    if (c === "'" || c === '"') { i = skipString(source, i); continue; }
    if (c === '`') {
      // Walk the template so its own expressions are collected.
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '/' && (source[j + 1] === '/' || source[j + 1] === '*')) { j = skipComment(source, j); continue; }
        if (source[j] === '`') break;
        if (source[j] === '$' && source[j + 1] === '{') {
          const expr = readExpression(source, j + 1);
          out.push(expr.expression);
          collectInterpolations(expr.expression, out);
          j = expr.end;
          continue;
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

// Every `+` that is not inside a call's parentheses: a concatenation of
// rendered text.
function topLevelConcatenations(source) {
  const out = [];
  let i = 0;
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) { i = skipComment(source, i); continue; }
    if (c === "'" || c === '"') { i = skipString(source, i); continue; }
    if (c === '`') { i = skipTemplate(source, i); continue; }
    if (c === '(' || c === '[' || c === '{') { depth += 1; i += 1; continue; }
    if (c === ')' || c === ']' || c === '}') { depth -= 1; i += 1; continue; }
    if (c === '+' && depth === 0) {
      const append = source[i + 1] === '=';
      out.push({ append, rest: source.slice(i + (append ? 2 : 1)).split('\n')[0].trim() });
      i += append ? 2 : 1;
      continue;
    }
    i += 1;
  }
  return out;
}

// One function's source, by matching its braces. The BODY starts after the
// parameter list, which may carry braces of its own (a destructuring
// parameter or a default value) - taking the first `{` after the name would
// stop at those and scan nothing.
function functionSource(name) {
  const start = SOURCE.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.notStrictEqual(start, -1, `${name} must exist in lib/view-model.js`);
  let p = start;
  while (p < SOURCE.length && SOURCE[p] !== '(') p += 1;
  let parenDepth = 1;
  p += 1;
  while (p < SOURCE.length && parenDepth > 0) {
    const c = SOURCE[p];
    if (c === '\\') { p += 2; continue; }
    if (c === "'" || c === '"') { p = skipString(SOURCE, p); continue; }
    if (c === '`') { p = skipTemplate(SOURCE, p); continue; }
    if (c === '(') parenDepth += 1;
    else if (c === ')') parenDepth -= 1;
    p += 1;
  }
  const open = SOURCE.indexOf('{', p);
  let depth = 0;
  let i = open;
  while (i < SOURCE.length) {
    const c = SOURCE[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '/' && (SOURCE[i + 1] === '/' || SOURCE[i + 1] === '*')) { i = skipComment(SOURCE, i); continue; }
    if (c === "'" || c === '"') { i = skipString(SOURCE, i); continue; }
    if (c === '`') { i = skipTemplate(SOURCE, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
    i += 1;
  }
  throw new Error(`${name}: unbalanced braces`);
}

const findings = [];

for (const name of SCANNED) {
  const source = functionSource(name);
  for (const expression of collectInterpolations(source)) {
    if (!expression) continue;
    if (!ALLOWED.some(([re]) => re.test(expression))) {
      findings.push(`${name}: \${${expression}} is not an allowed form`);
    }
  }
  for (const { append, rest } of topLevelConcatenations(source)) {
    // Every operand of a concatenation must itself be an allowed form: a
    // template literal (whose own interpolations are checked above), an
    // allowed call, or a fixed literal. A bare local is not - and neither is
    // a `+` composite, whose right operand would escape the sanitizer.
    const operand = rest.startsWith('`') ? '`a template`' : rest;
    const ok = append
      && (rest.startsWith('`') || ALLOWED.some(([re]) => re.test(operand)))
      && !/\+/.test(operand);
    if (!ok) {
      findings.push(`${name}: a string concatenation (${append ? '+=' : '+'}) is not an allowed form`);
    }
  }
}

assert.deepStrictEqual(findings, [],
  `the view text renderers interpolate a provider field directly:\n  ${findings.join('\n  ')}`);

console.log('view-text-guard: PASS');
