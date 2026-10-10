'use strict';
// Xiaomi live fallback session — the vault-free orchestrator for one
// report/check/refresh operation:
//
//   1. validate the configured Chrome source/profile (config metadata only),
//   2. read the selected profile's console cookies EXACTLY ONCE,
//   3. build the endpoint cookie headers (minimal pair for usage, full
//      console bundle for detail),
//   4. skip the console entirely when the bundle digest matches the stored
//      rejection (never replay rejected credentials),
//   5. perform at most ONE usage/detail pair through lib/adapters/xiaomi.js,
//   6. classify every failure into a fixed message — never a cookie value,
//      body, header, transport error text, or directory path,
//   7. persist ONLY digest-only rejected-bundle metadata (private 0600).
//
// No legacy vault has/get/set/remove, no SSO, no account cookies, no browser.
// The Chrome Safe Storage key comes from the reviewed non-interactive
// keychain bridge (lazy ESM import — Node 18 installs never load it); a
// deterministic key failure is suppressed until setup runs again. Round 4:
// grantInteractiveKey() is the interactive variant, used ONLY by explicit
// setup/update — the user answers the macOS dialog ("Always Allow"), and the
// background paths above never prompt. Suppression uses
// lib/cookies/metadata.js: owned private dirs, exclusive temps,
// symlink/foreign refusal (F2).

const fs = require('fs');
const path = require('path');
const { buildStatus } = require('./normalize');
const { dataDir } = require('./config');
const {
  loadConsoleCookies, cookieHeader, validProfile, ChromeError,
} = require('./cookies/chrome');
const { bundleDigest, readRejected, writeRejected, clearRejected, statePath } = require('./cookies/fingerprint');
const { MetadataError, readOwnedJson, writeOwnedJson, removeOwnedFile } = require('./cookies/metadata');
const xiaomiAdapter = require('./adapters/xiaomi');

const XIAOMI_PROVIDER = 'xiaomi';
const XIAOMI_ROUTE_ID = 'xiaomi-token-plan';
const DASHBOARD_URL = 'https://platform.xiaomimimo.com/';
const PENDING_MESSAGE = 'refresh in progress — live Xiaomi usage not fetched (no cached counts shown)';

// Classified, fixed error strings. Every Xiaomi failure surfaces through this
// table; no interpolation of provider/transport/filesystem data ever happens.
const MESSAGES = Object.freeze({
  // platform / runtime
  'macos-only': 'Chrome cookie fallback requires macOS',
  'node-sqlite-unavailable': 'Node with node:sqlite (22.5+) is required for the Chrome cookie fallback',
  // chrome store
  'chrome-source-not-configured': 'Chrome cookie source not configured — run /view-limits:setup xiaomi-token-plan',
  'invalid-chrome-profile': 'configured Chrome profile is invalid — rerun /view-limits:setup xiaomi-token-plan',
  'cookie-db-not-found': 'chrome cookie store unreadable',
  'cookie-db-unreadable': 'chrome cookie store unreadable',
  'cookie-db-version-missing': 'chrome cookie store unreadable',
  'console-cookie-rows-missing': `console cookies missing — open ${DASHBOARD_URL} in Chrome and log in`,
  'console-credentials-missing': `console cookies missing or locally expired — open ${DASHBOARD_URL} in Chrome and log in`,
  'unsupported-cookie-encryption': 'unsupported Chrome cookie encryption',
  'cookie-decryption-failed': 'console cookie decryption failed',
  'cookie-host-hash-mismatch': 'console cookie host validation failed',
  'invalid-cookie-value': 'console cookie store returned an invalid value',
  // key / helper (deterministic failures are suppressed until setup reruns)
  'keychain-unavailable': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-helper-missing': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-guard-failed': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-denied': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-restore-failed': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-cleanup-failed': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-no-private-pipe': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-protocol-error': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-bad-arguments': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-interactive-refused': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-helper-exit': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-no-frames': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-bad-frame': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-stdout-unexpected': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-stderr-unexpected': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  // F6: the bridge's actual exported failure enums, exhaustively mapped.
  'bridge-spawn-failed': 'Chrome key helper could not start — rerun /view-limits:setup xiaomi-token-plan',
  'bridge-internal': 'Chrome key helper failed — rerun /view-limits:setup xiaomi-token-plan',
  // bridge-timeout is RETRIABLE (see RETRIABLE_KEY_CODES): transient, so it is
  // never suppressed, but it still needs an actionable fixed message.
  'bridge-timeout': 'Chrome key helper timed out — retry, or rerun /view-limits:setup xiaomi-token-plan if this persists',
  'ok': 'Chrome key helper returned an unexpected result — rerun /view-limits:setup xiaomi-token-plan',
  'guard-failed': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'denied': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'restore-failed': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'cleanup-failed': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'no-private-pipe': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'protocol-error': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'bad-arguments': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'payload-too-large': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  'runtime-error': 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan',
  // transport (fixed enums from lib/cookies/http-get.js + adapter)
  'console-request-failed': 'console request failed',
  'console-request-timeout': 'console request timed out',
  'response-too-large': 'console response exceeded the size limit',
  'console-redirect-stopped': 'console request was redirected — stopped without following',
  'console-http-error': 'console request failed',
  'console-response-not-json': 'console response not recognized',
  'console-envelope-error': 'console response not recognized',
  'url-not-allowlisted': 'console request blocked by URL allowlist',
  'cookie-header-invalid': 'console cookies unavailable for the request',
  // F2: unsafe owned-metadata state (symlink/foreign/non-regular) — refused,
  // never followed; recovery is a manual removal, so no path is echoed.
  'metadata-unsafe': 'Xiaomi private state is unsafe — delete the xiaomi folder under the view-limits data directory, then rerun /view-limits:setup xiaomi-token-plan',
  // N1: a REAL unlink failure (e.g. an owned 0500 dir holding the suppression
  // file) is a classified refusal, not an absence — reset did not succeed, so
  // setup/update/remove must not save config or print their success message.
  'metadata-remove-failed': 'Xiaomi private state could not be cleared — the xiaomi folder under the view-limits data directory is not writable; make it writable or delete it, then rerun /view-limits:setup xiaomi-token-plan',
});

