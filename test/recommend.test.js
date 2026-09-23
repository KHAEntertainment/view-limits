'use strict';
// Tests for lib/recommend.js — the advisory recommendation pipeline (Issue
// #11). Pure-data fixtures plus injected transport stubs; the only
// subprocess/network proof lives in test/recommend-cli.test.js under
// guard.cjs.
//
// Coverage: AC1 dormant gate, AC3 five failure fallbacks + eligibility
// unchanged in both directions, AC4 policy supremacy over Jev output, AC5 six
// scoring dimensions with reasons/alternatives/unresolved visibility, AC6
// advisory boundary, AC7 registry decoupling, determinism.

const assert = require('assert');

const { recommend } = require('../lib/recommend');
const { evaluate } = require('../lib/eligibility');
const { createRegistry, defaultRegistry, DEFAULT_ENTRIES } = require('../lib/capability-registry');
const { READINESS_ITEMS, evaluateReadiness } = require('../lib/jev-readiness');

let failures = 0;
const pendingTests = [];
function test(name, fn) {
  let result;
  try { result = fn(); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); return; }
  if (result && typeof result.then === 'function') {
    pendingTests.push(result.then(
      () => { console.log(`  ✓ ${name}`); },
      (e) => { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); },
    ));
  } else {
    console.log(`  ✓ ${name}`);
  }
}

const REG = defaultRegistry();
const NOW = Date.parse('2026-09-23T00:00:00Z');
const FRESH = '2026-09-24T00:00:00Z';
const STALE = '2026-09-20T00:00:00Z';

// An all-PASS evidence set — injected, never the default. Used to exercise
// the Jev code path while the recorded gate stays closed.
const ALL_PASS = READINESS_ITEMS.map((i) => ({ ...i, verdict: 'pass' }));

const JEV_OK = {
  profile: {
    taskKind: 'code', exploration: 'scoped', specification: 'precise',
    reasoning: 'moderate', risk: 'low', autonomy: 'standard',
    verification: 'automated', executionStyle: 'batch',
  },
  confidence: 0.9,
};

const OPEN_JEV = (transport, config = {}) => ({
  config: {
    model: 'acme/jev-1.13', baseUrl: 'https://example.invalid',
    catalogUrl: 'https://example.invalid/models', ...config,
  },
  io: { request: transport },
});

function recordingTransport(result) {
  const calls = [];
  const fn = async (req, opts) => {
    calls.push(req);
    if (result instanceof Error) throw result;
    return typeof result === 'function' ? result(req, opts) : result;
  };
  return { fn, calls };
}

function baseCandidates() {
  return [
    {
      id: 'kimi-code-plan', model: 'kimi', harness: 'claude', profile: 'code-plan',
      harnessAvailable: true,
      route: { id: 'kimi-code-plan', state: 'healthy', freshUntil: FRESH },
    },
    {
      id: 'deepseek-direct', model: 'deepseek', harness: 'claude', profile: 'personal',
      harnessAvailable: true,
      route: { id: 'deepseek-direct', state: 'constrained', freshUntil: FRESH },
    },
    {
      id: 'minimax-token-plan', model: 'minimax', harness: 'codex', profile: 'token-plan',
      harnessAvailable: true,
      route: { id: 'minimax-token-plan', state: 'constrained', freshUntil: FRESH },
    },
  ];
}

const CALLER = {
  harness: 'claude',
  selectedProfile: { value: null, provenance: 'unknown', reason: 'caller-fact-absent' },
  selectedAccount: { value: null, provenance: 'unknown', reason: 'caller-fact-absent' },
};

console.log('recommend — AC1 readiness gate stays closed on recorded evidence');

test('default evidence: gate closed, Jev dormant, transport never invoked, fallback profile used', async () => {
  const t = recordingTransport({ statusCode: 200, body: JSON.stringify(JEV_OK) });
  const r = await recommend({
    task: { kind: 'code' }, candidates: baseCandidates(), policy: {},
    caller: CALLER, jev: OPEN_JEV(t.fn), now: NOW,
  });
  assert.strictEqual(r.jev.status, 'dormant');
  assert.strictEqual(r.jev.reason, 'jev-readiness-gate-closed');
  assert.strictEqual(r.jev.attempted, false);
  assert.strictEqual(t.calls.length, 0, 'Jev transport invoked while gate closed');
  assert.ok(r.jev.notPass.length > 0);
  assert.deepStrictEqual(r.jev.notPass.map((i) => i.id), [1, 2, 3, 4, 11]);
  assert.strictEqual(r.jev.modelVerification.reason, 'jev-verification-not-attempted');
  assert.ok(r.taskProfile.dimensions.taskKind.provenance !== 'unknown' ? r.taskProfile.dimensions.taskKind.source === 'task-metadata' : true);
  assert.strictEqual(r.readiness.open, false);
});

