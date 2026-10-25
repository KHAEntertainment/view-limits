'use strict';
// Guard test (Issue #59, fix batch 2): the view TEXT renderers may not
// interpolate a provider- or config-derived field directly.
//
// The scan is static: it reads lib/view-model.js, extracts the source of the
// renderers that build a rendered line, and checks every template
// interpolation and every string concatenation in them.
//
// The ALLOWED forms are named explicitly below. A value that reaches a
// rendered line must be, IN ITS ENTIRETY:
//   * textCell(...)        - the one sanitizer, at the text boundary, or
//   * a chained form        - padEnd(n), padStart(n), toUpperCase() or
//     repeat(n) on either the sanitizer's result or an escape-free string
//     literal, and only with the argument form each method permits (see
//     ALLOWED_CHAINS: a padEnd fill string, a concat/replace argument, or
//     any argument carrying a provider field would put that field back into
//     the cell unescaped),
//   * a numeric formatter   - barFor, formatCount, Math.round, Math.max,
//                             or a numeric toFixed expression, or
//   * a fixed-vocabulary lookup - ownLookup, whose result is one of a
//     fixed set of labels.
//
// One allowed form AND something else is NOT an allowed form. `textCell('') +
// route.stateReason` is not a sanitizer with a suffix - it is a
// concatenation whose right operand was never escaped.
//
// So the check PARSES the expression, with one string-, template- and
// comment-aware tokenizer, and requires that what it parses is exactly one
// of the forms above, with nothing left over. That matters because the
// earlier version of this guard matched a PREFIX: the regex that found the
// call ended at the first `)` it could balance, counting parentheses inside
// string literals as if they were syntax. So `textCell('(').concat(
// route.stateReason, ')')` read as ONE call and passed, while the text it
// produced carried a raw newline.
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
//
// KNOWN LIMITS (#101)
//
// The every-leaf behavioural test in test/view-schema.test.js is the proof
// of record: it drives the real renderers. This guard reads SOURCE TEXT, so
// it has lexical limits the behavioural test does not:
//
//   * R2-A1 - a regex literal desyncs collectInterpolations, functionSource
//     and tokenize: each scans the source with its own idea of where a
//     literal ends, so a regex can make them disagree.
//   * R2-A2 - a `/*` inside template text is read as a comment, so the
//     template is cut short at that marker.
//   * R2-Q1 - a `+=` inside a callback passed as a call argument is not
//     scanned: the concatenation scan looks at the call's own arguments.
//
// Filed as #101. The decision on them belongs to that issue.

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
const ALLOWED_CALLEES = new Set([
  'textCell',      // the one sanitizer
  'balanceText',   // the money cell, which sanitizes the currency
  'barFor',        // the numeric bar formatter
  'formatCount',   // the numeric count formatter
  'ownLookup',     // a fixed-vocabulary lookup
  'Math.round',    // a numeric formatter
  'Math.max',      // a numeric formatter
]);

// The methods that may be chained, and the argument form each must take.
//
// The argument is part of the rule, not a detail of it: a method allow-list
// on its own is not enough. `.padEnd(15, route.label)` writes its second
// argument (the fill string) into the cell, and `.concat(route.stateReason)`
// / `.replace(a, route.stateReason)` write theirs in directly - so padEnd
// and padStart take exactly ONE numeric-literal width and no fill string,
// toUpperCase takes no arguments, and repeat's count is an arithmetic
// expression over bare identifiers and numbers: never a member access, which
// is a provider field.
//
// These are exactly the methods lib/view-model.js chains on the scanned
// renderers today - padEnd/padStart/toUpperCase on textCell(...)
// (expandedRows:1345, renderViewText:1480/1495/1498) and padEnd/padStart/
// repeat on a string literal (renderViewText: header cells, barFor:1229).
// A method the source does not use, however harmless it looks, is not here.
const ALLOWED_CHAINS = new Map([
  ['padEnd', /^\d+$/],
  ['padStart', /^\d+$/],
  ['toUpperCase', /^$/],
  ['repeat', /^(?:[A-Za-z_$][\w$]*|\d+)(?:\s*[+\-*/%]\s*(?:[A-Za-z_$][\w$]*|\d+))*$/],
]);

