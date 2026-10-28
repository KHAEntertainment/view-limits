'use strict';
// Issue #148 — the Codex and OpenCode command lines pass VIEW_LIMITS_DATA_DIR
// with a POSIX `${VAR:+...}` expansion. zsh, the macOS default shell, does not
// split an unquoted expansion into words, so the form
//
//     ${VIEW_LIMITS_DATA_DIR:+--data-dir "$VIEW_LIMITS_DATA_DIR"}
//
// reaches vl.js as ONE word, `--data-dir /path`, which the option parser then
// reads as the command. The shipped form is
//
//     ${VIEW_LIMITS_DATA_DIR:+--data-dir="$VIEW_LIMITS_DATA_DIR"}
//
// which is one word in every shell, and `--data-dir=<path>` is accepted by
// lib/config.js parseGlobalOptions.
//
// This runs every shipped command line (5 Codex skills, 5 OpenCode commands, the
// 2 Codex hook commands) through `sh -c` AND `zsh -c` against a stub bin/vl.js
// that records the argv it receives, with the data dir set to a path that
// contains a space. zsh absent: that half is skipped with a printed reason.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseGlobalOptions } = require('../lib/config');

const ROOT = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-shell-parity-'));
const stubRoot = path.join(scratch, 'root with space');
const out = path.join(scratch, 'argv.json');
fs.mkdirSync(path.join(stubRoot, 'bin'), { recursive: true });
fs.writeFileSync(path.join(stubRoot, 'bin', 'vl.js'),
  "require('fs').writeFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)));\n");
const dataDir = path.join(scratch, 'plugin data dir');

const NEW_FORM = '${VIEW_LIMITS_DATA_DIR:+--data-dir="$VIEW_LIMITS_DATA_DIR"}';
const OLD_FORM = '${VIEW_LIMITS_DATA_DIR:+--data-dir "$VIEW_LIMITS_DATA_DIR"}';

// Every command line the Codex and OpenCode surfaces ship, with where it is from.
function shippedCommands() {
  const found = [];
  const fence = (file) => {
    const m = [...fs.readFileSync(file, 'utf8').matchAll(/```sh\n([\s\S]*?)```/g)];
    assert.strictEqual(m.length, 1, `${file}: exactly one sh block`);
    return m[0][1].trim();
  };
  for (const d of fs.readdirSync(path.join(ROOT, 'harness', 'codex', 'skills')).sort()) {
    const f = path.join(ROOT, 'harness', 'codex', 'skills', d, 'SKILL.md');
    found.push([path.relative(ROOT, f), fence(f)]);
  }
  for (const n of fs.readdirSync(path.join(ROOT, 'harness', 'opencode', 'command')).sort()) {
    const f = path.join(ROOT, 'harness', 'opencode', 'command', n);
    found.push([path.relative(ROOT, f), fence(f)]);
  }
  const hooks = require('../harness/codex/hooks.json');
  for (const [event, groups] of Object.entries(hooks.hooks)) {
    for (const g of groups) for (const h of g.hooks) found.push([`harness/codex/hooks.json ${event}`, h.command]);
  }
  return found;
}

function argvVia(shell, command, env) {
  fs.rmSync(out, { force: true });
  const args = shell === 'zsh' ? ['-f', '-c', command] : ['-c', command];
  const r = spawnSync(shell, args, {
    env: { PATH: process.env.PATH, HOME: scratch, VIEW_LIMITS_ROOT: stubRoot, STUB_OUT: out, ...env },
    encoding: 'utf8', timeout: 20000,
  });
  assert.strictEqual(r.status, 0, `${shell}: ${command}\n${r.stderr}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

const shells = ['sh'];
const haveZsh = spawnSync('zsh', ['-f', '-c', 'true']).status === 0;
if (haveZsh) shells.push('zsh');
else console.log('  - zsh is not installed here: the zsh half of the parity test is skipped');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

const commands = shippedCommands();
console.log(`\ndata-dir shell parity — ${commands.length} shipped command lines x ${shells.join(' + ')}`);

test('every shipped command line carries the = form, once, and never the two-word form', () => {
  assert.ok(commands.length >= 12, `found ${commands.length}`);
  for (const [where, cmd] of commands) {
    assert.strictEqual(cmd.split(NEW_FORM).length, 2, `${where}: the = form exactly once`);
    assert.ok(!cmd.includes(OLD_FORM), `${where}: the two-word form splits differently in zsh`);
  }
});

for (const shell of shells) {
  test(`${shell}: VIEW_LIMITS_DATA_DIR with a space reaches vl.js as ONE --data-dir=<path> argument`, () => {
    for (const [where, cmd] of commands) {
      const argv = argvVia(shell, cmd, { VIEW_LIMITS_DATA_DIR: dataDir });
      assert.deepStrictEqual(argv.filter((a) => a.startsWith('--data-dir')), [`--data-dir=${dataDir}`], `${shell} ${where}: ${JSON.stringify(argv)}`);
      assert.ok(!argv.includes('--data-dir'), `${shell} ${where}: no bare --data-dir word`);
      const parsed = parseGlobalOptions(argv);
      assert.strictEqual(parsed.ok, true, `${shell} ${where}: ${parsed.message}`);
      assert.strictEqual(parsed.dataDir, dataDir, `${shell} ${where}: the parser resolves the same directory`);
      assert.ok(parsed.rest.length > 0 && !parsed.rest[0].startsWith('--'), `${shell} ${where}: the command follows the option: ${JSON.stringify(parsed.rest)}`);
      assert.strictEqual(parsed.claudePlugin, false, `${shell} ${where}: never --claude-plugin`);
    }
  });

  test(`${shell}: VIEW_LIMITS_DATA_DIR unset (or empty) passes no data-dir argument at all`, () => {
    for (const [where, cmd] of commands) {
      for (const env of [{}, { VIEW_LIMITS_DATA_DIR: '' }]) {
        const argv = argvVia(shell, cmd, env);
        assert.deepStrictEqual(argv.filter((a) => a.includes('data-dir')), [], `${shell} ${where}: ${JSON.stringify(argv)}`);
      }
    }
  });
}

if (haveZsh) {
  test('control: the old two-word form really is ONE word in zsh (and two in sh) — the bug this guards', () => {
    const [where, cmd] = commands[0];
    const old = cmd.replace(NEW_FORM, OLD_FORM);
    assert.notStrictEqual(old, cmd, where);
    const zsh = argvVia('zsh', old, { VIEW_LIMITS_DATA_DIR: dataDir });
    assert.strictEqual(zsh[0], `--data-dir ${dataDir}`, `zsh: ${JSON.stringify(zsh)}`);
    assert.strictEqual(parseGlobalOptions(zsh).rest[0], zsh[0], 'the parser would read that word as the command');
    const sh = argvVia('sh', old, { VIEW_LIMITS_DATA_DIR: dataDir });
    assert.deepStrictEqual(sh.slice(0, 2), ['--data-dir', dataDir]);
  });
}

fs.rmSync(scratch, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} shell parity test(s) failed`); process.exit(1); }
console.log('\ndata-dir shell parity: ok');