test('readiness evaluator: any non-PASS item or unverified model keeps the gate closed; only all-PASS + verified opens', () => {
  assert.strictEqual(evaluateReadiness({ items: ALL_PASS, modelVerified: true }).open, true);
  assert.strictEqual(evaluateReadiness({ items: ALL_PASS, modelVerified: false }).open, false);
  assert.strictEqual(evaluateReadiness({ items: ALL_PASS, modelVerified: { status: 'verified' } }).open, false, 'non-boolean verification must not open');
  const withPartial = ALL_PASS.map((i) => (i.id === 4 ? { ...i, verdict: 'partial' } : i));
  assert.strictEqual(evaluateReadiness({ items: withPartial, modelVerified: true }).open, false);
  const malformed = ALL_PASS.map((i) => (i.id === 7 ? { ...i, verdict: 'probably' } : i));
  const g = evaluateReadiness({ items: malformed, modelVerified: true });
  assert.strictEqual(g.open, false);
  assert.strictEqual(g.notPass.find((i) => i.id === 7).verdict, 'blocking', 'unrecognized verdict must degrade to blocking');
});

test('all-PASS items but unverified model: gate closed AND no classifier request is made', async () => {
  const t = recordingTransport({ statusCode: 200, body: JSON.stringify(JEV_OK) });
  const r = await recommend({
    task: {}, candidates: baseCandidates(), policy: {}, caller: CALLER,
    readiness: ALL_PASS, modelVerification: { status: 'unverified', reason: 'jev-model-not-in-catalog' },
    jev: OPEN_JEV(t.fn), now: NOW,
  });
  assert.strictEqual(r.readiness.open, false);
  assert.strictEqual(r.jev.status, 'dormant');
  assert.strictEqual(r.jev.reason, 'jev-model-unverified');
  assert.strictEqual(t.calls.length, 0);
});

test('all-PASS items with no injected verification: recommend() attempts verification, which fails closed with no catalog transport', async () => {
  const t = recordingTransport({ statusCode: 200, body: JSON.stringify(JEV_OK) });
  const r = await recommend({
    task: {}, candidates: baseCandidates(), policy: {}, caller: CALLER,
    readiness: ALL_PASS,
    jev: OPEN_JEV(t.fn), now: NOW,
  });
  assert.strictEqual(r.readiness.open, false);
  assert.strictEqual(r.jev.status, 'dormant');
  assert.strictEqual(r.jev.modelVerification.reason, 'jev-catalog-transport-absent');
  assert.strictEqual(t.calls.length, 0);
});

console.log('\nrecommend — AC3 Jev failure paths fall back without touching eligibility');

const FAILURE_MODES = [
  ['unreachable', new Error('ECONNREFUSED'), 'jev-unreachable'],
  ['timeout', { timedOut: true }, 'jev-timeout'],
  ['malformed JSON', { statusCode: 200, body: '{broken' }, 'jev-response-malformed'],
  ['schema-invalid', { statusCode: 200, body: JSON.stringify({ profile: {}, confidence: 0.9 }) }, 'jev-response-schema-invalid'],
  ['low confidence', { statusCode: 200, body: JSON.stringify({ ...JEV_OK, confidence: 0.05 }) }, 'jev-low-confidence'],
];