// ---- the tokenizer --------------------------------------------------------
//
// One small scanner, aware of the three things a regex cannot see: strings,
// template literals, and comments. It yields the significant tokens of a
// region - a string or a template is ONE token, so a parenthesis inside one
// can never be mistaken for syntax.
//
// A token: { type, text, start, end, nlBefore }
//   type: 'name' | 'number' | 'string' | 'template' | 'regex' | 'punct'
//   nlBefore: a newline was crossed before this token.

// The operators, longest first, so `===` is one token and not three, and
// `?.` is not `.` followed by `?`.
const OPERATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', '?', ':',
  '(', ')', '[', ']', '{', '}', ',', ';', '.', '@', '#',
];

// After one of these a newline does NOT end the statement: the expression
// continues on the next line.
const CANNOT_START_A_STATEMENT = new Set([
  ')', ']', '}', '++', '--', '.', '?.', '?', ':',
  '&&', '||', '??', '+', '-', '*', '/', '%', '**',
  '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
  '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??=',
  '&=', '|=', '^=', '<<', '>>', '>>>', '<<=', '>>=', '>>>=',
  ',', '=>',
]);

// After one of these the expression is still incomplete - it needs a right
// operand - so a newline cannot end it either.
const NEEDS_OPERAND = new Set([
  '?', ':', '&&', '||', '??', '+', '-', '*', '/', '%', '**',
  '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
  '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??=',
  '&=', '|=', '^=', '<<', '>>', '>>>', '<<=', '>>=', '>>>=',
  ',', '.', '?.', '=>', '!',
]);

// A regex literal starting at the `/`. Returns the index just past it, or
// -1 if it is not one.
function skipRegex(source, i) {
  let j = i + 1;
  let inClass = false;
  while (j < source.length) {
    const c = source[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '[') { inClass = true; j += 1; continue; }
    if (c === ']') { inClass = false; j += 1; continue; }
    if (c === '\n') return -1;
    if (c === '/' && !inClass) { j += 1; break; }
    j += 1;
  }
  while (j < source.length && /[a-z]/i.test(source[j])) j += 1;
  return j;
}

// A numeric literal starting at `i`.
function scanNumber(source, i) {
  let j = i;
  if (source[j] === '0' && /[xXoObB]/.test(source[j + 1] || '')) {
    j += 2;
    while (j < source.length && /[0-9a-fA-F_]/.test(source[j])) j += 1;
    return j;
  }
  while (j < source.length && /[0-9_]/.test(source[j])) j += 1;
  if (source[j] === '.') {
    j += 1;
    while (j < source.length && /[0-9_]/.test(source[j])) j += 1;
  }
  if (/[eE]/.test(source[j] || '')) {
    let k = j + 1;
    if (/[+-]/.test(source[k] || '')) k += 1;
    if (/[0-9]/.test(source[k] || '')) {
      j = k;
      while (j < source.length && /[0-9_]/.test(source[j])) j += 1;
    }
  }
  return j;
}

// May a `/` here begin a regex literal? Only if the previous token could not
// have ended an expression - otherwise it is a division.
function regexAllowed(tokens) {
  const prev = tokens[tokens.length - 1];
  if (!prev) return true;
  if (prev.type === 'name' || prev.type === 'number' || prev.type === 'string'
    || prev.type === 'template' || prev.type === 'regex') return false;
  if (prev.type === 'punct' && (prev.text === ')' || prev.text === ']')) return false;
  return true;
}

