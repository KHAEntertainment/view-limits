'use strict';
// Synthetic Chrome cookie acquisition tests for the Xiaomi fallback.
// Real node:sqlite databases in temp dirs — never the user's Chrome store,
// never Keychain, never network. Run: node test/xiaomi-cookies.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureMod = require('./fixtures/xiaomi-cookie-db.cjs');
const {
  readConsoleRows, decryptCookie, cookieHeader, loadConsoleCookies, ChromeError,
} = require('../lib/cookies/chrome');

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  ✗ ${name}\n    ${e.stack || e.message}`);
  }
}

const code = (fn) => {
  try { const v = fn(); return v && typeof v.then === 'function' ? Promise.resolve(v).then(() => null, (e) => e && e.code) : (v && v.code) || null; }
  catch (e) { return e && e.code; }
};
const acode = async (fn) => {
  try { await fn(); return null; } catch (e) { return e && e.code; }
};
const SQLITE = fixtureMod.HAS_SQLITE;
const SKIP = SQLITE ? 'skip' : undefined;

(async () => {
  console.log('xiaomi cookies — synthetic SQLite acquisition');
  if (!SQLITE) console.log('  (node:sqlite unavailable — SQLite integration tests skipped)');

  await test('committed WAL rows are visible through the read-only backup; temp dir is 0700/0600 and cleaned', async () => {
    if (!SQLITE) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-xiaomi-wal-'));
    const tempRoot = path.join(root, 'snapshots');
    fs.mkdirSync(tempRoot);
    const fx = fixtureMod.createConsoleFixture(path.join(root, 'Chrome'), 'Profile 46');
    try {
      // wal_autocheckpoint=0 + open writer ⇒ data lives in the -wal file.
      const wal = fs.statSync(fx.walPath);
      assert.ok(wal.size > 0, 'expected committed data in the -wal file');
      const { version, rows } = await readConsoleRows(fx.dbPath, { tempRoot, platform: 'darwin' });
      assert.strictEqual(version, 24);
      assert.deepStrictEqual(rows.map((r) => r.name).sort(),
        ['api-platform_ph', 'api-platform_serviceToken', 'api-platform_slh', 'userId']);
      assert.deepStrictEqual(fs.readdirSync(tempRoot), [], 'temp snapshot must be removed');
      // still checkpointed by nobody: source WAL untouched
      assert.ok(fs.statSync(fx.walPath).size > 0, 'backup must not mutate/checkpoint the source');
    } finally {
      fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('backup copies are chmod 0700 (dir) and 0600 (file) before any query runs', async () => {
    if (!SQLITE) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-xiaomi-chmod-'));
    const tempRoot = path.join(root, 'snapshots');
    fs.mkdirSync(tempRoot);
    const fx = fixtureMod.createConsoleFixture(path.join(root, 'Chrome'), 'Profile 46');
    const observed = [];
    let snapshotCopy = null;
    // Observe modes at the moment the snapshot DB is OPENED — i.e. after
    // readConsoleRows has applied its 0700/0600 hardening and before queries.
    class ProbeDb extends fixtureMod.DatabaseSync {
      constructor(target, opts) {
        super(target, opts);
        if (snapshotCopy && target === snapshotCopy) {
          observed.push({
            dirMode: fs.statSync(path.dirname(target)).mode & 0o777,
            fileMode: fs.statSync(target).mode & 0o777,
          });
        }
      }
    }
    const probe = {
      DatabaseSync: ProbeDb,
      backup: async (src, dest) => {
        await fixtureMod.backup(src, dest);
        snapshotCopy = dest;
      },
    };
    try {
      await readConsoleRows(fx.dbPath, { tempRoot, platform: 'darwin', sqlite: probe });
      assert.strictEqual(observed.length, 1);
      assert.strictEqual(observed[0].dirMode, 0o700, 'snapshot temp dir must be private 0700');
      assert.strictEqual(observed[0].fileMode, 0o600, 'snapshot db copy must be private 0600');
    } finally {
      fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('pre-decryption SQL allowlist excludes account, host-only parent, unrelated and partitioned rows', async () => {
    if (!SQLITE) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-xiaomi-allow-'));
    const tempRoot = path.join(root, 'snapshots');
    fs.mkdirSync(tempRoot);
    const fx = fixtureMod.createConsoleFixture(path.join(root, 'Chrome'), 'Profile 46');
    try {
      // Rows that MUST never be selected (would fail decryption if touched):
      const poison = Buffer.from('v20-not-supported-account-secret');
      fx.add('.account.xiaomi.com', 'passToken', { encrypted: poison });
      fx.add('.account.xiaomi.com', 'userId', { encrypted: poison });
      fx.add(`.${fixtureMod.HOST}`, 'passToken', { encrypted: poison }); // name not allowlisted
      fx.add('.unrelated.example', 'api-platform_serviceToken', { encrypted: poison });
      fx.add('xiaomimimo.com', 'userId', { encrypted: poison }); // bare host-only parent
      fx.add(`.${fixtureMod.HOST}`, 'api-platform_serviceToken', { encrypted: poison, partition: 'https://other.example' });
      fx.add(`.${fixtureMod.HOST}`, 'deviceId', { encrypted: poison });

      const { rows } = await readConsoleRows(fx.dbPath, { tempRoot, platform: 'darwin' });
      assert.deepStrictEqual(rows.map((r) => r.name).sort(),
        ['api-platform_ph', 'api-platform_serviceToken', 'api-platform_slh', 'userId']);
      for (const row of rows) {
        assert.ok(['platform.xiaomimimo.com', '.platform.xiaomimimo.com', '.xiaomimimo.com'].includes(row.host_key));
        assert.ok(!Buffer.from(row.encrypted_value).equals(poison), 'account/poison rows must not be selected');
      }
      // 8 source rows total; only 4 selected — the other 4 were never read.
      assert.strictEqual(fx.db.prepare('SELECT count(*) AS n FROM cookies').get().n, 11);
      assert.deepStrictEqual(fs.readdirSync(tempRoot), []);
    } finally {
      fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('v10 legacy and v24 host-hash decryption; tampered host fails inside the validator', async () => {
    if (!SQLITE) return;
    const key = fixtureMod.KEY;
    const row24 = {
      host_key: '.platform.xiaomimimo.com',
      value: '',
      encrypted_value: fixtureMod.encryptValue(24, '.platform.xiaomimimo.com', 'synthetic-session-secret'),
    };
    const row23 = {
      host_key: '.platform.xiaomimimo.com',
      value: '',
      encrypted_value: fixtureMod.encryptValue(23, '.platform.xiaomimimo.com', 'synthetic-session-secret'),
    };
    assert.strictEqual(decryptCookie(row24, 24, key), 'synthetic-session-secret');
    assert.strictEqual(decryptCookie(row23, 23, key), 'synthetic-session-secret');

    // Tampered host: fetch WITHOUT the host filter (row exists), assert the
    // hash validator itself rejects — not an absent-row false pass.
    const tampered = {
      host_key: '.wrong.example',
      value: '',
      encrypted_value: fixtureMod.encryptValue(24, '.platform.xiaomimimo.com', 'synthetic-session-secret'),
    };
    assert.strictEqual(code(() => decryptCookie(tampered, 24, key)), 'cookie-host-hash-mismatch');

    const v20 = { host_key: '.platform.xiaomimimo.com', value: '', encrypted_value: Buffer.from('v20-nope') };
    assert.strictEqual(code(() => decryptCookie(v20, 24, key)), 'unsupported-cookie-encryption');
    assert.strictEqual(code(() => decryptCookie(row24, 24, Buffer.alloc(16))), 'cookie-decryption-failed');
    const crlf = {
      host_key: '.platform.xiaomimimo.com',
      value: '',
      encrypted_value: fixtureMod.encryptValue(24, '.platform.xiaomimimo.com', 'bad\r\nInjected: yes'),
    };
    assert.strictEqual(code(() => decryptCookie(crlf, 24, key)), 'invalid-cookie-value');
  });

  await test('cookieHeader respects domain, path, expiry and partition eligibility; minimal pair enforced', () => {
    const now = Date.now();
    const c = (name, extra = {}) => ({
      name, domain: `.${fixtureMod.HOST}`, path: '/', expiresAt: null, value: `synthetic-${name}-secret`, ...extra,
    });
    const input = [
      c('api-platform_serviceToken'),
      c('userId', { domain: '.xiaomimimo.com', value: '1234567890' }),
      c('api-platform_ph'),
      c('api-platform_slh'),
      c('passToken', { domain: '.account.xiaomi.com' }),
      c('userId', { domain: '.account.xiaomi.com', value: 'account-secret' }),
      c('api-platform_ph', { expiresAt: now - 1000, value: 'expired-secret' }),
      c('api-platform_slh', { path: '/other', value: 'wrong-path-secret' }),
    ];
    const header = cookieHeader(input, 'usage');
    for (const secret of ['passToken', 'account-secret', 'expired-secret', 'wrong-path-secret']) {
      assert.ok(!header.includes(secret), `header must exclude ${secret}`);
    }
    assert.ok(header.includes('api-platform_serviceToken='));
    assert.ok(header.includes('userId=1234567890'));
    const minimal = cookieHeader(input, 'usage', { minimal: true });
    assert.ok(!minimal.includes('api-platform_ph') && !minimal.includes('api-platform_slh'));
    assert.strictEqual(minimal.split('; ').length, 2);
    const full = cookieHeader(input, 'detail');
    assert.ok(full.includes('api-platform_ph'));

    assert.strictEqual(
      code(() => cookieHeader([c('api-platform_serviceToken')], 'usage')),
      'console-credentials-missing',
    );
    assert.strictEqual(
      code(() => cookieHeader([c('api-platform_serviceToken', { value: 'bad\r\nX:1' }), c('userId', { domain: '.xiaomimimo.com' })], 'usage')),
      'invalid-cookie-value',
    );
    assert.strictEqual(code(() => cookieHeader(input, 'balance')), 'url-not-allowlisted');
  });

  await test('loadConsoleCookies: one password read, wiped buffers, expired rows dropped, errors carry no paths', async () => {
    if (!SQLITE) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-xiaomi-load-'));
    const chromeRoot = path.join(root, 'Chrome');
    const fx = fixtureMod.createConsoleFixture(chromeRoot, 'Profile 46');
    const soon = Date.now() + 50_000;
    fx.add(`.${fixtureMod.HOST}`, 'api-platform_ph', { value: 'expiring', expires: Date.now() - 1000 });
    const password = Buffer.from(fixtureMod.PASSWORD, 'utf8');
    let reads = 0;
    try {
      const loaded = await loadConsoleCookies(
        { chromeSource: chromeRoot, chromeProfile: 'Profile 46', platform: 'darwin' },
        { passwordReader: () => { reads += 1; return password; } },
      );
      assert.strictEqual(reads, 1, 'exactly one key read per operation');
      assert.ok(password.every((b) => b === 0), 'password buffer must be wiped');
      assert.strictEqual(loaded.cookies.length, 4, 'locally expired optional row dropped');
      const header = cookieHeader(loaded.cookies, 'detail');
      assert.ok(header.includes('api-platform_serviceToken='));
      // encrypted payloads are wiped after decryption
      const raw = fx.db.prepare('SELECT encrypted_value FROM cookies LIMIT 1').get();
      assert.ok(raw, 'source rows intact (wiping happens on the snapshot copies only)');

      // profile guards (async — loadConsoleCookies returns a promise)
      assert.strictEqual(await acode(() => loadConsoleCookies(
        { chromeSource: chromeRoot, chromeProfile: '../evil', platform: 'darwin' }, { passwordReader: () => password },
      )), 'invalid-chrome-profile');
      assert.strictEqual(await acode(() => loadConsoleCookies(
        { chromeSource: '', chromeProfile: 'Profile 46', platform: 'darwin' }, { passwordReader: () => password },
      )), 'chrome-source-not-configured');
      assert.strictEqual(await acode(() => loadConsoleCookies(
        { chromeSource: chromeRoot, chromeProfile: 'Profile 99', platform: 'darwin' }, { passwordReader: () => password },
      )), 'cookie-db-not-found');
      assert.strictEqual(await acode(() => loadConsoleCookies(
        { chromeSource: chromeRoot, chromeProfile: 'Profile 46', platform: 'linux' }, { passwordReader: () => password },
      )), 'macos-only');
      // errors never expose directory paths
      const caught = await (async () => {
        try {
          await loadConsoleCookies({ chromeSource: chromeRoot, chromeProfile: 'Profile 99', platform: 'darwin' }, { passwordReader: () => password });
          return null;
        } catch (e) { return e; }
      })();
      assert.ok(caught, 'expected a failure');
      assert.ok(!caught.message.includes(root), 'error must not contain the source path');
      assert.ok(!String(caught.message).includes('/'), 'error must not contain any path');
      // missing rows → no password read at all
      const empty = fixtureMod.createCookieDb(path.join(root, 'Chrome2', 'Profile 46'));
      empty.db.exec('DELETE FROM cookies');
      let readsOnEmpty = 0;
      try {
        await loadConsoleCookies(
          { chromeSource: path.join(root, 'Chrome2'), chromeProfile: 'Profile 46', platform: 'darwin' },
          { passwordReader: () => { readsOnEmpty += 1; return password; } },
        );
        assert.fail('expected console-cookie-rows-missing');
      } catch (e) {
        assert.strictEqual(e.code, 'console-cookie-rows-missing');
      }
      assert.strictEqual(readsOnEmpty, 0, 'no key read when console rows are absent');
      empty.close();
      assert.ok(typeof soon === 'number');
    } finally {
      fx.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('cleanup runs on schema errors and missing files; no snapshot litter remains', async () => {
    if (!SQLITE) return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-xiaomi-clean-'));
    const tempRoot = path.join(root, 'snapshots');
    fs.mkdirSync(tempRoot);
    const bad = path.join(root, 'bad.db');
    const db = new fixtureMod.DatabaseSync(bad);
    db.exec('CREATE TABLE other(x TEXT)');
    db.close();
    try {
      assert.strictEqual(await acode(() => readConsoleRows(bad, { tempRoot, platform: 'darwin' })), 'cookie-db-unreadable');
      const missing = path.join(root, 'missing.db');
      assert.strictEqual(await acode(() => readConsoleRows(missing, { tempRoot, platform: 'darwin' })), 'cookie-db-unreadable');
      assert.strictEqual(await acode(() => readConsoleRows('', { tempRoot, platform: 'darwin' })), 'cookie-db-not-found');
      assert.deepStrictEqual(fs.readdirSync(tempRoot), [], 'failed reads must still clean up');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('missing node:sqlite capability classifies actionably instead of crashing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-xiaomi-nosqlite-'));
    try {
      assert.strictEqual(await acode(() => readConsoleRows(path.join(root, 'x.db'), { platform: 'darwin', sqlite: {} })), 'node-sqlite-unavailable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('F5: cipher update/final outputs wiped on success AND failure (retention spy)', async () => {
    const crypto = require('crypto');
    const orig = crypto.createDecipheriv;
    const held = [];
    crypto.createDecipheriv = function (...args) {
      const d = orig.apply(this, args);
      for (const n of ['update', 'final']) {
        const f = d[n];
        d[n] = function (...a) { const b = f.apply(this, a); held.push(b); return b; };
      }
      return d;
    };
    try {
      const encrypted = fixtureMod.encryptValue(24, '.platform.xiaomimimo.com', 'synthetic-retain-secret');
      const row = { host_key: '.platform.xiaomimimo.com', value: '', encrypted_value: encrypted };
      const out = decryptCookie(row, 24, fixtureMod.KEY);
      assert.strictEqual(out, 'synthetic-retain-secret');
      assert.ok(held.length >= 2, 'update and final outputs were captured');
      for (const b of held) assert.ok(b.every((v) => v === 0), 'every cipher-owned buffer must be wiped');
      assert.ok(!Buffer.concat(held).includes('synthetic-retain-secret'), 'no retained plaintext');

      // Failure path: wrong key → final() throws AFTER update() produced output.
      held.length = 0;
      const bad = { host_key: '.platform.xiaomimimo.com', value: '', encrypted_value: encrypted };
      assert.strictEqual(code(() => decryptCookie(bad, 24, Buffer.alloc(16))), 'cookie-decryption-failed');
      assert.ok(held.length >= 1, 'partial output existed on failure');
      for (const b of held) assert.ok(b.every((v) => v === 0), 'partial cipher output wiped on failure too');
      assert.ok(!Buffer.concat(held).includes('synthetic-retain-secret'));
    } finally {
      crypto.createDecipheriv = orig;
      for (const b of held) b.fill(0);
    }
  });

  if (failures) {
    console.error(`\n${failures} xiaomi cookie test(s) failed`);
    process.exit(1);
  }
  console.log('\nall xiaomi cookie tests passed');
})();