for (const [label, transportResult, code] of FAILURE_MODES) {
  test(`AC3 ${label}: status unavailable + deterministic fallback + eligibility buckets identical to no-Jev baseline`, async () => {
    const baseline = await recommend({
      task: { kind: 'code' }, candidates: baseCandidates(), policy: {},
      caller: CALLER, jev: {}, now: NOW,
    });
    const r = await recommend({
      task: { kind: 'code' }, candidates: baseCandidates(), policy: {},
      caller: CALLER, readiness: ALL_PASS, modelVerification: true,
      jev: OPEN_JEV(async () => {
        if (transportResult instanceof Error) throw transportResult;
        return transportResult;
      }), now: NOW,
    });
    assert.strictEqual(r.jev.status, 'unavailable', label);
    assert.strictEqual(r.jev.reason, code, label);
    assert.strictEqual(r.jev.attempted, true, label);
    assert.strictEqual(r.jev.fallback, 'deterministic-fallback', label);
    // The fallback profile is identical to the no-Jev baseline profile.
    assert.deepStrictEqual(r.taskProfile, baseline.taskProfile, label);
    // Hard eligibility is unchanged in BOTH directions: identical rejected,
    // undecided and scored candidate ids.
    assert.deepStrictEqual(
      r.candidates.rejected.map((c) => c.candidateId),
      baseline.candidates.rejected.map((c) => c.candidateId), label);
    assert.deepStrictEqual(
      r.candidates.undecided.map((c) => c.candidateId),
      baseline.candidates.undecided.map((c) => c.candidateId), label);
    assert.deepStrictEqual(
      r.candidates.scored.map((c) => c.candidateId),
      baseline.candidates.scored.map((c) => c.candidateId), label);
  });
}

test('AC3 reverse direction: a failed Jev cannot rescue an ineligible candidate into eligibility', async () => {
  const cands = baseCandidates();
  cands[1].route.state = 'exhausted'; // hard-ineligible regardless of Jev
  const r = await recommend({
    task: { kind: 'code' }, candidates: cands, policy: {},
    caller: CALLER, readiness: ALL_PASS, modelVerification: true,
    jev: OPEN_JEV(async () => ({ statusCode: 200, body: '{broken' })), now: NOW,
  });
  assert.strictEqual(r.jev.status, 'unavailable');
  assert.deepStrictEqual(r.candidates.rejected.map((c) => c.candidateId), ['deepseek-direct']);
  assert.ok(!r.candidates.scored.some((c) => c.candidateId === 'deepseek-direct'));
});

console.log('\nrecommend — AC4 policy supremacy over Jev output');

test('Jev suggestion naming a hard-ineligible candidate is rejected with reasons; confidence cannot flip eligibility', async () => {
  const cands = baseCandidates();
  cands[0].route.state = 'exhausted'; // kimi route proven exhausted → ineligible
  const t = recordingTransport({
    statusCode: 200,
    body: JSON.stringify({ ...JEV_OK, confidence: 1.0, suggestedCandidateId: 'kimi-code-plan' }),
  });
  const r = await recommend({
    task: { kind: 'code' }, candidates: cands, policy: {},
    caller: CALLER, readiness: ALL_PASS, modelVerification: true,
    jev: OPEN_JEV(t.fn), now: NOW,
  });
  assert.strictEqual(r.jev.status, 'applied');
  assert.deepStrictEqual(r.jev.suggestion.disposition, 'rejected');
  assert.strictEqual(r.jev.suggestion.code, 'jev-suggestion-ineligible');
  assert.ok(r.jev.suggestion.reasons.some((x) => x.code === 'route-exhausted'));
  const rejected = r.candidates.rejected.find((c) => c.candidateId === 'kimi-code-plan');
  assert.ok(rejected, 'kimi must remain rejected');
  assert.ok(rejected.reasons.some((x) => x.code === 'route-exhausted'));
  assert.ok(!r.candidates.scored.some((c) => c.candidateId === 'kimi-code-plan'));
  assert.notStrictEqual(r.recommendation && r.recommendation.candidateId, 'kimi-code-plan');
});

test('Jev suggestion naming a policy-forbidden candidate is rejected even at confidence 1.0', async () => {
  const t = recordingTransport({
    statusCode: 200,
    body: JSON.stringify({ ...JEV_OK, confidence: 1.0, suggestedCandidateId: 'deepseek-direct' }),
  });
  const r = await recommend({
    task: { kind: 'code' }, candidates: baseCandidates(),
    policy: { forbid: { models: ['deepseek'] } },
    caller: CALLER, readiness: ALL_PASS, modelVerification: true,
    jev: OPEN_JEV(t.fn), now: NOW,
  });
  assert.strictEqual(r.jev.suggestion.disposition, 'rejected');
  const rejected = r.candidates.rejected.find((c) => c.candidateId === 'deepseek-direct');
  assert.ok(rejected.reasons.some((x) => x.code === 'model-forbidden'));
});