// The significant tokens of `source` between `start` and `end`. Comments and
// whitespace are dropped; a newline before a token is recorded on it.
function tokenize(source, start = 0, end = source.length) {
  const tokens = [];
  let i = start;
  let nl = false;
  while (i < end) {
    const c = source[i];
    if (c === '\n') { nl = true; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i += 1; continue; }
    if (c === '/' && source[i + 1] === '/') { const e = source.indexOf('\n', i); i = e === -1 ? end : e; continue; }
    if (c === '/' && source[i + 1] === '*') {
      const e = source.indexOf('*/', i + 2);
      const stop = e === -1 ? end : e + 2;
      if (source.slice(i, stop).includes('\n')) nl = true;
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      const e = skipString(source, i);
      tokens.push({ type: 'string', text: source.slice(i, e), start: i, end: e, nlBefore: nl });
      nl = false;
      i = e;
      continue;
    }
    if (c === '`') {
      const e = skipTemplate(source, i);
      tokens.push({ type: 'template', text: source.slice(i, e), start: i, end: e, nlBefore: nl });
      nl = false;
      i = e;
      continue;
    }
    if (c === '/' && regexAllowed(tokens)) {
      const e = skipRegex(source, i);
      if (e !== -1) {
        tokens.push({ type: 'regex', text: source.slice(i, e), start: i, end: e, nlBefore: nl });
        nl = false;
        i = e;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const e = scanNumber(source, i);
      tokens.push({ type: 'number', text: source.slice(i, e), start: i, end: e, nlBefore: nl });
      nl = false;
      i = e;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let e = i + 1;
      while (e < end && /[\w$]/.test(source[e])) e += 1;
      tokens.push({ type: 'name', text: source.slice(i, e), start: i, end: e, nlBefore: nl });
      nl = false;
      i = e;
      continue;
    }
    let op = c;
    for (const cand of OPERATORS) {
      if (source.startsWith(cand, i) && i + cand.length <= end) { op = cand; break; }
    }
    tokens.push({ type: 'punct', text: op, start: i, end: i + op.length, nlBefore: nl });
    nl = false;
    i += op.length;
  }
  return tokens;
}

// The index of the `)` that closes the `(` at `open`, or -1.
function matchClose(tokens, open) {
  let depth = 0;
  for (let j = open; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.type !== 'punct') continue;
    if (t.text === '(' || t.text === '[' || t.text === '{') depth += 1;
    else if (t.text === ')' || t.text === ']' || t.text === '}') {
      depth -= 1;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// The chain that may follow a receiver: zero or more segments of
// '.' name '(' args ')'. Every segment must be a method ALLOWED_CHAINS lists,
// taking that method's argument form. Returns the index just past the
// chain, or -1 if a segment is not allowed.
function matchChain(tokens, i) {
  let j = i;
  while (j < tokens.length && tokens[j].type === 'punct' && tokens[j].text === '.') {
    const name = tokens[j + 1];
    if (!name || name.type !== 'name') return -1;
    const open = tokens[j + 2];
    if (!open || open.type !== 'punct' || open.text !== '(') return -1;
    const close = matchClose(tokens, j + 2);
    if (close === -1) return -1;
    const rule = ALLOWED_CHAINS.get(name.text);
    if (!rule) return -1;
    const args = tokens.slice(j + 3, close).map((t) => t.text).join(' ').trim();
    if (!rule.test(args)) return -1;
    j = close + 1;
  }
  return j;
}

// Is `tokens` exactly one allowed form? Nothing may be left over: an
// allowed form AND something else is not an allowed form.
function isAllowedTokens(tokens) {
  if (tokens.length === 0) return false;
  const first = tokens[0];

  // A string literal receiver: 'literal'.method(args). The literal must be
  // escape-free - a `\n` inside it would put a real newline in the cell.
  if (first.type === 'string') {
    if (/\\/.test(first.text)) return false;
    const end = matchChain(tokens, 1);
    return end !== -1 && end === tokens.length;
  }

  // A parenthesized expression followed by .toFixed(n): the numeric
  // formatter. `toFixed` coerces to a number, so it cannot carry text.
  if (first.type === 'punct' && first.text === '(') {
    const close = matchClose(tokens, 0);
    if (close === -1) return false;
    const dot = tokens[close + 1];
    const name = tokens[close + 2];
    const open = tokens[close + 3];
    if (!dot || dot.type !== 'punct' || dot.text !== '.') return false;
    if (!name || name.type !== 'name' || name.text !== 'toFixed') return false;
    if (!open || open.type !== 'punct' || open.text !== '(') return false;
    const close2 = matchClose(tokens, close + 3);
    if (close2 === -1 || close2 !== tokens.length - 1) return false;
    const digits = tokens.slice(close + 4, close2).map((t) => t.text).join('').trim();
    return /^\d+$/.test(digits);
  }

  // A call: name ['.' name] '(' args ')' [ chain ].
  if (first.type !== 'name') return false;
  let j = 1;
  let callee = first.text;
  if (tokens[j] && tokens[j].type === 'punct' && tokens[j].text === '.') {
    const prop = tokens[j + 1];
    if (!prop || prop.type !== 'name') return false;
    callee = `${first.text}.${prop.text}`;
    j += 2;
  }
  const open = tokens[j];
  if (!open || open.type !== 'punct' || open.text !== '(') return false;
  const close = matchClose(tokens, j);
  if (close === -1) return false;
  if (!ALLOWED_CALLEES.has(callee)) return false;
  const end = matchChain(tokens, close + 1);
  return end !== -1 && end === tokens.length;
}

// Is this expression exactly one allowed form?
function isAllowedExpression(expression) {
  return isAllowedTokens(tokenize(expression));
}

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
  let prev = '';
  while (j < source.length && depth > 0) {
    const c = source[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '/' && (source[j + 1] === '/' || source[j + 1] === '*')) { j = skipComment(source, j); continue; }
    if (c === "'" || c === '"') { j = skipString(source, j); prev = 'x'; continue; }
    if (c === '`') { j = skipTemplate(source, j); prev = 'x'; continue; }
    if (c === '/' && !/[\w$)\]'"]/.test(prev)) {
      const e = skipRegex(source, j);
      if (e !== -1) { j = e; prev = 'x'; continue; }
    }
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    if (!/\s/.test(c)) prev = c;
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

// The right-hand side of a concatenation: the WHOLE of it must be one
// allowed form.
//
// A numeric literal carries no text, so appending one cannot put a provider
// field into a cell: `counts[state] += 1;` is a counter, not rendered text.
function isAllowedOperand(tokens) {
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && tokens[0].type === 'number') return true;
  // A template literal, whole and nothing else - the interpolations inside
  // it are checked where the template was found.
  if (tokens.length === 1 && tokens[0].type === 'template') return true;
  return isAllowedTokens(tokens);
}

// Does the expression continue across a newline? It does when the next
// token cannot begin a statement, or when the expression so far still needs
// a right operand.
function continuesAfterNewline(prev, next) {
  if (prev && prev.type === 'punct' && NEEDS_OPERAND.has(prev.text)) return true;
  if (next.type === 'punct' && CANNOT_START_A_STATEMENT.has(next.text)) return true;
  return false;
}

// The tokens of the expression that follows a `+` / `+=`: to the true end
// of the statement.
//
// JavaScript does not end a statement at a newline when the next token
// cannot begin one (`&&`, `||`, `+`, `.`, ...) or when the expression is
// still incomplete. So the reader follows the expression, not the line.
function readRhs(tokens, start) {
  let depth = 0;
  let j = start;
  let prev = null;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t.type === 'punct') {
      if (t.text === '(' || t.text === '[') { depth += 1; j += 1; prev = t; continue; }
      if (t.text === ')' || t.text === ']') { depth -= 1; j += 1; prev = t; continue; }
      if (t.text === ';' && depth === 0) break;
    }
    if (depth === 0 && j > start && t.nlBefore && !continuesAfterNewline(prev, t)) break;
    prev = t;
    j += 1;
  }
  return tokens.slice(start, j);
}

