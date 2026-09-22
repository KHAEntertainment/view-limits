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

function keySignature(key, fields) {
  return fields.map((f) => key[f]).join('');
}

// Validate one section of a version-1 document.
//   returns { rows, invalid } — rows are the retained entries verbatim (the
//   stored document is the fact payload; later slices own field-level
//   normalization). `invalid` is true when the section or any row failed
//   validation, which the caller turns into one section-invalid diagnostic.
function validateSection(rows, fields) {
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
    kept.push(row);
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
    const { rows, invalid } = validateSection(doc[section], fields);
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
