'use strict';
// Tests for lib/eligibility.js — deterministic three-valued eligibility over
// normalized candidates. Every fixture is pure data: no provider I/O, no
// network, no Jev, no clock. Covers eligible / ineligible / unresolved plus
// the Issue #9 edge cases (a)–(h).

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { evaluate, RESULTS, REASON_ORDER } = require('../lib/eligibility');
const { DEFAULT_ENTRIES, createRegistry, defaultRegistry, mergeEntries } = require('../lib/capability-registry');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

const REG = defaultRegistry();

// A fully-proven baseline candidate: registered model with 'code', registered
// harness providing the 'dev' skill, proven availability and a healthy route.
function baseCandidate(overrides = {}) {
  return {
    id: 'cand-1',
    model: 'kimi-k2',
    harness: 'claude',
    harnessAvailable: true,
    profile: 'kha-main',
    skills: [],
    route: { id: 'kimi-code-plan', state: 'healthy' },
    ...overrides,
  };
}

const BASE_POLICY = {
  require: {
    taskCapabilities: ['code'],
    executionCapabilities: ['dispatch'],
    skills: ['dev'],
    harnesses: ['claude'],
    route: true,
    usableRoute: true,
  },
};

function codes(result) {
  return result.reasons.map((r) => `${r.code}@${r.scope}`);
}

function hasCode(result, code) {
  return result.reasons.some((r) => r.code === code);
}

console.log('eligibility — three-valued contract');

test('fully proven candidate + satisfied policy → eligible with no reasons', () => {
  const r = evaluate(baseCandidate(), BASE_POLICY, REG);
  assert.strictEqual(r.result, 'eligible');
  assert.deepStrictEqual(r.reasons, []);
  assert.ok(RESULTS.includes(r.result));
});

test('fact-shaped inputs: observed and configured provenance both count as proven evidence', () => {
  // Provenance distinguishes evidence sources but never gatekeeps truth here:
  // 'observed' and 'configured' facts are equally proven for eligibility.
  for (const prov of ['observed', 'configured']) {
    const r = evaluate(baseCandidate({
      model: { value: 'kimi-k2', provenance: prov, source: 'runtime.json' },
      harnessAvailable: { value: true, provenance: prov, source: 'config' },
    }), BASE_POLICY, REG);
    assert.strictEqual(r.result, 'eligible', prov);
  }
});

