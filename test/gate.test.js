'use strict';
// Pure-function tests for lib/gate.js decide(). Exercises the deny matrix plus
// the malformed-input fail-open guarantee: stale/unknown/unmapped/null/array/
// bad-timestamp cache entries must never produce a deny and must never throw.

const assert = require('assert');

const { decide } = require('../lib/gate');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const ROUTE = { id: 'kimi-code-plan', provider: 'kimi' };
const NOW = Date.parse('2026-09-19T00:00:00Z');
const FRESH = '2026-09-19T00:05:00Z'; // 5 min ahead
const STALE = '2026-09-18T23:00:00Z'; // 1h ago

function entry(status, freshUntil = FRESH) {
  return { routeId: ROUTE.id, observedAt: 'x', freshUntil, source: 'kimi', status };
}

console.log('decide — happy paths');

test('no route → allow (fail open)', () => {
  assert.deepStrictEqual(decide({ route: null, entry: null, now: NOW }), { action: 'allow' });
});

test('route, no cache entry → allow + refresh', () => {
  const d = decide({ route: ROUTE, entry: undefined, now: NOW });
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.refresh, true);
  assert.match(d.context, /no fresh status/);
});

test('route, stale entry → allow + refresh', () => {
  const d = decide({ route: ROUTE, entry: entry({ state: 'healthy' }, STALE), now: NOW });
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.refresh, true);
});

test('route, fresh + exhausted → deny', () => {
  const d = decide({ route: ROUTE, entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }), now: NOW });
  assert.strictEqual(d.action, 'deny');
  assert.match(d.reason, /kimi-code-plan.*exhausted/);
});

test('route, fresh + exhausted, with resetAt → deny includes reset string', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: '2026-09-19T05:00:00Z' }),
    now: NOW,
  });
  assert.strictEqual(d.action, 'deny');
  assert.match(d.reason, /Resets/);
});

test('route, fresh + healthy → allow + context', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'healthy', windows: [{ type: 'weekly', remaining: 80, limit: 100 }] }),
    now: NOW,
  });
  assert.strictEqual(d.action, 'allow');
  assert.match(d.context, /weekly 80%/);
});

test('route, fresh + constrained → allow + context', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'constrained', windows: [{ type: 'weekly', remaining: 10, limit: 100 }] }),
    now: NOW,
  });
  assert.strictEqual(d.action, 'allow');
});

test('route, fresh + unknown → allow + context', () => {
  const d = decide({ route: ROUTE, entry: entry({ state: 'unknown' }), now: NOW });
  assert.strictEqual(d.action, 'allow');
});

console.log('\ndecide — malformed cache shapes must never deny');

test('entry is null → allow, no throw', () => {
  assert.doesNotThrow(() => {
    const d = decide({ route: ROUTE, entry: null, now: NOW });
    assert.strictEqual(d.action, 'allow');
  });
});

test('entry is undefined → allow, no throw', () => {
  assert.doesNotThrow(() => {
    const d = decide({ route: ROUTE, entry: undefined, now: NOW });
    assert.strictEqual(d.action, 'allow');
  });
});

test('entry is a string → allow, no throw', () => {
  assert.doesNotThrow(() => {
    const d = decide({ route: ROUTE, entry: 'garbage', now: NOW });
    assert.strictEqual(d.action, 'allow');
  });
});

test('entry is a number → allow, no throw', () => {
  assert.doesNotThrow(() => {
    const d = decide({ route: ROUTE, entry: 42, now: NOW });
    assert.strictEqual(d.action, 'allow');
  });
});

test('entry is an array → allow, no throw', () => {
  assert.doesNotThrow(() => {
    const d = decide({ route: ROUTE, entry: [], now: NOW });
    assert.strictEqual(d.action, 'allow');
  });
});

test('entry with invalid freshUntil timestamp → allow, no throw', () => {
  const d = decide({ route: ROUTE, entry: entry({ state: 'exhausted' }, 'not-a-date'), now: NOW });
  assert.strictEqual(d.action, 'allow');
});

test('entry with empty freshUntil → allow, no throw', () => {
  const d = decide({ route: ROUTE, entry: entry({ state: 'exhausted' }, ''), now: NOW });
  assert.strictEqual(d.action, 'allow');
});

test('entry with non-string freshUntil → allow, no throw', () => {
  const d = decide({ route: ROUTE, entry: entry({ state: 'exhausted' }, { weird: true }), now: NOW });
  assert.strictEqual(d.action, 'allow');
});

test('entry.status is null → allow, no deny', () => {
  const d = decide({ route: ROUTE, entry: entry(null), now: NOW });
  assert.strictEqual(d.action, 'allow');
});

test('entry.status is array → allow, no deny', () => {
  const d = decide({ route: ROUTE, entry: entry([]), now: NOW });
  assert.strictEqual(d.action, 'allow');
});

