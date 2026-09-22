'use strict';
// Versioned runtime sidecar (runtime.json) — read path only.
//
// The sidecar carries runtime facts written by refresh-time producers (later
// slices): session rows keyed by host+ade+epic+agent, harness rows keyed by
// host+harness+surface, profile rows keyed by host+provider+profile. This
// reader validates the document version and each section independently so a
// corrupt or unsupported cache degrades to unknown instead of fabricating
// facts.
//
//   absent file            → doc null, no degradation (first run is not an error)
//   unreadable/non-object  → runtime-sidecar-corrupt
//   version absent/!== 1   → runtime-sidecar-unsupported
//   section not an array   → that section [], runtime-sidecar-section-invalid
//   row with bad/missing   → row dropped, same section diagnostic
//   key or duplicate key
//   row field that is not  → field dropped, same section diagnostic — raw
//   fact-shaped/declared      file bytes never flow into the snapshot
//
// Diagnostic scopes for section-invalid are the section names themselves so a
// single read never emits two degradations with the same (code, scope) pair.

const fs = require('fs');
const path = require('path');

const SIDECAR_VERSION = 1;
const SIDECAR_FILE = 'runtime.json';

// Composite key fields each section's rows must fully populate.
const SECTION_KEYS = {
  sessions: ['host', 'ade', 'epicId', 'agentId'],
  harnesses: ['host', 'harness', 'surface'],
  profiles: ['host', 'provider', 'profileId'],
};

// Non-fact fields a retained row may still carry, per section — the harness
// row's contract-declared containers: `defaults` is a fact map; `sessionRefs`
// and `resourceRefs` are lists of key-like references. Every other row field
// must be fact-shaped or it is dropped.
const CONTAINER_FIELDS = {
  sessions: {},
  harnesses: { defaults: 'fact-map', sessionRefs: 'ref-list', resourceRefs: 'ref-list' },
  profiles: {},
};

const SUMMARIES = {
  'runtime-sidecar-corrupt': 'runtime snapshot cache (runtime.json) is unreadable; runtime facts are unknown.',
  'runtime-sidecar-unsupported': 'runtime snapshot cache version is unsupported; runtime facts are unknown.',
  'runtime-sidecar-section-invalid': 'part of the runtime snapshot cache failed validation and was ignored.',
};

