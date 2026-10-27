'use strict';
// The shared harness for the Issue #81 empty-defaults suite.
//
// The suite is split in two test files so neither approaches the runner's
// per-file budget on its own (#106):
//
//   test/empty-defaults.test.js        the config document itself: empty
//                                      defaults, the publish protocol, the
//                                      reader/lock rules, and a document
//                                      that cannot be read
//   test/empty-defaults-cli.test.js    the real-CLI surfaces: migration,
//                                      refusal, repair, the setup form,
//                                      provider add/update/remove
//
// Everything here used to live in one file; it is unchanged and only moved,
// so the two halves share one definition of the CLI child env, the scratch
// dirs, the own-run helper and the failure count.

// Issue #81: config.json is ASSEMBLED by setup and PRUNED by remove. A fresh
// install shows no provider rows; the five shipped built-ins are offered for
// setup but not present until added; and an install that predates this — no
// config.json, credentials stored — is migrated once to rows for exactly those
// providers.
//
// This shipped once on PR #79 and was reverted after review found three P1s.
// Each has a section here that fails if its fix is reverted:
//
//   P1-1  the migration erased a concurrent `provider add`
//           -> "migration under the ownership boundary" (real lock, real fs)
//   P1-2  a transiently unreadable vault migrated routes away for good
//           -> "unreadable is never absent" (unit) and the real-file-vault
//              CLI case, where secrets/ really is unreadable
//   P1-3  /view-limits:setup handed the user a dead form on an empty config
//           -> "the setup form on a fresh install" (real form server, real
//              parent, the real POST)
//
// Real-CLI cases load test/fixtures/migration-preload.cjs, which forces the
// DEFAULT vault backend to the real file vault so a test never reads the
// developer's Keychain, journals any network attempt, and records instead of
// performing a browser launch. Nothing about the vault itself is stubbed.


// Issue #81: config.json is ASSEMBLED by setup and PRUNED by remove. A fresh
// install shows no provider rows; the five shipped built-ins are offered for
// setup but not present until added; and an install that predates this — no
// config.json, credentials stored — is migrated once to rows for exactly those
// providers.
//
// This shipped once on PR #79 and was reverted after review found three P1s.
// Each has a section here that fails if its fix is reverted:
//
//   P1-1  the migration erased a concurrent `provider add`
//           -> "migration under the ownership boundary" (real lock, real fs)
//   P1-2  a transiently unreadable vault migrated routes away for good
//           -> "unreadable is never absent" (unit) and the real-file-vault
//              CLI case, where secrets/ really is unreadable
//   P1-3  /view-limits:setup handed the user a dead form on an empty config
//           -> "the setup form on a fresh install" (real form server, real
//              parent, the real POST)
//
// Real-CLI cases load test/fixtures/migration-preload.cjs, which forces the
// DEFAULT vault backend to the real file vault so a test never reads the
// developer's Keychain, journals any network attempt, and records instead of
// performing a browser launch. Nothing about the vault itself is stubbed.

const assert = require('assert');

const crypto = require('crypto');

const fs = require('fs');

const http = require('http');

const net = require('net');

const os = require('os');

const path = require('path');

const { spawn, spawnSync } = require('child_process');


const config = require('../../lib/config');

// Same default the preload forces in the CLI: the real file vault, so the
// in-process premise checks below read the backend the CLI will use.
config.DEFAULTS.vault.backend = 'file';

const { DEFAULTS, BUILT_IN_ROUTES, builtInRoute, loadConfig, saveConfig, configPath } = config;

const vault = require('../../lib/vault');

const lifecycle = require('../../lib/provider-lifecycle');

const lockModule = require('../../lib/lock');

const { getRuntimeSnapshot } = require('../../lib/runtime-snapshot');


const cli = path.resolve(__dirname, '../../bin/vl.js');

const preload = path.join(__dirname, '../fixtures/migration-preload.cjs');

