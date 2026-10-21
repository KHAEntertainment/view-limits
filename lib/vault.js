'use strict';
// Local secret store, keyed by route id. No runtime password-manager calls.
// Credentials enter once via `vl.js setup` (loopback form / stdin / native-file
// auto-import); refresh reads them silently thereafter.
//
//   keychain — macOS Keychain generic-password via `security` (no biometric).
//   file     — AES-256-GCM encrypted blobs keyed by VIEW_LIMITS_MASTER_KEY.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { dataDir, loadConfig } = require('./config');

function vaultCfg() {
  return loadConfig().vault;
}

// ---- keychain ---------------------------------------------------------------

function keychainSet(service, id, secret) {
  execFileSync('security', [
    'add-generic-password', '-U',
    '-a', id,
    '-s', service,
    '-w', secret,
  ]);
}

function keychainGet(service, id) {
  try {
    const out = execFileSync('security', [
      'find-generic-password', '-a', id, '-s', service, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function keychainDelete(service, id) {
  try {
    execFileSync('security', ['delete-generic-password', '-a', id, '-s', service], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Presence WITHOUT reading the secret. `find-generic-password` is run without
// `-w`, so the credential never enters a buffer, a pipe or an error message —
// and the exit status still separates the two cases `get()` cannot:
//
//   0  — the item exists
//   44 — errSecItemNotFound: it provably does not
//   *  — Keychain could not answer (locked, denied, `security` missing), which
//        is NOT absence and must never be reported as one.
function keychainProbe(service, id) {
  try {
    execFileSync('security', ['find-generic-password', '-a', id, '-s', service], { stdio: 'ignore' });
    return 'present';
  } catch (e) {
    return e && e.status === 44 ? 'absent' : 'unreadable';
  }
}

// ---- encrypted-file backend --------------------------------------------------

function masterKey() {
  const fromEnv = process.env.VIEW_LIMITS_MASTER_KEY;
  if (fromEnv) return Buffer.from(fromEnv, 'utf8');
  const keyFile = path.join(dataDir(), 'master.key');
  if (fs.existsSync(keyFile)) {
    const key = fs.readFileSync(keyFile);
    if (key.length) return key;
  }
  const error = new Error('file vault master key is not configured');
  error.code = 'VIEW_LIMITS_MASTER_KEY_REQUIRED';
  throw error;
}

function assertWritable() {
  const v = vaultCfg();
  if (v.backend === 'keychain') return;
  if (v.backend !== 'file') throw new Error(`unsupported vault backend "${v.backend}"`);
  masterKey();
}

function filePath(id) {
  return path.join(dataDir(), 'secrets', `${id}.enc`);
}

function encrypt(secret, key) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(key, salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  });
}

function decrypt(blob, key) {
  const { salt, iv, tag, ct } = JSON.parse(blob);
  const derived = crypto.scryptSync(key, Buffer.from(salt, 'base64'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derived, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

function fileSet(id, secret) {
  const target = filePath(id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temp, encrypt(secret, masterKey()), { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function fileGet(id) {
  try {
    return decrypt(fs.readFileSync(filePath(id), 'utf8'), masterKey());
  } catch {
    return null;
  }
}

function fileDelete(id) {
  try {
    fs.unlinkSync(filePath(id));
    return true;
  } catch {
    return false;
  }
}

// Presence of the blob, deliberately WITHOUT decrypting it. `stat` needs no
// read permission on the file and no master key, so an undecryptable or
// unreadable secret is still reported as present rather than as absent —
// `fileGet` cannot tell those apart, and a wrong answer here would license a
// "credential removed" claim over a secret that is still on disk.
function fileProbe(id) {
  try {
    return fs.statSync(filePath(id)).isFile() ? 'present' : 'unreadable';
  } catch (e) {
    return e && e.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

// ---- public interface ---------------------------------------------------------

function set(id, secret) {
  const v = vaultCfg();
  if (v.backend === 'keychain') keychainSet(v.service, id, secret);
  else fileSet(id, secret);
}

function get(id) {
  const v = vaultCfg();
  if (v.backend === 'keychain') return keychainGet(v.service, id);
  return fileGet(id);
}

function has(id) {
  return !!get(id);
}

// Three-way presence: 'present' | 'absent' | 'unreadable'.
//
// `get()` and `remove()` are both LENIENT by design — each swallows its backend
// error and returns null/false — so neither can support a claim that a secret
// is gone: "nothing there" and "I could not look" come back identical. Only
// 'absent' from this probe proves absence. Callers that report a deletion to a
// user (lib/provider-lifecycle.js) must gate on it; a backend error is reported
// as a failed delete, never as a successful one. An unsupported backend is
// 'unreadable' for the same reason: no proof is not proof.
function probe(id) {
  const v = vaultCfg();
  if (v.backend === 'keychain') return keychainProbe(v.service, id);
  if (v.backend === 'file') return fileProbe(id);
  return 'unreadable';
}

function remove(id) {
  const v = vaultCfg();
  if (v.backend === 'keychain') return keychainDelete(v.service, id);
  return fileDelete(id);
}

module.exports = { set, get, has, probe, remove, assertWritable };