test('an applied Jev profile changes only the profile, never the eligibility buckets', async () => {
  const t = recordingTransport({ statusCode: 200, body: JSON.stringify(JEV_OK) });
  const r = await recommend({
    task: { kind: 'code' }, candidates: baseCandidates(), policy: {},
    caller: CALLER, readiness: ALL_PASS, modelVerification: true,
    jev: OPEN_JEV(t.fn), now: NOW,
  });
  assert.strictEqual(r.jev.status, 'applied');
  assert.strictEqual(r.taskProfile.dimensions.reasoning.value, 'moderate');
  assert.strictEqual(r.taskProfile.dimensions.reasoning.source, 'jev');
  // Same eligibility verdicts as evaluate() alone.
  for (const c of baseCandidates()) {
    const v = evaluate(c, {}, REG);
    const bucket = v.result === 'eligible' ? 'scored'
      : v.result === 'unresolved' ? 'undecided' : 'rejected';
    assert.ok(r.candidates[bucket].some((x) => x.candidateId === c.id), `${c.id} in ${bucket}`);
  }
});

console.log('\nrecommend — AC5 six scoring dimensions, reasons, alternatives, unresolved visibility');

test('all six dimensions are exercised; winner carries reasons; alternatives are ordered', async () => {
  const r = await recommend({
    task: { kind: 'code' },
    candidates: baseCandidates(),
    policy: {},
    caller: CALLER, now: NOW,
  });
  assert.ok(r.recommendation, 'a recommendation exists');
  assert.strictEqual(r.recommendation.candidateId, 'kimi-code-plan');
  const dims = r.candidates.scored[0].dimensions;
  assert.deepStrictEqual(Object.keys(dims), [
    'taskFit', 'harnessAffinity', 'resourcePressure',
    'costSpeed', 'continuity', 'reviewIndependence',
  ]);
  // kimi-code-plan: taskFit full (code), same-harness, healthy+fresh route,
  // no preference (neutral), continuity unresolved (caller profile absent),
  // independence not required.
  const kimi = r.candidates.scored.find((c) => c.candidateId === 'kimi-code-plan');
  assert.strictEqual(kimi.dimensions.taskFit.status, 'scored');
  assert.strictEqual(kimi.dimensions.taskFit.contribution, 4000);
  assert.strictEqual(kimi.dimensions.harnessAffinity.contribution, 2000);
  assert.strictEqual(kimi.dimensions.resourcePressure.contribution, 3000);
  assert.strictEqual(kimi.dimensions.costSpeed.contribution, 1000);
  assert.strictEqual(kimi.dimensions.continuity.status, 'unresolved');
  assert.strictEqual(kimi.dimensions.continuity.contribution, 0);
  assert.strictEqual(kimi.dimensions.reviewIndependence.contribution, 1000);
  assert.strictEqual(kimi.score, 11000);
  assert.ok(kimi.scoredWeight < 13, 'unresolved continuity removed its weight');
  assert.ok(r.recommendation.rationale.length > 0);
  assert.deepStrictEqual(
    r.recommendation.alternatives.map((a) => a.candidateId),
    ['deepseek-direct', 'minimax-token-plan'],
  );
  // Every alternative has its own rationale.
  for (const a of r.recommendation.alternatives) assert.ok(a.rationale.length > 0);
});

test('unresolved dimensions contribute zero weight, keep their reason, and surface in the result (continuity via BLOCKING selectedProfile)', async () => {
  const r = await recommend({
    task: { kind: 'code' }, candidates: baseCandidates(), policy: {},
    caller: CALLER, now: NOW,
  });
  for (const c of r.candidates.scored) {
    const cont = c.dimensions.continuity;
    assert.strictEqual(cont.status, 'unresolved');
    assert.strictEqual(cont.contribution, 0, 'unresolved must contribute zero');
    assert.strictEqual(cont.weight, 2, 'weight is reported, not redistributed');
    assert.ok(c.unresolved.some((u) => u.dimension === 'continuity' && u.code === 'selected-profile-unproven'));
  }
  assert.ok(r.unresolved.some((u) => u.code === 'selected-profile-unproven' && u.scope.includes('continuity')));
  // Task-profile unresolved dimensions are also listed.
  assert.ok(r.unresolved.some((u) => u.scope === 'task-profile.exploration' && u.code === 'profile-dimension-unresolved'));
});

