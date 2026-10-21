'use strict';
// Preload for the gate-path case in test/empty-defaults.test.js (PR #82 round 5).
//
// Records every call into the strict config reader, the mutation lock and the
// vault, to VL_STRICT_JOURNAL, so "the PreToolUse gate never takes the lock,
// never reads strictly and never touches the vault" is an assertion over the
// real gate run. bin/vl.js requires all three modules at load time, so a
// static walk of its imports cannot separate the gate's path; this pins the
// path itself.
//
// A recorded vault call is REFUSED, never performed: a regression must show up
// in the journal, not as a real Keychain or vault access. Lock and strict-read
// calls are recorded and then run unchanged.
//
// VL_STRICT_JOURNAL_VAULT=pass journals vault calls and then performs them —
// for commands that legitimately use the vault (report, session-start, check),
// loaded AFTER migration-preload.cjs so the vault is the real file vault.
const fs = require('fs');

const file = process.env.VL_STRICT_JOURNAL;
function journal(name) {
  try { fs.appendFileSync(file, `${name}\n`); } catch { /* best effort */ }
}

const config = require('../../lib/config');
const lock = require('../../lib/lock');

const realStrict = config.loadConfigStrict;
config.loadConfigStrict = function journaledStrict(...a) { journal('loadConfigStrict'); return realStrict.apply(this, a); };
// bin/vl.js and lib/runtime-snapshot.js bind these at load time, after this
// preload, so they bind the journaled versions.
const realRead = config.readConfigText;
config.readConfigText = function journaledRead(opts) {
  if (opts && opts.strict) journal('readConfigText:strict');
  return realRead.call(this, opts);
};
const realReadIn = config.readConfigTextIn;
config.readConfigTextIn = function journaledReadIn(dir, opts) {
  if (opts && opts.strict) journal('readConfigTextIn:strict');
  return realReadIn.call(this, dir, opts);
};
for (const name of ['acquireMutationLock', 'acquireMutationLockWithin']) {
  const real = lock[name];
  lock[name] = function journaledLock(...a) { journal(name); return real.apply(this, a); };
}

// Patched after config, so vault.js (loaded now) binds the journaled strict read.
const vault = require('../../lib/vault');
const passVault = process.env.VL_STRICT_JOURNAL_VAULT === 'pass';
for (const name of ['set', 'get', 'has', 'probe', 'remove']) {
  const real = vault[name];
  vault[name] = function journaledVault(...a) {
    journal(`vault.${name}`);
    if (passVault) return real.apply(this, a);
    throw new Error('vault access refused by strict-journal');
  };
}
