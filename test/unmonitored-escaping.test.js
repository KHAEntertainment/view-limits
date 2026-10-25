'use strict';
// #104 — the unmonitored block printed route ids raw.
//
// bin/vl.js's unmonitoredBlock(cfg) prints two kinds of line, and both
// interpolated the route id raw:
//
//     ${r.id}: unmonitored — no documented quota source
//     ${id}: unmonitored — kept by explicit choice (no usable quota signal at setup)
//
// The block reaches stdout through reportCmd (`vl report` and its alias
// `vl status`) and through refresh() (`vl refresh`). A control character in
// the id splits the line, and the remainder reads as an extra route row to
// the agent that parses this text before dispatching — the same forged-line
// shape #99 fixed for the route rows. The sibling failedRouteLines already
// escaped its id, and #99 escaped the route rows in the very same report.
//
// The id comes from the owner's own config.json, not from a provider
// response: `provider add` allocates ids through validateLabel
// (alphanumerics plus ._-), so a control character can only arrive from a
// hand-edited config. The threat model is weaker than #99's; the fix is the
// same one sanitizer.
//
// unmonitoredBlock is not exported, so this drives the real CLI with a
// scratch CLAUDE_PLUGIN_DATA and a hand-edited config.json. Nothing goes
// out: the stepfun-plan recipe documents no quota source and fetches
// locally, and the kept route holds no credential.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { RETENTION } = require('../lib/provider-lifecycle');

const cli = path.resolve(__dirname, '../bin/vl.js');
const MASTER_KEY = 'offline-unmonitored-escaping-test-key';

// The control characters the hostile id carries: a newline, a carriage
// return, ESC, ENQ, DEL, NEL and the C1 CSI. The last three are the ones a
// JSON-stringify escape leaves raw.
const CONTROLS = ['\n', '\r', '\x1b', '\x05', '\x7f', '\u0085', '\u009b'];

// The escaped form each of them must take. Spelled out here, NOT taken from
// the implementation under test: the test states the expected bytes.
const ESCAPED_FORMS = ['\\n', '\\r', '\\u001b', '\\u0005', '\\u007f', '\\u0085', '\\u009b'];

// No control character may reach stdout: the C0 range, DEL and the C1 range.
// The check runs per LINE, so the '\n' that separates the report's own lines
// is the only control character that is legitimately there.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

// The two hostile ids — one per line kind — and their escaped forms.
const HOSTILE_A = `evil-a${CONTROLS.join('')}FORGED: forged route`;
const HOSTILE_B = `evil-b${CONTROLS.join('')}FORGED: forged route`;
const ESCAPED_A = `evil-a${ESCAPED_FORMS.join('')}FORGED: forged route`;
const ESCAPED_B = `evil-b${ESCAPED_FORMS.join('')}FORGED: forged route`;

// The ordinary ids: their rendering must stay byte-identical to the pre-fix
// output, which is the raw id interpolated into the same template. They sort
// like the hostile ones (the route rows are sorted by id), so the two
// reports differ only in the id text.
const PLAIN_A = 'plain-a-stepfun';
const PLAIN_B = 'plain-b-kept';

const LINE_A = 'unmonitored — no documented quota source';
const LINE_B = 'unmonitored — kept by explicit choice (no usable quota signal at setup)';

// A scratch data dir holding a hand-edited config.json with one route per
// unmonitored line kind:
//   - a custom-monitored route whose recipe documents no quota source
//     (stepfun-plan): the "no documented quota source" line;
//   - a route the owner explicitly kept (#58) with a monitorable recipe:
//     the "kept by explicit choice" line.
function scratchConfig(idA, idB) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-unmonitored-escaping-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [
      {
        id: idA,
        provider: 'stepfun',
        match: { model: 'stepfun' },
        monitor: { recipe: 'stepfun-plan', endpoint: 'https://example.invalid/usage' },
      },
      {
        id: idB,
        provider: 'minimax',
        match: { model: 'minimax' },
        retention: RETENTION.KEEP,
      },
    ],
    vault: { backend: 'file', service: 'test' },
  }, null, 2));
  return dir;
}

function run(dir, args) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: dir, VIEW_LIMITS_MASTER_KEY: MASTER_KEY };
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr || String(r.error));
  assert.strictEqual(r.stderr, '', `unexpected stderr: ${r.stderr}`);
  return r.stdout;
}

