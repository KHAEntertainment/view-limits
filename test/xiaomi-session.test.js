'use strict';
// Xiaomi session orchestration tests: one Chrome read per operation,
// value-sensitive rejected-bundle fingerprint (same-length rotations),
// auth/transport/shape classification, suppression, and no credential
// persistence. Synthetic fixtures only — no Chrome store, no Keychain,
// no network, no helper execution. Run: node test/xiaomi-session.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureMod = require('./fixtures/xiaomi-cookie-db.cjs');
const xiaomiSession = require('../lib/xiaomi-session');
const { bundleDigest, readRejected, writeRejected, clearRejected, statePath } = require('../lib/cookies/fingerprint');

const HOST = fixtureMod.HOST;
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

const USAGE_JSON = {
  code: 0,
  data: {
    usage: { percent: 0.25, items: [{ name: 'plan_total_token', used: 9631677420, limit: 38000000000, percent: 0.25 }] },
    monthUsage: { percent: 0.2535, items: [] },
  },
};
const DETAIL_JSON = { code: 0, data: { currentPeriodEnd: '2026-11-07 23:59:59', expired: false } };

// Fake transport: 'ok' → code-0 pair, 'auth' → 401, 'network' → throw,
// 'shape' → code-0 with junk data. Records every request.
function makeTransport(mode) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, cookie: options.headers.Cookie });
    const respond = (status, body) => ({ status, body: null, text: async () => JSON.stringify(body) });
    if (mode === 'network') throw new Error('raw-transport-secret');
    if (mode === 'auth') return respond(401, { code: 401, message: 'echo-secret' });
    if (mode === 'shape') return respond(200, url.endsWith('/usage') ? { code: 0, data: {} } : DETAIL_JSON);
    return respond(200, url.endsWith('/usage') ? USAGE_JSON : DETAIL_JSON);
  };
  transport.calls = calls;
  return transport;
}

function scratch(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `vl-xiaomi-${name}-`));
  const chromeRoot = path.join(root, 'chrome-root');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const fx = fixtureMod.createConsoleFixture(chromeRoot, 'Profile 46');
  const cfg = {
    providers: { xiaomi: { baseUrl: `https://${HOST}` } },
    xiaomi: { chromeSource: chromeRoot, chromeProfile: 'Profile 46' },
    routes: [{ id: 'xiaomi-token-plan', provider: 'xiaomi', account: 'token-plan', match: { model: 'mimo' }, ttlSeconds: 0, credentialSource: 'chrome-cookies' }],
    gate: { mode: 'off' },
  };
  const ctx = () => ({
    xiaomiDeps: {
      dataDir,
      platform: 'darwin',
      passwordReader: () => Buffer.from(fixtureMod.PASSWORD, 'utf8'),
      transport: makeTransport('ok'),
    },
  });
  return { root, chromeRoot, dataDir, fx, cfg, ctx };
}

const SECRET_VALUES = [
  'synthetic-session-secret-0001',
  'synthetic-ph-secret',
  'synthetic-slh-secret',
  fixtureMod.PASSWORD,
];

function assertNoSecrets(root, extra = []) {
  const hunt = [...SECRET_VALUES, ...extra];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        const buf = fs.readFileSync(p);
        for (const secret of hunt) {
          assert.ok(!buf.includes(secret), `secret "${secret.slice(0, 12)}…" persisted in ${path.basename(p)}`);
        }
      }
    }
  };
  walk(root);
}