const DEFAULT_ERROR = 'console status unavailable';

function message(code) {
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) ? MESSAGES[code] : DEFAULT_ERROR;
}

// Deterministic key/helper failures: Chrome is not retried until setup runs
// (the design failure-table row "Chrome is not retried until setup reruns").
// F6: suppression is an explicit per-code decision.
//   * SUPPRESSED — deterministic failures that only setup/update can fix:
//     every code here EXCEPT the retriable ones below.
//   * RETRIABLE (never suppressed): `bridge-timeout` — a transient helper
//     timeout must be retried on the next operation, not gated behind setup.
//     It is kept out of this set deliberately and covered by a regression.
const KEY_FAILURE_CODES = new Set([
  'keychain-unavailable',
  'bridge-helper-missing', 'bridge-guard-failed', 'bridge-denied', 'bridge-restore-failed',
  'bridge-cleanup-failed', 'bridge-no-private-pipe', 'bridge-protocol-error', 'bridge-bad-arguments',
  'bridge-interactive-refused', 'bridge-helper-exit', 'bridge-no-frames', 'bridge-bad-frame',
  'bridge-stdout-unexpected', 'bridge-stderr-unexpected',
  // F6: deterministic spawn/internal failures suppress until setup/update.
  'bridge-spawn-failed', 'bridge-internal',
  'guard-failed', 'denied', 'restore-failed', 'cleanup-failed', 'no-private-pipe',
  'protocol-error', 'bad-arguments', 'payload-too-large', 'runtime-error',
]);

// Explicitly retriable helper failures: never suppressed (see F6 decision).
const RETRIABLE_KEY_CODES = new Set(['bridge-timeout']);

function isKeyFailure(code) {
  if (RETRIABLE_KEY_CODES.has(code)) return false;
  return KEY_FAILURE_CODES.has(code);
}

function isXiaomiRoute(route) {
  return !!route && typeof route === 'object' && route.provider === XIAOMI_PROVIDER;
}

function isXiaomiRouteId(id) {
  return id === XIAOMI_ROUTE_ID;
}

// Config metadata only — no Chrome, Keychain, or vault access.
function sourceConfigured(cfg) {
  const x = cfg && typeof cfg === 'object' ? cfg.xiaomi : null;
  return !!x && typeof x === 'object' &&
    typeof x.chromeSource === 'string' && x.chromeSource.length > 0 &&
    validProfile(x.chromeProfile);
}

// ---- status builders ---------------------------------------------------------

function authStatus(profile) {
  const reauth = { reason: 'auth-expired', url: DASHBOARD_URL };
  if (typeof profile === 'string' && validProfile(profile)) reauth.profile = profile;
  return buildStatus({ unknown: true, windows: [], detail: { reauth } });
}

function errorStatus(text) {
  return buildStatus({ unknown: true, windows: [], detail: { error: text } });
}

function pendingStatus() {
  return buildStatus({ unknown: true, windows: [], detail: { error: PENDING_MESSAGE, pending: true } });
}

// F2: an unsafe metadata path (symlink/foreign/non-regular) refuses the whole
// operation with one fixed actionable message; nothing is followed or read.
function unsafeStatus() {
  return errorStatus(message('metadata-unsafe'));
}

