'use strict';
// Issue #148 — the global `--data-dir` / `--claude-plugin` options.
//
// Claude Code exports CLAUDE_PLUGIN_DATA to hooks but not to the environment of
// a `!` exec line, so the command shims pass it as an argument. This pins:
//   * the option wins over the environment, for the whole process;
//   * it is inherited by anything vl.js spawns (the dashboard daemon, `serve`),
//     which take no flag of their own;
//   * a value that is missing, empty, relative, or still carries a `$` is a
//     usage error that reads and writes NOTHING;
//   * `--relay` still gets the line to the person instead of an aborted shim.
//
// Every run uses a scratch HOME and scratch data dirs. Nothing real is read.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'vl.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-dd-flag-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

function run(argv, env = {}) {
  const base = { PATH: process.env.PATH, HOME: home };
  return spawnSync(process.execPath, [CLI, ...argv], { env: { ...base, ...env }, encoding: 'utf8', timeout: 20000 });
}
const scratch = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
const configuredDir = (name) => {
  const d = scratch(name);
  fs.writeFileSync(path.join(d, 'config.json'), '{"routes":[]}\n');
  return d;
};
const dataDirOf = (r) => JSON.parse(r.stdout).dataDir;
const entries = (d) => fs.readdirSync(d).sort();

console.log('\n--data-dir — which directory the process uses');

test('the option names the data directory', () => {
  const b = configuredDir('b');
  const r = run(['--data-dir', b, 'config']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(dataDirOf(r), b);
});

test('--data-dir=<path> is the same option', () => {
  const b = configuredDir('b2');
  assert.strictEqual(dataDirOf(run([`--data-dir=${b}`, 'config'])), b);
});

test('it wins over a CLAUDE_PLUGIN_DATA the session already carries (another plugin\'s dir)', () => {
  const other = configuredDir('other-plugin');
  const mine = configuredDir('mine');
  const r = run(['--data-dir', mine, 'config'], { CLAUDE_PLUGIN_DATA: other });
  assert.strictEqual(dataDirOf(r), mine);
  assert.deepStrictEqual(entries(other), ['config.json'], 'the other plugin\'s dir is not touched');
});

test('without it the environment and the ~/.view-limits fallback are unchanged', () => {
  const env = configuredDir('env');
  assert.strictEqual(dataDirOf(run(['config'], { CLAUDE_PLUGIN_DATA: env })), env);
  const fallback = path.join(home, '.view-limits');
  fs.mkdirSync(fallback);
  fs.writeFileSync(path.join(fallback, 'config.json'), '{"routes":[]}\n');
  assert.strictEqual(dataDirOf(run(['config'])), fallback);
  fs.rmSync(fallback, { recursive: true });
});

test('a trailing slash and dot segments are normalised, not refused', () => {
  const b = configuredDir('norm');
  assert.strictEqual(dataDirOf(run(['--data-dir', `${b}/sub/..`, 'config'])), b);
});

test('the directory reaches everything vl.js spawns (the environment they inherit)', () => {
  const b = configuredDir('inherit');
  const probe = path.join(root, 'inherit-probe.cjs');
  const out = path.join(root, 'inherit-out.txt');
  fs.writeFileSync(probe, `process.on('exit', () => require('fs').writeFileSync(${JSON.stringify(out)}, String(process.env.CLAUDE_PLUGIN_DATA)));`);
  const r = run(['--data-dir', b, 'config'], { CLAUDE_PLUGIN_DATA: scratch('stale'), NODE_OPTIONS: `--require=${probe}` });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), b, 'a spawned child inherits CLAUDE_PLUGIN_DATA = the option, not the stale one');
});

console.log('\n--data-dir — fail closed, nothing read or written');

const REFUSED = [
  ['an empty value', ['--data-dir', '', 'config']],
  ['a blank value', ['--data-dir', '   ', 'config']],
  ['a relative path', ['--data-dir', 'relative/dir', 'config']],
  ['a dot-relative path', ['--data-dir', './x', 'config']],
  ['an unexpanded ${CLAUDE_PLUGIN_DATA}', ['--data-dir', '${CLAUDE_PLUGIN_DATA}', 'config']],
  ['an unexpanded $VAR', ['--data-dir', '$HOME/x', 'config']],
  ['a $ in the middle of an absolute path', ['--data-dir', '/tmp/a$b', 'config']],
  ['a missing value', ['--data-dir']],
  ['the option repeated', ['--data-dir', '/tmp/a', '--data-dir', '/tmp/b', 'config']],
  ['--claude-plugin repeated', ['--claude-plugin', '--claude-plugin', 'config']],
];
for (const [name, argv] of REFUSED) {
  test(`refuses ${name}: exit 2, a usage line, no files`, () => {
    const watch = scratch('watch-' + name.replace(/\W+/g, '-'));
    const r = run(argv, { CLAUDE_PLUGIN_DATA: watch });
    assert.strictEqual(r.status, 2, `exit ${r.status}; stdout=${r.stdout}`);
    assert.match(r.stderr, /^view-limits: .*nothing was read or written\./m);
    assert.strictEqual(r.stdout, '', 'nothing was dispatched');
    assert.deepStrictEqual(entries(watch), [], 'the environment\'s directory was not created into');
    assert.deepStrictEqual(entries(home), [], 'the fallback directory was not created');
  });
}

test('--claude-plugin with no --data-dir and no usable CLAUDE_PLUGIN_DATA refuses', () => {
  const r = run(['--claude-plugin', 'config']);
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /needs a plugin data directory/);
  assert.deepStrictEqual(entries(home), []);
});

test('--claude-plugin takes the hook\'s CLAUDE_PLUGIN_DATA when there is no --data-dir', () => {
  const d = configuredDir('hook');
  const r = run(['--claude-plugin', 'config'], { CLAUDE_PLUGIN_DATA: d });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(dataDirOf(r), d);
});

test('the options are leading only: after the subcommand they are not options', () => {
  const b = configuredDir('late');
  const env = configuredDir('late-env');
  const r = run(['config', '--data-dir', b], { CLAUDE_PLUGIN_DATA: env });
  assert.strictEqual(dataDirOf(r), env, 'the late flag did not move the directory');
});

test('under --relay the refusal reaches the person: same line, exit 0', () => {
  const r = run(['--data-dir', '${CLAUDE_PLUGIN_DATA}', '--claude-plugin', 'view', '--relay']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /unexpanded \$ reference/);
  assert.deepStrictEqual(entries(home), []);
});

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} data-dir flag test(s) failed`); process.exit(1); }
console.log('\ndata-dir flag: ok');