const MASTER = 'vl-81-empty-defaults-master';

const KEY_A = 'sk-kimi-TEST-81-aaaa1111';

const KEY_B = 'sk-glm-TEST-81-bbbb2222';

const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;


// ---- harness -------------------------------------------------------------------

let failures = 0;

let queue = Promise.resolve();

function test(name, fn) {
  queue = queue.then(async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures += 1;
      console.log(`  ✗ ${name}\n    ${(e && e.message) || e}`);
    }
  });
}

function section(name) { queue = queue.then(() => console.log(`\n${name}`)); }


function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-'));
}


// Journals live OUTSIDE the data dir, so a zero-write assertion on the data
// dir is never disturbed by the test's own bookkeeping.
function journals() {
  const side = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-journal-'));
  return {
    net: path.join(side, 'net'),
    browser: path.join(side, 'browser'),
    read(file) { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; } },
  };
}


function envFor(dir, j, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: dir,
    CLAUDE_PLUGIN_DATA: dir,
    VIEW_LIMITS_MASTER_KEY: MASTER,
    NODE_OPTIONS: `--require=${preload}`,
    // [#106] `setup`/`update` otherwise run a real `npm ci` for the view's
    // banner dependency, which on a tree without node_modules stalls until the
    // per-child budget kills it. The preload stubs the installer, gated on this
    // flag: no case here asserts on it.
    VL_TEST_STUB_DEPENDENCY_INSTALL: '1',
    VL_NET_JOURNAL: j.net,
    VL_BROWSER_JOURNAL: j.browser,
    ...extra,
  };
}


function run(dir, args, j = journals(), extra = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: envFor(dir, j, extra), encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not every command prints JSON */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, j };
}


// Run fn with this data dir and master key, so the REAL lib/vault and
// lib/config resolve exactly what the CLI would.
function inDataDir(dir, fn) {
  const prev = { data: process.env.CLAUDE_PLUGIN_DATA, key: process.env.VIEW_LIMITS_MASTER_KEY };
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = MASTER;
  try { return fn(); } finally {
    if (prev.data === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prev.data;
    if (prev.key === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prev.key;
  }
}


// A stored credential and NO config.json: an install from before empty
// defaults. Written by the real vault, exactly as setup would have.
function upgradeWith(...ids) {
  const dir = scratch();
  inDataDir(dir, () => { for (const id of ids) vault.set(id, `sk-${id}-TEST-81`); });
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, 'premise: no config.json');
  return dir;
}


// A config.json that exists — so nothing migrates — with the file vault.
function seeded(routes = []) {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes, vault: { backend: 'file' }, gate: { mode: 'off' },
  }, null, 1));
  return dir;
}


function routeIds(dir) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  return (Array.isArray(doc.routes) ? doc.routes : []).map((r) => r && r.id);
}


// Every path under dir, with each file's content hash, so an in-place rewrite
// is caught as well as a created or deleted file.
function tree(dir) {
  const out = [];
  (function walk(rel) {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const r = path.join(rel, name);
      const st = fs.statSync(path.join(dir, r));
      if (st.isDirectory()) { out.push(`${r}/`); walk(r); }
      else out.push(`${r}:${crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex')}`);
    }
  }(''));
  return out;
}


function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}