// Every run gets a pristine scratch dir: `vl refresh` publishes a cache, and
// a cached observation changes the route rows.
function runFresh(idA, idB, args) {
  const dir = scratchConfig(idA, idB);
  try { return run(dir, args); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The unmonitored block's own lines: the ones that carry the unmonitored
// marker. The route rows never carry it.
function blockLines(stdout) {
  return stdout.split('\n').filter((l) => l.includes(': unmonitored — '));
}

// The generated-at stamp is wall-clock, so two runs a moment apart differ
// there and nowhere else.
function maskStamp(stdout) {
  return stdout.replace(
    /^view-limits runtime inventory — generated .* · completeness partial$/m,
    'view-limits runtime inventory — generated <stamp> · completeness partial',
  );
}

// Every hostile id must survive as its ESCAPED form on its own line: the
// line count must not change, no control character may appear anywhere in
// the output, and no line may be a forged continuation of a split id.
function assertEscaped(stdout, label, expectedLines) {
  // No control character may reach stdout. The report separates its own lines
  // with '\n', so the check runs per line: a '\n' inside a line is impossible,
  // and a '\r' (or any other control character) is caught.
  for (const line of stdout.split('\n')) {
    assert.ok(!CONTROL_RE.test(line),
      `${label}: a raw control character reached stdout: ${JSON.stringify(line)}`);
  }

  const block = blockLines(stdout);
  assert.strictEqual(block.length, expectedLines.length,
    `${label}: expected ${expectedLines.length} unmonitored lines, got ${block.length}:\n${stdout}`);
  for (const line of expectedLines) {
    assert.ok(stdout.includes(line), `${label}: missing the escaped line ${JSON.stringify(line)}:\n${stdout}`);
  }

  for (const line of stdout.split('\n')) {
    assert.ok(!line.startsWith('FORGED'),
      `${label}: a forged line was printed: ${JSON.stringify(line)}`);
  }
}

const hostileLines = [
  `    ${ESCAPED_A}: ${LINE_A}`,
  `    ${ESCAPED_B}: ${LINE_B}`,
];
// The pre-fix bytes for an ordinary id: the raw id in the same template.
const plainLines = [
  `    ${PLAIN_A}: ${LINE_A}`,
  `    ${PLAIN_B}: ${LINE_B}`,
];

// --- report / status / refresh: the hostile ids -----------------------------
// All three stdout paths that carry the block.
for (const args of [['report'], ['status'], ['refresh']]) {
  const label = `vl ${args[0]}`;
  const stdout = runFresh(HOSTILE_A, HOSTILE_B, args);
  assertEscaped(stdout, label, hostileLines);
}

// --- the line count must not change -----------------------------------------
// A raw newline in an id would split its line, so the report would grow a
// line per hostile id. The ordinary config has the same two routes and the
// same two unmonitored lines, so the line counts must match exactly.
const hostileReport = runFresh(HOSTILE_A, HOSTILE_B, ['report']);
const plainReport = runFresh(PLAIN_A, PLAIN_B, ['report']);
assert.strictEqual(hostileReport.split('\n').length, plainReport.split('\n').length,
  'the report line count changed with a hostile id');

// --- byte identity for an ordinary id ---------------------------------------
// The pre-fix rendering of an ordinary id is the raw id in the same
// template, so these exact lines ARE the pre-fix bytes. They must be
// reproduced unchanged.
assert.deepStrictEqual(blockLines(plainReport), plainLines,
  `the ordinary id no longer renders byte-identically:\n${plainReport}`);
assertEscaped(plainReport, 'vl report (ordinary ids)', plainLines);

// And nothing else in the report may move: the hostile report must be the
// ordinary report with the two ids replaced by their escaped forms — byte
// for byte, apart from the wall-clock stamp.
const hostileMasked = maskStamp(hostileReport);
const plainMasked = maskStamp(plainReport).split(PLAIN_A).join(ESCAPED_A).split(PLAIN_B).join(ESCAPED_B);
assert.strictEqual(hostileMasked, plainMasked,
  `the report differs beyond the escaped id text:\n${hostileMasked}\n---\n${plainMasked}`);

console.log('unmonitored route ids are escaped in report/status/refresh: PASS');
