'use strict';
// Rejected console-bundle fingerprint: digest-only metadata for the Xiaomi
// Chrome-cookie fallback.
//
// Contract:
//  * The digest is SHA-256 over the canonical, sorted [name, domain, path,
//    expiresAt, value] tuples of the SELECTED bundle — cookie VALUES are part
//    of the digest so a same-length serviceToken or userId rotation produces
//    a different digest and becomes eligible for a fresh request.
//  * Only the hex digest (plus its observation time) is ever persisted, in a
//    private 0600 file inside the owned 0700 metadata directory. No cookie
//    value, name list, or header is written, and the digest itself never
//    appears in config, report, snapshot, or any error output.
//  * Storage safety uses lib/cookies/metadata.js: owned private dirs, unique
//    exclusively-created temps, symlink/foreign/non-regular refusal on
//    read/write/reset. A write or reset that would touch an unsafe path
//    throws MetadataError instead of following it.
//  * A bundle whose digest matches the stored rejection is NOT replayed
//    against the console until Chrome supplies changed cookies. Transport and
//    shape failures never write a rejection.

const path = require('path');
const crypto = require('crypto');
const { readOwnedJson, writeOwnedJson, removeOwnedFile } = require('./metadata');

const DIGEST_RE = /^[0-9a-f]{64}$/;

// Canonical, order-independent digest of the selected bundle (value-sensitive).
function bundleDigest(cookies) {
  const tuples = (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && typeof c === 'object' &&
      typeof c.name === 'string' && typeof c.value === 'string')
    .map((c) => [
      c.name,
      typeof c.domain === 'string' ? c.domain : '',
      typeof c.path === 'string' ? c.path : '/',
      typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt) ? c.expiresAt : null,
      c.value,
    ])
    .sort((a, b) => {
      const x = JSON.stringify(a);
      const y = JSON.stringify(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
  return crypto.createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
}

function stateDir(dataDir) {
  return path.join(dataDir, 'xiaomi');
}

function statePath(dataDir) {
  return path.join(stateDir(dataDir), 'rejected.json');
}

// Returns the stored hex digest, or null (absent/malformed). Throws
// MetadataError when the path exists but is unsafe.
function readRejected(dataDir) {
  const doc = readOwnedJson(statePath(dataDir), stateDir(dataDir));
  if (doc && typeof doc.digest === 'string' && DIGEST_RE.test(doc.digest)) return doc.digest;
  return null;
}

// Persist only { digest, rejectedAt }. Private 0600 file in a 0700 dir;
// refuses unsafe pre-existing paths (throws MetadataError).
function writeRejected(dataDir, digest) {
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) return false;
  return writeOwnedJson(statePath(dataDir), stateDir(dataDir),
    { digest, rejectedAt: new Date().toISOString() });
}

// True when removed, false when genuinely absent. Throws MetadataError on
// unsafe paths (symlinks are never unlinked) AND on any real unlink failure
// (N1: e.g. EACCES in a read-only private dir is never reported as success).
function clearRejected(dataDir) {
  return removeOwnedFile(statePath(dataDir), stateDir(dataDir));
}

module.exports = { bundleDigest, readRejected, writeRejected, clearRejected, statePath, stateDir };
