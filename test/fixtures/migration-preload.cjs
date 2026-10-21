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
const fs = require('fs');
const cp = require('child_process');

require('../../lib/config').DEFAULTS.vault.backend = 'file';

function journal(file, line) {
  if (!file) return;
  try { fs.appendFileSync(file, `${line}\n`); } catch { /* best effort */ }
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

// A form server that dies before it listens.
if (process.argv[2] === 'serve' && process.env.VL_TEST_SERVE_EXIT) {
  process.exit(Number(process.env.VL_TEST_SERVE_EXIT));
}
