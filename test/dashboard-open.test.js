'use strict';
// Issue #136 — `vl.js dashboard open`, the browser opener, and the three
// argument-free verbs (Q34-A) the Claude command files call.
// opener, run through the real CLI against a scratch CLAUDE_PLUGIN_DATA.
//
// The opener is a STUB, always, and the stubbing is hermetic: every name the
// opener can be asked for on ANY platform (`open`, `xdg-open`, `cmd`,
// `cmd.exe`) is written into the stub dir, and the run's PATH is that dir plus
// a dir holding `ps` — nothing else. A host `xdg-open` on a Linux box, or the
// real `open` on macOS, is therefore unreachable rather than merely shadowed,
// so no case can pass by launching the owner's browser. Each stub records the
// argv it was handed and the name it answered as, which is how the cases prove
// the capture came from the stub. Every daemon this file starts lives in a
// scratch data directory and is stopped (or killed) in `cleanup`.
//
// What the cases hold the surface to:
//   start-or-reuse with the same rules as `dashboard start` (C-002 verification,
//   stale recovery, the existing refusals), one loopback URL to the opener and
//   nothing else — never the LAN link, the LAN read token or the control nonce,
//   an opener that is an argv array on every platform, a failing opener that is
//   still exit 0 with the daemon running, `--no-open`, and the slash mapper's
//   three shapes plus its refusals.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const daemonLib = require('../lib/dashboard/daemon');
const lanLib = require('../lib/dashboard/lan');
const {
  PRELOAD, records, identity, scratch, vl, record, note, cleanup, alive, until,
  forgeTicket, liveStranger, tickets, started, dirs,
} = require('./helpers/dashboard-harness');

const PLATFORM_SHIM = path.join(__dirname, 'fixtures/platform-as.cjs');
const PS_BLIND = path.join(__dirname, 'fixtures/ps-blind.cjs');
const RUNNING_RE = /^dashboard: running at (http:\/\/[^\s]+)\n$/;

// `ps` is the one external the dashboard's identity read needs besides the
// opener, so the stub PATH always carries it.
const PS_PATH = (() => {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    if (d && fs.existsSync(path.join(d, 'ps'))) return path.join(d, 'ps');
  }
  throw new Error('no ps on PATH — the dashboard identity read cannot run here');
})();

let failures = 0;
const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// ---- the opener stub ---------------------------------------------------------

// Every file name the opener can be asked for, per platform, as bin/vl.js
// picks it. Windows is listed with both `cmd` and the `cmd.exe` Node resolves
// it to, because that resolution happens below our code and a stub answering as
// `cmd.exe` is still the stub.
const OPENER_FILES = {
  darwin: ['open'],
  linux: ['xdg-open'],
  freebsd: ['xdg-open'],
  win32: ['cmd', 'cmd.exe'],
};
// Every platform's files, so a run can never reach a host binary whatever the
// host or the shimmed platform turns out to be.
const ALL_OPENER_FILES = ['open', 'xdg-open', 'cmd', 'cmd.exe'];
const openerFilesFor = (platform) => OPENER_FILES[platform] || ['xdg-open'];

// A stub opener: records the argv it was handed, one element per line, then a
// marker naming WHICH stub answered. `$0` is what the CLI resolved, so the
// marker also shows the platform's own lookup; nothing but the stub can write
// this file, which is what makes "the capture exists" a proof no real browser
// was asked.
function stubScript(target, exitCode) {
  fs.writeFileSync(target,
    '#!/bin/sh\n'
    + 'name="${0##*/}"\n'
    + 'for a in "$@"; do printf "ARG:%s\\n" "$a" >> "$CAPTURE"; done\n'
    + 'printf "STUB:%s\\n" "$name" >> "$CAPTURE"\n'
    + `exit ${exitCode}\n`,
    { mode: 0o755 });
}