(async () => {
  console.log('xiaomi session — orchestration, fingerprint, suppression');
  if (!fixtureMod.HAS_SQLITE) {
    console.log('  (node:sqlite unavailable — session tests skipped)');
    return;
  }

  await test('one Chrome read + exactly one usage/detail pair on success; counts displayed as unknown', async () => {
    const s = scratch('success');
    try {
      let reads = 0;
      const ctx = s.ctx();
      ctx.xiaomiDeps.passwordReader = () => { reads += 1; return Buffer.from(fixtureMod.PASSWORD, 'utf8'); };
      const st = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx);
      assert.strictEqual(reads, 1, 'exactly one Chrome/key read');
      assert.strictEqual(ctx.xiaomiDeps.transport.calls.length, 2, 'one usage + one detail');
      assert.strictEqual(ctx.xiaomiDeps.transport.calls[0].url.endsWith('/usage'), true);
      assert.strictEqual(ctx.xiaomiDeps.transport.calls[1].url.endsWith('/detail'), true);
      assert.strictEqual(st.state, 'unknown');
      assert.strictEqual(st.windows.length, 1);
      assert.strictEqual(st.windows[0].type, 'tokens');
      assert.strictEqual(st.detail.error, undefined);
      // full bundle for detail, minimal pair for usage
      assert.ok(ctx.xiaomiDeps.transport.calls[0].cookie.includes('api-platform_serviceToken='));
      assert.ok(!ctx.xiaomiDeps.transport.calls[0].cookie.includes('api-platform_ph'), 'usage uses the minimal pair');
      assert.ok(ctx.xiaomiDeps.transport.calls[1].cookie.includes('api-platform_ph'), 'detail uses the full bundle');
      assert.strictEqual(readRejected(s.dataDir), null, 'no rejection recorded on success');
      assertNoSecrets(s.dataDir);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('auth failure records digest-only rejection; SAME-LENGTH serviceToken rotation resumes', async () => {
    const s = scratch('rotation-token');
    try {
      const ctx1 = s.ctx();
      ctx1.xiaomiDeps.transport = makeTransport('auth');
      const first = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx1);
      assert.strictEqual(first.detail.reauth.reason, 'auth-expired');
      assert.strictEqual(first.detail.reauth.url, 'https://platform.xiaomimimo.com/');
      assert.strictEqual(first.detail.reauth.profile, 'Profile 46');
      assert.deepStrictEqual(first.windows, []);
      assert.strictEqual(ctx1.xiaomiDeps.transport.calls.length, 1, 'auth stops before detail');

      const digest1 = readRejected(s.dataDir);
      assert.ok(digest1 && /^[0-9a-f]{64}$/.test(digest1), 'digest persisted');
      const meta = JSON.parse(fs.readFileSync(statePath(s.dataDir), 'utf8'));
      assert.strictEqual(meta.digest, digest1);
      assert.ok(!JSON.stringify(meta).includes('secret'), 'metadata never contains cookie values');

      // Rejected bundle is NOT replayed: a working transport gets zero calls.
      const ctx2 = s.ctx();
      const second = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx2);
      assert.strictEqual(second.detail.reauth.reason, 'auth-expired');
      assert.strictEqual(ctx2.xiaomiDeps.transport.calls.length, 0, 'rejected bundle must not be replayed');

      // SAME-LENGTH serviceToken rotation → digest changes → requests resume.
      const tokenRow = s.fx.db.prepare("UPDATE cookies SET encrypted_value = ? WHERE name = 'api-platform_serviceToken'");
      tokenRow.run(fixtureMod.encryptValue(24, `.${HOST}`, 'z'.repeat('synthetic-session-secret-0001'.length)));
      const ctx3 = s.ctx();
      const third = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx3);
      assert.strictEqual(ctx3.xiaomiDeps.transport.calls.length, 2, 'changed same-length token becomes eligible');
      assert.strictEqual(third.state, 'unknown');
      assert.strictEqual(third.windows.length, 1, 'recovery resumes with fresh counts');
      assert.strictEqual(readRejected(s.dataDir), null, 'rejection cleared after acceptance');
      assertNoSecrets(s.dataDir, ['z'.repeat(30)]);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('SAME-LENGTH userId rotation also changes the digest and resumes', async () => {
    const s = scratch('rotation-user');
    try {
      const ctx1 = s.ctx();
      ctx1.xiaomiDeps.transport = makeTransport('auth');
      await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx1);
      assert.ok(readRejected(s.dataDir), 'rejected after auth failure');

      const ctx2 = s.ctx();
      await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx2);
      assert.strictEqual(ctx2.xiaomiDeps.transport.calls.length, 0, 'unchanged bundle skipped');

      s.fx.db.prepare("UPDATE cookies SET encrypted_value = ? WHERE name = 'userId'")
        .run(fixtureMod.encryptValue(24, '.xiaomimimo.com', '0987654321')); // same length as 1234567890
      const ctx3 = s.ctx();
      const st = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx3);
      assert.strictEqual(ctx3.xiaomiDeps.transport.calls.length, 2, 'same-length userId rotation resumes');
      assert.strictEqual(st.windows.length, 1);
      assertNoSecrets(s.dataDir, ['0987654321']);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('transport and shape failures never write a rejection', async () => {
    for (const mode of ['network', 'shape']) {
      const s = scratch(`no-reject-${mode}`);
      try {
        const ctx = s.ctx();
        ctx.xiaomiDeps.transport = makeTransport(mode);
        const st = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx);
        assert.strictEqual(st.state, 'unknown');
        assert.deepStrictEqual(st.windows, []);
        assert.strictEqual(typeof st.detail.error, 'string');
        assert.ok(!st.detail.error.includes('raw-transport-secret'), 'transport text must not surface');
        assert.strictEqual(readRejected(s.dataDir), null, `${mode} failure must not reject credentials`);
        if (mode === 'network') assert.strictEqual(ctx.xiaomiDeps.transport.calls.length, 1);
      } finally {
        s.fx.close();
        fs.rmSync(s.root, { recursive: true, force: true });
      }
    }
  });

  await test('network failure → classified timeout/failed message, never raw error text', async () => {
    const s = scratch('network-msg');
    try {
      const ctx = s.ctx();
      ctx.xiaomiDeps.transport = makeTransport('network');
      const st = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx);
      assert.strictEqual(st.detail.error, 'console request failed');
      assert.ok(!JSON.stringify(st).includes('raw-transport-secret'));
      assertNoSecrets(s.dataDir);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('key failure is classified, suppressed until reset, and retried after resetXiaomiState', async () => {
    const s = scratch('suppression');
    try {
      let reads = 0;
      const ctx1 = s.ctx();
      ctx1.xiaomiDeps.passwordReader = () => { reads += 1; const e = new Error('keychain-unavailable'); e.code = 'keychain-unavailable'; throw e; };
      const first = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx1);
      assert.strictEqual(first.detail.error, 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan');
      assert.strictEqual(reads, 1);
      assert.ok(xiaomiSession.readSuppressed(s.dataDir), 'suppression written');

      const ctx2 = s.ctx();
      ctx2.xiaomiDeps.passwordReader = () => { reads += 1; return Buffer.from(fixtureMod.PASSWORD, 'utf8'); };
      const second = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx2);
      assert.strictEqual(reads, 1, 'suppressed: Chrome is not retried until setup runs');
      assert.strictEqual(second.detail.error, first.detail.error);

      xiaomiSession.resetXiaomiState(s.dataDir);
      assert.strictEqual(xiaomiSession.readSuppressed(s.dataDir), false);
      const third = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx2);
      assert.strictEqual(reads, 2, 'attempted again after reset');
      assert.strictEqual(third.state, 'unknown');
      assert.strictEqual(third.windows.length, 1);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('missing console rows → auth-expired; unreadable store → classified error with no path', async () => {
    const s = scratch('missing-rows');
    try {
      s.fx.db.exec('DELETE FROM cookies');
      const ctx = s.ctx();
      const st = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx);
      assert.strictEqual(st.detail.reauth.reason, 'auth-expired');
      assert.strictEqual(ctx.xiaomiDeps.transport.calls.length, 0);

      // Profile with no DB at all
      s.cfg = { ...s.cfg, xiaomi: { chromeSource: path.join(s.root, 'nope'), chromeProfile: 'Profile 46' } };
      const ctx2 = s.ctx();
      const st2 = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx2);
      assert.strictEqual(st2.detail.error, 'chrome cookie store unreadable');
      assert.ok(!st2.detail.error.includes(s.root), 'no directory path in errors');
      assert.strictEqual(ctx2.xiaomiDeps.transport.calls.length, 0);
      assertNoSecrets(s.dataDir);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('unconfigured source fails fast with actionable setup message and no reads', async () => {
    const s = scratch('unconfigured');
    try {
      let reads = 0;
      const ctx = s.ctx();
      ctx.xiaomiDeps.passwordReader = () => { reads += 1; return Buffer.from(fixtureMod.PASSWORD, 'utf8'); };
      const cfg = { ...s.cfg };
      delete cfg.xiaomi;
      const st = await xiaomiSession.fetchStatus(cfg, cfg.routes[0], ctx);
      assert.strictEqual(st.detail.error, 'Chrome cookie source not configured — run /view-limits:setup xiaomi-token-plan');
      assert.strictEqual(reads, 0);
      assert.strictEqual(ctx.xiaomiDeps.transport.calls.length, 0);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('default key path (no injected reader) fails closed without helper — no spawn, no prompt', async () => {
    const s = scratch('default-reader');
    try {
      const cp = require('child_process');
      const originalSpawn = cp.spawn;
      const originalSpawnSync = cp.spawnSync;
      const spawns = [];
      cp.spawn = (...args) => { spawns.push(args[0]); return originalSpawn(...args); };
      cp.spawnSync = (...args) => { spawns.push(args[0]); return originalSpawnSync(...args); };
      let st;
      try {
        // No helper exists under dataDir/bin ⇒ access() fails before any spawn.
        st = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], { xiaomiDeps: { dataDir: s.dataDir, platform: 'darwin' } });
      } finally {
        cp.spawn = originalSpawn;
        cp.spawnSync = originalSpawnSync;
      }
      assert.strictEqual(st.detail.error, 'Chrome key unavailable — rerun /view-limits:setup xiaomi-token-plan');
      assert.deepStrictEqual(spawns, [], 'no process spawned on the default path without a helper');
      assert.ok(xiaomiSession.readSuppressed(s.dataDir), 'deterministic key failure suppresses retries');
      assertNoSecrets(s.dataDir);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('bundle digest is value-sensitive, order-independent and metadata never carries values', async () => {
    const base = [
      { name: 'api-platform_serviceToken', domain: '.x', path: '/', expiresAt: null, value: 'aaa' },
      { name: 'userId', domain: '.x', path: '/', expiresAt: null, value: '111' },
    ];
    const d1 = bundleDigest(base);
    assert.strictEqual(d1, bundleDigest(base.slice().reverse()), 'order independent');
    const rotated = base.map((c) => (c.name === 'userId' ? { ...c, value: '222' } : c));
    assert.notStrictEqual(d1, bundleDigest(rotated), 'same-length value rotation changes the digest');
    const renamed = base.map((c) => ({ ...c, domain: '.other' }));
    assert.notStrictEqual(d1, bundleDigest(renamed), 'domain change changes the digest');

    const s = scratch('digest-meta');
    try {
      writeRejected(s.dataDir, d1);
      const raw = fs.readFileSync(statePath(s.dataDir), 'utf8');
      assert.ok(!raw.includes('aaa') && !raw.includes('111'), 'no cookie values in metadata');
      assert.strictEqual(readRejected(s.dataDir), d1);
      assert.strictEqual((fs.statSync(path.dirname(statePath(s.dataDir))).mode & 0o777), 0o700);
      assert.strictEqual((fs.statSync(statePath(s.dataDir)).mode & 0o777), 0o600);
      clearRejected(s.dataDir);
      assert.strictEqual(readRejected(s.dataDir), null);
      assert.strictEqual(writeRejected(s.dataDir, 'not-a-digest'), false, 'malformed digests refused');
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('success path clears any stale rejection and never persists credentials', async () => {
    const s = scratch('clear-on-success');
    try {
      writeRejected(s.dataDir, '0'.repeat(64)); // stale, non-matching
      const ctx = s.ctx();
      const st = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx);
      assert.strictEqual(st.windows.length, 1);
      assert.strictEqual(readRejected(s.dataDir), null, 'stale rejection cleared on acceptance');
      assertNoSecrets(s.dataDir);
    } finally {
      s.fx.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });

  await test('F6: every exported bridge RESULT/BRIDGE enum maps to a fixed actionable message', async () => {
    const bridge = await import('../lib/cookies/keychain-bridge.mjs');
    const codes = [...Object.values(bridge.RESULT), ...Object.values(bridge.BRIDGE)];
    assert.ok(codes.length >= 21, 'expected the full exported enum set');
    for (const code of codes) {
      const msg = xiaomiSession.message(code);
      assert.notStrictEqual(msg, xiaomiSession.DEFAULT_ERROR,
        `no generic fallthrough for bridge enum ${code}`);
      assert.strictEqual(typeof msg, 'string');
      assert.ok(msg.length > 0);
      assert.ok(!msg.includes('\n'), 'messages stay single-line');
      assert.ok(/setup|retry/i.test(msg), `${code} message must be actionable`);
    }
  });

  await test('F6: deterministic spawn/internal failures suppress until reset; timeout is retriable', async () => {
    const probe = async (code) => {
      const s = scratch(`f6-${code.replace(/[^a-z0-9]+/gi, '')}`);
      let reads = 0;
      try {
        const ctx = s.ctx();
        ctx.xiaomiDeps.passwordReader = () => {
          reads += 1;
          const e = new Error(code); // enum only — never a secret path
          e.code = code;
          throw e;
        };
        const first = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx);
        const second = await xiaomiSession.fetchStatus(s.cfg, s.cfg.routes[0], ctx);
        return {
          first, second, reads,
          suppressed: xiaomiSession.readSuppressed(s.dataDir),
          root: s,
        };
      } catch (e) {
        s.fx.close();
        fs.rmSync(s.root, { recursive: true, force: true });
        throw e;
      }
    };
    try {
      for (const code of ['bridge-spawn-failed', 'bridge-internal', 'bridge-denied']) {
        const r = await probe(code);
        assert.strictEqual(r.first.detail.error, xiaomiSession.message(code),
          `${code} gets its own actionable message`);
        assert.notStrictEqual(r.first.detail.error, xiaomiSession.DEFAULT_ERROR);
        assert.strictEqual(r.suppressed, true, `${code} is deterministic → suppressed`);
        assert.strictEqual(r.reads, 1, `${code}: Chrome not retried after suppression`);
        assert.strictEqual(r.second.detail.error, xiaomiSession.message('keychain-unavailable'));
        r.root.fx.close();
        fs.rmSync(r.root.root, { recursive: true, force: true });
      }
      // bridge-timeout: explicitly RETRIABLE — actionable message, never
      // suppressed, and the next operation attempts the key again.
      const t = await probe('bridge-timeout');
      assert.strictEqual(t.first.detail.error, xiaomiSession.message('bridge-timeout'));
      assert.ok(/timed out/.test(t.first.detail.error));
      assert.strictEqual(t.suppressed, false, 'bridge-timeout must NOT be suppressed');
      assert.strictEqual(t.reads, 2, 'retriable: second operation retries the key read');
      assert.strictEqual(t.second.detail.error, xiaomiSession.message('bridge-timeout'));
      t.root.fx.close();
      fs.rmSync(t.root.root, { recursive: true, force: true });
    } finally {
      /* per-probe cleanup already done above */
    }
  });

  await test('R4 interactive grant: exact bridge args, secret wiped, classified denial/malformed results', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-xiaomi-grant-'));
    try {
      // Success: the bridge sees exactly the reviewed interactive-request
      // shape, and the granted secret is wiped before returning — the grant,
      // not the key, is the product of this call.
      const calls = [];
      const secret = Buffer.from('synthetic-grant-secret', 'utf8');
      const fakeBridge = {
        acquireKey: async (opts) => { calls.push(opts); return { ok: true, secret }; },
        describeResult: (r) => (r && r.ok === true ? { ok: true } : { ok: false, code: (r && r.code) || 'bridge-internal' }),
      };
      assert.strictEqual(await xiaomiSession.grantInteractiveKey(root, { bridge: fakeBridge }), true);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].helperPath, path.join(root, 'bin', 'kh-helper'));
      assert.strictEqual(calls[0].interactive, true, 'grant must be interactive');
      assert.strictEqual(calls[0].purpose, 'interactive-setup', 'exact purpose the bridge enforces');
      assert.strictEqual(calls[0].timeoutMs, 60000, 'human click window');
      assert.ok(secret.every((b) => b === 0), 'granted secret must be wiped — never retained');
      assert.ok(!JSON.stringify(calls).includes('synthetic-grant-secret'), 'no secret in recorded args');

      // Denial: a classified code surfaces — never raw bridge/OS text.
      const denied = {
        acquireKey: async () => ({ ok: false, code: 'bridge-denied' }),
        describeResult: (r) => ({ ok: false, code: r.code }),
      };
      try {
        await xiaomiSession.grantInteractiveKey(root, { bridge: denied });
        assert.fail('a denied grant must throw');
      } catch (e) {
        assert.strictEqual(e.code, 'bridge-denied');
        assert.strictEqual(xiaomiSession.message(e.code), xiaomiSession.MESSAGES['bridge-denied']);
      }

      // Malformed/absent results fail closed with the classified internal code
      // — including a malformed SUCCESS ({ok:true} with no usable secret).
      for (const bad of [{ ok: false }, undefined, { ok: true }]) {
        const bridge = {
          acquireKey: async () => bad,
          describeResult: (r) => (r && r.ok === true ? { ok: true } : { ok: false, code: (r && r.code) || 'bridge-internal' }),
        };
        try {
          await xiaomiSession.grantInteractiveKey(root, { bridge });
          assert.fail('a malformed grant result must throw');
        } catch (e) {
          assert.strictEqual(e.code, 'bridge-internal');
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  if (failures) {
    console.error(`\n${failures} xiaomi session test(s) failed`);
    process.exit(1);
  }
  console.log('\nall xiaomi session tests passed');
})();