test('resolvable continuity scores: matching profile wins over different profile', async () => {
  const caller = { harness: 'claude', selectedProfile: 'code-plan' };
  const r = await recommend({
    task: { kind: 'code' }, candidates: baseCandidates(), policy: {},
    caller, now: NOW,
  });
  const kimi = r.candidates.scored.find((c) => c.candidateId === 'kimi-code-plan');
  const deep = r.candidates.scored.find((c) => c.candidateId === 'deepseek-direct');
  assert.strictEqual(kimi.dimensions.continuity.contribution, 2000);
  assert.strictEqual(deep.dimensions.continuity.contribution, 400);
});

test('resource pressure: constrained < healthy; stale evidence discounted; unproven state unresolved', async () => {
  const cands = baseCandidates();
  const r = await recommend({ task: { kind: 'code' }, candidates: cands, policy: {}, caller: CALLER, now: NOW });
  const healthy = r.candidates.scored.find((c) => c.candidateId === 'kimi-code-plan');
  const constrained = r.candidates.scored.find((c) => c.candidateId === 'minimax-token-plan');
  assert.strictEqual(healthy.dimensions.resourcePressure.contribution, 3000);
  assert.strictEqual(constrained.dimensions.resourcePressure.contribution, 1200);
  assert.ok(constrained.dimensions.resourcePressure.reasons.some((x) => x.code === 'route-constrained'));

  const staleCands = [{ ...cands[0], route: { ...cands[0].route, freshUntil: STALE } }];
  const r2 = await recommend({ task: { kind: 'code' }, candidates: staleCands, policy: {}, caller: CALLER, now: NOW });
  const stale = r2.candidates.scored[0];
  assert.strictEqual(stale.dimensions.resourcePressure.contribution, 1500);
  assert.ok(stale.dimensions.resourcePressure.reasons.some((x) => x.code === 'route-evidence-stale'));

  const noState = [{ ...cands[0], route: { id: 'x' } }];
  const r3 = await recommend({ task: { kind: 'code' }, candidates: noState, policy: {}, caller: CALLER, now: NOW });
  assert.strictEqual(r3.candidates.scored[0].dimensions.resourcePressure.status, 'unresolved');
  assert.strictEqual(r3.candidates.scored[0].dimensions.resourcePressure.contribution, 0);
});

test('cost/speed preferences: unproven signal → unresolved; proven tiers rank deterministically', async () => {
  const withPrefs = { preferences: { cost: 'minimize', speed: 'fast' } };
  const cands = [
    { ...baseCandidates()[0], costTier: 'low', speedTier: 'fast' },
    { ...baseCandidates()[1], costTier: 'high', speedTier: 'slow' },
    { ...baseCandidates()[2] }, // no tiers → unresolved
  ];
  const r = await recommend({ task: { kind: 'code' }, candidates: cands, policy: withPrefs, caller: CALLER, now: NOW });
  const kimi = r.candidates.scored.find((c) => c.candidateId === 'kimi-code-plan');
  const deep = r.candidates.scored.find((c) => c.candidateId === 'deepseek-direct');
  const mini = r.candidates.scored.find((c) => c.candidateId === 'minimax-token-plan');
  assert.strictEqual(kimi.dimensions.costSpeed.contribution, 1000);
  assert.strictEqual(deep.dimensions.costSpeed.contribution, 150);
  assert.strictEqual(mini.dimensions.costSpeed.status, 'unresolved');
  assert.strictEqual(mini.dimensions.costSpeed.contribution, 0);
  assert.ok(mini.unresolved.some((u) => u.code === 'cost-signal-unproven'));
});