// The environment for ONE CLI run. PATH holds the stub dir and a dir with `ps`
// (the one external the dashboard's identity read needs) and NOTHING ELSE: no
// host PATH, so no real `open`, `xdg-open` or `cmd` is reachable on any
// platform, and the case cannot pass by launching the owner's browser. `bin/vl
// .js` is run by absolute path and the daemon spawns node the same way, so
// nothing else needs lookup. `withOpener: false` is the missing-binary case: no
// stub at all, still only `ps` reachable.
function stubbed(dir, { openers = ALL_OPENER_FILES, exitCode = 0, withOpener = true, platform = null, blindPid = null } = {}) {
  const bin = path.join(dir, 'stub-bin');
  const tools = path.join(dir, 'stub-tools');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(tools, { recursive: true });
  if (!fs.existsSync(path.join(tools, 'ps'))) fs.symlinkSync(PS_PATH, path.join(tools, 'ps'));
  const capture = path.join(dir, 'opener-argv.txt');
  // One case, one capture: start from empty, so "no lines" means "never ran".
  if (fs.existsSync(capture)) fs.truncateSync(capture);
  if (withOpener) {
    assert.ok(!openers.some((n) => !ALL_OPENER_FILES.includes(n)), `unknown opener name stubbed: ${openers.join(', ')}`);
    for (const name of openers) stubScript(path.join(bin, name), exitCode);
  }
  const env = { PATH: withOpener ? `${bin}${path.delimiter}${tools}` : tools, CAPTURE: capture };
  const preloads = [PRELOAD];
  if (platform) { env.VL_TEST_PLATFORM = platform; preloads.push(PLATFORM_SHIM); }
  if (blindPid) { env.VL_PS_BLIND_PID = String(blindPid); preloads.push(PS_BLIND); }
  if (preloads.length > 1) env.NODE_OPTIONS = preloads.map((f) => `--require=${f}`).join(' ');
  return { env, capture, bin, tools };
}

// What the stubs were handed: one entry per opener invocation, each naming the
// stub that ran and its full argv as separate elements. `null` when nothing ran.
function captures(file) {
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
  const runs = [];
  let cur = [];
  for (const line of lines) {
    if (line.startsWith('STUB:')) {
      runs.push({ name: line.slice(5), argv: cur });
      cur = [];
      continue;
    }
    assert.ok(line.startsWith('ARG:'), `unexpected stub line: ${line}`);
    cur.push(line.slice(4));
  }
  assert.deepStrictEqual(cur, [], 'an opener run without its STUB marker');
  return runs;
}

// The one entry a case expects: the platform's own stub, handed exactly `argv`.
function assertOneRun(runs, platform, argv, msg) {
  assert.strictEqual(runs.length, 1, `${msg}: expected one opener call, got ${JSON.stringify(runs)}`);
  assert.ok(openerFilesFor(platform || process.platform).includes(runs[0].name),
    `${msg}: the stub that answered (${runs[0].name}) is not this platform's opener (${openerFilesFor(platform || process.platform).join(' or ')})`);
  assert.deepStrictEqual(runs[0].argv, argv, msg);
  return runs[0];
}

// The loopback page URL of the recorded daemon, exactly as lib computes it.
function loopbackUrl(rec) { return daemonLib.urlFor(rec.host, rec.port); }

// ---- cases -------------------------------------------------------------------

console.log('open: start-or-reuse');

test('nothing running → starts the daemon, prints only the running line, opens exactly that URL', async () => {
  const dir = scratch();
  const { env, capture } = stubbed(dir);
  const res = await vl(dir, ['dashboard', 'open'], { env });
  assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
  const m = res.stdout.match(RUNNING_RE);
  assert.ok(m, `expected exactly one running line, got: ${JSON.stringify(res.stdout)}`);
  note(dir);
  const rec = record(dir);
  assert.strictEqual(m[1], loopbackUrl(rec), 'the printed address is the record\'s URL');
  assert.strictEqual(rec.host, '127.0.0.1');
  assert.ok(alive(rec.pid), 'the daemon is running');
  const runs = captures(capture);
  assertOneRun(runs, null, [m[1]], 'the opener is handed the URL and nothing else — one argv element, no shell string');
  assert.ok(!runs[0].argv[0].includes(rec.nonce), 'the control nonce is not in the URL');
});