test('fact-shaped input with provenance unknown is NOT proven — never coerced to a value', () => {
  const r = evaluate(baseCandidate({
    model: { value: 'kimi-k2', provenance: 'unknown', reason: 'model-evidence-absent' },
  }), { require: { taskCapabilities: ['code'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(hasCode(r, 'model-capability-unproven'));
});

test('a fact-shaped input is not silently downgraded to a bare primitive', () => {
  // An unknown-provenance fact object must not collapse to its value; a
  // proven fact object must still drive registry resolution (alias lookup).
  const unknownFact = evaluate(baseCandidate({
    harness: { value: 'claude', provenance: 'unknown', reason: 'harness-absent' },
  }), { forbid: { harnesses: ['claude'] } }, REG);
  assert.strictEqual(unknownFact.result, 'unresolved');
  assert.ok(hasCode(unknownFact, 'harness-identity-unproven'));
  const provenFact = evaluate(baseCandidate({
    harness: { value: 'Claude-Code', provenance: 'observed', source: 'runtime.json' },
  }), { forbid: { harnesses: ['claude'] } }, REG);
  assert.strictEqual(provenFact.result, 'ineligible'); // alias resolved → forbidden
  assert.ok(hasCode(provenFact, 'harness-forbidden'));
});

test('unknown-provenance facts are never coerced — required evidence stays unproven', () => {
  const r = evaluate(baseCandidate({
    route: { id: 'kimi-code-plan', state: { value: null, provenance: 'unknown', reason: 'cached-state-absent' } },
  }), BASE_POLICY, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('route-state-unproven@route'));
  assert.strictEqual(r.reasons.every((x) => typeof x.summary === 'string' && x.summary.length > 0), true);
});

test('malformed inputs never throw and never guess', () => {
  for (const [cand, pol] of [[null, null], ['x', 'x'], [42, []], [{}, {}]]) {
    const r = evaluate(cand, pol, REG);
    assert.ok(RESULTS.includes(r.result));
    assert.ok(Array.isArray(r.reasons));
  }
  // no requirements and no known violations → eligible
  assert.strictEqual(evaluate(null, null, REG).result, 'eligible');
});

test('determinism: same input → same result and same ordered reason codes', () => {
  const cand = baseCandidate({
    model: 'unregistered-model',
    route: { id: 'blocked-route', state: 'exhausted' },
    harnessAvailable: false,
  });
  const pol = {
    require: { taskCapabilities: ['vision'], skills: ['dev'] },
    forbid: { routes: ['blocked-route'], profiles: ['kha-main'] },
  };
  const a = evaluate(cand, pol, REG);
  const b = evaluate(JSON.parse(JSON.stringify(cand)), pol, REG);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.result, 'ineligible');
});

console.log('\neligibility — (a) resource health cannot override a hard requirement');

test('(a) healthy route + proven-missing required skill → ineligible', () => {
  const r = evaluate(baseCandidate({ route: { id: 'kimi-code-plan', state: 'healthy' } }),
    { require: { skills: ['nonexistent-skill'] } }, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(codes(r).includes('required-skill-missing@skill:nonexistent-skill'));
});

test('(a) healthy route + required harness outside allowlist → ineligible', () => {
  const r = evaluate(baseCandidate({ route: { id: 'kimi-code-plan', state: 'healthy' } }),
    { require: { harnesses: ['codex'] } }, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(hasCode(r, 'harness-not-allowed'));
});

test('(a) healthy route + registered harness missing required exec capability → ineligible', () => {
  const r = evaluate(baseCandidate({ harness: 'codex', route: { id: 'kimi-code-plan', state: 'healthy' } }),
    { require: { executionCapabilities: ['mcp'] } }, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(codes(r).includes('execution-capability-missing@capability:mcp'));
});

console.log('\neligibility — (b) exhausted route is a policy-independent hard constraint');

test('(b) observed exhausted route + otherwise-fine candidate → ineligible', () => {
  const r = evaluate(baseCandidate({ route: { id: 'kimi-code-plan', state: 'exhausted' } }),
    { require: { taskCapabilities: ['code'] } }, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(codes(r).includes('route-exhausted@route:kimi-code-plan'));
});

test('(b) exhausted route denies even with an empty policy', () => {
  const r = evaluate(baseCandidate({ route: { id: 'kimi-code-plan', state: 'exhausted' } }), {}, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(hasCode(r, 'route-exhausted'));
});

console.log('\neligibility — (c) unproven required capability → unresolved, never eligible');

test('(c) unregistered model + required task capability → unresolved', () => {
  const r = evaluate(baseCandidate({ model: 'mystery-model-9000' }),
    { require: { taskCapabilities: ['code'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('model-capability-unproven@capability:code'));
});

test('(c) absent model + required task capability → unresolved', () => {
  const cand = baseCandidate();
  delete cand.model;
  const r = evaluate(cand, { require: { taskCapabilities: ['code'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(hasCode(r, 'model-capability-unproven'));
});

test('(c) unregistered harness + required execution capability → unresolved', () => {
  const r = evaluate(baseCandidate({ harness: 'paperclip-os' }),
    { require: { executionCapabilities: ['shell'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('execution-capability-unproven@capability:shell'));
});

test('(c) required skill with only partial evidence → unresolved', () => {
  // harness registered but lacks the skill; candidate skill inventory absent
  // (unproven) → absence cannot be proven → unresolved, not ineligible.
  const cand = baseCandidate();
  delete cand.skills;
  const r = evaluate(cand, { require: { skills: ['nonexistent-skill'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('required-skill-unproven@skill:nonexistent-skill'));
});

test('(c) declared candidate capabilities can prove presence for unregistered model', () => {
  const r = evaluate(baseCandidate({
    model: 'mystery-model-9000',
    taskCapabilities: ['code'],
  }), { require: { taskCapabilities: ['code'] } }, REG);
  assert.strictEqual(r.result, 'eligible');
});

console.log('\neligibility — (d/e) independent-review family rule');

const REVIEW_POLICY = { review: { requireDifferentFamily: true, subject: { model: 'claude-sonnet-4' } } };

test('(d) review-required + candidate family unproven → unresolved', () => {
  const r = evaluate(baseCandidate({ model: 'mystery-model-9000' }), REVIEW_POLICY, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('family-unproven@family:candidate'));
});

test('(d) review-required + subject family unproven → unresolved', () => {
  const r = evaluate(baseCandidate(), {
    review: { requireDifferentFamily: true, subject: { model: 'unregistered-subject-model' } },
  }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('family-unproven@family:subject'));
});

test('(d) review-required + both families proven and different → eligible contribution', () => {
  const r = evaluate(baseCandidate({ model: 'kimi-k2' }), REVIEW_POLICY, REG);
  assert.strictEqual(r.result, 'eligible');
});

test('(e) review-required + both families proven equal → deterministic exclusion', () => {
  const r = evaluate(baseCandidate({ model: 'claude-opus-4' }), REVIEW_POLICY, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(codes(r).includes('review-same-family@review'));
});

test('(e) family aliases canonicalize before comparison', () => {
  const r = evaluate(baseCandidate({ model: 'claude-opus-4' }), {
    review: { requireDifferentFamily: true, subject: 'claude' }, // family alias → anthropic
  }, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(hasCode(r, 'review-same-family'));
});

console.log('\neligibility — (f) forbidden route/profile');

test('(f) forbidden route and forbidden profile → ineligible with both reasons', () => {
  const r = evaluate(baseCandidate(), {
    forbid: { routes: ['kimi-code-plan'], profiles: ['KHA-MAIN'] },
  }, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(codes(r).includes('route-forbidden@route:kimi-code-plan'));
  assert.ok(codes(r).includes('profile-forbidden@profile:kha-main'));
});

test('(f) forbidden model matches canonical id and aliases', () => {
  for (const forbidden of ['kimi-k2', 'kimi-for-coding']) {
    const r = evaluate(baseCandidate(), { forbid: { models: [forbidden] } }, REG);
    assert.strictEqual(r.result, 'ineligible', forbidden);
    assert.ok(hasCode(r, 'model-forbidden'), forbidden);
  }
});

test('(f) non-empty forbid list + unproven identity → unresolved, not cleared', () => {
  const cand = baseCandidate();
  delete cand.route;
  const r = evaluate(cand, { forbid: { routes: ['kimi-code-plan'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('route-identity-unproven@route'));
});

console.log('\neligibility — (g) incompatible model');

test('(g) registered model lacking a required task capability → ineligible', () => {
  const r = evaluate(baseCandidate({ model: 'kimi-k2' }),
    { require: { taskCapabilities: ['reasoning'] } }, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(codes(r).includes('model-capability-missing@capability:reasoning'));
});

test('(g) model outside the policy allowlist → ineligible', () => {
  const r = evaluate(baseCandidate({ model: 'kimi-k2' }),
    { require: { models: ['gpt-5', 'claude-opus-4'] } }, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.ok(codes(r).includes('model-not-allowed@model:kimi-k2'));
});

test('(g) allowlist matches aliases; unproven model under allowlist → unresolved', () => {
  const ok = evaluate(baseCandidate({ model: 'kimi-for-coding' }),
    { require: { models: ['kimi-k2'] } }, REG);
  assert.strictEqual(ok.result, 'eligible');
  const cand = baseCandidate();
  delete cand.model;
  const r = evaluate(cand, { require: { models: ['kimi-k2'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(hasCode(r, 'model-identity-unproven'));
});

console.log('\neligibility — proven-positive sentinel contract (route state + harness availability)');

test('proven-negative harness availability → ineligible regardless of policy', () => {
  for (const v of [false, 'unavailable', { value: false, provenance: 'observed', source: 'runtime.json' }]) {
    const r = evaluate(baseCandidate({ harnessAvailable: v }), {}, REG);
    assert.strictEqual(r.result, 'ineligible', JSON.stringify(v));
    assert.ok(hasCode(r, 'harness-unavailable'));
  }
});

test('only an explicit positive proves availability; every other value is unproven', () => {
  const pol = { require: { harnesses: ['claude'] } };
  for (const v of [true, 'available']) {
    const r = evaluate(baseCandidate({ harnessAvailable: v }), pol, REG);
    assert.strictEqual(r.result, 'eligible', `proven positive ${JSON.stringify(v)}`);
  }
  // 'unknown', 'false', '', 0 — same sentinels, same treatment: never a
  // proven positive, and not a proven negative either → unresolved.
  for (const v of ['unknown', 'false', '', 0, 'yes', null, undefined]) {
    const cand = baseCandidate({ harnessAvailable: v });
    if (v === undefined) delete cand.harnessAvailable;
    const r = evaluate(cand, pol, REG);
    assert.strictEqual(r.result, 'unresolved', `unproven ${JSON.stringify(v)}`);
    assert.ok(codes(r).includes('harness-availability-unproven@harness'), JSON.stringify(v));
  }
});

test('route state uses the same sentinel rule under require.usableRoute', () => {
  const pol = { require: { usableRoute: true } };
  for (const state of ['healthy', 'constrained']) {
    const r = evaluate(baseCandidate({ route: { id: 'kimi-code-plan', state } }), pol, REG);
    assert.strictEqual(r.result, 'eligible', state);
  }
  for (const state of ['unknown', 'weird-state', '', 0]) {
    const r = evaluate(baseCandidate({ route: { id: 'kimi-code-plan', state } }), pol, REG);
    assert.strictEqual(r.result, 'unresolved', JSON.stringify(state));
    assert.ok(codes(r).includes('route-state-unproven@route'), JSON.stringify(state));
  }
  // 'exhausted' is a proven negative: ineligible only, never ALSO unproven
  const r = evaluate(baseCandidate({ route: { id: 'kimi-code-plan', state: 'exhausted' } }), pol, REG);
  assert.strictEqual(r.result, 'ineligible');
  assert.deepStrictEqual(codes(r), ['route-exhausted@route:kimi-code-plan']);
});

test('unproven availability is only required when the policy demands a harness', () => {
  const cand = baseCandidate();
  delete cand.harnessAvailable;
  // no harness requirement → absent availability is not a deficit
  assert.strictEqual(evaluate(cand, { require: { taskCapabilities: ['code'] } }, REG).result, 'eligible');
  // execution-capability requirement → unproven availability → unresolved
  const r = evaluate(cand, { require: { executionCapabilities: ['dispatch'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('harness-availability-unproven@harness'));
});

console.log('\neligibility — precedence and ordering');

test('ineligible outranks unresolved; ineligible reasons sort first', () => {
  const r = evaluate(baseCandidate({
    model: 'mystery-model-9000', // unproven capability
    route: { id: 'kimi-code-plan', state: 'exhausted' }, // violated hard constraint
  }), { require: { taskCapabilities: ['code'] } }, REG);
  assert.strictEqual(r.result, 'ineligible');
  const list = codes(r);
  assert.ok(list.includes('route-exhausted@route:kimi-code-plan'));
  assert.ok(list.includes('model-capability-unproven@capability:code'));
  assert.ok(list.indexOf('route-exhausted@route:kimi-code-plan') < list.indexOf('model-capability-unproven@capability:code'));
});

test('reason order is canonical, not input-order dependent', () => {
  const mk = (forbidFirst) => ({
    forbid: forbidFirst
      ? { routes: ['kimi-code-plan'], models: ['kimi-k2'] }
      : { models: ['kimi-k2'], routes: ['kimi-code-plan'] },
  });
  const a = evaluate(baseCandidate(), mk(true), REG);
  const b = evaluate(baseCandidate(), mk(false), REG);
  assert.deepStrictEqual(codes(a), codes(b));
  const ranks = a.reasons.map((r) => REASON_ORDER.indexOf(r.code));
  assert.deepStrictEqual(ranks, ranks.slice().sort((x, y) => x - y));
});

console.log('\neligibility — (h) registry extension changes results without adapter changes');

test('(h) adding a registry entry flips unresolved → eligible with zero adapter diff', () => {
  const cand = baseCandidate({ model: 'acme-ultra' });
  const pol = { require: { taskCapabilities: ['code'] } };

  const before = evaluate(cand, pol, REG);
  assert.strictEqual(before.result, 'unresolved');
  assert.ok(hasCode(before, 'model-capability-unproven'));

  const hashAdapters = () => {
    const dir = path.join(__dirname, '..', 'lib', 'adapters');
    const out = {};
    for (const f of fs.readdirSync(dir).sort()) {
      out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    }
    return out;
  };
  const hashesBefore = hashAdapters();

  const extended = createRegistry(mergeEntries(DEFAULT_ENTRIES, {
    families: { acme: {} },
    models: { 'acme-ultra': { family: 'acme', taskCapabilities: ['code'] } },
  }));
  const after = evaluate(cand, pol, extended);
  assert.strictEqual(after.result, 'eligible');

  assert.deepStrictEqual(hashAdapters(), hashesBefore, 'adapter files must be byte-identical');
  const adapterModules = Object.keys(require.cache)
    .filter((k) => k.includes(`${path.sep}lib${path.sep}adapters${path.sep}`));
  assert.deepStrictEqual(adapterModules, [], 'no provider adapter may be loaded by the eligibility path');
});

test('(h) eligibility modules never import adapters or runtime discovery', () => {
  for (const mod of ['eligibility.js', 'capability-registry.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', mod), 'utf8');
    assert.ok(!/require\([^)]*adapters/.test(src), `${mod} must not require adapters`);
    assert.ok(!/require\([^)]*traycer-adapter/.test(src), `${mod} must not require the runtime adapter`);
  }
});

test('(h) lib sources are plain text — no NUL bytes that would break grep/file tooling', () => {
  for (const mod of ['eligibility.js', 'capability-registry.js']) {
    const buf = fs.readFileSync(path.join(__dirname, '..', 'lib', mod));
    assert.strictEqual(buf.includes(0), false, `${mod} must contain no NUL bytes`);
  }
});

console.log('\neligibility — review-coverage hardening');

test('skills union: unregistered harness + proven-empty candidate inventory → unresolved', () => {
  // Harness side cannot prove absence (unregistered → harnessSkills null);
  // the known-empty candidate inventory alone cannot prove it either.
  const r = evaluate(baseCandidate({ harness: 'paperclip-os', skills: [] }),
    { require: { skills: ['dev'] } }, REG);
  assert.strictEqual(r.result, 'unresolved');
  assert.ok(codes(r).includes('required-skill-unproven@skill:dev'));
});

test('bare-string subject naming an unregistered family compares as a literal', () => {
  // Documented decision: a supplied family literal is evidence of itself.
  // 'totally-unknown-family' ≠ candidate 'moonshot' → families differ → the
  // review requirement is satisfied.
  const r = evaluate(baseCandidate({ model: 'kimi-k2' }), {
    review: { requireDifferentFamily: true, subject: 'totally-unknown-family' },
  }, REG);
  assert.strictEqual(r.result, 'eligible');
});

test('family declared via alias on a model entry canonicalizes in BOTH directions', () => {
  const reg = createRegistry({
    families: { anthropic: { aliases: ['claude'] }, acme: {} },
    models: {
      'm-one': { family: 'claude', taskCapabilities: ['code'] }, // alias → anthropic
      'm-two': { family: 'acme', taskCapabilities: ['code'] },
    },
    harnesses: { h: { executionCapabilities: [], skills: [] } },
  });
  const cand = { model: 'm-one', harness: 'h', harnessAvailable: true };
  // candidate family 'claude' (alias) vs subject 'anthropic' (canonical)
  const same = evaluate(cand, {
    review: { requireDifferentFamily: true, subject: { family: 'anthropic' } },
  }, reg);
  assert.strictEqual(same.result, 'ineligible');
  assert.ok(codes(same).includes('review-same-family@review'));
  // candidate 'claude' (alias → anthropic) vs subject model m-two (acme)
  const diff = evaluate(cand, {
    review: { requireDifferentFamily: true, subject: { model: 'm-two' } },
  }, reg);
  assert.strictEqual(diff.result, 'eligible');
});

if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nall eligibility tests passed');