function request(port, method, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: '/', headers: body ? { 'Content-Type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.once('error', (e) => resolve({ status: 0, error: e.code }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}


async function waitListening(port, exited, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let gone = false;
  exited.then(() => { gone = true; });
  while (Date.now() < deadline) {
    if (gone) return false;
    const r = await request(port, 'GET');
    if (r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}


// ---- the migration as a unit -------------------------------------------------

// io for migrateFromVault, recording every call. `presence` is the sequence
// configPresence() returns: the first answer is the pre-check outside the lock,
// the second is the re-check inside it.
function fakeIo({ presence = ['absent'], states = {}, lockOk = true, saveThrows = false } = {}) {
  const calls = { presence: 0, probes: [], saves: [], locks: 0, releases: 0 };
  return {
    calls,
    configPresence: () => {
      const v = presence[Math.min(calls.presence, presence.length - 1)];
      calls.presence += 1;
      if (v instanceof Error) throw v;
      return v;
    },
    lock: () => {
      calls.locks += 1;
      return lockOk ? { ok: true, release: () => { calls.releases += 1; return true; } } : { ok: false, error: 'held' };
    },
    vault: {
      probe: (id) => {
        calls.probes.push(id);
        if (!Object.prototype.hasOwnProperty.call(states, id)) return 'absent';
        const v = states[id];
        if (v instanceof Error) throw v;
        return v;
      },
    },
    saveConfig: (doc) => {
      if (saveThrows) throw new Error('ENOSPC: no space left on device');
      calls.saves.push(JSON.parse(JSON.stringify(doc)));
    },
  };
}


// The invariant itself, not the dispatcher wiring: an absent config.json means
// the migration has not resolved, so ANY publish that would create the file is
// refused — whatever command, list or caller it came from — and every publish
// runs under the provider mutation lock.

// Run fn with this data dir AND the real mutation lock held, as every in-protocol
// publisher does.
function underLock(dir, fn) {
  return inDataDir(dir, () => {
    const lock = lifecycle.acquireMutationLock(dir);
    assert.ok(lock.ok, 'premise: the test holds the mutation lock');
    try { return fn(); } finally { lock.release(); }
  });
}

const PREV = (dir) => path.join(dir, 'config.json.prev');

const docAt = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));


function deleteAt(dir, at, args) {
  const hook = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-del-')), 'hook');
  const r = run(dir, args, journals(), { VL_TEST_DELETE_CONFIG_AT: at, VL_TEST_HOOK_JOURNAL: hook });
  const fired = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, fired };
}

const ADD_AFTER = ['provider', 'add', '--label', 'after', '--provider', 'stepplan', '--recipe', 'stepfun-plan', '--keep-unmonitored'];


// Readers (PR #82 round 4). A reader takes no lock, and the publisher is
// usually ANOTHER process, so synchronous I/O in the reader does not exclude
// it: a whole publish can complete between two of the reader's reads. These
// run that schedule deterministically — each time the reader misses
// config.json or .prev, the next scheduled writer step runs before the
// reader's next read. A step is the real saveConfig under the real lock, or
// saveConfig's real first step (the move-aside).
async function onReaderMiss(steps, fn) {
  const realRead = fs.readFileSync;
  const misses = [];
  fs.readFileSync = function readAtBoundary(file, ...rest) {
    try {
      return realRead.call(this, file, ...rest);
    } catch (e) {
      const name = path.basename(String(file));
      if (e && e.code === 'ENOENT' && (name === 'config.json' || name === 'config.json.prev')) {
        misses.push(name);
        const step = steps.shift();
        if (step) step();
      }
      throw e;
    }
  };
  try {
    return { value: await fn(), misses };
  } finally {
    fs.readFileSync = realRead;
  }
}

const customDoc = (id) => ({
  routes: [{ id, provider: 'stepplan', monitor: { recipe: 'stepfun-plan' }, retention: 'keep-unmonitored' }],
  vault: { backend: 'file' }, gate: { mode: 'off' },
});

const OLD_DOC = customDoc('custom-old');

const NEW_DOC = customDoc('custom-new');


// ---- PR #82 round 5: absence is proven under the lock -----------------------------
//
// N back-to-back publishes by other processes can exhaust any N lock-free
// rounds. The schedule below is the reviewer's: in every round writer k moves
// config.json aside (at the reader's .prev miss of the round before), then
// completes — link, unlink .prev — at the reader's config.json miss, so both
// reads of every round miss while a valid document exists at the end.
function nWriterSchedule(dir, docs) {
  const steps = [];
  docs.forEach((doc, i) => {
    steps.push(() => underLock(dir, () => saveConfig(doc)));
    if (i < docs.length - 1) steps.push(() => fs.renameSync(path.join(dir, 'config.json'), PREV(dir)));
  });
  return steps;
}

const SIX_MISSES = ['config.json', 'config.json.prev', 'config.json', 'config.json.prev', 'config.json', 'config.json.prev'];


// Counts every lock acquire made through lib/lock.js's module object, which is
// how lib/config.js takes it.
async function countingAcquires(fn) {
  const real = lockModule.acquireMutationLock;
  let count = 0;
  lockModule.acquireMutationLock = function countedAcquire(...a) { count += 1; return real.apply(this, a); };
  try {
    const value = await fn(() => count);
    return { value, count };
  } finally {
    lockModule.acquireMutationLock = real;
  }
}


// A ticket planted for another process, numbered ahead of any newcomer.
function plantTicket(dir, pid) {
  const root = path.join(dir, lockModule.LOCK_DIR);
  fs.mkdirSync(root, { recursive: true });
  const name = `${pid}-${crypto.randomBytes(16).toString('hex')}.json`;
  fs.writeFileSync(path.join(root, name), JSON.stringify({ pid, owner: 'planted', number: 1 }));
  return path.join(root, name);
}


// ---- PR #82 round 6 (owner ruling "fix the commands"): consumer wiring --------------
//
// A command whose lock-free config read could not confirm config.json must not
// act on, or present, built-in DEFAULTS. These run the REAL CLI with
// test/fixtures/reader-churn.cjs: other processes' publishes — each holding the
// real lock for its whole publish — land between the command's reads.
const churnPreload = path.join(__dirname, '../fixtures/reader-churn.cjs');

const strictJournalPreload = path.join(__dirname, '../fixtures/strict-journal.cjs');

const xiaomiPreload = path.join(__dirname, '../fixtures/xiaomi-cli-preload.cjs');

const kimiDoc = (extra) => ({ routes: [builtInRoute('kimi-code-plan'), ...extra], vault: { backend: 'file' }, gate: { mode: 'off' } });

const CHURN_DOCS = [1, 2, 3].map((n) => kimiDoc([customDoc(`custom-w${n}`).routes[0]]));


function churnRun(dir, args, { at = 1, preloads = [], extra = {} } = {}) {
  const side = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-churn-'));
  const hook = path.join(side, 'hook');
  const locks = path.join(side, 'locks');
  const r = run(dir, args, journals(), {
    NODE_OPTIONS: [preload, ...preloads, churnPreload, strictJournalPreload].map((p) => `--require=${p}`).join(' '),
    VL_TEST_CHURN_DOCS: JSON.stringify(CHURN_DOCS), VL_TEST_CHURN_AT: String(at), VL_TEST_HOOK_JOURNAL: hook,
    VL_STRICT_JOURNAL: locks, VL_STRICT_JOURNAL_VAULT: 'pass', ...extra,
  });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  const all = read(hook).map((l) => JSON.parse(l));
  return {
    r,
    steps: all.filter((s) => s.step !== 'read'),
    reads: all.filter((s) => s.step === 'read'),
    acquires: read(locks).filter((c) => c.startsWith('acquireMutationLock')),
  };
}

// One read, attempt `at`, sees a syntactically broken document; the file is untouched.
function corruptRun(dir, args, at, { preloads = [], extra = {} } = {}) {
  const side = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-corrupt-'));
  const hook = path.join(side, 'hook');
  const r = run(dir, args, journals(), {
    NODE_OPTIONS: [preload, ...preloads, churnPreload].map((p) => `--require=${p}`).join(' '),
    VL_TEST_CHURN_DOCS: '[]', VL_TEST_CORRUPT_AT: String(at), VL_TEST_HOOK_JOURNAL: hook, ...extra,
  });
  const all = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { r, steps: all.filter((s) => s.step !== 'read'), reads: all.filter((s) => s.step === 'read') };
}

// The bin/vl.js function that made read attempt `at`.
const siteAt = (reads, at) => (reads.find((s) => s.attempt === at) || {}).site;

// The attempt number of the LAST config read made in `site`, from an
// uncontended run of the same command on an identically prepared data dir. No
// writers run, so every read before it is the same in the churn run.
function readAt(prepare, args, site) {
  const side = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-sites-'));
  const hook = path.join(side, 'hook');
  run(prepare(), args, journals(), {
    NODE_OPTIONS: [preload, churnPreload].map((p) => `--require=${p}`).join(' '),
    VL_TEST_CHURN_DOCS: '[]', VL_TEST_HOOK_JOURNAL: hook,
  });
  const reads = fs.readFileSync(hook, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((s) => s.step === 'read' && s.site === site);
  assert.ok(reads.length, `premise: ${args.join(' ')} reads config.json in ${site}`);
  return reads[reads.length - 1].attempt;
}

// Which config read the churn starts at: a command's own read is the 1st. The
// dispatcher's migration makes no config read (it decides presence by lstat
// under its own lock and is handed no cfg), so nothing comes before it.
const OWN_READ = () => 1;

const EXHAUSTED = (steps) => steps.filter((s) => s.step === 'miss').length === 6 && steps.filter((s) => s.step === 'complete').length === 3;


// The two other Xiaomi config writers had the same read-outside-the-lock shape.
function xiaomiConfigured() {
  const chrome = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-81-chrome-'));
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    routes: [builtInRoute('kimi-code-plan'), customDoc('custom-keep').routes[0], {
      id: 'xiaomi-token-plan', provider: 'xiaomi', account: 'token-plan', match: { model: 'mimo' },
      ttlSeconds: 0, credentialSource: 'chrome-cookies',
    }],
    providers: { xiaomi: { baseUrl: 'https://platform.xiaomimimo.com' } },
    xiaomi: { chromeSource: chrome, chromeProfile: 'Profile 46' },
    vault: { backend: 'file' }, gate: { mode: 'off' },
  }));
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  return { dir, chrome };
}


