'use strict';
// Preload for the real-CLI cases in test/empty-defaults.test.js (Issue #81).
//
// The one-time migration runs BEFORE config.json exists, so the vault backend
// it sees is the built-in default — the macOS Keychain on darwin. A test must
// never read the developer's real Keychain: it is slow, its contents depend on
// the machine, and on this repo's own machine it holds real provider keys.
//
// So this forces the DEFAULT backend to the AES-256-GCM FILE vault, and
// nothing else about the vault changes. Every vault call — `set`, `get`,
// `remove` and the strict three-way `probe` — is the REAL lib/vault.js code
// running against a temporary data dir. Nothing is stubbed: an unreadable
// `secrets/` really produces probe() === 'unreadable', which is the point.
//
// Environment:
//   VL_NET_JOURNAL       file; every attempted network call is appended to it
//                        and then refused, so "this path is network-free" is an
//                        assertion and not an assumption.
//   VL_BROWSER_JOURNAL   file; openBrowser's spawn of `open`/`xdg-open` is
//                        recorded and NOT executed — no real browser opens.
//   VL_TEST_SERVE_EXIT   numeric code; the `serve` child exits with it before it
//                        listens, reproducing a form server that dies on its
//                        own validation, so the parent's reporting is testable.
//   VL_TEST_STUB_DEPENDENCY_INSTALL=1
//                        stub lib/npm-install (#106): see below. Gated so this
//                        preload can never silently stub the installer for a
//                        test that means to exercise it (test/npm-install.test.js
//                        does not load this preload at all).
const fs = require('fs');
const cp = require('child_process');

require('../../lib/config').DEFAULTS.vault.backend = 'file';

function journal(file, line) {
  if (!file) return;
  try { fs.appendFileSync(file, `${line}\n`); } catch { /* best effort */ }
}

// [#106] `setup` and `update` install the view's banner dependency on every
// user-invoked run (bin/vl.js:1370 -> lib/npm-install.js:81). On a tree where
// the pinned `ascii.rest` is not installed under the plugin root — every fresh
// worktree, every machine without network — that is a real `npm ci --omit=dev`.
// The install's own budget is 120 s and the per-child budget here is 20 s, so
// each such case spent 20 s waiting and then failed on `status === null`.
//
// This is not a weakened assertion: no case in this file asserts on the
// installer, the banner, or the install's notice. It only stops a test child
// from depending on the machine's node_modules and network. Everything else
// about lib/npm-install.js is kept — `pinnedVersion`, `installedVersion`,
// `DEPENDENCY` and `INSTALL_TIMEOUT_MS` still come from the real module.
if (process.env.VL_TEST_STUB_DEPENDENCY_INSTALL === '1') {
  const Module = require('module');
  const { isModuleId } = require('./module-id.cjs');
  const realLoad = Module._load;
  Module._load = function loadWithInstalledDependency(id, ...args) {
    if (isModuleId(id, 'npm-install')) {
      return Object.assign({}, realLoad.call(this, id, ...args), {
        // The steady state after a first setup: the pin is present.
        dependencySatisfied: () => true,
        // Never spawn a package manager; report what a satisfied pin reports.
        installDependencies: () => ({ ok: true, status: 0, skipped: true }),
      });
    }
    return realLoad.call(this, id, ...args);
  };
}

// Network: record, then refuse. A probe that fetched would surface here.
const netFile = process.env.VL_NET_JOURNAL;
global.fetch = async (url) => {
  journal(netFile, `fetch ${String(url)}`);
  throw new Error('network forbidden in empty-defaults tests');
};
for (const mod of ['http', 'https']) {
  for (const m of ['get', 'request']) {
    const real = require(mod)[m];
    require(mod)[m] = (...args) => {
      const target = typeof args[0] === 'string' ? args[0] : (args[0] && (args[0].host || args[0].hostname)) || '?';
      // The form server's own loopback traffic is not outbound network.
      if (/^(127\.0\.0\.1|localhost)/.test(String(target)) || /\/\/(127\.0\.0\.1|localhost)/.test(String(target))) {
        return real.apply(require(mod), args);
      }
      journal(netFile, `${mod}.${m} ${target}`);
      throw new Error('network forbidden in empty-defaults tests');
    };
  }
}

