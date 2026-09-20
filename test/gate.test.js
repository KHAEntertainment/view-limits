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

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall gate tests passed');