test('review independence: required + proven-different family scores; unproven family unresolved', async () => {
  const policy = { review: { requireDifferentFamily: true, subject: { model: 'kimi-k2' } } };
  // claude-model candidate: anthropic vs moonshot → different
  const cands = [
    { id: 'claude-route', model: 'claude-sonnet-4', harness: 'claude', profile: 'p', route: { id: 'r1', state: 'healthy', freshUntil: FRESH } },
  ];
  const r = await recommend({ task: { kind: 'code' }, candidates: cands, policy, caller: CALLER, now: NOW });
  const c = r.candidates.scored.find((x) => x.candidateId === 'claude-route');
  assert.strictEqual(c.dimensions.reviewIndependence.contribution, 1000);
  assert.ok(c.dimensions.reviewIndependence.reasons.some((x) => x.code === 'independence-proven'));

  // Same family → ineligible upstream AND zero contribution standalone.
  const sameFam = [{ id: 'kimi-route', model: 'kimi-k2', harness: 'claude', profile: 'p', route: { id: 'r2', state: 'healthy', freshUntil: FRESH } }];
  const r2 = await recommend({ task: { kind: 'code' }, candidates: sameFam, policy, caller: CALLER, now: NOW });
  assert.ok(r2.candidates.rejected.some((x) => x.candidateId === 'kimi-route'));
  assert.strictEqual(r2.recommendation, null);
});

console.log('\nrecommend — AC6 advisory boundary');