// Every `+` / `+=` inside the function BODY that concatenates rendered text:
// at the body's top level, or in a nested block that is not a call's argument
// list.
//
// The depth is counted from the BODY's own opening brace. The function's
// braces ARE the body, not a parent of it: counting from them put every
// statement inside the function at depth >= 1, so no `+` was ever at depth 0
// and the check never fired on anything.
function topLevelConcatenations(tokens) {
  const out = [];
  let parenDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'punct') continue;
    if (t.text === '(' || t.text === '[') { parenDepth += 1; continue; }
    if (t.text === ')' || t.text === ']') { parenDepth -= 1; continue; }
    if (parenDepth !== 0) continue;
    if (t.text !== '+' && t.text !== '+=') continue;
    out.push({ append: t.text === '+=', tokens: readRhs(tokens, i + 1) });
  }
  return out;
}

// One function's source, by matching its braces. The BODY starts after the
// parameter list, which may carry braces of its own (a destructuring
// parameter or a default value) - taking the first `{` after the name would
// stop at those and scan nothing.
//
// Returns the function's text and the offset of the body's opening brace,
// so a scan that counts depth can count it from the body.
function functionSource(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
  assert.notStrictEqual(start, -1, `${name} must exist in the scanned source`);
  let p = start;
  while (p < source.length && source[p] !== '(') p += 1;
  let parenDepth = 1;
  p += 1;
  while (p < source.length && parenDepth > 0) {
    const c = source[p];
    if (c === '\\') { p += 2; continue; }
    if (c === "'" || c === '"') { p = skipString(source, p); continue; }
    if (c === '`') { p = skipTemplate(source, p); continue; }
    if (c === '(') parenDepth += 1;
    else if (c === ')') parenDepth -= 1;
    p += 1;
  }
  const open = source.indexOf('{', p);
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) { i = skipComment(source, i); continue; }
    if (c === "'" || c === '"') { i = skipString(source, i); continue; }
    if (c === '`') { i = skipTemplate(source, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return { text: source.slice(start, i + 1), bodyStart: open - start };
    }
    i += 1;
  }
  throw new Error(`${name}: unbalanced braces`);
}

