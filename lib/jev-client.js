'use strict';
// Optional Jev classifier client — Issue #11.
//
// PRESENT BUT DORMANT: this module is the complete Jev network path — request
// construction, model-support verification, response validation — but it is
// only ever invoked behind the readiness gate (lib/jev-readiness.js), which
// evaluates CLOSED on the current evidence. Nothing in this module runs on a
// default path, and every transport is injected: this module performs no I/O
// of its own. Unconfigured, unverified, unreachable, malformed, or
// low-confidence outcomes are reported with stable reason codes — never
// retried silently, never defaulted, never faked.
//
// Configuration contract (NO fabricated defaults):
//   config = {
//     model,          — exact provider model id; REQUIRED, no default
//     baseUrl,        — OpenRouter-compatible endpoint; REQUIRED, no default
//     apiKey,         — credential material held by the CALLER (never read
//                       from the vault here; this module never queries
//                       balances or account state)
//     catalogUrl,     — model catalog endpoint for support verification
//     timeoutMs,      — request deadline hint passed to the transport
//     minConfidence,  — classifier confidence floor (default MIN_CONFIDENCE)
//   }
//
//   io = {
//     request(requestDoc, { timeoutMs, apiKey, baseUrl })
//                          — injected transport; returns { statusCode, body }
//                            (body string or already-parsed object). Throw →
//                            unreachable; { timedOut:true } or a thrown
//                            err.timedOut / err.code 'JEV_TIMEOUT' → timeout.
//     fetchCatalog(catalogUrl) — injected catalog transport returning a parsed
//                            catalog document { data: [{ id, ... }] }.
//   }
//
// AC7 boundary: buildClassifierRequest depends ONLY on the task input and the
// static dimension vocabulary from lib/task-profile.js. Registry entries,
// candidate lists, and scoring data NEVER appear in the request — changing a
// capability-registry entry cannot change the classifier prompt.

const { DIMENSIONS, DIMENSION_ORDER, validateClassifierResponse } = require('./task-profile');

const JEV_SCHEMA_VERSION = 1;
const MIN_CONFIDENCE = 0.6;
const DEFAULT_TIMEOUT_MS = 15000;

const JEV_REASONS = [
  'jev-model-unconfigured',
  'jev-endpoint-unconfigured',
  'jev-transport-absent',
  'jev-catalog-transport-absent',
  'jev-timeout',
  'jev-unreachable',
  'jev-http-error',
  'jev-catalog-unreachable',
  'jev-catalog-timeout',
  'jev-catalog-malformed',
  'jev-model-not-in-catalog',
  'jev-structured-output-unverified',
  'jev-response-malformed',
  'jev-response-schema-invalid',
  'jev-low-confidence',
];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Deterministic deep serialization: object keys sorted recursively so two
// calls with equivalent input produce byte-identical output. Used to pin the
// classifier request across registry changes (AC7).
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

// The classifier request document. Deterministic in (task, model): identical
// inputs always produce identical bytes via canonicalJson. The task is
// carried as caller-supplied text/metadata — nothing else is read.
function buildClassifierRequest({ task, model }) {
  const t = isPlainObject(task) ? task : {};
  const criteria = {};
  for (const name of DIMENSION_ORDER) criteria[name] = DIMENSIONS[name].values.slice();
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    model,
    instructions:
      'Classify the task in `state.task` on every dimension in `criteria`. ' +
      'Choose exactly one level per dimension. Judge only what the task ' +
      'evidence supports; do not infer missing constraints.',
    criteria,
    state: {
      task: {
        text: nonEmptyString(t.text) ? t.text : null,
        kind: nonEmptyString(t.kind) ? t.kind : null,
        metadata: isPlainObject(t.metadata) ? t.metadata : {},
      },
    },
    responseFormat: {
      type: 'json_schema',
      schema: {
        type: 'object',
        required: ['profile', 'confidence'],
        properties: {
          profile: {
            type: 'object',
            required: DIMENSION_ORDER.slice(),
            properties: Object.fromEntries(
              DIMENSION_ORDER.map((name) => [name, { type: 'string', enum: DIMENSIONS[name].values.slice() }]),
            ),
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          suggestedCandidateId: { type: 'string' },
        },
      },
    },
  };
}

function unavailable(reason, detail) {
  const out = { status: 'unavailable', reason };
  if (detail !== undefined) out.detail = detail;
  return out;
}