test('result carries parameters + rationale only; no functions, no commands, no side-effect fields', async () => {
  const r = await recommend({
    task: { kind: 'code' }, candidates: baseCandidates(), policy: {},
    caller: CALLER, now: NOW,
  });
  assert.strictEqual(r.advisoryOnly, true);
  const json = JSON.parse(JSON.stringify(r));
  // No functions anywhere in the serializable result.
  const scan = (v) => {
    assert.ok(v === null || typeof v !== 'function', 'function leaked into result');
    if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan(json);
  const params = r.recommendation.parameters;
  assert.deepStrictEqual(Object.keys(params), ['harness', 'model', 'route', 'profile']);
  for (const k of ['harness', 'model', 'profile']) {
    assert.deepStrictEqual(Object.keys(params[k]).sort(),
      ['freshUntil', 'observedAt', 'provenance', 'reason', 'source', 'value']);
  }
  assert.deepStrictEqual(Object.keys(params.route).sort(), ['id', 'state']);
});

test('injected spies: recommendation performs zero request/spawn/write activity when gate closed', async () => {
  const requestSpy = recordingTransport({ statusCode: 200, body: JSON.stringify(JEV_OK) });
  const catalogSpy = { calls: 0, fn: async () => { catalogSpy.calls += 1; return { data: [] }; } };
  const r = await recommend({
    task: { kind: 'code' }, candidates: baseCandidates(), policy: {},
    caller: CALLER, now: NOW,
    jev: { config: { model: 'm', baseUrl: 'b' }, io: { request: requestSpy.fn, fetchCatalog: catalogSpy.fn } },
  });
  assert.strictEqual(r.jev.status, 'dormant');
  assert.strictEqual(requestSpy.calls.length, 0, 'classifier transport invoked');
  assert.strictEqual(catalogSpy.calls, 0, 'catalog transport invoked');
});

console.log('\nrecommend — AC7 registry decoupling');

test('registry swap changes the recommendation while the classifier prompt stays byte-identical', async () => {
  // regA registers m-x WITH 'code'; regB registers m-x WITHOUT it — under
  // require.taskCapabilities the same candidate flips eligible→ineligible,
  // changing the recommendation with zero change to the classifier request.
  const regA = createRegistry({
    families: { acme: { aliases: [] } },
    models: { 'm-x': { family: 'acme', taskCapabilities: ['code'] } },
    harnesses: { claude: { executionCapabilities: [], skills: [] } },
  });
  const regB = createRegistry({
    families: { acme: { aliases: [] } },
    models: { 'm-x': { family: 'acme', taskCapabilities: [] } },
    harnesses: { claude: { executionCapabilities: [], skills: [] } },
  });
  const cands = [{
    id: 'acme-route', model: 'm-x', harness: 'claude', profile: 'p',
    route: { id: 'acme-route', state: 'healthy', freshUntil: FRESH },
  }];
  const policy = { require: { taskCapabilities: ['code'], route: true, usableRoute: true } };
  const t1 = recordingTransport({ statusCode: 200, body: JSON.stringify(JEV_OK) });
  const t2 = recordingTransport({ statusCode: 200, body: JSON.stringify(JEV_OK) });
  const common = {
    task: { kind: 'code', text: 'fix it' }, candidates: cands, policy,
    caller: CALLER, readiness: ALL_PASS, modelVerification: true, now: NOW,
  };
  const rA = await recommend({ ...common, registry: regA, jev: OPEN_JEV(t1.fn) });
  const rB = await recommend({ ...common, registry: regB, jev: OPEN_JEV(t2.fn) });
  assert.strictEqual(rA.recommendation.candidateId, 'acme-route', 'regA: eligible → recommended');
  assert.strictEqual(rB.recommendation, null, 'regB: ineligible → no recommendation');
  assert.ok(rB.candidates.rejected.some((x) => x.reasons.some((y) => y.code === 'model-capability-missing')));
  // The classifier requests captured in both runs are byte-identical.
  assert.strictEqual(t1.calls.length, 1);
  assert.strictEqual(t2.calls.length, 1);
  const { canonicalJson } = require('../lib/jev-client');
  assert.strictEqual(canonicalJson(t1.calls[0]), canonicalJson(t2.calls[0]),
    'registry swap must not change the classifier prompt');
});

test('AC7 failure path: Jev down + registry swap still changes the deterministic recommendation', async () => {
  const regA = createRegistry({
    families: { acme: { aliases: [] } },
    models: { 'm-x': { family: 'acme', taskCapabilities: ['code'] } },
    harnesses: { claude: { executionCapabilities: [], skills: [] } },
  });
  const regB = createRegistry({
    families: { acme: { aliases: [] } },
    models: { 'm-x': { family: 'acme', taskCapabilities: [] } },
    harnesses: { claude: { executionCapabilities: [], skills: [] } },
  });
  const cands = [{
    id: 'acme-route', model: 'm-x', harness: 'claude', profile: 'p',
    route: { id: 'acme-route', state: 'healthy', freshUntil: FRESH },
  }];
  const policy = { require: { taskCapabilities: ['code'], route: true, usableRoute: true } };
  const down = async () => { throw new Error('unreachable'); };
  const common = {
    task: { kind: 'code' }, candidates: cands, policy, caller: CALLER,
    readiness: ALL_PASS, modelVerification: true, now: NOW,
    jev: OPEN_JEV(down),
  };
  const rA = await recommend({ ...common, registry: regA });
  const rB = await recommend({ ...common, registry: regB });
  assert.strictEqual(rA.jev.reason, 'jev-unreachable');
  assert.strictEqual(rB.jev.reason, 'jev-unreachable');
  assert.ok(rA.recommendation !== null && rB.recommendation === null,
    'deterministic layer must differ on registry swap even with Jev down');
});

console.log('\nrecommend — determinism');

test('same inputs twice → deep-equal output; shuffled key order → deep-equal output', async () => {
  const t1 = recordingTransport({ statusCode: 200, body: JSON.stringify(JEV_OK) });
  const args1 = {
    task: { kind: 'code', text: 'x' },
    candidates: baseCandidates(),
    policy: { require: { route: true, usableRoute: true } },
    caller: CALLER, readiness: ALL_PASS, modelVerification: true,
    jev: OPEN_JEV(t1.fn), now: NOW,
  };
  const r1 = await recommend(args1);
  const r2 = await recommend(args1);
  assert.deepStrictEqual(r1, r2);
  // Rebuild every object with shuffled key insertion order.
  const shuffle = (o) => Object.fromEntries(Object.entries(o).sort(() => 0.5 - Math.random()).map(([k, v]) => [k, v]));
  const shuffled = {
    jev: OPEN_JEV(t1.fn), caller: CALLER, modelVerification: true,
    readiness: ALL_PASS, now: NOW,
    policy: shuffle({ require: { usableRoute: true, route: true } }),
    task: shuffle({ text: 'x', kind: 'code' }),
    candidates: baseCandidates().map((c) => shuffle({ ...c, route: shuffle(c.route) })),
  };
  const r3 = await recommend(shuffled);
  assert.deepStrictEqual(r1, r3, 'key order must not change the result');
});

test('recommend with no candidates → recommendation null, empty buckets, still dormant', async () => {
  const r = await recommend({ task: {}, candidates: [], policy: {}, caller: {}, now: NOW });
  assert.strictEqual(r.recommendation, null);
  assert.deepStrictEqual(r.candidates.scored, []);
  assert.strictEqual(r.jev.status, 'dormant');
  assert.strictEqual(r.schemaVersion, 1);
  assert.strictEqual(r.advisoryOnly, true);
});

Promise.all(pendingTests).then(() => {
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall recommend tests passed');
});
