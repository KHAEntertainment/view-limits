'use strict';
// Xiaomi console transport bounds: URL allowlist, manual redirects, the
// fetch+body timer, streamed byte cap, and classified-only errors (provider
// bodies never reach an error message). No network. Run:
// node test/xiaomi-http.test.js

const assert = require('assert');
const {
  consoleGet, CookieTransportError, fixedUrl, resolveKind, URLS, TIMEOUT_MS, MAX_BYTES,
} = require('../lib/cookies/http-get');

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
const catchCode = async (fn) => {
  try { await fn(); return null; } catch (e) { return e && e.code; }
};

(async () => {
  console.log('xiaomi http-get — allowlist, redirects, bounds, redaction');

  await test('only the two exact console URLs pass the allowlist', async () => {
    assert.strictEqual(resolveKind('usage'), URLS.usage);
    assert.strictEqual(resolveKind('detail'), URLS.detail);
    for (const bad of ['balance', '__proto__', 'constructor', undefined, null, 42]) {
      assert.strictEqual(await catchCode(() => resolveKind(bad)), 'url-not-allowlisted');
    }
    for (const url of [
      'https://account.xiaomi.com/x',
      `https://platform.xiaomimimo.com/api/v1/balance`,
      `${URLS.usage}?token=x`,
      `${URLS.usage}#frag`,
      `http://platform.xiaomimimo.com/api/v1/tokenPlan/usage`,
      `https://user:pass@platform.xiaomimimo.com/api/v1/tokenPlan/usage`,
      `https://platform.xiaomimimo.com:8443/api/v1/tokenPlan/usage`,
      `https://evil-platform.xiaomimimo.com/api/v1/tokenPlan/usage`,
      'not a url',
    ]) {
      assert.strictEqual(await catchCode(() => fixedUrl(url)), 'url-not-allowlisted', url);
    }
  });

  await test('GET only, manual redirect, Cookie set, Authorization never present', async () => {
    const seen = [];
    const transport = async (url, options) => {
      seen.push({ url, options });
      return { status: 200, body: null, text: async () => JSON.stringify({ code: 0, data: {} }) };
    };
    const res = await consoleGet('usage', 'a=b', { transport });
    assert.strictEqual(res.outcome, 'json');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].url, URLS.usage);
    assert.strictEqual(seen[0].options.method, 'GET');
    assert.strictEqual(seen[0].options.redirect, 'manual');
    assert.strictEqual(seen[0].options.credentials, 'omit');
    assert.strictEqual(seen[0].options.headers.Cookie, 'a=b');
    assert.ok(!('Authorization' in seen[0].options.headers));
    assert.ok(seen[0].options.signal, 'abort signal attached');
  });

  await test('3xx is stopped and classified — never followed', async () => {
    let transportCalls = 0;
    let cancels = 0;
    let textReads = 0;
    const transport = async () => {
      transportCalls += 1;
      return {
        status: 302,
        body: { cancel: async () => { cancels += 1; } },
        text: async () => { textReads += 1; return 'moved'; },
      };
    };
    assert.strictEqual(await catchCode(() => consoleGet('usage', 'a=b', { transport })), 'console-redirect-stopped');
    assert.strictEqual(transportCalls, 1, 'redirect target never requested');
    assert.strictEqual(cancels, 1, 'redirect body discarded');
    assert.strictEqual(textReads, 0, 'redirect body never read');
  });

  await test('HTTP 401 classifies as auth before any body is read', async () => {
    let textReads = 0;
    const transport = async () => ({
      status: 401,
      body: { cancel: async () => {} },
      text: async () => { textReads += 1; return 'raw-secret-401-body'; },
    });
    const res = await consoleGet('usage', 'a=b', { transport });
    assert.strictEqual(res.outcome, 'auth');
    assert.strictEqual(res.body, null);
    assert.strictEqual(textReads, 0, '401 body never parsed');
  });

  await test('timeout covers a never-resolving request; classified enum only', async () => {
    // Mirrors real fetch: the promise settles (rejects) when the signal aborts.
    const transport = (url, options) => new Promise((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    });
    assert.strictEqual(
      await catchCode(() => consoleGet('usage', 'a=b', { transport, timeoutMs: 30 })),
      'console-request-timeout',
    );
  });

  await test('timeout also covers a stalled response body', async () => {
    const transport = async (url, options) => ({
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise((_, reject) => {
            const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            if (options.signal.aborted) onAbort();
            else options.signal.addEventListener('abort', onAbort, { once: true });
          }),
          releaseLock: () => {},
          cancel: async () => {},
        }),
      },
      text: async () => '',
    });
    assert.strictEqual(
      await catchCode(() => consoleGet('usage', 'a=b', { transport, timeoutMs: 30 })),
      'console-request-timeout',
    );
  });

  await test('response byte cap aborts an oversized streamed body', async () => {
    let cancelled = false;
    let sent = 0;
    const transport = async () => ({
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            sent += 1;
            return { done: false, value: Buffer.alloc(64) };
          },
          cancel: async () => { cancelled = true; },
          releaseLock: () => {},
        }),
      },
      text: async () => '',
    });
    assert.strictEqual(
      await catchCode(() => consoleGet('usage', 'a=b', { transport, maxBytes: 100 })),
      'response-too-large',
    );
    assert.ok(cancelled, 'reader cancelled at the cap');
    assert.ok(sent <= 3, 'stopped reading immediately');
  });

  await test('hard byte cap constant is bounded', () => {
    assert.strictEqual(TIMEOUT_MS, 8000);
    assert.strictEqual(MAX_BYTES, 512 * 1024);
  });

  await test('non-2xx bodies are never parsed or returned; transport text never leaks', async () => {
    const httpError = await consoleGet('usage', 'a=b', {
      transport: async () => ({
        status: 500,
        body: { cancel: async () => {} },
        text: async () => JSON.stringify({ echo: 'raw-secret-server' }),
      }),
    });
    assert.strictEqual(httpError.outcome, 'http-error');
    assert.strictEqual(httpError.body, null, 'error body never returned');

    const notJson = await consoleGet('usage', 'a=b', {
      transport: async () => ({ status: 200, body: null, text: async () => '<html>raw-secret</html>' }),
    });
    assert.strictEqual(notJson.outcome, 'not-json');
    assert.strictEqual(notJson.body, null);

    const thrown = await catchCode(() => consoleGet('usage', 'a=b', {
      transport: async () => { throw new Error('raw-secret-transport'); },
    }));
    assert.strictEqual(thrown, 'console-request-failed');

    const badShape = await catchCode(() => consoleGet('usage', 'a=b', {
      transport: async () => ({ notStatus: true }),
    }));
    assert.strictEqual(badShape, 'console-request-failed');
  });

  await test('empty cookie header is refused before transport', async () => {
    let calls = 0;
    const transport = async () => { calls += 1; return { status: 200, text: async () => '{}' }; };
    assert.strictEqual(await catchCode(() => consoleGet('usage', '', { transport })), 'cookie-header-invalid');
    assert.strictEqual(await catchCode(() => consoleGet('usage', undefined, { transport })), 'cookie-header-invalid');
    assert.strictEqual(calls, 0);
  });

  await test('error messages are the enum code itself — nothing else', async () => {
    const cases = [
      [() => consoleGet('nope', 'a=b', {}), 'url-not-allowlisted'],
      [() => consoleGet('usage', 'a=b', { transport: async () => { throw new Error('S3CR3T-VALUE'); } }), 'console-request-failed'],
    ];
    for (const [fn, expected] of cases) {
      try {
        await fn();
        assert.fail('expected a throw');
      } catch (e) {
        assert.ok(e instanceof CookieTransportError);
        assert.strictEqual(e.message, expected, 'message is exactly the enum');
        assert.strictEqual(e.code, expected);
        assert.ok(!e.message.includes('S3CR3T'), 'no transport text in the message');
      }
    }
  });

  await test('F5: incoming chunks and join buffers wiped on success/cap/timeout/read-error/parse-error', async () => {
    const SECRET = 'synthetic-http-echo-secret';
    const body = JSON.stringify({ code: 0, data: { echo: SECRET } });
    const origConcat = Buffer.concat;
    const heldConcat = [];
    Buffer.concat = function (...args) {
      const b = origConcat.apply(this, args);
      heldConcat.push(b);
      return b;
    };
    const stream = (chunks, after = 'done') => {
      let i = 0;
      return async (url, options) => ({
        status: 200,
        body: {
          getReader: () => ({
            read: () => {
              if (i < chunks.length) { const value = chunks[i]; i += 1; return Promise.resolve({ done: false, value }); }
              if (after === 'reject') return Promise.reject(new Error('read-boom-raw-secret'));
              if (after === 'stall') {
                // Stall forever (until abort) → exercises the timeout path.
                return new Promise((_, reject) => {
                  const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                  if (options.signal.aborted) onAbort();
                  else options.signal.addEventListener('abort', onAbort, { once: true });
                });
              }
              return Promise.resolve({ done: true });
            },
            releaseLock: () => {},
            cancel: async () => {},
          }),
        },
        text: async () => '',
      });
    };
    const assertWiped = (buf, label) => {
      assert.ok(!buf.includes(SECRET), `${label} must not retain the echoed secret`);
    };
    try {
      // 1. Success: delivered chunk + join buffer wiped.
      const incoming1 = Buffer.from(body);
      heldConcat.length = 0;
      const ok = await consoleGet('usage', 'a=b', {
        transport: stream([incoming1]), timeoutMs: 500,
      });
      assert.strictEqual(ok.outcome, 'json');
      assertWiped(incoming1, 'success incoming chunk');
      assert.ok(heldConcat.length >= 1, 'join buffer captured');
      for (const b of heldConcat) assertWiped(b, 'success join buffer');

      // 2. Cap exit: the over-cap chunk and copies wiped.
      const incoming2 = Buffer.from(body + 'x'.repeat(200));
      heldConcat.length = 0;
      let capErr = null;
      try { await consoleGet('usage', 'a=b', { transport: stream([incoming2]), maxBytes: 32 }); }
      catch (e) { capErr = e.code; }
      assert.strictEqual(capErr, 'response-too-large');
      assertWiped(incoming2, 'cap incoming chunk');
      for (const b of heldConcat) assertWiped(b, 'cap join buffer');

      // 3. Timeout after one delivered chunk: chunk + copies wiped.
      const incoming3 = Buffer.from(body);
      heldConcat.length = 0;
      let timeoutErr = null;
      try { await consoleGet('usage', 'a=b', { transport: stream([incoming3], 'stall'), timeoutMs: 40 }); }
      catch (e) { timeoutErr = e.code; }
      assert.strictEqual(timeoutErr, 'console-request-timeout');
      assertWiped(incoming3, 'timeout incoming chunk');
      for (const b of heldConcat) assertWiped(b, 'timeout join buffer');

      // 4. Read error after one delivered chunk: both wiped, text never leaks.
      const incoming4 = Buffer.from(body);
      heldConcat.length = 0;
      let readErr = null;
      try { await consoleGet('usage', 'a=b', { transport: stream([incoming4], 'reject'), timeoutMs: 500 }); }
      catch (e) { readErr = e.code; }
      assert.strictEqual(readErr, 'console-request-failed');
      assertWiped(incoming4, 'read-error incoming chunk');
      assert.ok(!String(readErr).includes('read-boom-raw-secret'), 'transport text never surfaces');
      for (const b of heldConcat) assertWiped(b, 'read-error join buffer');

      // 5. Parse error: buffers wiped; the immutable JS string is the
      //    documented best-effort limit (it cannot be wiped by design).
      const incoming5 = Buffer.from(`{{{not-json-${SECRET}`);
      heldConcat.length = 0;
      const bad = await consoleGet('usage', 'a=b', { transport: stream([incoming5]), timeoutMs: 500 });
      assert.strictEqual(bad.outcome, 'not-json');
      assertWiped(incoming5, 'parse-error incoming chunk');
      for (const b of heldConcat) assertWiped(b, 'parse-error join buffer');
    } finally {
      Buffer.concat = origConcat;
      for (const b of heldConcat) b.fill(0);
    }
  });

  if (failures) {
    console.error(`\n${failures} xiaomi http test(s) failed`);
    process.exit(1);
  }
  console.log('\nall xiaomi http tests passed');
})();
