'use strict';
// Preload for the route-migration CLI cases in test/empty-defaults.test.js.
//
// The migration runs BEFORE config.json exists, so the vault backend it sees
// is the default — macOS Keychain on darwin. A test must never read the
// developer's real Keychain: it would be slow, it would depend on which
// credentials that machine happens to hold, and on this repo's own machine it
// would find real provider keys and report rows the test never set up.
//
// So the credential CHECK is replaced here, and nothing else. bin/vl.js calls
// `vault.probe(id)` on the shared module object, so overwriting that one
// function is enough; `set`, `get` and `remove` keep their real file-backed
// behaviour for the parts of these tests that store credentials.
//
//   VL_FAKE_PRESENT   comma-separated route ids to report as 'present'
//
// Any id not listed is 'absent'. A real probe call would be a bug in these
// tests, so the stub also records that it was asked, letting a test assert the
// migration did NOT re-probe once config.json exists.
const fs = require('fs');
const vault = require('../../lib/vault');

const present = new Set((process.env.VL_FAKE_PRESENT || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean));

const journal = process.env.VL_PROBE_JOURNAL;

vault.probe = (id) => {
  if (journal) {
    try { fs.appendFileSync(journal, `${id}\n`); } catch { /* journal is best-effort */ }
  }
  return present.has(id) ? 'present' : 'absent';
};

// Guard the premise: if lib/vault stops exposing probe, these tests must fail
// loudly rather than silently stub a function nobody calls.
if (typeof vault.get !== 'function' || typeof vault.remove !== 'function') {
  throw new Error('lib/vault no longer has the interface this preload assumes');
}