test('entry.status.state = exhausted but entry is stale → allow (only fresh + exhausted denies)', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, STALE),
    now: NOW,
  });
  assert.strictEqual(d.action, 'allow');
});

test('exhausted but invalid resetAt → deny still emits, no throw', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: 'garbage' }),
    now: NOW,
  });
  assert.strictEqual(d.action, 'deny');
  assert.doesNotThrow(() => d.reason);
});

test('decide is pure: same inputs → same outputs (no Date.now leakage)', () => {
  const a = decide({ route: ROUTE, entry: entry({ state: 'healthy' }), now: NOW });
  const b = decide({ route: ROUTE, entry: entry({ state: 'healthy' }), now: NOW });
  assert.deepStrictEqual(a, b);
});

console.log('\ndecide — nested malformed status fields (F3)');

test('windows is an object (not iterable) → safe summary, no throw', () => {
  assert.doesNotThrow(() => {
    const d = decide({
      route: ROUTE,
      entry: entry({ state: 'unknown', windows: {} }),
      now: NOW,
    });
    assert.strictEqual(d.action, 'allow');
  });
});

test('windows array contains null element → safe summary, no throw', () => {
  assert.doesNotThrow(() => {
    const d = decide({
      route: ROUTE,
      entry: entry({ state: 'healthy', windows: [null] }),
      now: NOW,
    });
    assert.strictEqual(d.action, 'allow');
  });
});

test('windows array contains primitive → safe summary, no throw', () => {
  assert.doesNotThrow(() => {
    const d = decide({
      route: ROUTE,
      entry: entry({ state: 'healthy', windows: [42, 'string', true] }),
      now: NOW,
    });
    assert.strictEqual(d.action, 'allow');
  });
});

test('balance is null/array/primitive → safe summary, no throw', () => {
  for (const b of [null, [], 42, 'string']) {
    assert.doesNotThrow(() => {
      decide({ route: ROUTE, entry: entry({ state: 'healthy', balance: b }), now: NOW });
    });
  }
});

test('window without type field → still emits a summary line', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'healthy', windows: [{ limit: 100, remaining: 50 }] }),
    now: NOW,
  });
  assert.strictEqual(d.action, 'allow');
  assert.match(d.context, /window 50%/);
});

console.log('\ndecide — strict ISO 8601 UTC timestamps (CodeRabbit 4056155869)');

test('calendar overflow: Sept 31 normalizes to Oct 1 → fail open (no deny)', () => {
  // FIXED_NOW = Sep 19 2026; '2030-09-31' parses as Oct 1 2030 (future),
  // which under the loose Date.parse check would mark the entry as fresh
  // and produce a deny. The strict parser must reject the overflow.
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, '2030-09-31T00:00:00.000Z'),
    now: NOW,
  });
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.refresh, true);
});

test('calendar overflow: Feb 29 in non-leap year → fail open', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, '2025-02-29T00:00:00.000Z'),
    now: NOW,
  });
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.refresh, true);
});

test('calendar overflow: month > 12 → fail open', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, '2026-13-01T00:00:00.000Z'),
    now: NOW,
  });
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.refresh, true);
});

test('valid leap-year date (Feb 29) → accepted as fresh', () => {
  // 2104 is a leap year (2104 % 4 == 0; 2104 % 100 != 0); Feb 29 is real;
  // round-trip matches; the future marks fresh + exhausted → deny.
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, '2104-02-29T00:00:00.000Z'),
    now: NOW,
  });
  assert.strictEqual(d.action, 'deny');
});

test('valid date without millisecond component → accepted', () => {
  // Cache may write toISOString (always .sss) but a provider or a manual
  // cache edit may omit the millis — still a valid ISO 8601 UTC string.
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, '2099-09-19T00:00:00Z'),
    now: NOW,
  });
  assert.strictEqual(d.action, 'deny');
});

test('valid date with sub-millisecond precision (.1) → accepted', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, '2099-09-19T00:00:00.1Z'),
    now: NOW,
  });
  assert.strictEqual(d.action, 'deny');
});

test('non-UTC timezone designator (offset) → accepted; fresh + exhausted still denies', () => {
  // The cache contract is the INSTANT, not the textual form. Valid ISO 8601
  // offsets represent real instants and must not be rejected as a policy
  // choice. A future schema or a manual cache edit using offsets must still
  // gate the dispatch on the resolved instant.
  const offCases = [
    '2099-09-19T00:00:00+00:00', // offset 0 == UTC Z
    '2099-09-19T00:00:00-05:00', // Sep 19 local == Sep 19 05:00 UTC
    '2099-09-19T00:00:00+05:00', // Sep 19 local == Sep 18 19:00 UTC
    '2099-09-19T00:00:00+0000', // compact offset form (no colon)
  ];
  for (const off of offCases) {
    const d = decide({
      route: ROUTE,
      entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, off),
      now: NOW,
    });
    assert.strictEqual(d.action, 'deny', `valid offset ${off} must deny when fresh+exhausted`);
  }
});

