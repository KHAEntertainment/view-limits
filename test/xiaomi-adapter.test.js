'use strict';
// Xiaomi console adapter fixture tests: code-0 envelopes, plan counts,
// auth/transport classification, redaction. No network, no credentials —
// every response is synthetic. Run: node test/xiaomi-adapter.test.js

const assert = require('assert');
const { fetchStatus, XiaomiFetchError } = require('../lib/adapters/xiaomi');
const { consoleGet, CookieTransportError, URLS } = require('../lib/cookies/http-get');

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

const USAGE_COUNTS = { used: 9631677420, limit: 38000000000 };
const usageBody = (item = { name: 'plan_total_token', ...USAGE_COUNTS, percent: 0.25 }) => ({
  code: 0,
  data: {
    usage: { percent: 0.25, items: [item, { name: 'compensation_total_token', used: 0, limit: 0, percent: 0 }] },
    monthUsage: { percent: 0.2535, items: [] },
  },
});
const detailBody = (data = { currentPeriodEnd: '2026-11-07 23:59:59', expired: false, planName: 'private-plan-label' }) =>
  ({ code: 0, data });

const CREDENTIALS = { usageCookie: 'api-platform_serviceToken=u-secret; userId=1234567890', detailCookie: 'api-platform_serviceToken=u-secret; userId=1234567890; api-platform_ph=ph' };

// Fake consoleGet with scripted per-kind replies; records call order.
function scripted(replies) {
  const calls = [];
  const get = async (kind) => {
    calls.push(kind);
    const reply = replies[kind];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(kind);
    return reply;
  };
  return { calls, get };
}
const json = (body) => ({ outcome: 'json', httpStatus: 200, body });

