'use strict';
// Read-only acquisition of the SELECTED Chrome profile's console cookies on
// macOS. Transport-neutral: no Keychain/bridge calls live here — the caller
// supplies a passwordReader seam.
//
// Contract:
//  * macOS only; `node:sqlite` is loaded lazily so Node 18 installs that never
//    take this path keep working.
//  * The profile must be explicitly `Default` or `Profile <n>` — no scanning
//    of other profiles, no directory path ever appears in an error.
//  * One read = one private temp dir (0700) + one read-only SQLite backup
//    (includes committed WAL data via node:sqlite backup()) + a 0600 snapshot,
//    recursively removed on success, schema failure, and missing source.
//  * Pre-decryption SQL allowlist: only console host_key × name rows (plus an
//    empty partition key when the column exists) are selected. Account rows
//    (passToken, .account.xiaomi.com, deviceId, …) are never queried into the
//    result and never decrypted.
//  * Values: `v10` prefix → AES-128-CBC with the PBKDF2-SHA1('saltysalt',
//    1003, 16 bytes) key; DB version >= 24 requires a matching SHA-256 host
//    hash prefix (stripped after verification). Any other prefix/shape fails
//    closed with a classified code. Callers wipe the password and the key.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URLS } = require('./http-get');

const HOST = 'platform.xiaomimimo.com';
const DOMAINS = Object.freeze([HOST, `.${HOST}`, '.xiaomimimo.com']);
const NAMES = Object.freeze([
  'api-platform_serviceToken',
  'userId',
  'api-platform_ph',
  'api-platform_slh',
]);
// The verified minimal pair for /usage (serviceToken + userId).
const MINIMAL = Object.freeze(NAMES.slice(0, 2));
const PROFILE_RE = /^(Default|Profile \d+)$/;
const VALUE_RE = /^[\x21-\x3a\x3c-\x7e]{1,4096}$/;
// Windows FILETIME epoch for cookie expires_utc (100ns ticks since 1601-01-01).
const EPOCH = 11644473600000000n;

class ChromeError extends Error {
  constructor(code) {
    super(code); // classified enum only — never a path, body, or cookie value
    this.code = code;
  }
}

function validProfile(profile) {
  return typeof profile === 'string' && PROFILE_RE.test(profile);
}

// Lazy, guarded loader: never runs at module load (Node 18 compatibility).
function loadSqlite() {
  let mod;
  try {
    mod = require('node:sqlite');
  } catch {
    throw new ChromeError('node-sqlite-unavailable');
  }
  if (typeof mod.DatabaseSync !== 'function' || typeof mod.backup !== 'function') {
    throw new ChromeError('node-sqlite-unavailable');
  }
  return mod;
}

function assertPlatform(platform) {
  if ((platform === undefined ? process.platform : platform) !== 'darwin') {
    throw new ChromeError('macos-only');
  }
}

// expires_utc: 0 (session cookie) or absent → null; otherwise ms epoch.
function expiresAtOf(raw) {
  if (raw === null || raw === undefined) return null;
  let ticks;
  try {
    ticks = typeof raw === 'bigint' ? raw : BigInt(Math.trunc(Number(raw)));
  } catch {
    return null;
  }
  if (ticks <= 0n) return null;
  const ms = Number((ticks - EPOCH) / 1000n);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Take a private read-only snapshot of the console cookie rows and return
 * the raw allowlisted rows plus the DB meta version. Decryption happens
 * later — only rows that passed the SQL allowlist ever reach it.
 *
 * @param {string} dbPath cookie database path.
 * @param {{tempRoot?:string, sqlite?:object, platform?:string}} [options]
 * @returns {Promise<{version:number, rows:Array}>}
 * @throws {ChromeError} classified enum code only.
 */
async function readConsoleRows(dbPath, options = {}) {
  assertPlatform(options.platform);
  if (typeof dbPath !== 'string' || dbPath.length === 0) throw new ChromeError('cookie-db-not-found');
  const mod = options.sqlite || loadSqlite();
  if (typeof mod.DatabaseSync !== 'function' || typeof mod.backup !== 'function') {
    throw new ChromeError('node-sqlite-unavailable');
  }
  const tempRoot = typeof options.tempRoot === 'string' && options.tempRoot ? options.tempRoot : os.tmpdir();

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(tempRoot, 'xiaomi-console-'));
    fs.chmodSync(dir, 0o700);
  } catch {
    throw new ChromeError('cookie-db-unreadable');
  }

  let source = null;
  let snapshot = null;
  try {
    source = new mod.DatabaseSync(dbPath, { readOnly: true, timeout: 3000 });
    const copy = path.join(dir, 'Cookies');
    await mod.backup(source, copy); // committed WAL data included
    source.close();
    source = null;
    fs.chmodSync(copy, 0o600);
    snapshot = new mod.DatabaseSync(copy, { readOnly: true });

    const versionRow = snapshot.prepare("SELECT value FROM meta WHERE key='version'").get();
    const version = Number(versionRow && versionRow.value);
    if (!Number.isInteger(version) || version < 1) throw new ChromeError('cookie-db-version-missing');

    const columns = new Set(
      snapshot.prepare('PRAGMA table_info(cookies)').all().map((c) => c.name),
    );
    // Pre-decryption allowlist: console hosts × console names × unpartitioned.
    const partition = columns.has('top_frame_site_key') ? " AND top_frame_site_key=''" : '';
    const query = snapshot.prepare(
      `SELECT host_key,name,path,value,encrypted_value,expires_utc,is_secure FROM cookies
       WHERE host_key IN (${DOMAINS.map(() => '?').join(',')})
         AND name IN (${NAMES.map(() => '?').join(',')})${partition}`,
    );
    if (typeof query.setReadBigInts === 'function') query.setReadBigInts(true);
    const rows = query.all(...DOMAINS, ...NAMES);
    return { version, rows };
  } catch (e) {
    throw e instanceof ChromeError ? e : new ChromeError('cookie-db-unreadable');
  } finally {
    try {
      if (snapshot) snapshot.close();
    } finally {
      try {
        if (source) source.close();
      } finally {
        try {
          if (dir) fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* best effort */ }
      }
    }
  }
}