// Every finding in `source`'s copy of the scanned renderers. Takes the source
// so the same checker can be run against the real file and against in-memory
// probes (Issue #92).
function findingsIn(source, names = SCANNED) {
  const findings = [];
  for (const name of names) {
    const { text, bodyStart } = functionSource(source, name);
    for (const expression of collectInterpolations(text)) {
      if (!expression) continue;
      if (!isAllowedExpression(expression)) {
        findings.push(`${name}: \${${expression}} is not an allowed form`);
      }
    }
    for (const { append, tokens } of topLevelConcatenations(tokenize(text, bodyStart))) {
      // A plain binary `+` is never allowed, and an `+=` must have a
      // right-hand side that is ONE allowed form.
      //
      // The `append` requirement is not incidental: this check only ever
      // looks at the RIGHT-HAND side, so a plain `+` would leave its LEFT
      // operand unchecked - `route.stateReason + ''` would pass with a raw
      // provider field on the left. Requiring `+=` closes that: a `+=` has
      // no left operand to smuggle a field through.
      //
      // And the whole right-hand side must be one allowed form. A prefix is
      // not enough: `1 /* c */ && route.stateReason` starts with a safe
      // numeric literal and still appends a raw provider field.
      if (!append || !isAllowedOperand(tokens)) {
        findings.push(`${name}: a string concatenation (${append ? '+=' : '+'}) is not an allowed form`);
      }
    }
  }
  return findings;
}

const findings = findingsIn(SOURCE);

assert.deepStrictEqual(findings, [],
  `the view text renderers interpolate a provider field directly:\n  ${findings.join('\n  ')}`);

// ---- probes (Issue #92) ----
//
// The checker runs on an in-memory renderer source exactly as it runs on the
// real file, so a form can be proved flagged (or proved still accepted)
// without touching lib/view-model.js.
function probeFindings(expression) {
  const source = [
    'function renderViewText(schema, opts = {}) {',
    '  return `' + '${' + expression + '}`;',
    '}',
    '',
  ].join('\n');
  return findingsIn(source, ['renderViewText']);
}

// Forms that must be FLAGGED: a provider field reaching the cell through a
// chain argument, through a chain method that is not listed, or not through
// a call at all.
const ESCAPES = [
  "textCell('').concat(route.stateReason)",
  "textCell('').replace(/x/, route.stateReason)",
  "textCell('').padEnd(3, route.stateReason)",
  "textCell('').padStart(3, route.stateReason)",
  "textCell('').toUpperCase().padEnd(3, route.stateReason)",
  // an ALLOWED method with a provider field in its argument must still fail
  "textCell('').repeat(route.stateReason)",
  // the literal base is no safer a place to hide one
  "'#'.concat(route.stateReason)",
  "'PROVIDER'.padEnd(15, route.stateReason)",
  "'PROVIDER\\nFAKE'.padEnd(15)",
  "textCell('').trim()",
  "textCell('').toLowerCase()",
  "textCell('') + route.stateReason",
  'route.stateReason',
  // A quoted paren hides the real closing paren of the call: the guard used
  // to balance parens without seeing the string, so the whole chain was
  // read as one call and accepted.
  "textCell('(').concat(route.stateReason, ')')",
  "textCell('(').padEnd(8, route.stateReason + ')')",
  "textCell('(') + route.stateReason + (')')",
  // The expression continues past a comment or a newline, so a prefix that
  // looks safe is not the whole expression.
  'textCell("") /* c */ || route.stateReason',
  'textCell("")\n|| route.stateReason',
];