// The guard: every config-reading call in bin/, lib/ and harness/, by file,
// enclosing function, helper and its exact arguments. The set must equal this
// table exactly, so a new call site (in any mode), a widened opt-in and a
// removed one all fail here until the table — the PR's review artifact — is
// updated to match. Modes: strict-default (loadConfig() refuses), display /
// session-warmup opt-in, strict by construction, lstat presence.
const CONFIG_READERS = [
  // loadConfig: the five opt-ins, each surfacing the mark itself.
  'bin/vl.js | gate | loadConfig | { display: true }',
  'bin/vl.js | refresh | loadConfig | fromSessionStart ? { sessionWarmup: true } : undefined',
  'bin/vl.js | reportCmd | loadConfig | { display: true }',
  'bin/vl.js | recommendCmd | loadConfig | { display: true }',
  'bin/vl.js | sessionStart | loadConfig | { display: true }',
  // loadConfig: strict default (refuses, exit 9).
  'bin/vl.js | check | loadConfig | ',
  'bin/vl.js | serve | loadConfig | ',
  'bin/vl.js | requireRowAfterStore | loadConfig | ',
  'bin/vl.js | setup | loadConfig | ',
  'bin/vl.js | setup | loadConfig | ',
  'bin/vl.js | update | loadConfig | ',
  'bin/vl.js | remove | loadConfig | ',
  'bin/vl.js | providerCmd | loadConfig | ',
  'bin/vl.js | config | loadConfig | ',
  // `dashboard start` (#61): strict default — an unconfirmed or corrupt
  // config.json refuses (exit 9 / 10) before any daemon is spawned, so the
  // interval is never read from built-in defaults.
  'bin/vl.js | dashboardCmd | loadConfig | ',
  // Issue #62 LAN view: `lan url` reads the confirmed config; enable/disable
  // read-modify-write dashboard.lan under the mutation lock.
  'bin/vl.js | dashboardLanCmd | loadConfig | ',
  'bin/vl.js | writeLanConfig | readUserConfigStrict | ',
  // The view's own read: strict default (it refuses), and the mark is
  // surfaced by the command itself — the JSON envelope is printed before
  // the exit, so the wrapper's immediate exit cannot be used here.
  'bin/vl.js | viewCmd | libLoadConfig | ',
  // The view's re-confirmation of an absent document: an lstat presence
  // check (never a document read), which tells a document that was never
  // published from one that exists but could not be read.
  'bin/vl.js | viewCmd | configPresence | ',
  // The bin wrapper: the throw becomes exit 9 at the call.
  'bin/vl.js | loadConfig | libLoadConfig | opts',
  // Strict by construction (proves absence under the lock, or throws / exits 9).
  'bin/vl.js | planXiaomiConfig | loadConfigStrict | ',
  'bin/vl.js | lifecycleIo | loadConfigStrict | ',
  'lib/vault.js | vaultCfg | loadConfigStrict | ',
  'bin/vl.js | readUserConfig | readConfigText | { strict: true }',
  'bin/vl.js | readUserConfigStrict | readConfigText | { strict: true }',
  'bin/vl.js | materializeBuiltInRoute | readUserConfigStrict | ',
  'bin/vl.js | planXiaomiConfig | readUserConfig | ',
  'bin/vl.js | writeXiaomiSourceProfile | readUserConfig | ',
  'bin/vl.js | removeXiaomi | readUserConfig | ',
  'lib/provider-lifecycle.js | persistRoute | readUserConfig | ',
  'lib/provider-lifecycle.js | removeWithinLock | readUserConfig | ',
  'lib/provider-lifecycle.js | userConfigBlocked | readUserConfigStrict | ',
  // The snapshot's own reader: carries the config-inconclusive diagnostic.
  'lib/runtime-snapshot.js | defaultReadConfig | readConfigTextIn | dir',
  // lstat presence (the migration), never a document read.
  'lib/provider-lifecycle.js | configPresenceOf | configPresence | ',
  // lib/config.js internals.
  'lib/config.js | buildConfig | readConfigText | { strict }',
  'lib/config.js | loadConfig | buildConfig | false',
  'lib/config.js | loadConfigStrict | buildConfig | true',
  'lib/config.js | readConfigText | readConfigTextIn | dataDir(), opts',
];