/**
 * Decrypt one allowlisted row. v10 AES-128-CBC; DB version >= 24 verifies and
 * strips the 32-byte SHA-256 host hash. Everything else fails closed.
 * Wipes its plaintext buffers on every path.
 */
function decryptCookie(row, version, key) {
  if (!row || typeof row !== 'object') throw new ChromeError('cookie-decryption-failed');
  if (!Buffer.isBuffer(key) || key.length === 0) throw new ChromeError('keychain-unavailable');
  const encrypted = row.encrypted_value === null || row.encrypted_value === undefined
    ? Buffer.alloc(0) : Buffer.from(row.encrypted_value);
  let plain = null;
  try {
    if (!encrypted.length) {
      plain = Buffer.from(typeof row.value === 'string' ? row.value : '', 'utf8');
    } else {
      if (encrypted.length < 3 || encrypted.subarray(0, 3).toString('utf8') !== 'v10') {
        throw new ChromeError('unsupported-cookie-encryption');
      }
      let updateOut = null;
      let finalOut = null;
      try {
        const cipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 32));
        try {
          // F5: both intermediate allocations are retained so every byte the
          // cipher produced is wiped — including when final() throws (bad
          // padding / wrong key), where update() output already exists.
          updateOut = cipher.update(encrypted.subarray(3));
          finalOut = cipher.final();
          plain = Buffer.concat([updateOut, finalOut]);
        } finally {
          if (updateOut && typeof updateOut.fill === 'function') updateOut.fill(0);
          if (finalOut && typeof finalOut.fill === 'function') finalOut.fill(0);
          updateOut = null;
          finalOut = null;
        }
      } catch {
        throw new ChromeError('cookie-decryption-failed');
      }
      if (version >= 24) {
        const expected = crypto.createHash('sha256').update(String(row.host_key || '')).digest();
        if (plain.length < 32 || !crypto.timingSafeEqual(expected, plain.subarray(0, 32))) {
          throw new ChromeError('cookie-host-hash-mismatch');
        }
        const value = Buffer.from(plain.subarray(32));
        plain.fill(0); // replaced allocation is wiped
        plain = value;
      }
    }
    const value = plain.toString('utf8');
    if (!VALUE_RE.test(value)) throw new ChromeError('invalid-cookie-value');
    return value;
  } catch (e) {
    throw e instanceof ChromeError ? e : new ChromeError('cookie-decryption-failed');
  } finally {
    encrypted.fill(0);
    if (plain) plain.fill(0);
  }
}

// RFC-ish scope check: console name + matching host + path match + unexpired.
function usable(cookie, url, now) {
  if (!cookie || typeof cookie !== 'object') return false;
  if (!NAMES.includes(cookie.name)) return false;
  if (!DOMAINS.includes(cookie.domain)) return false;
  const expiresAt = cookie.expiresAt;
  if (expiresAt !== null && expiresAt !== undefined) {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) return false;
  }
  const cookiePath = typeof cookie.path === 'string' && cookie.path ? cookie.path : '/';
  const pathname = url.pathname;
  return pathname === cookiePath ||
    (pathname.startsWith(cookiePath) && (cookiePath.endsWith('/') || pathname[cookiePath.length] === '/'));
}