test('already running → reused: same pid, same instance, one ownership ticket, opened again', async () => {
  const dir = scratch();
  const a = stubbed(dir);
  const first = await vl(dir, ['dashboard', 'open'], { env: a.env });
  const rec = record(dir);
  note(dir);
  const before = captures(a.capture);
  assert.strictEqual(before.length, 1, 'first run opened once');

  const b = stubbed(dir);
  const second = await vl(dir, ['dashboard', 'open'], { env: b.env });
  assert.strictEqual(second.status, 0, second.stderr);
  assert.strictEqual(second.stdout, first.stdout, 'the same address, printed the same way');
  const after = record(dir);
  assert.strictEqual(after.pid, rec.pid, 'no new daemon');
  assert.strictEqual(after.instanceId, rec.instanceId, 'the same instance');
  assert.strictEqual(tickets(dir).length, 1, 'nothing took a second ownership ticket');
  assertOneRun(captures(b.capture), null, [first.stdout.match(RUNNING_RE)[1]],
    'the reuse still hands the browser the address');

  const json = JSON.parse((await vl(dir, ['dashboard', 'status', '--json'], { preload: false })).stdout);
  assert.strictEqual(json.state, 'running');
  assert.strictEqual(json.pid, rec.pid);
});

test('a stale record is recovered exactly as start recovers it, then opened', async () => {
  const dir = scratch();
  const a = stubbed(dir);
  assert.strictEqual((await vl(dir, ['dashboard', 'open'], { env: a.env })).status, 0);
  const dead = record(dir);
  note(dir);
  process.kill(dead.pid, 'SIGKILL');
  await until(async () => !alive(dead.pid), 'the killed daemon to be gone');

  const st = await vl(dir, ['dashboard', 'status'], { preload: false });
  assert.strictEqual(st.status, 3);
  assert.match(st.stdout, /not running — a stale record names pid \d+/);

  const b = stubbed(dir);
  const res = await vl(dir, ['dashboard', 'open'], { env: b.env });
  assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
  const m = res.stdout.match(RUNNING_RE);
  assert.ok(m, res.stdout);
  note(dir);
  const rec = record(dir);
  assert.notStrictEqual(rec.instanceId, dead.instanceId, 'the stale record was replaced');
  assert.ok(alive(rec.pid), 'a live daemon answers the recovered record');
  assertOneRun(captures(b.capture), null, [m[1]], 'the recovered address is the one opened');
});

console.log('open: the URL is the loopback page URL');

