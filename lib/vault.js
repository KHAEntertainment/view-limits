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

function remove(id) {
  const v = vaultCfg();
  if (v.backend === 'keychain') return keychainDelete(v.service, id);
  return fileDelete(id);
}

module.exports = { set, get, has, remove, assertWritable };