const READER_NAMES = ['loadConfig', 'libLoadConfig', 'loadConfigStrict', 'buildConfig', 'readConfigText',
  'readConfigTextIn', 'readUserConfig', 'readUserConfigStrict', 'configPresence'];


function configReaderCalls() {
  const root = path.resolve(__dirname, '../..');
  const calls = [];
  const bypasses = [];
  const call = new RegExp(`(?<![\\w$])(${READER_NAMES.join('|')})\\(`, 'g');
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) { if (name !== 'node_modules') walk(file); continue; }
      if (!/\.c?js$/.test(name)) continue;
      const rel = path.relative(root, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let fn = '(top level)';
      lines.forEach((line, i) => {
        const decl = line.match(/^(?:async\s+)?function\s+(\w+)/);
        if (decl) fn = decl[1];
        else if (/^\S/.test(line) && !/^(\/\/|\}|\*)/.test(line)) fn = '(top level)';
        const code = line.replace(/\/\/.*$/, '');
        // A document read that bypasses the helpers.
        if (rel !== 'lib/config.js' && /readFileSync\(/.test(code) && /config\.json|configPath\(/.test(code)) bypasses.push(`${rel}:${i + 1}`);
        for (const m of code.matchAll(call)) {
          if (/function\s+$/.test(code.slice(0, m.index))) continue;
          let depth = 0;
          let args = '';
          for (let k = m.index + m[1].length; k < code.length; k += 1) {
            const c = code[k];
            if (c === '(') { depth += 1; if (depth === 1) continue; }
            if (c === ')') { depth -= 1; if (depth === 0) break; }
            args += c;
          }
          calls.push(`${rel} | ${fn} | ${m[1]} | ${args.trim()}`);
        }
      });
    }
  };
  for (const sub of ['bin', 'lib', 'harness']) if (fs.existsSync(path.join(root, sub))) walk(path.join(root, sub));
  return { calls, bypasses };
}