function sidecarPath(dir) {
  return path.join(dir, SIDECAR_FILE);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// A row's key must be a plain object with every composite field populated as
// a non-empty string.
function validKey(key, fields) {
  if (!isPlainObject(key)) return false;
  return fields.every((f) => nonEmptyString(key[f]));
}

// Distinct composite keys must never collide: encode the tuple, never
// concatenate — 'a'+'bc' and 'ab'+'c' would share a delimiter-less signature.
function keySignature(key, fields) {
  return JSON.stringify(fields.map((f) => key[f]));
}

const FACT_PROVENANCES = new Set(['observed', 'configured', 'unknown']);
const FACT_ANNOTATION_KEYS = ['source', 'observedAt', 'freshUntil', 'reason'];

function isFact(v) {
  return isPlainObject(v) && 'value' in v && FACT_PROVENANCES.has(v.provenance);
}

// Reduce a stored fact to the canonical six-key envelope so a crafted row
// cannot smuggle extra fields through the passthrough. `value` is the fact
// payload and is carried as stored; annotations must be strings or null.
function sanitizeFact(f) {
  const out = { value: f.value, provenance: f.provenance };
  for (const k of FACT_ANNOTATION_KEYS) out[k] = typeof f[k] === 'string' ? f[k] : null;
  return out;
}

// A reference element is key-like: a plain object whose values are all
// non-empty strings — the same discipline as a row's composite key.
function isKeyLike(v) {
  return isPlainObject(v) && Object.keys(v).length > 0 &&
    Object.values(v).every(nonEmptyString);
}

// Sanitize one declared container field. `defaults` is a fact map; ref lists
// carry key-like reference objects. Returns { value, dropped }: `value` is
// undefined when the field's own shape does not conform; `dropped` is true
// when any member/element failed validation.
function sanitizeContainer(kind, v) {
  if (kind === 'fact-map') {
    if (!isPlainObject(v)) return { dropped: true };
    const out = {};
    let dropped = false;
    for (const [k, member] of Object.entries(v)) {
      if (isFact(member)) out[k] = sanitizeFact(member);
      else dropped = true;
    }
    return { value: out, dropped };
  }
  if (!Array.isArray(v)) return { dropped: true };
  const out = [];
  let dropped = false;
  for (const el of v) {
    if (isKeyLike(el)) out.push(el);
    else dropped = true;
  }
  return { value: out, dropped };
}

// Retain only the validated composite key plus declared, shape-valid fields:
// fact-shaped fields are reduced to the canonical envelope; harness container
// fields keep only conforming members/elements; everything else is dropped and
// marks the section invalid. Raw file bytes never flow into the snapshot.
function sanitizeRow(row, fields, containers) {
  const out = { key: {} };
  for (const f of fields) out.key[f] = row.key[f];
  let invalid = false;
  for (const [name, v] of Object.entries(row)) {
    if (name === 'key') continue;
    if (isFact(v)) {
      out[name] = sanitizeFact(v);
      continue;
    }
    const kind = containers[name];
    if (kind) {
      const { value, dropped } = sanitizeContainer(kind, v);
      if (value !== undefined) out[name] = value;
      if (dropped) invalid = true;
      continue;
    }
    invalid = true;
  }
  return { row: out, invalid };
}

// Validate one section of a version-1 document.
//   returns { rows, invalid } — rows are retained after key validation and
//   field sanitization (the stored document is the fact payload; later slices
//   own field-level normalization). `invalid` is true when the section, any
//   row, or any retained row's dropped field failed validation, which the
//   caller turns into one section-invalid diagnostic.
function validateSection(rows, fields, containers) {
  if (rows === undefined) return { rows: [], invalid: false };
  if (!Array.isArray(rows)) return { rows: [], invalid: true };
  const seen = new Set();
  const kept = [];
  let invalid = false;
  for (const row of rows) {
    if (!isPlainObject(row) || !validKey(row.key, fields)) {
      invalid = true;
      continue;
    }
    const sig = keySignature(row.key, fields);
    if (seen.has(sig)) {
      invalid = true;
      continue;
    }
    seen.add(sig);
    const { row: keptRow, invalid: rowInvalid } = sanitizeRow(row, fields, containers);
    if (rowInvalid) invalid = true;
    kept.push(keptRow);
  }
  return { rows: kept, invalid };
}

// Read and validate runtime.json under `dir`.
//   → { doc: { sessions, harnesses, profiles } | null, degradations: [{code, scope, summary}] }
function readRuntimeSidecar(dir) {
  let raw;
  try {
    raw = fs.readFileSync(sidecarPath(dir), 'utf8');
  } catch {
    return { doc: null, degradations: [] }; // absent is not an error
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return {
      doc: null,
      degradations: [{ code: 'runtime-sidecar-corrupt', scope: 'sidecar', summary: SUMMARIES['runtime-sidecar-corrupt'] }],
    };
  }
  if (!isPlainObject(doc)) {
    return {
      doc: null,
      degradations: [{ code: 'runtime-sidecar-corrupt', scope: 'sidecar', summary: SUMMARIES['runtime-sidecar-corrupt'] }],
    };
  }
  if (doc.version !== SIDECAR_VERSION) {
    return {
      doc: null,
      degradations: [{ code: 'runtime-sidecar-unsupported', scope: 'sidecar', summary: SUMMARIES['runtime-sidecar-unsupported'] }],
    };
  }

  const out = { sessions: [], harnesses: [], profiles: [] };
  const degradations = [];
  for (const [section, fields] of Object.entries(SECTION_KEYS)) {
    const { rows, invalid } = validateSection(doc[section], fields, CONTAINER_FIELDS[section]);
    out[section] = rows;
    if (invalid) {
      degradations.push({
        code: 'runtime-sidecar-section-invalid',
        scope: section,
        summary: SUMMARIES['runtime-sidecar-section-invalid'],
      });
    }
  }
  return { doc: out, degradations };
}

module.exports = { SIDECAR_VERSION, SIDECAR_FILE, SECTION_KEYS, sidecarPath, readRuntimeSidecar };
