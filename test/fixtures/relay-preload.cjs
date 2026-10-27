'use strict';
// Test-only: keep the banner install out of the child process.
//
// `vl.js setup` and `vl.js update` start by installing the view's banner
// dependency, which is a real `npm ci` in the plugin root. A relay test has to
// run those commands for their exit-code behavior, so it must not spawn npm,
// touch node_modules or reach the network. It replaces `installDependencies`
// only, and leaves `dependencySatisfied` alone: the commands still take the same
// branch they would take for real, they just do not perform the install, and the
// lines they log about it are the same in a flagged and an unflagged run.
// Installed through NODE_OPTIONS, which runs before bin/vl.js destructures the
// helper.
const path = require('path');
const npmInstall = require(path.join(__dirname, '..', '..', 'lib', 'npm-install'));

const realSatisfied = npmInstall.dependencySatisfied;
npmInstall.installDependencies = () => ({ ok: true, status: 0, skipped: true });
// Guard against a future caller that reads the predicate to decide whether to
// import the banner: it stays the real one, so nothing about the view changes.
if (npmInstall.dependencySatisfied !== realSatisfied) {
  throw new Error('npm-install.dependencySatisfied was expected to stay untouched');
}