// Classify one task through the configured Jev endpoint. Fully dormant unless
// called — lib/recommend.js calls this only when the readiness gate is OPEN.
// Every failure mode degrades to { status:'unavailable', reason }.
async function classify({ task, config = {}, io = {} } = {}) {
  const cfg = isPlainObject(config) ? config : {};
  if (!nonEmptyString(cfg.model)) return unavailable('jev-model-unconfigured');
  if (!nonEmptyString(cfg.baseUrl)) return unavailable('jev-endpoint-unconfigured');
  const transport = isPlainObject(io) ? io.request : null;
  if (typeof transport !== 'function') return unavailable('jev-transport-absent');

  const request = buildClassifierRequest({ task, model: cfg.model });
  let res;
  try {
    res = await transport(request, {
      timeoutMs: Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
    });
  } catch (e) {
    // TimeoutError is what AbortSignal.timeout() throws on the real fetch
    // transport; timedOut/code cover injected transports.
    if (e && (e.timedOut === true || e.code === 'JEV_TIMEOUT' || e.name === 'TimeoutError')) {
      return unavailable('jev-timeout');
    }
    return unavailable('jev-unreachable', e && nonEmptyString(e.message) ? e.message : undefined);
  }

  if (isPlainObject(res) && res.timedOut === true) return unavailable('jev-timeout');
  if (!isPlainObject(res) || (!('body' in res) && !('statusCode' in res) && !('status' in res))) {
    return unavailable('jev-response-malformed');
  }
  const statusCode = Number.isFinite(res.statusCode) ? res.statusCode
    : (Number.isFinite(res.status) ? res.status : null);
  if (statusCode !== null && (statusCode < 200 || statusCode >= 300)) {
    return unavailable('jev-http-error', statusCode);
  }
  let payload = res.body;
  if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
    try { payload = JSON.parse(String(payload)); }
    catch { return unavailable('jev-response-malformed'); }
  }
  if (!isPlainObject(payload)) return unavailable('jev-response-malformed');

  const validated = validateClassifierResponse(payload);
  if (!validated.ok) return unavailable('jev-response-schema-invalid', validated.violations);

  const floor = Number.isFinite(cfg.minConfidence) ? cfg.minConfidence : MIN_CONFIDENCE;
  if (validated.confidence < floor) {
    return unavailable('jev-low-confidence', { confidence: validated.confidence, minConfidence: floor });
  }
  return {
    status: 'ok',
    profile: validated.profile,
    confidence: validated.confidence,
    suggestedCandidateId: validated.suggestedCandidateId,
    request,
  };
}

// Verify that the configured model exists and supports structured output in
// the provider catalog — the second precondition for opening the Jev gate.
// Fail-closed: unreachable catalog, malformed catalog, absent model, or
// unproven structured-output support all return non-'verified' statuses.
async function verifyModelSupport({ config = {}, io = {} } = {}) {
  const cfg = isPlainObject(config) ? config : {};
  if (!nonEmptyString(cfg.model)) return { status: 'unverified', reason: 'jev-model-unconfigured' };
  if (!nonEmptyString(cfg.catalogUrl)) return { status: 'unverified', reason: 'jev-endpoint-unconfigured' };
  const fetchCatalog = isPlainObject(io) ? io.fetchCatalog : null;
  if (typeof fetchCatalog !== 'function') {
    return { status: 'unverified', reason: 'jev-catalog-transport-absent' };
  }

  let catalog;
  try {
    catalog = await fetchCatalog(cfg.catalogUrl);
  } catch (e) {
    return e && (e.timedOut === true || e.code === 'JEV_TIMEOUT' || e.name === 'TimeoutError')
      ? { status: 'unverified', reason: 'jev-catalog-timeout' }
      : { status: 'unverified', reason: 'jev-catalog-unreachable' };
  }
  const rows = isPlainObject(catalog) && Array.isArray(catalog.data) ? catalog.data : null;
  if (!rows) return { status: 'unverified', reason: 'jev-catalog-malformed' };

  const wanted = cfg.model.trim().toLowerCase();
  const entry = rows.find((r) => isPlainObject(r) && nonEmptyString(r.id) &&
    r.id.trim().toLowerCase() === wanted);
  if (!entry) return { status: 'unverified', reason: 'jev-model-not-in-catalog' };

  const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
  const supported = entry.structured_outputs === true ||
    params.some((p) => nonEmptyString(p) &&
      ['response_format', 'structured_outputs', 'json_schema'].includes(p.trim().toLowerCase()));
  return supported
    ? { status: 'verified', reason: null, model: entry.id }
    : { status: 'unverified', reason: 'jev-structured-output-unverified', model: entry.id };
}

module.exports = {
  JEV_SCHEMA_VERSION,
  MIN_CONFIDENCE,
  DEFAULT_TIMEOUT_MS,
  JEV_REASONS,
  buildClassifierRequest,
  canonicalJson,
  classify,
  verifyModelSupport,
};