// ---- CodeRabbit finding A: a config.json that EXISTS but cannot be used ----
//
// Invalid JSON, JSON that is not an object, or a read error other than ENOENT.
// The backend choice lives in that document, so nothing can know it was the
// file vault: the property is that NO backend is touched, never DEFAULTS'.
const keychainPreload = path.join(__dirname, '../fixtures/keychain-tripwire.cjs');

const CORRUPT_NOTICE = /config\.json could not be read or parsed — fix it or move it aside, then rerun/;

const RETRY_NOTICE = /config unreadable mid-write; retry/;

const CORRUPT_DOCS = ['{ "vault": { "backend": "file" }, "routes": [ ', 'null', '[]', '42'];


const receipts = require('../../lib/receipts');

const RECEIPT_ACK = /credentials rotated for kimi-code-plan at /;

const freshReceipt = (dir) => receipts.writeReceipt(dir, { outcome: receipts.OUTCOME_SUBMITTED, routeIds: ['kimi-code-plan'] });


function realPresence(dir) {
  return () => {
    try { fs.statSync(path.join(dir, 'config.json')); return 'present'; }
    catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  };
}


// Verbatim on purpose: a notice that silently changes shape is a user-facing
// regression, so any rewording has to change this line too.
const UNREADABLE_NOTICE = 'view-limits: the credential vault could not be read, so stored credentials were not migrated into routes and no configuration was written — this retries on the next command.';