test('equivalent instants (UTC Z vs offset) produce identical freshness decisions', () => {
  // 2099-09-19T00:00:00Z ≡ 2099-09-19T05:00:00+05:00 ≡ 2099-09-19T00:00:00+00:00.
  // All three must produce the same epoch and therefore the same decision.
  const equivs = [
    '2099-09-19T00:00:00Z',
    '2099-09-19T05:00:00+05:00',
    '2099-09-19T00:00:00+00:00',
  ];
  for (const e of equivs) {
    const d = decide({
      route: ROUTE,
      entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, e),
      now: NOW,
    });
    assert.strictEqual(d.action, 'deny', `${e} (future, exhausted) must deny`);
  }
});

test('overflow with offset designator → fail open', () => {
  // The overflow defense is calendar-only; an offset does not let a bad
  // calendar slip through.
  for (const off of [
    '2030-09-31T00:00:00+00:00',
    '2030-09-31T00:00:00-05:00',
    '2099-02-29T00:00:00+00:00',
    '2026-13-01T00:00:00+05:00',
  ]) {
    const d = decide({
      route: ROUTE,
      entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: null }, off),
      now: NOW,
    });
    assert.strictEqual(d.action, 'allow', `overflow ${off} must fail open`);
    assert.strictEqual(d.refresh, true);
  }
});

test('safeIso also rejects calendar-overflow resetAt — no Invalid Date in deny reason', () => {
  const d = decide({
    route: ROUTE,
    entry: entry({ state: 'exhausted', windows: [], balance: null, resetAt: '2030-09-31T00:00:00.000Z' }, '2030-09-31T00:00:00.000Z'),
    now: NOW,
  });
  // Both freshUntil AND resetAt are overflow; entry fails open.
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.refresh, true);
});

test('parseStrictIsoTimestamp unit cases', () => {
  const { parseStrictIsoTimestamp } = require('../lib/gate');
  // accepted
  assert.ok(Number.isFinite(parseStrictIsoTimestamp('2024-02-29T00:00:00.000Z')), 'leap-year Feb 29');
  assert.ok(Number.isFinite(parseStrictIsoTimestamp('2026-09-19T00:00:00Z')), 'no millis');
  assert.ok(Number.isFinite(parseStrictIsoTimestamp('2026-09-19T00:00:00.000Z')), 'canonical');
  assert.ok(Number.isFinite(parseStrictIsoTimestamp('2026-09-19T00:00:00.1Z')), 'sub-millis');
  // valid offsets accepted
  assert.ok(Number.isFinite(parseStrictIsoTimestamp('2099-09-19T00:00:00+00:00')), 'offset +00:00');
  assert.ok(Number.isFinite(parseStrictIsoTimestamp('2099-09-19T00:00:00-05:00')), 'offset -05:00');
  assert.ok(Number.isFinite(parseStrictIsoTimestamp('2099-09-19T00:00:00+05:00')), 'offset +05:00');
  assert.ok(Number.isFinite(parseStrictIsoTimestamp('2099-09-19T00:00:00+0000')), 'compact offset');
  // rejected — calendar overflow
  assert.strictEqual(parseStrictIsoTimestamp('2030-09-31T00:00:00.000Z'), null, 'Sept 31 overflow');
  assert.strictEqual(parseStrictIsoTimestamp('2030-09-31T00:00:00+00:00'), null, 'Sept 31 overflow with offset');
  assert.strictEqual(parseStrictIsoTimestamp('2025-02-29T00:00:00.000Z'), null, 'Feb 29 non-leap');
  assert.strictEqual(parseStrictIsoTimestamp('2026-13-01T00:00:00.000Z'), null, 'month 13');
  // rejected — bad shape
  assert.strictEqual(parseStrictIsoTimestamp('2026-09-19'), null, 'date-only rejected');
  assert.strictEqual(parseStrictIsoTimestamp('2026-09-19 00:00:00Z'), null, 'space separator rejected');
  assert.strictEqual(parseStrictIsoTimestamp('2026-09-19T00:00:00'), null, 'no tz designator rejected');
  assert.strictEqual(parseStrictIsoTimestamp(''), null, 'empty');
  assert.strictEqual(parseStrictIsoTimestamp(null), null, 'null');
  assert.strictEqual(parseStrictIsoTimestamp(undefined), null, 'undefined');
  assert.strictEqual(parseStrictIsoTimestamp(12345), null, 'number');
  assert.strictEqual(parseStrictIsoTimestamp([]), null, 'array');
  assert.strictEqual(parseStrictIsoTimestamp('not-a-date'), null, 'garbage');
  // equivalent instants → identical epoch
  assert.strictEqual(
    parseStrictIsoTimestamp('2099-09-19T00:00:00Z'),
    parseStrictIsoTimestamp('2099-09-19T05:00:00+05:00'),
    'UTC Z and +05:00 offset of same instant must produce identical epoch',
  );
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall gate tests passed');