/**
 * Build the Cookie header for one console endpoint.
 * `minimal: true` restricts to the verified usage pair (serviceToken + userId).
 * Throws if the minimal pair is not present/eligible or a value is malformed.
 *
 * @param {Array} cookies loaded console cookies.
 * @param {'usage'|'detail'} kind endpoint selector.
 * @param {{minimal?:boolean, now?:number}} [options]
 * @throws {ChromeError} classified enum only.
 */
function cookieHeader(cookies, kind, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(URLS, kind)) throw new ChromeError('url-not-allowlisted');
  const url = new URL(URLS[kind]);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const minimal = options.minimal === true;
  const list = Array.isArray(cookies) ? cookies : [];
  const eligible = list.filter((c) => usable(c, url, now) && (!minimal || MINIMAL.includes(c.name)));
  for (const cookie of eligible) {
    if (typeof cookie.value !== 'string' || !VALUE_RE.test(cookie.value)) {
      throw new ChromeError('invalid-cookie-value');
    }
  }
  for (const name of MINIMAL) {
    if (!eligible.some((c) => c.name === name)) throw new ChromeError('console-credentials-missing');
  }
  return eligible
    .slice()
    .sort((a, b) => ((b.path || '/').length - (a.path || '/').length))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Load the selected profile's console cookies: locate the DB (Cookies or
 * Network/Cookies under the explicit profile), snapshot it privately, select
 * allowlisted rows only, decrypt, and return in-memory cookies. The password
 * buffer and derived key are wiped here; caller wipes returned values.
 *
 * @param {{chromeSource:string, chromeProfile:string, platform?:string}} source
 * @param {{passwordReader:Function, tempRoot?:string, sqlite?:object, now?:number}} deps
 * @throws {ChromeError} classified enum only — never a directory path.
 */
async function loadConsoleCookies(source, deps = {}) {
  const options = source && typeof source === 'object' ? source : {};
  const depsObj = deps && typeof deps === 'object' ? deps : {};
  assertPlatform(options.platform);
  if (typeof options.chromeSource !== 'string' || options.chromeSource.length === 0) {
    throw new ChromeError('chrome-source-not-configured');
  }
  if (!validProfile(options.chromeProfile)) throw new ChromeError('invalid-chrome-profile');

  let dbPath = null;
  for (const relative of ['Cookies', 'Network/Cookies']) {
    const candidate = path.join(options.chromeSource, options.chromeProfile, relative);
    try {
      if (fs.statSync(candidate).isFile()) {
        dbPath = candidate;
        break;
      }
    } catch { /* try the next known path */ }
  }
  if (!dbPath) throw new ChromeError('cookie-db-not-found');

  const { version, rows } = await readConsoleRows(dbPath, {
    tempRoot: depsObj.tempRoot,
    sqlite: depsObj.sqlite,
    platform: options.platform,
  });

  let password = null;
  let key = null;
  try {
    if (!rows.length) throw new ChromeError('console-cookie-rows-missing');
    const names = new Set(rows.map((r) => r.name));
    for (const name of MINIMAL) {
      if (!names.has(name)) throw new ChromeError('console-credentials-missing');
    }
    if (typeof depsObj.passwordReader !== 'function') throw new ChromeError('keychain-unavailable');
    password = await depsObj.passwordReader();
    if (!Buffer.isBuffer(password) || password.length === 0) throw new ChromeError('keychain-unavailable');
    key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const now = Number.isFinite(depsObj.now) ? depsObj.now : Date.now();
    const cookies = [];
    for (const row of rows) {
      cookies.push({
        name: row.name,
        domain: row.host_key,
        path: row.path,
        expiresAt: expiresAtOf(row.expires_utc),
        value: decryptCookie(row, version, key),
      });
    }
    // Keep only locally-unexpired rows in the returned bundle; expired rows
    // never reach header construction. (Scope filtering happens per-URL.)
    return { version, cookies: cookies.filter((c) => c.expiresAt === null || c.expiresAt > now) };
  } finally {
    if (Buffer.isBuffer(password)) password.fill(0);
    if (Buffer.isBuffer(key)) key.fill(0);
    for (const row of rows) {
      row.value = '';
      if (row.encrypted_value && typeof row.encrypted_value.fill === 'function') row.encrypted_value.fill(0);
    }
  }
}

module.exports = {
  HOST, DOMAINS, NAMES, MINIMAL, PROFILE_RE,
  ChromeError, validProfile, loadSqlite, readConsoleRows, decryptCookie,
  cookieHeader, loadConsoleCookies, usable, expiresAtOf,
};