const INCONCLUSIVE_NOTICE = 'view-limits: config unreadable mid-write; retry. (config.json could not be confirmed — it was being replaced while it was read, or does not exist — so the configured providers are not shown.)';

const NO_CREDS_NUDGE = JSON.stringify({ systemMessage: 'view-limits: no credentials configured yet. Run /view-limits:setup to add your provider keys.' });


function withLockedSecrets(dir, fn) {
  const secrets = path.join(dir, 'secrets');
  fs.chmodSync(secrets, 0o000);
  try { return fn(); } finally { fs.chmodSync(secrets, 0o700); }
}


// The miss that sent round 1 back: migrateFromVault aborted correctly, and
// then `provider add` ran anyway, published config.json, and disarmed the
// migration for good. So the matrix crosses an unreadable vault with EVERY
// command, in both directions.
const REFUSAL = 'view-limits: not run: stored credentials have not been migrated into routes yet (the credential vault could not be read, or another provider change is in progress), and this command would change the configuration before they are. Your stored credentials are untouched and nothing was written. Make sure the vault is accessible (for example, unlock the Keychain), then rerun this command.';

const CONFIG_WRITERS = [
  ['setup'],
  ['setup', 'glm-coding-plan', '--key', KEY_B],
  ['update'],
  ['update', 'kimi-code-plan'],
  ['remove', 'kimi-code-plan'],
  ['provider', 'add', '--label', 'new-plan', '--provider', 'stepplan', '--recipe', 'stepfun-plan', '--keep-unmonitored'],
  ['provider', 'update', 'custom-new-plan', '--match-model', 'x'],
  ['provider', 'remove', 'kimi-code-plan'],
];

