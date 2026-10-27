'use strict';
// Issue #136/#142, D2-a — the `--relay` exit waiver.
//
// `--relay` exists because a command shim's injected `!` exec is aborted by
// Claude Code on ANY non-zero exit, which would otherwise turn "the dashboard is
// not running" into an error banner. It waives the exit code and nothing else:
// the bytes stay identical, and every unflagged path keeps its contract.
//
// Every case runs the real CLI against a scratch CLAUDE_PLUGIN_DATA (never the
// owner's plugin data dir) with the relay preload, so nothing installs a
// dependency and nothing reaches a provider. The one case that starts a daemon
// stops it before it returns.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const records = require('../lib/dashboard/record');
const {
  CLI, PRELOAD, scratch, vl, record, note, cleanup, alive, until, sleep, dirs,
} = require('./helpers/dashboard-harness');

const RELAY_PRELOAD = path.join(__dirname, 'fixtures/relay-preload.cjs');
const TWO_PRELOADS = `--require=${PRELOAD} --require=${RELAY_PRELOAD}`;

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// Run the CLI and hand back the exit code plus the RAW bytes of both streams —
// the comparison below is byte-level on purpose, because "output identical" is
// the whole promise of the flag.
function raw(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir,
        NODE_OPTIONS: TWO_PRELOADS, LC_ALL: 'C', LANG: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = []; const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

// The pair every waived case must satisfy: same bytes on both streams, and the
// exit goes from the documented code to 0.
async function assertWaived(dir, args, unflaggedExit, label) {
  const plain = await raw(dir, args);
  const relay = await raw(dir, [...args, '--relay']);
  assert.strictEqual(plain.status, unflaggedExit, `${label}: unflagged exit ${plain.status}, stderr ${JSON.stringify(plain.stderr.toString())}`);
  assert.strictEqual(relay.status, 0, `${label}: --relay must exit 0, got ${relay.status}`);
  assert.deepStrictEqual(relay.stdout, plain.stdout, `${label}: stdout bytes changed with --relay`);
  assert.deepStrictEqual(relay.stderr, plain.stderr, `${label}: stderr bytes changed with --relay`);
  return plain;
}

// A JSON envelope carries its own generation time, so two runs are never
// byte-equal and that is not what the flag promises. Set the timestamps aside
// and the shape, the fields and the reason codes must not move.
const stripVolatile = (b) => b.toString()
  .replace(/"(generatedAt|observedAt|updatedAt|now|resetAt|freshUntil|startedAt|finishedAt)": "[^"]*"/g, '"$1": "-"')
  .replace(/"(uptimeSeconds|ageSeconds|observationAgeSeconds)": -?[0-9]+/g, '"$1": -');

// Same pair, for a JSON envelope.
async function assertWaivedJson(dir, args, unflaggedExit, label) {
  const plain = await raw(dir, args);
  const relay = await raw(dir, [...args, '--relay']);
  assert.strictEqual(plain.status, unflaggedExit, `${label}: unflagged exit ${plain.status}`);
  assert.strictEqual(relay.status, 0, `${label}: --relay must exit 0, got ${relay.status}`);
  assert.strictEqual(stripVolatile(relay.stdout), stripVolatile(plain.stdout), `${label}: the JSON envelope changed with --relay`);
  assert.deepStrictEqual(relay.stderr, plain.stderr, `${label}: stderr bytes changed with --relay`);
  assert.ok(plain.stdout.length > 0, `${label}: nothing was printed`);
  return plain;
}

function corruptConfig(dir) {
  fs.writeFileSync(path.join(dir, 'config.json'), '{"routes": [ this is not json');
}

console.log('relay: the waived commands');

// A configuration that cannot be read is refused rather than guessed at, and it
// is refused with exit 10 — the case the shim must still be able to report.
test('view — a refused configuration: 10 unflagged, 0 with --relay, bytes identical', async () => {
  const dir = scratch();
  corruptConfig(dir);
  await assertWaived(dir, ['view'], 10, 'view');
  const json = await assertWaivedJson(dir, ['view', '--json'], 10, 'view --json');
  assert.strictEqual(JSON.parse(json.stdout.toString()).routes.length, 0, 'the refusing envelope is still the valid one');
});

test('setup and update — the same refusal, waived', async () => {
  const dir = scratch();
  corruptConfig(dir);
  await assertWaived(dir, ['setup'], 10, 'setup');
  await assertWaived(dir, ['update'], 10, 'update');
});

test('dashboard status — nothing running: 3 unflagged, 0 with --relay', async () => {
  const dir = scratch();
  await assertWaived(dir, ['dashboard', 'status'], 3, 'dashboard status');
  await assertWaived(dir, ['dashboard', 'status', '--json'], 3, 'dashboard status --json');
});

test('dashboard stop — nothing running: 1 unflagged, 0 with --relay', async () => {
  const dir = scratch();
  await assertWaived(dir, ['dashboard', 'stop'], 1, 'dashboard stop');
});

test('dashboard open — a refusal starts nothing and is waived', async () => {
  const dir = scratch();
  const plain = await raw(dir, ['dashboard', 'open', '--host', '10.0.0.1']);
  assert.strictEqual(plain.status, 1);
  const relay = await raw(dir, ['dashboard', 'open', '--host', '10.0.0.1', '--relay']);
  assert.strictEqual(relay.status, 0);
  assert.deepStrictEqual(relay.stdout, plain.stdout);
  assert.deepStrictEqual(relay.stderr, plain.stderr);
  assert.ok(!fs.existsSync(records.recordPath(dir)), 'the waived refusal still started no daemon');
});

test('the flag is invisible to the parsers: order-free, and no unknown-option error', async () => {
  const dir = scratch();
  const a = await raw(dir, ['dashboard', 'status', '--relay', '--json']);
  const b = await raw(dir, ['dashboard', 'status', '--json', '--relay']);
  assert.strictEqual(a.stdout.toString().replace(/"generatedAt": "[^"]*"/, ''), b.stdout.toString().replace(/"generatedAt": "[^"]*"/, ''),
    '--relay before or after another flag reads the same');
  assert.strictEqual(a.status, 0); assert.strictEqual(b.status, 0);
  const corrupt = scratch();
  corruptConfig(corrupt);
  const plain = await raw(corrupt, ['dashboard', 'status', '--json']);
  assert.strictEqual(plain.status, 3);
  assert.strictEqual(stripVolatile(a.stdout), stripVolatile(plain.stdout), 'the same envelope the unflagged run prints, waived or not');
  const open = await raw(dir, ['dashboard', 'open', '--relay', '--no-open']);
  assert.strictEqual(open.status, 0, open.stderr.toString());
  note(dir);
  const rec = record(dir);
  assert.match(open.stdout.toString(), /^dashboard: running at http:\/\/127\.0\.0\.1:\d+\/\n$/, 'the launch still reports its address');
  const stopped = await raw(dir, ['dashboard', 'stop', '--relay']);
  assert.strictEqual(stopped.status, 0);
  await until(async () => !alive(rec.pid), 'the daemon from the waived open to stop');
});

console.log('relay: where the waiver is refused');

test('every other command refuses --relay with a usage exit, and does not run', async () => {
  const dir = scratch();
  corruptConfig(dir);
  const cases = [
    ['report', ['report']],
    ['status', ['status']],
    ['snapshot', ['snapshot', '--json']],
    ['config', ['config']],
    ['recommend', ['recommend', '--json']],
    ['provider', ['provider', 'list']],
    ['check', ['check', 'kimi-code-plan']],
    ['refresh', ['refresh', '--quiet']],
    ['session-start', ['session-start']],
    ['dashboard start', ['dashboard', 'start']],
    ['dashboard lan url', ['dashboard', 'lan', 'url']],
    ['dashboard start --relay position', ['dashboard', '--relay', 'start']],
  ];
  for (const [label, args] of cases) {
    const withFlag = await raw(dir, [...args, '--relay']);
    assert.strictEqual(withFlag.status, 2, `${label} --relay must be a usage refusal, got ${withFlag.status}`);
    const text = `${withFlag.stderr.toString()}${withFlag.stdout.toString()}`;
    assert.match(text, /^view-limits: --relay is the command-surface exit waiver only/, `${label}: the refusal must say what the flag is for`);
    assert.strictEqual(withFlag.stdout.length, 0, `${label}: nothing of the command may run`);
  }
  // The refusals ran no command: no cache was written and no daemon was started.
  assert.ok(!fs.existsSync(path.join(dir, 'status.json')), 'no refresh happened');
  assert.ok(!fs.existsSync(records.recordPath(dir)), 'no daemon was started');
  // `gate` reads a hook envelope on stdin; it refuses the flag the same way and
  // never reaches the gate.
  const gate = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'gate', '--relay'], {
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, NODE_OPTIONS: TWO_PRELOADS },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (status) => resolve({ status, err }));
    child.stdin.end('{}');
  });
  assert.strictEqual(gate.status, 2, 'gate refuses --relay too — its exit code is the hook contract');
  assert.match(gate.err, /command-surface exit waiver/);
});