// Forms lib/view-model.js actually uses: they must keep passing, so the
// restriction cannot be satisfied by banning chains outright.
const LEGIT_FORMS = [
  "textCell(pctLabel(w.remainingRatio)).padStart(3)",
  "textCell(provider).padEnd(15)",
  "textCell(cells.left).padStart(4)",
  "textCell(route.state || 'unknown').toUpperCase().padEnd(13)",
  "textCell(route.freshness || 'unknown').toUpperCase()",
  "textCell(row.label).padEnd(9)",
  "'PROVIDER'.padEnd(15)",
  "'LEFT'.padStart(4)",
  "'#'.repeat(filled)",
  "'-'.repeat(BAR_WIDTH - filled)",
  '(value / 1e9).toFixed(1)',
  'textCell(row.label)',
  'barFor(w.remainingRatio)',
  'ownLookup(map, key)',
];

for (const expression of ESCAPES) {
  const found = probeFindings(expression);
  assert.ok(found.length > 0,
    `this escape must be flagged: \${${expression}}\n  checker said: ${found.join('; ') || 'nothing'}`);
}
for (const expression of LEGIT_FORMS) {
  const found = probeFindings(expression);
  assert.deepStrictEqual(found, [],
    `this is a form lib/view-model.js uses and must keep passing: \${${expression}}`);
}

// ---- probes (Issue #96) ----
//
// The concatenation check is a DIFFERENT rule from the interpolation check:
// it looks at a `+` / `+=` STATEMENT in a renderer body, not at a `${...}`.
// So it gets its own probe, which injects a statement into a renderer body
// and asks the same checker about it.
function probeConcatFindings(statement) {
  const source = [
    'function renderViewText(schema, opts = {}) {',
    '  ' + statement,
    '  return "";',
    '}',
    '',
  ].join('\n');
  return findingsIn(source, ['renderViewText']);
}

// Statements that must be FLAGGED: a provider field concatenated straight
// into a rendered line, with a `+` or with an `+=`.
const CONCAT_ESCAPES = [
  "let value = 'a' + route.stateReason;",
  'value += route.stateReason;',
  "value += 'a' + route.stateReason;",
  // The right-hand side continues past a comment or a newline: the operand
  // is not the numeric literal it starts with.
  'value += 1 /* c */ && route.stateReason;',
  'value += 1\n&& route.stateReason;',
  // A template prefix with an unchecked suffix.
  'value += `safe`.concat(route.stateReason);',
  'value += `safe` && route.stateReason;',
  // A plain binary `+` is never allowed: the check only looks at the
  // right-hand side, so a raw provider field on the LEFT would slip through.
  "const line = route.stateReason + '';",
  "route.stateReason + textCell('')",
  'route.stateReason + `|`',
];
for (const statement of CONCAT_ESCAPES) {
  const found = probeConcatFindings(statement);
  assert.ok(found.some(f => f.includes('concatenation')),
    `this concatenation must be flagged: ${statement}\n  checker said: ${found.join('; ') || 'nothing'}`);
}

// Statements that must keep passing: the ones lib/view-model.js uses - the
// `value += \`...\`` that appends a rendered cell, and the `counts[state]
// += 1` that counts a state.
const CONCAT_LEGIT = [
  'counts[state] += 1;',
  'value += textCell(row.label);',
  'value += `${textCell(row.label)}`;',
];
for (const statement of CONCAT_LEGIT) {
  const found = probeConcatFindings(statement);
  assert.deepStrictEqual(found, [],
    `this is a concatenation lib/view-model.js uses and must keep passing: ${statement}`);
}

console.log(`view-text-guard: PASS (${ESCAPES.length} expression escapes flagged, ${LEGIT_FORMS.length} real forms accepted, ${CONCAT_ESCAPES.length} concatenation escapes flagged, ${CONCAT_LEGIT.length} real concatenations accepted)`);

module.exports = { findingsIn, isAllowedExpression };