(async () => {
  console.log('xiaomi adapter — envelopes, counts, failures, redaction');

  await test('valid plan counts → one tokens window, state unknown, no error, no guessed reset', async () => {
    const s = scripted({ usage: json(usageBody()), detail: json(detailBody()) });
    const st = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get });
    assert.strictEqual(st.state, 'unknown');
    assert.strictEqual(st.windows.length, 1);
    assert.deepStrictEqual(st.windows[0], {
      type: 'tokens',
      remaining: 28368322580,
      limit: 38000000000,
      resetAt: null,
    });
    assert.strictEqual(st.resetAt, null, 'no unverified reset guess');
    assert.strictEqual(st.balance, null);
    assert.strictEqual(st.detail.error, undefined, 'valid counts carry no fictitious error');
    assert.strictEqual(st.detail.expired, false);
    assert.deepStrictEqual(s.calls, ['usage', 'detail']);
  });

  await test('compensation and monthUsage never become windows or route state', async () => {
    const s = scripted({ usage: json(usageBody()), detail: json(detailBody()) });
    const st = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get });
    assert.strictEqual(st.windows.length, 1);
    assert.strictEqual(st.state, 'unknown', 'unresolved compensation keeps state unknown');
    assert.ok(!JSON.stringify(st).includes('compensation_total_token'));
    assert.ok(!JSON.stringify(st).includes('monthUsage'));
  });

  await test('explicit expired → unknown with NO windows (never exhaustion)', async () => {
    const s = scripted({ usage: json(usageBody()), detail: json(detailBody({ currentPeriodEnd: '2026-11-07', expired: true })) });
    const st = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get });
    assert.strictEqual(st.state, 'unknown');
    assert.deepStrictEqual(st.windows, []);
    assert.strictEqual(st.detail.expired, true);
    assert.strictEqual(st.detail.error, undefined);
  });

  for (const [label, usage] of [
    ['missing plan item', { code: 0, data: { usage: { items: [{ name: 'other', used: 1, limit: 2 }] } } }],
    ['items not an array', { code: 0, data: { usage: { items: {} } } }],
    ['non-integer counts', { code: 0, data: { usage: { items: [{ name: 'plan_total_token', used: '9631677420', limit: 38000000000 }] } } }],
    ['used greater than limit', { code: 0, data: { usage: { items: [{ name: 'plan_total_token', used: 11, limit: 10 }] } } }],
    ['zero limit', { code: 0, data: { usage: { items: [{ name: 'plan_total_token', used: 0, limit: 0 }] } } }],
    ['data not an object', { code: 0, data: [] }],
  ]) {
    await test(`unrecognized usage shape (${label}) → unknown, no windows, classified error`, async () => {
      const s = scripted({ usage: json(usage), detail: json(detailBody()) });
      const st = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get });
      assert.strictEqual(st.state, 'unknown');
      assert.deepStrictEqual(st.windows, []);
      assert.strictEqual(st.detail.error, 'console response unrecognized');
    });
  }

  for (const [label, detail] of [
    ['missing currentPeriodEnd', { code: 0, data: { expired: false } }],
    ['non-boolean expired', { code: 0, data: { currentPeriodEnd: 'x', expired: 'false' } }],
    ['missing data', { code: 0 }],
  ]) {
    await test(`unrecognized detail shape (${label}) → no windows even with valid usage counts`, async () => {
      const s = scripted({ usage: json(usageBody()), detail: json(detail) });
      const st = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get });
      assert.deepStrictEqual(st.windows, []);
      assert.strictEqual(st.detail.error, 'console response unrecognized');
    });
  }

  await test('usage HTTP 401 stops BEFORE detail (one call) with auth classification', async () => {
    const s = scripted({ usage: { outcome: 'auth', httpStatus: 401, body: null } });
    const err = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get }).then(() => null, (e) => e);
    assert.ok(err instanceof XiaomiFetchError);
    assert.strictEqual(err.kind, 'auth');
    assert.deepStrictEqual(s.calls, ['usage'], 'detail must never be requested');
  });

  await test('HTTP-200 code-401 envelope is an auth failure; success:false is not auth', async () => {
    const s1 = scripted({ usage: json({ code: 401, message: 'echo-should-not-leak' }) });
    const e1 = await fetchStatus({}, CREDENTIALS, { consoleGet: s1.get }).then(() => null, (e) => e);
    assert.strictEqual(e1 && e1.kind, 'auth');
    assert.ok(!String(e1.message).includes('echo-should-not-leak'));

    const s2 = scripted({ usage: json({ code: 0, success: false, data: { usage: { items: [] } } }) });
    const e2 = await fetchStatus({}, CREDENTIALS, { consoleGet: s2.get }).then(() => null, (e) => e);
    assert.strictEqual(e2 && e2.kind, 'transport');
    assert.strictEqual(e2 && e2.code, 'console-envelope-error');
  });

  for (const [label, reply, expected] of [
    ['http-error', { outcome: 'http-error', httpStatus: 500, body: null }, 'console-http-error'],
    ['not-json', { outcome: 'not-json', httpStatus: 200, body: null }, 'console-response-not-json'],
    ['timeout throw', new CookieTransportError('console-request-timeout'), 'console-request-timeout'],
    ['size throw', new CookieTransportError('response-too-large'), 'response-too-large'],
    ['redirect throw', new CookieTransportError('console-redirect-stopped'), 'console-redirect-stopped'],
    ['foreign error message', Object.assign(new Error('raw-secret-body-echo'), { code: undefined }), 'console-request-failed'],
  ]) {
    await test(`transport failure (${label}) → classified enum ${expected}, no raw text`, async () => {
      const s = scripted({ usage: reply });
      const err = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get }).then(() => null, (e) => e);
      assert.ok(err instanceof XiaomiFetchError);
      assert.strictEqual(err.kind, 'transport');
      assert.strictEqual(err.code, expected);
      assert.strictEqual(err.message, expected, 'message is the enum itself');
      assert.ok(!err.message.includes('raw-secret'), 'no transport error text leaks');
      assert.deepStrictEqual(s.calls, ['usage']);
    });
  }

  await test('detail failure after successful usage still never leaks provider text', async () => {
    const s = scripted({ usage: json(usageBody()), detail: { outcome: 'not-json', httpStatus: 200, body: null } });
    const err = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get }).then(() => null, (e) => e);
    assert.strictEqual(err && err.code, 'console-response-not-json');
    assert.deepStrictEqual(s.calls, ['usage', 'detail']);
  });

  await test('credentials echoed as string, property name, or number never reach status or errors', async () => {
    const echoedString = 'synthetic-session-secret-0001';
    const echoedNumber = 1234567890; // same as userId
    const s = scripted({
      usage: json({
        code: 0,
        message: echoedString,
        [echoedString]: true,
        data: { usage: { items: [{ name: 'plan_total_token', ...USAGE_COUNTS }], leaked: echoedNumber } },
      }),
      detail: json({ code: 0, [echoedString]: echoedNumber, data: { currentPeriodEnd: '2026-11-07 23:59:59', expired: false, token: echoedString } }),
    });
    const st = await fetchStatus({}, CREDENTIALS, { consoleGet: s.get });
    const encoded = JSON.stringify(st);
    assert.ok(!encoded.includes(echoedString), 'string echo must not leak');
    assert.ok(!encoded.includes(String(echoedNumber)), 'numeric echo must not leak');
    assert.ok(!encoded.includes('leaked'), 'arbitrary property names must not leak');
    assert.strictEqual(st.state, 'unknown');
    assert.strictEqual(st.windows[0].remaining, 28368322580);
  });

  await test('no Authorization header and allowlisted URLs only in the real transport', async () => {
    const seen = [];
    const transport = async (url, options) => {
      seen.push({ url, options });
      return {
        status: 200,
        body: null,
        text: async () => JSON.stringify(url.endsWith('/usage') ? usageBody() : detailBody()),
      };
    };
    const st = await fetchStatus({}, CREDENTIALS, { transport });
    assert.strictEqual(st.state, 'unknown');
    assert.strictEqual(seen.length, 2);
    for (const { url, options } of seen) {
      assert.ok(Object.values(URLS).includes(url), 'only allowlisted console URLs');
      assert.strictEqual(options.method, 'GET');
      assert.strictEqual(options.redirect, 'manual');
      assert.ok(!('Authorization' in options.headers), 'no Authorization header');
      assert.ok(typeof options.headers.Cookie === 'string' && options.headers.Cookie.length > 0);
    }
    assert.strictEqual(seen[0].url, URLS.usage);
    assert.strictEqual(seen[1].url, URLS.detail);
  });

  await test('callers cannot smuggle arbitrary URLs through ctx.transport path', async () => {
    const bogus = [];
    const transport = async (url) => {
      bogus.push(url);
      return { status: 200, text: async () => '{}' };
    };
    // consoleGet itself enforces the allowlist before transport runs.
    await assert.rejects(
      () => consoleGet('balance', 'x=1', { transport }),
      (e) => e instanceof CookieTransportError && e.code === 'url-not-allowlisted',
    );
    assert.deepStrictEqual(bogus, [], 'no transport call for a non-allowlisted kind');
  });

  if (failures) {
    console.error(`\n${failures} xiaomi adapter test(s) failed`);
    process.exit(1);
  }
  console.log('\nall xiaomi adapter tests passed');
})();
