'use strict';
// Preload for the credential-misrouting pins (PR #82, CodeRabbit finding A).
// Load AFTER migration-preload.cjs.
//
// Restores the real darwin DEFAULT backend, the Keychain, which is exactly
// what a config.json that cannot be used would fall back to. Every `security`
// invocation is REFUSED, never performed: it is journaled to
// VL_KEYCHAIN_JOURNAL as its subcommand only (never the argv, which carries
// the secret), then throws. So "no credential reached the Keychain" is an
// assertion over the real CLI with nothing of the user's touched.
const fs = require('fs');
const childProcess = require('child_process');

require('../../lib/config').DEFAULTS.vault.backend = 'keychain';

const journalFile = process.env.VL_KEYCHAIN_JOURNAL;
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function refusedSecurity(cmd, args, ...rest) {
  if (cmd === 'security') {
    try { fs.appendFileSync(journalFile, `${Array.isArray(args) ? args[0] : '?'}\n`); } catch { /* best effort */ }
    const e = new Error('keychain access refused by test/fixtures/keychain-tripwire.cjs');
    e.status = 1;
    throw e;
  }
  return realExecFileSync.call(this, cmd, args, ...rest);
};