test('the unflagged contract is untouched: the codes the gate and terminals rely on', async () => {
  const dir = scratch();
  const codes = await raw(dir, ['dashboard', 'status']);
  assert.strictEqual(codes.status, 3, 'dashboard status still exits 3 for the CLI');
  assert.strictEqual((await raw(dir, ['dashboard', 'bogus'])).status, 2, 'usage still exits 2');
  const unwaived = await raw(dir, ['gate']);
  assert.strictEqual(unwaived.status, 0, 'gate stays fail-open at exit 0 with no input');
});

console.log('relay: the daemon lifecycle through waived calls');

test('open → status → stop all with --relay really runs the lifecycle', async () => {
  const dir = scratch();
  const opened = await raw(dir, ['dashboard', 'open', '--no-open', '--relay']);
  assert.strictEqual(opened.status, 0, opened.stderr.toString());
  note(dir);
  const rec = record(dir);
  assert.ok(alive(rec.pid), 'the waived open started a live daemon');
  const stat = await raw(dir, ['dashboard', 'status', '--json', '--relay']);
  assert.strictEqual(stat.status, 0);
  assert.strictEqual(JSON.parse(stat.stdout.toString()).state, 'running');
  const stopped = await raw(dir, ['dashboard', 'stop', '--relay']);
  assert.strictEqual(stopped.status, 0);
  assert.match(stopped.stdout.toString(), /dashboard: stopped/);
  await until(async () => !alive(rec.pid), 'the waived stop to shut the daemon down');
  assert.strictEqual((await raw(dir, ['dashboard', 'status'])).status, 3, 'and the unflagged status confirms it');
});

// ---- runner ------------------------------------------------------------------

(async () => {
  try {
    for (const { name, fn } of cases) {
      try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
    }
  } finally {
    await cleanup();
  }
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log(`\nall relay-flag tests passed (${cases.length} cases)`);
  process.exit(0);
})();