// Browser: record openBrowser's launch instead of performing it. bin/vl.js
// destructures `spawn` at load time, which is after this preload runs.
const realSpawn = cp.spawn;
const browserFile = process.env.VL_BROWSER_JOURNAL;
cp.spawn = (cmd, args, opts) => {
  if (cmd === 'open' || cmd === 'xdg-open' || (cmd === 'cmd' && Array.isArray(args) && args.includes('start'))) {
    journal(browserFile, `${cmd} ${(args || []).join(' ')}`);
    const { EventEmitter } = require('events');
    const fake = new EventEmitter();
    fake.unref = () => fake;
    return fake;
  }
  return realSpawn(cmd, args, opts);
};

// A deterministic interleaving, not a sleep (VL_TEST_BEFORE_FIRST_LOCK = a JSON
// argv for bin/vl.js). At this process's FIRST mutation-lock acquire, before
// the real acquire runs, that REAL command runs to completion in a child — so
// "a concurrent writer lands between the caller's scan and its lock" happens
// every time. The lock itself is not replaced: the original acquire runs next.
// The child's outcome is journaled to VL_TEST_HOOK_JOURNAL.
if (process.env.VL_TEST_BEFORE_FIRST_LOCK) {
  const lifecycle = require('../../lib/provider-lifecycle');
  const realAcquire = lifecycle.acquireMutationLock;
  let fired = false;
  lifecycle.acquireMutationLock = function acquireAfterInterleaving(dir) {
    if (!fired) {
      fired = true;
      const argv = JSON.parse(process.env.VL_TEST_BEFORE_FIRST_LOCK);
      const env = { ...process.env };
      delete env.VL_TEST_BEFORE_FIRST_LOCK;
      const r = cp.spawnSync(process.execPath, [require('path').join(__dirname, '../../bin/vl.js'), ...argv],
        { env, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
      journal(process.env.VL_TEST_HOOK_JOURNAL, JSON.stringify({ argv, status: r.status, stdout: r.stdout }));
    }
    return realAcquire.apply(this, arguments);
  };
}

// An outside actor deleting config.json at an exact publish boundary
// (VL_TEST_DELETE_CONFIG_AT = 'before-move' | 'before-link'). Deterministic, no
// sleeps: the delete happens immediately before the REAL call at that step of
// lib/config.js saveConfig — moving config.json aside, or linking the new
// document in — and the real call then runs unchanged. Journaled to
// VL_TEST_HOOK_JOURNAL.
if (process.env.VL_TEST_DELETE_CONFIG_AT) {
  const path = require('path');
  const at = process.env.VL_TEST_DELETE_CONFIG_AT;
  const outsideDelete = (target) => {
    let removed = false;
    try { fs.unlinkSync(target); removed = true; } catch { /* nothing there */ }
    journal(process.env.VL_TEST_HOOK_JOURNAL, JSON.stringify({ at, removed }));
  };
  // 'before-move' fires at the FIRST publishing step, whichever shape it has:
  // moving config.json aside (the shipped protocol), or renaming a temp file
  // onto config.json (the check-then-rename form it replaced) — so the same
  // test proves the protocol and turns red against the old shape.
  let moved = false;
  const realRename = fs.renameSync;
  fs.renameSync = function renameAtBoundary(from, to) {
    const f = path.basename(String(from));
    const t = path.basename(String(to));
    const firstStep = (f === 'config.json' && t === 'config.json.prev') || (f.startsWith('config.json.tmp.') && t === 'config.json');
    if (at === 'before-move' && !moved && firstStep) {
      moved = true;
      outsideDelete(path.join(path.dirname(String(to)), 'config.json'));
    }
    return realRename.apply(this, arguments);
  };
  const realLink = fs.linkSync;
  fs.linkSync = function linkAtBoundary(from, to) {
    if (at === 'before-link' && path.basename(String(to)) === 'config.json'
        && path.basename(String(from)).startsWith('config.json.tmp.')) {
      outsideDelete(String(to));
    }
    return realLink.apply(this, arguments);
  };
}

// A form server that dies before it listens.
if (process.argv[2] === 'serve' && process.env.VL_TEST_SERVE_EXIT) {
  process.exit(Number(process.env.VL_TEST_SERVE_EXIT));
}
