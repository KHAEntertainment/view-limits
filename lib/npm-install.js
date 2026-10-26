'use strict';
// The plugin's runtime dependency install (Issue #103).
//
// The view's live banner is drawn by the `ascii.rest` package (MIT,
// Copyright 2026 bas3line — https://ascii.rest). It is installed into the
// plugin root by a user-invoked `setup` or `update`, through
// `npm ci --omit=dev`.
//
// Contract:
//  * Runs ONLY from a user-invoked setup or update — never during refresh,
//    report, the gate, the hooks, the dashboard or any background path.
//  * It never throws and never fails the command it runs in: a missing npm,
//    a network error, a broken lock file or a timeout is a one-line notice,
//    and the view keeps its static banner.
//  * The install is SKIPPED when the pinned dependency is already installed
//    at the pinned version. `npm ci` wipes node_modules and reinstalls it, so
//    running it on every setup would churn a working install and cost a
//    network round trip for nothing. A missing or stale install is repaired.
//  * The `run` seam exists so tests can drive the flow with a fake runner;
//    production always uses spawnSync('npm', …).

const fs = require('fs');
const path = require('path');

const DEPENDENCY = 'ascii.rest';
const INSTALL_TIMEOUT_MS = 120000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The version the plugin root pins for the dependency, or null when the
// plugin root has no package.json (there is nothing to install against).
function pinnedVersion(pluginRoot) {
  const pkg = readJson(path.join(pluginRoot, 'package.json'));
  const spec = pkg && pkg.dependencies ? pkg.dependencies[DEPENDENCY] : null;
  if (typeof spec !== 'string' || !spec) return null;
  // The pin is exact; a range prefix would only widen the comparison.
  return spec.replace(/^[^\d]*/, '');
}

// The version installed under the plugin root, or null when it is absent.
function installedVersion(pluginRoot) {
  const pkg = readJson(path.join(pluginRoot, 'node_modules', DEPENDENCY, 'package.json'));
  return pkg && typeof pkg.version === 'string' ? pkg.version : null;
}

// True when the dependency is already installed at the pinned version.
function dependencySatisfied(pluginRoot) {
  const pinned = pinnedVersion(pluginRoot);
  if (!pinned) return false;
  const installed = installedVersion(pluginRoot);
  return installed !== null && installed === pinned;
}

function defaultRun({ command, args, cwd }) {
  // Looked up at call time (not destructured at load) so the surrounding
  // process — and the test seams — see one consistent child_process module.
  const { spawnSync } = require('child_process');
  let result;
  try {
    result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS });
  } catch {
    return { status: -1 };
  }
  if (result && result.error) return { status: -1 };
  return { status: typeof result.status === 'number' ? result.status : -1 };
}

/**
 * Install the plugin's runtime dependencies into the plugin root.
 *
 * @param {{pluginRoot:string, run?:Function, force?:boolean}} options
 * @returns {{ok:boolean, status:number, skipped:boolean}} `skipped` is true
 *   when the pinned dependency was already installed and nothing was run.
 */
function installDependencies(options = {}) {
  const pluginRoot = options.pluginRoot;
  if (typeof pluginRoot !== 'string' || !pluginRoot) return { ok: false, status: -1, skipped: false };
  if (options.force !== true && dependencySatisfied(pluginRoot)) {
    return { ok: true, status: 0, skipped: true };
  }
  const run = typeof options.run === 'function' ? options.run : defaultRun;
  const result = run({ command: 'npm', args: ['ci', '--omit=dev'], cwd: pluginRoot });
  const status = result && typeof result.status === 'number' ? result.status : -1;
  return { ok: status === 0, status, skipped: false };
}

module.exports = {
  installDependencies,
  dependencySatisfied,
  pinnedVersion,
  installedVersion,
  DEPENDENCY,
  INSTALL_TIMEOUT_MS,
};