// ---- key-failure suppression (cleared by setup/update) ------------------------
// Storage goes through lib/cookies/metadata.js (F2): owned private directory,
// unique exclusively-created temp, symlink/foreign/non-regular refusal on
// read/write/unlink. Unsafe paths throw MetadataError (mapped to a fixed
// message); absent state is a plain false/null.

function suppressionDir(root) {
  return path.join(root, 'xiaomi');
}

function suppressionPath(root) {
  return path.join(suppressionDir(root), 'key-suppressed.json');
}

function readSuppressed(root) {
  const doc = readOwnedJson(suppressionPath(root), suppressionDir(root));
  return !!(doc && typeof doc.code === 'string' && doc.code.length);
}

function writeSuppressed(root, code) {
  return writeOwnedJson(suppressionPath(root), suppressionDir(root),
    { code: String(code), at: new Date().toISOString() });
}

function clearSuppressed(root) {
  return removeOwnedFile(suppressionPath(root), suppressionDir(root));
}

// Setup/update/remove call this: drop both private metadata files.
function resetXiaomiState(root) {
  const clearedRejected = clearRejected(root);
  const clearedSuppressed = clearSuppressed(root);
  return clearedRejected || clearedSuppressed;
}

// Round 5 (P2-1): READ-ONLY prevalidation for the reset above. Refuses an
// unsafe metadata path (the exact refusals the reset itself makes) or a
// directory whose files could not be unlinked (owned 0500: readable, not
// writable) — before any interactive prompt is raised. Mutates nothing and
// cannot promise unlink success (a same-UID race can still change things;
// the reset re-checks everything), but it catches the deterministic cases
// without making the user click a dialog for a command that must fail.
function prevalidateXiaomiStateForReset(root) {
  const dir = suppressionDir(root);
  readOwnedJson(suppressionPath(root), dir); // dir + stored file validation (null when absent)
  readOwnedJson(statePath(root), dir); // rejected-bundle digest — same dir
  let dirExists = true;
  try {
    fs.statSync(dir);
  } catch {
    dirExists = false; // nothing stored yet — nothing to unlink
  }
  if (dirExists) {
    try {
      fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); // unlink needs write+search
    } catch {
      throw new MetadataError('metadata-remove-failed');
    }
  }
}

// ---- key acquisition (background: non-interactive only) -----------------------

function bridgeError(code) {
  const error = new Error(code); // enum only
  error.code = code;
  return error;
}

// Lazy ESM import so Node 18 installs never load the bridge unless a Xiaomi
// refresh actually runs. Never interactive: background reads must not prompt.
async function loadBridge() {
  try {
    return await import('./cookies/keychain-bridge.mjs');
  } catch {
    throw bridgeError('bridge-helper-missing');
  }
}

async function defaultPasswordReader(root) {
  const helperPath = path.join(root, 'bin', 'kh-helper');
  const bridge = await loadBridge();
  const result = await bridge.acquireKey({ helperPath, timeoutMs: 5000 });
  if (!result || result.ok !== true) {
    const described = bridge.describeResult(result);
    throw bridgeError(typeof described.code === 'string' && described.code ? described.code : 'bridge-internal');
  }
  // SECRET-BEARING: chrome.loadConsoleCookies wipes this buffer after use.
  return result.secret;
}

// Interactive key grant — EXPLICIT setup/update only (round 4). The macOS
// dialog is answered by the USER ("Always Allow" persists the ACL that the
// non-interactive background reads later rely on); this code never automates
// or bypasses it. The granted secret is discarded and wiped — the grant, not
// the key, is the product of this call. `deps.bridge` is a synthetic-bridge
// seam for tests; production lazy-imports the reviewed bridge. The bridge
// itself refuses `interactive:true` unless purpose is exactly
// 'interactive-setup', and caps the timeout at 60 s for a human click.
async function grantInteractiveKey(root, deps = {}) {
  const helperPath = path.join(root, 'bin', 'kh-helper');
  const bridge = deps.bridge || await loadBridge();
  const result = await bridge.acquireKey({
    helperPath,
    interactive: true,
    purpose: 'interactive-setup',
    timeoutMs: 60000,
  });
  if (!result || result.ok !== true) {
    const described = bridge.describeResult(result);
    throw bridgeError(typeof described.code === 'string' && described.code ? described.code : 'bridge-internal');
  }
  // Round 5 hardening: a success MUST carry a nonempty Buffer secret — a
  // malformed success is a classified failure, never a silent pass (the
  // reviewed bridge always validates this; defense-in-depth).
  if (!Buffer.isBuffer(result.secret) || result.secret.length === 0) {
    throw bridgeError('bridge-internal');
  }
  // SECRET-BEARING success payload we do not need: wipe before returning.
  result.secret.fill(0);
  return true;
}

// ---- the operation ------------------------------------------------------------

