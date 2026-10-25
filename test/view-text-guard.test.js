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
//   * a chained form        - padEnd(n), padStart(n), toUpperCase() or
//     repeat(n) on either the sanitizer's result or an escape-free string
//     literal, and only with the argument form each method permits (see
//     ALLOWED_CHAINS: a padEnd fill string, a concat/replace argument, or
//     any argument carrying a provider field would put that field back into
//     the cell unescaped),
//   * a numeric formatter   - barFor, formatCount, Math.round, Math.max,
//                             or a numeric toFixed expression, or
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
const ALLOWED_CALLEES = new Set([
  'textCell',      // the one sanitizer
  'balanceText',   // the money cell, which sanitizes the currency
  'barFor',        // the numeric bar formatter
  'formatCount',   // the numeric count formatter
  'ownLookup',     // a fixed-vocabulary lookup
  'Math.round',    // a numeric formatter
  'Math.max',      // a numeric formatter
]);

// The expression must be EXACTLY one call: the argument list is matched with
// BALANCED parentheses and the rest must be empty or a method chain, which is
// captured so every segment of it can be checked against ALLOWED_CHAINS. A
// greedy pattern would accept `textCell('') + String(x)`, whose right
// operand escapes the sanitizer.
const ONE_CALL = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\((?:[^()]|\([^()]*\))*\)((?:\.[A-Za-z_$][\w$]*\((?:[^()]|\([^()]*\))*\))*)$/;

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

// A string literal may be the receiver of a chain: its output starts from a
// fixed, escape-free value (a `\n` escape in the literal would put a real
// newline in it, so backslashes are out), and then only through a method
// ALLOWED_CHAINS lists, with that method's argument form.
const LITERAL_CALL = /^'(?:[^'\\]*)'\.([A-Za-z_$][\w$]*)\(((?:[^()]|\([^()]*\))*)\)$/;
const NUMERIC_CALL = /^\([^()]*\)\.toFixed\(\d\)$/;

// Every segment of a captured chain must be a listed method taking its
// listed argument form, and the segments must cover the whole suffix.
function chainAllowed(suffix) {
  const segment = /\.([A-Za-z_$][\w$]*)\(((?:[^()]|\([^()]*\))*)\)/g;
  let cursor = 0;
  let match = segment.exec(suffix);
  while (match !== null) {
    if (match.index !== cursor) return false;
    cursor = segment.lastIndex;
    const rule = ALLOWED_CHAINS.get(match[1]);
    if (!rule || !rule.test(match[2].trim())) return false;
    match = segment.exec(suffix);
  }
  return cursor === suffix.length;
}

function isAllowedExpression(expression) {
  const literal = LITERAL_CALL.exec(expression);
  if (literal) {
    const rule = ALLOWED_CHAINS.get(literal[1]);
    return !!rule && rule.test(literal[2].trim());
  }
  if (NUMERIC_CALL.test(expression)) return true;
  const call = ONE_CALL.exec(expression);
  if (!call || !ALLOWED_CALLEES.has(call[1])) return false;
  return chainAllowed(call[2]);
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
      if (depth === 0) return source.slice(start, i + 1);
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
    const body = functionSource(source, name);
    for (const expression of collectInterpolations(body)) {
      if (!expression) continue;
      if (!isAllowedExpression(expression)) {
        findings.push(`${name}: \${${expression}} is not an allowed form`);
      }
    }
    for (const { append, rest } of topLevelConcatenations(body)) {
      // Every operand of a concatenation must itself be an allowed form: a
      // template literal (whose own interpolations are checked above), an
      // allowed call, or a fixed literal. A bare local is not - and neither is
      // a `+` composite, whose right operand would escape the sanitizer.
      const operand = rest.startsWith('`') ? '`a template`' : rest;
      const ok = append
        && (rest.startsWith('`') || isAllowedExpression(operand))
        && !/\+/.test(operand);
      if (!ok) {
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

console.log(`view-text-guard: PASS (${ESCAPES.length} escapes flagged, ${LEGIT_FORMS.length} real forms accepted)`);

module.exports = { findingsIn, isAllowedExpression };