const READERS = [
  ['refresh'], ['refresh', '--quiet', '--session-start'], ['check', 'kimi-code-plan'], ['session-start'],
  ['report'], ['status'], ['snapshot', '--json'], ['recommend', '--json'], ['provider', 'list', '--json'],
];


function assertRefused(dir, args, r) {
  const label = args.join(' ');
  assert.strictEqual(r.status, 8, `${label}: expected the migration-pending refusal (exit 8); got ${r.status}: ${r.stderr}`);
  assert.strictEqual(fs.existsSync(path.join(dir, 'config.json')), false, `${label} wrote config.json`);
  const text = `${r.stdout}${r.stderr}`;
  assert.ok(!text.includes(dir), `${label}: the refusal carried a data-dir path`);
  assert.doesNotMatch(text, /EACCES|EPERM|ENOENT|Error:|sk-/, `${label}: the refusal carried errno, error text or credential material`);
}


// The other four built-ins are configured and stored, so bare setup has
// nothing missing and opens no form; only kimi can be row-less.
function setUpOthers() {
  const others = BUILT_IN_ROUTES.map((r) => r.id).filter((id) => id !== 'kimi-code-plan');
  const dir = seeded(others.map((id) => builtInRoute(id)));
  inDataDir(dir, () => { for (const id of others) vault.set(id, `sk-${id}-TEST-81`); });
  return dir;
}


function rowlessKimi() {
  const dir = setUpOthers();
  const held = lifecycle.acquireMutationLock(dir);
  assert.ok(held.ok, 'premise: the test holds the mutation lock');
  const r = run(dir, ['setup', 'kimi-code-plan', '--key', KEY_A]);
  assert.match(r.stderr, /credential stored, but another provider mutation holds the lock — rerun to add the "kimi-code-plan" route\./);
  assert.strictEqual(inDataDir(dir, () => vault.get('kimi-code-plan')), KEY_A, 'premise: the credential was stored');
  assert.ok(!routeIds(dir).includes('kimi-code-plan'), 'premise: the row did not materialize');
  return { dir, held };
}


// The suite's failure count and serial queue are shared by the sections of
// whichever test file requires this module. A file ends with finish(), which
// joins the same queue, so it runs after every test has.
function finish(label) {
  queue.then(() => {
    if (failures) {
      console.error(`\n${failures} ${label} test(s) failed`);
      process.exit(1);
    }
    console.log(`\nall ${label} tests passed`);
  });
}

module.exports = {
  test,
  section,
  finish,
  failures,
  queue,
  assert, crypto, fs, http, net, os, path, spawn, spawnSync, config, DEFAULTS, BUILT_IN_ROUTES,
  builtInRoute, loadConfig, saveConfig, configPath, vault, lifecycle, lockModule,
  getRuntimeSnapshot, cli, preload, MASTER, KEY_A, KEY_B, IS_ROOT, failures, queue, test, section,
  scratch, journals, envFor, run, inDataDir, upgradeWith, seeded, routeIds, tree, freePort,
  request, waitListening, fakeIo, underLock, PREV, docAt, deleteAt, ADD_AFTER, onReaderMiss,
  customDoc, OLD_DOC, NEW_DOC, nWriterSchedule, SIX_MISSES, countingAcquires, plantTicket,
  churnPreload, strictJournalPreload, xiaomiPreload, kimiDoc, CHURN_DOCS, churnRun, corruptRun,
  siteAt, readAt, OWN_READ, EXHAUSTED, xiaomiConfigured, CONFIG_READERS, READER_NAMES,
  configReaderCalls, keychainPreload, CORRUPT_NOTICE, RETRY_NOTICE, CORRUPT_DOCS, receipts,
  RECEIPT_ACK, freshReceipt, realPresence, UNREADABLE_NOTICE, INCONCLUSIVE_NOTICE, NO_CREDS_NUDGE,
  withLockedSecrets, REFUSAL, CONFIG_WRITERS, READERS, assertRefused, setUpOthers, rowlessKimi,
};