/**
 * Fetch current Xiaomi usage for one operation.
 *
 * @param {object} cfg effective config (cfg.xiaomi carries source/profile).
 * @param {object} route the configured xiaomi route (unused beyond identity).
 * @param {object} [ctx] { threshold?, xiaomiDeps? } — xiaomiDeps is the
 *   dependency seam ({ dataDir, platform, tempRoot, sqlite, passwordReader,
 *   transport, consoleGet }) for synthetic tests.
 * @returns {Promise<object>} NormalizedStatus — never throws.
 */
async function fetchStatus(cfg, route, ctx = {}) {
  const deps = ctx.xiaomiDeps && typeof ctx.xiaomiDeps === 'object' ? ctx.xiaomiDeps : {};
  const root = typeof deps.dataDir === 'string' && deps.dataDir.length ? deps.dataDir : dataDir();
  const profile = cfg && cfg.xiaomi ? cfg.xiaomi.chromeProfile : undefined;
  const source = cfg && cfg.xiaomi ? cfg.xiaomi.chromeSource : undefined;

  if (!sourceConfigured(cfg)) return errorStatus(message('chrome-source-not-configured'));

  // F2: every metadata touch is guarded — an unsafe path refuses the
  // operation instead of following it. fetchStatus never throws.
  let suppressed;
  try {
    suppressed = readSuppressed(root);
  } catch {
    return unsafeStatus();
  }
  if (suppressed) return errorStatus(message('keychain-unavailable'));

  let bundle;
  try {
    bundle = await loadConsoleCookies(
      { chromeSource: source, chromeProfile: profile, platform: deps.platform },
      {
        passwordReader: typeof deps.passwordReader === 'function'
          ? deps.passwordReader
          : () => defaultPasswordReader(root),
        tempRoot: deps.tempRoot,
        sqlite: deps.sqlite,
      },
    );
  } catch (e) {
    const code = e instanceof ChromeError || (e && typeof e.code === 'string') ? e.code : 'cookie-db-unreadable';
    if (code === 'console-cookie-rows-missing' || code === 'console-credentials-missing') {
      return authStatus(profile); // no usable console bundle in the profile
    }
    if (isKeyFailure(code)) {
      // Best-effort marker write: a refusal here (only a same-UID race can
      // cause it right after a successful read above) never masks the real,
      // classified key failure we are about to report.
      try { writeSuppressed(root, code); } catch { /* state unsafe — already reported below */ }
    }
    return errorStatus(message(code));
  }

  const cookies = bundle.cookies;
  const digest = bundleDigest(cookies);
  // Known rejected bundle: not replayed until Chrome supplies changed cookies.
  let rejected;
  try {
    rejected = readRejected(root);
  } catch {
    return unsafeStatus();
  }
  if (rejected === digest) return authStatus(profile);

  let usageCookie;
  let detailCookie;
  try {
    usageCookie = cookieHeader(cookies, 'usage', { minimal: true });
    detailCookie = cookieHeader(cookies, 'detail');
  } catch (e) {
    const code = e instanceof ChromeError || (e && typeof e.code === 'string') ? e.code : 'cookie-header-invalid';
    if (code === 'console-credentials-missing') return authStatus(profile);
    return errorStatus(message(code));
  }

  const adapterCtx = { ...ctx };
  if (deps.transport) adapterCtx.transport = deps.transport;
  if (deps.consoleGet) adapterCtx.consoleGet = deps.consoleGet;
  delete adapterCtx.xiaomiDeps;

  try {
    const status = await xiaomiAdapter.fetchStatus(
      cfg,
      { usageCookie, detailCookie },
      adapterCtx,
    );
    // Best-effort cleanup: drop a stale rejection once both endpoints accepted
    // this bundle. A refusal cannot invalidate the counts we are returning —
    // the metadata dir was validated at operation start (F2).
    try { clearRejected(root); } catch { /* next operation refuses if unsafe */ }
    return status;
  } catch (e) {
    if (e && e.kind === 'auth') {
      try {
        writeRejected(root, digest); // persist digest only — never the values
      } catch {
        // F2: recording the rejection is what keeps the replay guard working.
        // If the state path is unsafe we refuse loudly instead of pretending
        // the only problem is an expired session.
        return unsafeStatus();
      }
      return authStatus(profile);
    }
    const code = e && typeof e.code === 'string' && e.code ? e.code : 'console-request-failed';
    return errorStatus(message(code));
  }
}

module.exports = {
  XIAOMI_PROVIDER, XIAOMI_ROUTE_ID, DASHBOARD_URL, PENDING_MESSAGE, MESSAGES, DEFAULT_ERROR,
  fetchStatus, message, sourceConfigured, isXiaomiRoute, isXiaomiRouteId,
  authStatus, errorStatus, pendingStatus,
  readSuppressed, writeSuppressed, clearSuppressed, resetXiaomiState,
  prevalidateXiaomiStateForReset, grantInteractiveKey,
};
