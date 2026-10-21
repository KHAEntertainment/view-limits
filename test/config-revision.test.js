'use strict';
// configRevision, end to end (Issue #58, closing QA M3 from #54).
//
// #54 added the cache-side WRITER (`attachRevisions`) but nothing called it
// with `options.routes` and nothing read the field back, so the guard was
// inert. This file pins both halves:
//
//   writer   `vl.js refresh` publishes each route's revision into status.json
//   reader   `lib/gate.js` refuses to deny on an entry whose revision no
//            longer matches the configured route
//   parity   an entry with NO revision — every cache written before #58 —
//            behaves exactly as it did, including still denying
//
// It also closes QA M-R1 (deferred from #54 to #58): the depth-2 credential
// rejection inside `recipeOptions`.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { decide } = require('../lib/gate');
const { configRevision, isConfigObsolete, validateMonitor } = require('../lib/monitor-schema');
const cache = require('../lib/cache');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${(e && e.message) || e}`); }
}

const ROUTE = Object.freeze({
  id: 'custom-acme-plan',
  provider: 'openai-compat',
  match: { model: 'acme' },
  ttlSeconds: 600,
  monitor: Object.freeze({
    recipe: 'openai-compat',
    endpoint: 'https://acme.example.com',
    recipeOptions: Object.freeze({ path: '/v1/models', scope: 'account' }),
  }),
});

const DENY_CONFIG = Object.freeze({ gate: { mode: 'deny', injectContext: false, constrainedThreshold: 0.2 } });

function exhaustedEntry(extra = {}) {
  return {
    routeId: ROUTE.id,
    observedAt: new Date().toISOString(),
    freshUntil: new Date(Date.now() + 600_000).toISOString(),
    source: 'openai-compat',
    status: {
      state: 'exhausted',
      windows: [],
      balance: null,
      resetAt: new Date(Date.now() + 3_600_000).toISOString(),
      detail: {},
    },
    ...extra,
  };
}

function edited(changes) {
  return {
    ...ROUTE,
    monitor: { ...ROUTE.monitor, ...changes, recipeOptions: { ...ROUTE.monitor.recipeOptions, ...(changes.recipeOptions || {}) } },
  };
}

console.log('isConfigObsolete — pure predicate');

test('an entry with no configRevision is never obsolete (pre-#58 parity)', () => {
  assert.strictEqual(isConfigObsolete(exhaustedEntry(), ROUTE), false);
  assert.strictEqual(isConfigObsolete(exhaustedEntry({ configRevision: '' }), ROUTE), false);
  assert.strictEqual(isConfigObsolete(exhaustedEntry({ configRevision: null }), ROUTE), false);
  assert.strictEqual(isConfigObsolete(exhaustedEntry({ configRevision: 42 }), ROUTE), false);
});

test('a matching revision is not obsolete', () => {
  assert.strictEqual(isConfigObsolete(exhaustedEntry({ configRevision: configRevision(ROUTE) }), ROUTE), false);
});

test('a differing revision is obsolete', () => {
  assert.strictEqual(isConfigObsolete(exhaustedEntry({ configRevision: 'deadbeef' }), ROUTE), true);
});

test('each revision-bearing monitor field makes an old entry obsolete', () => {
  const stamped = exhaustedEntry({ configRevision: configRevision(ROUTE) });
  for (const change of [
    { endpoint: 'https://other.example.com' },
    { account: 'second-seat' },
    { profile: 'work' },
    { region: 'us-east-1' },
    { model: 'acme-large' },
    { recipeOptions: { scope: 'model' } },
    { recipeOptions: { path: '/v1/other' } },
    { recipeOptions: { resetEncoding: 'rfc3339' } },
  ]) {
    assert.strictEqual(isConfigObsolete(stamped, edited(change)), true, JSON.stringify(change));
  }
});

test('an ephemeral option (timeoutMs) does NOT make an entry obsolete', () => {
  const stamped = exhaustedEntry({ configRevision: configRevision(ROUTE) });
  assert.strictEqual(isConfigObsolete(stamped, edited({ recipeOptions: { timeoutMs: 12000 } })), false,
    'transport tuning must not invalidate a cached observation');
});

test('the predicate is total: no input throws, and an unverifiable revision fails OPEN', () => {
  // A BigInt in a HASHED field is the reliable way to make configRevision
  // throw: JSON.stringify refuses to serialize it. A circular reference on a
  // key outside ALLOWED_MONITOR_FIELDS would simply be dropped by
  // normalizedMonitor and never reach the hash at all.
  const unhashable = { ...ROUTE, monitor: { ...ROUTE.monitor, endpoint: 1n } };
  assert.throws(() => configRevision(unhashable), /BigInt|serialize/i,
    'the fixture must really be unhashable, or this test proves nothing');
  for (const entry of [null, undefined, 42, 's', []]) {
    assert.strictEqual(isConfigObsolete(entry, ROUTE), false, 'a non-entry is never obsolete');
  }
  // A revision IS present but cannot be checked against the route ⇒ obsolete,
  // which is the fail-open direction at the gate: an observation we cannot
  // verify must not support a deny.
  const stamped = exhaustedEntry({ configRevision: 'abc123' });
  for (const route of [null, undefined, 42, [], 'nope']) {
    assert.strictEqual(isConfigObsolete(stamped, route), true,
      'an unusable route must not leave a stamped entry deny-capable');
  }
  assert.strictEqual(isConfigObsolete(stamped, {}), true);
  assert.strictEqual(isConfigObsolete(stamped, unhashable), true,
    'a route whose revision cannot be computed must not be deny-capable');
  // But a legacy entry with NO revision keeps its pre-#58 behaviour whatever
  // the route looks like.
  assert.strictEqual(isConfigObsolete(exhaustedEntry(), null), false);
  assert.strictEqual(isConfigObsolete(exhaustedEntry(), unhashable), false);
});

test('lib/cache re-exports the same predicate', () => {
  assert.strictEqual(cache.isConfigObsolete, isConfigObsolete);
});

console.log('gate.decide — the reader');

test('a fresh exhausted entry with a MATCHING revision still denies', () => {
  const d = decide({ route: ROUTE, entry: exhaustedEntry({ configRevision: configRevision(ROUTE) }), now: Date.now(), config: DENY_CONFIG });
  assert.strictEqual(d.action, 'deny');
  assert.match(d.reason, /is exhausted/);
});

test('a fresh exhausted entry with NO revision still denies (pre-#58 parity)', () => {
  const d = decide({ route: ROUTE, entry: exhaustedEntry(), now: Date.now(), config: DENY_CONFIG });
  assert.strictEqual(d.action, 'deny', 'an existing install must keep denying');
});

test('an obsolete entry does NOT deny; it takes the existing fail-open branch', () => {
  const entry = exhaustedEntry({ configRevision: configRevision(ROUTE) });
  const d = decide({ route: edited({ account: 'second-seat' }), entry, now: Date.now(), config: DENY_CONFIG });
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.refresh, true, 'the obsolete branch must schedule a refresh, like a stale entry');
  assert.strictEqual(d.reason, undefined);
});

test('the obsolete branch emits the same no-fresh-status context as a stale entry', () => {
  const config = { gate: { mode: 'deny', injectContext: true, constrainedThreshold: 0.2 } };
  const entry = exhaustedEntry({ configRevision: configRevision(ROUTE) });
  const obsolete = decide({ route: edited({ account: 'second-seat' }), entry, now: Date.now(), config });
  const stale = decide({ route: ROUTE, entry: { ...entry, freshUntil: new Date(Date.now() - 1000).toISOString() }, now: Date.now(), config });
  assert.strictEqual(obsolete.context, stale.context,
    'an obsolete entry must be indistinguishable from a stale one at the gate');
});

test('an obsolete HEALTHY entry also falls open rather than reporting old numbers', () => {
  const entry = exhaustedEntry({ configRevision: configRevision(ROUTE) });
  entry.status = { state: 'healthy', windows: [], balance: null, resetAt: null, detail: {} };
  const config = { gate: { mode: 'deny', injectContext: true, constrainedThreshold: 0.2 } };
  const d = decide({ route: edited({ endpoint: 'https://other.example.com' }), entry, now: Date.now(), config });
  assert.strictEqual(d.action, 'allow');
  assert.strictEqual(d.refresh, true);
  assert.doesNotMatch(d.context || '', /healthy/, 'stale-config numbers must not be summarized as current');
});

test('advisory mode is unaffected by an obsolete entry (never denies anyway)', () => {
  const entry = exhaustedEntry({ configRevision: configRevision(ROUTE) });
  const config = { gate: { mode: 'advisory', injectContext: true, constrainedThreshold: 0.2 } };
  const d = decide({ route: edited({ account: 'second-seat' }), entry, now: Date.now(), config });
  assert.strictEqual(d.action, 'allow');
});

test('a stamped entry whose revision cannot be verified does not deny', () => {
  const unhashable = { ...ROUTE, monitor: { ...ROUTE.monitor, endpoint: 1n } };
  const d = decide({
    route: unhashable,
    entry: exhaustedEntry({ configRevision: configRevision(ROUTE) }),
    now: Date.now(),
    config: DENY_CONFIG,
  });
  assert.strictEqual(d.action, 'allow', 'an unverifiable revision must fail open, not deny');
  assert.strictEqual(d.refresh, true);
});

console.log('CLI — writer and reader together');

const cli = path.resolve(__dirname, '../bin/vl.js');

function gateDir(route, entry, gate = { mode: 'deny' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-revision-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ routes: [route], gate, vault: { backend: 'file' } }, null, 1));
  if (entry) {
    fs.writeFileSync(path.join(dir, 'status.json'),
      JSON.stringify({ updatedAt: new Date().toISOString(), routes: { [route.id]: entry } }, null, 1));
  }
  return dir;
}

function runGate(dir, model) {
  const r = spawnSync(process.execPath, [cli, 'gate'], {
    env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir, VIEW_LIMITS_MASTER_KEY: 'k' },
    input: JSON.stringify({ tool_name: 'Task', tool_input: { model } }),
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.strictEqual(r.status, 0, 'the gate must always exit 0 (fail-open contract)');
  return r.stdout;
}

test('the real gate denies on a matching revision and falls open once the route is edited', () => {
  const dir = gateDir(ROUTE, exhaustedEntry({ configRevision: configRevision(ROUTE) }));
  assert.match(runGate(dir, 'acme'), /"permissionDecision":"deny"/);
  // The realistic case this guard exists for: a hand-edited config.json.
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  doc.routes[0].monitor.recipeOptions.scope = 'model';
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(doc, null, 1));
  const after = runGate(dir, 'acme');
  assert.doesNotMatch(after, /deny/, 'an edited route must not keep denying on the old observation');
});

test('the real gate still denies a pre-#58 cache entry (no configRevision field)', () => {
  const dir = gateDir(ROUTE, exhaustedEntry());
  assert.match(runGate(dir, 'acme'), /"permissionDecision":"deny"/);
});

test('refresh publishes a revision for every route it observes (the writer)', () => {
  const dir = gateDir(ROUTE, null, { mode: 'off' });
  const preload = path.join(__dirname, 'fixtures/lifecycle-cli-preload.cjs');
  // Store a credential so the route takes part in the refresh.
  for (const args of [['setup', ROUTE.id, '--key', 'sk-TEST-rev-0001'], ['refresh', '--quiet']]) {
    const r = spawnSync(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH, HOME: dir, CLAUDE_PLUGIN_DATA: dir,
        VIEW_LIMITS_MASTER_KEY: 'k', NODE_OPTIONS: `--require=${preload}`,
        VL_FAKE_HEADERS: JSON.stringify({
          'x-ratelimit-limit-requests': '1000',
          'x-ratelimit-remaining-requests': '900',
          'x-ratelimit-reset-requests': '45s',
        }),
      },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.strictEqual(r.status, 0, `${args[0]} failed: ${r.stderr}`);
  }
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  const entry = doc.routes[ROUTE.id];
  assert.ok(entry, 'the route must be in the cache');
  assert.strictEqual(entry.configRevision, configRevision(ROUTE),
    'refresh must publish the route revision (QA M3 writer)');
  // And the published field is immediately usable by the reader.
  assert.strictEqual(isConfigObsolete(entry, ROUTE), false);
  assert.strictEqual(isConfigObsolete(entry, edited({ account: 'other' })), true);
});

console.log('QA M-R1 — depth-2 credential rejection inside recipeOptions');

// Deferred from #54 ("check whether SECRET_VALUE_RES at {2,} now covers it")
// and closed here: both the NAME and the VALUE rules apply one level inside
// recipeOptions, and a nested object is refused outright, so there is no depth
// at which a credential can be smuggled into config.json.
test('a credential-shaped option NAME is rejected at depth 2', () => {
  for (const name of ['token', 'apiKey', 'api_key', 'secret', 'password', 'authorization',
    'bearer', 'cookie', 'sessionId', 'credential', 'private_key', 'signature', 'xAuthToken']) {
    const r = validateMonitor({ id: 'x', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models', [name]: 'v' } } });
    assert.strictEqual(r.ok, false, `recipeOptions.${name} must be refused`);
    assert.match(r.error, /credential-shaped|not an option/, name);
  }
});

test('a credential-shaped option VALUE is rejected at depth 2, including short fragments', () => {
  for (const value of ['Bearer abc', 'basic abc', 'sk-AAA', 'sk_ABCDEFGH',
    'eyJhbGci.eyJzdWIi', 'xoxb-123', 'ghp_abc', 'AKIAABCDEFGH12345678']) {
    const r = validateMonitor({ id: 'x', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models', scope: value } } });
    assert.strictEqual(r.ok, false, `recipeOptions value "${value}" must be refused`);
    // Assert the CREDENTIAL-specific reason, not merely ok:false. Every value
    // here is also outside `scope`'s enum, so a bare ok:false assertion would
    // stay green even with the secret-value guard deleted — the enum branch
    // would reject it anyway. This pins the guard itself.
    assert.match(r.error, /holds a credential-shaped value and is non-persistable/,
      `"${value}" was rejected by the wrong rule — the credential-value guard did not fire`);
  }
});

test('a credential-shaped path SEGMENT is rejected', () => {
  const r = validateMonitor({ id: 'x', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/sk-AAA/models' } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /credential-shaped segment/);
});

test('a nested object inside recipeOptions is refused, so there is no depth 3', () => {
  const r = validateMonitor({ id: 'x', provider: 'openai-compat', monitor: { recipe: 'openai-compat', endpoint: 'https://a.example.com', recipeOptions: { path: '/v1/models', nested: { token: 'x' } } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /must be a primitive/);
});

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exitCode = 1;
} else {
  console.log('\nall config-revision tests passed');
}