test('the opener never sees the LAN address, the LAN token or the nonce (LAN enabled)', async () => {
  const addr = lanLib.localAddresses().find((a) => net.isIPv4(a)) || null;
  if (!addr) { console.log('    (skipped: needs a non-loopback IPv4 address on this machine)'); return; }
  const dir = scratch();
  const enable = await vl(dir, ['dashboard', 'lan', 'enable', '--interface', addr], { preload: false });
  assert.strictEqual(enable.status, 0, enable.stderr);
  const { env, capture } = stubbed(dir);
  const res = await vl(dir, ['dashboard', 'open'], { env });
  assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
  note(dir);
  const rec = record(dir);
  const m = res.stdout.match(RUNNING_RE);
  assert.ok(m, res.stdout);
  assert.strictEqual(m[1], loopbackUrl(rec));
  assert.ok(!res.stdout.includes(addr), `stdout carries no LAN address: ${res.stdout}`);
  assert.match(res.stdout, /127\.0\.0\.1/, 'the printed address is loopback');
  const text = fs.readFileSync(capture, 'utf8');
  assertOneRun(captures(capture), null, [m[1]], 'one argument: the loopback URL');
  assert.ok(!text.includes(addr), 'the LAN address never reaches the opener');
  assert.ok(!text.includes(rec.nonce), 'the control nonce never reaches the opener');
  const token = fs.existsSync(path.join(dir, 'dashboard-lan-token'))
    ? fs.readFileSync(path.join(dir, 'dashboard-lan-token'), 'utf8').trim() : null;
  if (token) assert.ok(!text.includes(token), 'the LAN read token never reaches the opener or argv');
  assert.ok(!/[?#]/.test(captures(capture)[0].argv[0]), 'no query or fragment: nothing secret rides in the URL');
});

console.log('open: refusals never open a browser');

test('an unverified record → the existing refusal, exit 1, no opener call', async () => {
  const dir = scratch();
  const a = stubbed(dir);
  assert.strictEqual((await vl(dir, ['dashboard', 'open'], { env: a.env })).status, 0);
  note(dir);
  const rec = record(dir);

  // The record is intact and the listener answers; only the process-identity
  // read fails, which is what makes an instance unverifiable rather than stale.
  const b = stubbed(dir, { blindPid: rec.pid });
  const st = await vl(dir, ['dashboard', 'status'], { env: b.env });
  assert.strictEqual(st.status, 3);
  assert.match(st.stdout, /UNVERIFIED/);

  const res = await vl(dir, ['dashboard', 'open'], { env: b.env });
  assert.strictEqual(res.status, 1, res.stdout);
  assert.match(res.stderr, /dashboard start: a record names an instance that could not be verified; nothing was signalled/);
  assert.deepStrictEqual(captures(b.capture) || [], [], 'no browser was opened');
  assert.strictEqual(record(dir).instanceId, rec.instanceId, 'the unverified record was not replaced');
  assert.ok(alive(rec.pid), 'and nothing was signalled to the process it names');
});

test('a lock held by another start → the existing refusal, exit 1, no browser, nothing published', async () => {
  const dir = scratch();
  const stranger = liveStranger();
  forgeTicket(dir, stranger.pid, identity.psStartToken(stranger.pid));
  const { env, capture } = stubbed(dir);
  const res = await vl(dir, ['dashboard', 'open'], { env });
  assert.strictEqual(res.status, 1, `${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /another start is in progress or holds the ownership lock; run `dashboard status`/);
  assert.deepStrictEqual(captures(capture) || [], [], 'no browser was opened');
  assert.ok(!fs.existsSync(records.recordPath(dir)), 'no record was published');
  assert.ok(alive(stranger.pid), 'the holder was never signalled');
});

console.log('open: a failing opener is not a failing command');

test('opener binary missing → address, one diagnostic line, exit 0, daemon still running', async () => {
  const dir = scratch();
  const up = stubbed(dir);
  assert.strictEqual((await vl(dir, ['dashboard', 'open'], { env: up.env })).status, 0);
  const rec = record(dir);
  note(dir);

  const no = stubbed(dir, { withOpener: false });
  const res = await vl(dir, ['dashboard', 'open'], { env: no.env });
  assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  assert.strictEqual(lines.length, 2, `address + one diagnostic, got: ${res.stdout}`);
  assert.strictEqual(lines[0], `dashboard: running at ${loopbackUrl(rec)}`);
  // Derived from the platform's own opener name, never a hardcoded string: on
  // macOS that is `open`, on Linux `xdg-open`, on Windows what `cmd` resolves
  // to. The diagnostic has to name the command that is missing, not a bare
  // errno, and it has to be THIS machine's command.
  const want = openerFilesFor(process.platform);
  const diag = lines[1].match(/^dashboard: browser not opened \(spawn (.+) ENOENT\)$/);
  assert.ok(diag, `diagnostic names the missing opener: ${lines[1]}`);
  assert.ok(want.includes(diag[1]) || want.includes(`${diag[1]}.exe`),
    `the diagnostic names ${diag[1]}, expected ${want.join(' or ')} for ${process.platform}`);
  assert.deepStrictEqual(captures(no.capture) || [], [], 'and nothing reached an opener');
  assert.ok(alive(rec.pid), 'the daemon keeps running');
  assert.strictEqual(record(dir).instanceId, rec.instanceId, 'and was not restarted');
});

test('opener exits nonzero → address, one diagnostic line, exit 0, daemon still running', async () => {
  const dir = scratch();
  const up = stubbed(dir);
  assert.strictEqual((await vl(dir, ['dashboard', 'open'], { env: up.env })).status, 0);
  const rec = record(dir);
  note(dir);

  const bad = stubbed(dir, { exitCode: 3 });
  const res = await vl(dir, ['dashboard', 'open'], { env: bad.env });
  assert.strictEqual(res.status, 0, `${res.stdout}${res.stderr}`);
  const lines = res.stdout.trim().split('\n');
  assert.strictEqual(lines[0], `dashboard: running at ${loopbackUrl(rec)}`);
  assert.match(lines[1], /^dashboard: browser not opened \(the browser opener exited 3\)$/);
  assertOneRun(captures(bad.capture), null, [loopbackUrl(rec)], 'the failing process was the stub');
  assert.ok(alive(rec.pid));
});

console.log('open: --no-open and the platform argv shapes');

test('--no-open prints the address and launches nothing (fresh and reused)', async () => {
  const dir = scratch();
  const a = stubbed(dir);
  const first = await vl(dir, ['dashboard', 'open', '--no-open'], { env: a.env });
  assert.strictEqual(first.status, 0, first.stderr);
  const m = first.stdout.match(RUNNING_RE);
  assert.ok(m, first.stdout);
  note(dir);
  const rec = record(dir);
  assert.deepStrictEqual(captures(a.capture) || [], [], 'nothing was launched');

  const b = stubbed(dir);
  const second = await vl(dir, ['dashboard', 'open', '--no-open'], { env: b.env });
  assert.strictEqual(second.stdout, first.stdout, 'the reuse prints the same address');
  assert.strictEqual(record(dir).instanceId, rec.instanceId, 'and starts nothing');
  assert.deepStrictEqual(captures(b.capture) || [], [], 'still nothing launched');
});

test('Windows gets cmd /c start "" <url> as an array; Linux gets xdg-open <url>', async () => {
  const dir = scratch();
  const up = stubbed(dir);
  assert.strictEqual((await vl(dir, ['dashboard', 'open'], { env: up.env })).status, 0);
  const rec = record(dir);
  note(dir);
  const url = loopbackUrl(rec);

  // Every platform's opener name is stubbed and the PATH holds nothing else,
  // so on the Windows leg the only thing that can answer is the stub — whether
  // Node asks for `cmd` or resolves it to `cmd.exe`. What the case pins is the
  // ARGV the branch builds: `/c start "" <url>`, with the empty element as
  // `start`'s window title and the URL as its own element.
  const win = stubbed(dir, { platform: 'win32' });
  const resWin = await vl(dir, ['dashboard', 'open'], { env: win.env });
  assert.strictEqual(resWin.status, 0, resWin.stderr);
  assert.strictEqual(resWin.stdout, `dashboard: running at ${url}\n`,
    'no diagnostic line: the opener ran');
  assertOneRun(captures(win.capture), 'win32', ['/c', 'start', '', url],
    'the Windows argv array, handed to the stub');

  const lin = stubbed(dir, { platform: 'linux' });
  const resLin = await vl(dir, ['dashboard', 'open'], { env: lin.env });
  assert.strictEqual(resLin.status, 0, resLin.stderr);
  assert.strictEqual(resLin.stdout, `dashboard: running at ${url}\n`, 'no diagnostic line: the opener ran');
  assertOneRun(captures(lin.capture), 'linux', [url], 'one argument: the URL, never a shell string');
});

test('the Linux capture is the stub speaking: PATH is the stub dir and `ps`, nothing else', async () => {
  const dir = scratch();
  const up = stubbed(dir);
  assert.strictEqual((await vl(dir, ['dashboard', 'open'], { env: up.env })).status, 0);
  const rec = record(dir);
  note(dir);
  const url = loopbackUrl(rec);

  const lin = stubbed(dir, { platform: 'linux' });
  // Hermetic, and proved rather than assumed: the run's PATH is exactly the
  // stub dir plus the `ps` dir, so a host `xdg-open` (which every desktop Linux
  // box has, and which would open a real browser) is not reachable at all.
  assert.deepStrictEqual(lin.env.PATH.split(path.delimiter), [lin.bin, lin.tools],
    'the opener lookup can only reach the stub dir');
  assert.deepStrictEqual(fs.readdirSync(lin.bin).sort(), ALL_OPENER_FILES.slice().sort(),
    'every platform opener name is shadowed by a stub');

  const res = await vl(dir, ['dashboard', 'open'], { env: lin.env });
  assert.strictEqual(res.status, 0, res.stderr);
  const runs = captures(lin.capture);
  assertOneRun(runs, 'linux', [url], 'the stub was handed the loopback URL');
  assert.strictEqual(runs[0].name, 'xdg-open',
    'the linux branch ran the stub named xdg-open, not a desktop opener');
});

console.log('the three argument-free verbs the shims call');

// Issue #136 with owner ruling Q34-A ("no arguments in any pre-approved
// command"): /view-limits:dashboard, /view-limits:dashboard-stop and
// /view-limits:dashboard-status each run ONE fixed CLI call. The mapping that
// used to sit in front of them (`dashboard slash`) is gone, so these are the
// three verbs themselves — walked in the order a user meets them, including the
// exit codes the shims relay verbatim.
test('status (nothing running) → open → status → stop → status', async () => {
  const dir = scratch();
  const before = await vl(dir, ['dashboard', 'status'], { preload: false });
  assert.strictEqual(before.status, 3, before.stdout);
  assert.match(before.stdout, /dashboard: not running/);
  assert.ok(!fs.existsSync(records.recordPath(dir)), 'a status read starts nothing');

  const a = stubbed(dir);
  const opened = await vl(dir, ['dashboard', 'open'], { env: a.env });
  assert.strictEqual(opened.status, 0, opened.stderr);
  const m = opened.stdout.match(RUNNING_RE);
  assert.ok(m, opened.stdout);
  note(dir);
  assert.strictEqual(captures(a.capture).length, 1, 'open handed the address to the stub');

  const stat = await vl(dir, ['dashboard', 'status'], { preload: false });
  assert.strictEqual(stat.status, 0);
  assert.match(stat.stdout, /dashboard: running at http:\/\/127\.0\.0\.1:\d+\/ \(pid \d+, up \d+s, interval 30s\)/);

  const b = stubbed(dir);
  const stopped = await vl(dir, ['dashboard', 'stop'], { env: b.env });
  assert.strictEqual(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /dashboard: stopped/);
  assert.deepStrictEqual(captures(b.capture) || [], [], 'stop opens no browser');

  const after = await vl(dir, ['dashboard', 'status'], { preload: false });
  assert.strictEqual(after.status, 3, 'and it really stopped');
  assert.match(after.stdout, /dashboard: not running/);
});

// The removed mapper must leave no trace a caller can still trip over.
test('the dashboard command refuses everything else, the removed mapper included', async () => {
  const dir = scratch();
  for (const args of [['bogus'], ['slash'], ['status', '--bogus'], ['stop', '--force'], ['start', '--bogus']]) {
    const { env, capture } = stubbed(dir);
    const res = await vl(dir, ['dashboard', ...args], { env });
    assert.strictEqual(res.status, 2, `dashboard ${args.join(' ')} → ${res.status}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /usage: vl\.js dashboard /);
    // The mapper is gone, so `slash` is now just another unknown word…
    if (args[0] === 'slash') assert.match(res.stderr, /unknown dashboard command "slash"/);
    // …and it is not offered anywhere in the usage block itself.
    const usageBlock = res.stderr.split('\n').filter((l) => l.startsWith('usage:') || l.startsWith('       vl.js')).join('\n');
    assert.ok(!usageBlock.includes('slash'), `the usage no longer offers the removed mapper:\n${usageBlock}`);
    assert.deepStrictEqual(captures(capture) || [], [], `dashboard ${args.join(' ')}: no browser`);
    assert.ok(!fs.existsSync(records.recordPath(dir)), `dashboard ${args.join(' ')}: nothing was started`);
  }
  const bare = await vl(dir, ['dashboard'], { preload: false });
  assert.strictEqual(bare.status, 2);
  assert.match(bare.stderr, /a dashboard command is required/);
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
  for (const pid of started) {
    if (alive(pid)) { failures += 1; console.log(`  ✗ daemon ${pid} survived cleanup`); }
  }
  for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log(`\nall dashboard-open tests passed (${cases.length} cases, ${os.platform()})`);
  process.exit(0);
})();
