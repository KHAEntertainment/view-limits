'use strict';
// Synthetic Chrome cookie database builder for the Xiaomi fallback tests.
// Real node:sqlite databases in a temp directory — never the user's store.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// node:sqlite is optional at load time (Node >= 22.5); tests skip cleanly.
let DatabaseSync = null;
let backup = null;
try {
  ({ DatabaseSync, backup } = require('node:sqlite'));
} catch { /* unavailable on this runtime */ }

const HAS_SQLITE = typeof DatabaseSync === 'function' && typeof backup === 'function';

const HOST = 'platform.xiaomimimo.com';
const PASSWORD = 'synthetic-storage-password';
const EPOCH = 11644473600000000n;
const KEY = crypto.pbkdf2Sync(Buffer.from(PASSWORD, 'utf8'), 'saltysalt', 1003, 16, 'sha1');

function encryptValue(version, domain, value) {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16, 32));
  const parts = [];
  if (version >= 24) parts.push(crypto.createHash('sha256').update(domain).digest());
  parts.push(Buffer.from(String(value), 'utf8'));
  const plain = Buffer.concat(parts);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
}

function expiresTicks(ms) {
  if (ms === null || ms === undefined) return 0n;
  return BigInt(Math.trunc(ms)) * 1000n + EPOCH;
}

/**
 * Create a synthetic cookie DB at <dir>/Cookies.
 *
 * add(host, name, { value, encrypted, path, expires, partition }) appends a
 * row. Rows default to an encrypted console-shaped value.
 */
function createCookieDb(dir, { version = 24, partitionColumn = true } = {}) {
  if (!HAS_SQLITE) throw new Error('node-sqlite-unavailable');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'Cookies');
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE meta(key TEXT,value TEXT);
    INSERT INTO meta VALUES('version','${version}');
    CREATE TABLE cookies(host_key TEXT,name TEXT,path TEXT,value TEXT,encrypted_value BLOB,expires_utc INTEGER,is_secure INTEGER${partitionColumn ? ',top_frame_site_key TEXT' : ''});`);
  const insert = db.prepare(
    `INSERT INTO cookies VALUES(${Array(partitionColumn ? 8 : 7).fill('?').join(',')})`,
  );
  const add = (host, name, options = {}) => {
    const encrypted = options.encrypted !== undefined
      ? options.encrypted
      : encryptValue(version, host, options.value !== undefined ? options.value : `synthetic-${name}-secret`);
    insert.run(
      host,
      name,
      options.path || '/',
      '',
      encrypted,
      expiresTicks(options.expires),
      1,
      ...(partitionColumn ? [options.partition || ''] : []),
    );
  };
  return {
    dbPath,
    db,
    add,
    close: () => db.close(),
    walPath: `${dbPath}-wal`,
  };
}

/** The standard console bundle (4 allowlisted rows) in a profile dir. */
function createConsoleFixture(chromeRoot, profile = 'Profile 46', options = {}) {
  const fixture = createCookieDb(path.join(chromeRoot, profile), options);
  fixture.add(`.${HOST}`, 'api-platform_serviceToken', { value: 'synthetic-session-secret-0001' });
  fixture.add('.xiaomimimo.com', 'userId', { value: '1234567890' });
  fixture.add(`.${HOST}`, 'api-platform_ph', { value: 'synthetic-ph-secret' });
  fixture.add(`.${HOST}`, 'api-platform_slh', { value: 'synthetic-slh-secret' });
  return fixture;
}

module.exports = {
  HOST, PASSWORD, KEY, EPOCH, HAS_SQLITE,
  encryptValue, expiresTicks, createCookieDb, createConsoleFixture,
  backup: (...args) => backup(...args),
  DatabaseSync,
};
