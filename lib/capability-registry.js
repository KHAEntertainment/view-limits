'use strict';
// Declarative capability registry — schemaVersion 1.
//
// The registry is the ONLY home for capability and family knowledge:
//   * models     — task capabilities a model is configured to perform, plus a
//                  family reference that must resolve to a declared family id
//                  or alias (stored canonicalized)
//   * harnesses  — execution capabilities and executable skills a harness is
//                  configured to provide
//   * families   — canonical model-family ids plus their aliases
//
// Separation contract (Issue #9): availability lives in runtime observations
// (status.json / runtime.json), policy lives with the caller of
// lib/eligibility.js, and provider protocol knowledge lives in lib/adapters.
// This module is pure data plus a deterministic indexer — adding or changing
// an entry NEVER requires an adapter or runtime-discovery edit, and family
// aliases resolve here, never in adapters.
//
// Truthfulness contract (same as lib/runtime-snapshot.js):
//   * every lookup returns a fact { value, provenance, source, observedAt,
//     freshUntil, reason }
//   * registry contents are configured truth → provenance 'configured',
//     source 'capability-registry'
//   * absent entries return value null + provenance 'unknown' + a stable
//     reason code — never a sentinel
//   * lookups are exact-match on normalized names (canonical id or declared
//     alias): deterministic, no fuzzy matching, no I/O

const REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_SOURCE = 'capability-registry';

const PROVENANCES = new Set(['observed', 'configured', 'unknown']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Normalized lookup key: trimmed lowercase. Identity comparison in the
// registry is case-insensitive but otherwise exact — no substring or fuzzy
// matching, so results are stable across hosts and runs.
function norm(v) {
  return nonEmptyString(v) ? v.trim().toLowerCase() : null;
}

function fact(value, provenance, { source = null, observedAt = null, freshUntil = null } = {}) {
  return { value, provenance, source, observedAt, freshUntil, reason: null };
}

function configuredFact(value, source) {
  return fact(value, 'configured', { source });
}

function unknown(reason) {
  return { value: null, provenance: 'unknown', source: null, observedAt: null, freshUntil: null, reason };
}

// Sorted, de-duplicated, frozen lowercase list from an array of
// capability/skill names. Non-strings are dropped at build time; a
// deterministically ordered canonical list keeps eligibility checks and
// emitted facts stable, and freezing keeps lookup results from mutating
// shared entry state.
function normList(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const n = norm(v);
    if (!n) continue;
    if (!out.includes(n)) out.push(n);
  }
  out.sort();
  return Object.freeze(out);
}

function deepFreeze(v) {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

// ---- built-in entries ------------------------------------------------------
//
// Task capabilities are model-intrinsic abilities ('code', 'review',
// 'planning', 'reasoning', 'tool-use', 'long-context', 'vision').
// Execution capabilities are harness abilities ('dispatch', 'subagent',
// 'tools', 'mcp', 'shell', 'file-edit'); `skills` names executable skills the
// harness provides to agents it runs.
//
// These seed entries cover the providers/harnesses the plugin already knows;
// they are declarations, not discoveries — extend them via mergeEntries or a
// caller-supplied registry without touching adapters or this file's index
// logic.

const DEFAULT_ENTRIES = {
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  families: {
    anthropic: { aliases: ['claude'] },
    openai: { aliases: ['gpt', 'chatgpt'] },
    moonshot: { aliases: ['kimi', 'moonshotai'] },
    zai: { aliases: ['glm', 'zhipu', 'z-ai'] },
    deepseek: { aliases: [] },
    minimax: { aliases: ['abab'] },
    google: { aliases: ['gemini'] },
  },
  models: {
    'claude-sonnet-4': {
      family: 'anthropic',
      aliases: ['claude-sonnet-4-5', 'claude-sonnet', 'sonnet'],
      taskCapabilities: ['code', 'review', 'planning', 'tool-use', 'long-context'],
    },
    'claude-opus-4': {
      family: 'anthropic',
      aliases: ['claude-opus-4-1', 'claude-opus', 'opus'],
      taskCapabilities: ['code', 'review', 'planning', 'reasoning', 'tool-use', 'long-context'],
    },
    'claude-haiku-4': {
      family: 'anthropic',
      aliases: ['claude-haiku-4-5', 'haiku'],
      taskCapabilities: ['code', 'tool-use'],
    },
    'kimi-k2': {
      family: 'moonshot',
      aliases: ['kimi', 'kimi-k2-instruct', 'kimi-for-coding'],
      taskCapabilities: ['code', 'tool-use', 'long-context'],
    },
    'glm-4.6': {
      family: 'zai',
      aliases: ['glm', 'glm-4.5'],
      taskCapabilities: ['code', 'tool-use'],
    },
    'deepseek-v3.2': {
      family: 'deepseek',
      aliases: ['deepseek', 'deepseek-chat', 'deepseek-reasoner'],
      taskCapabilities: ['code', 'reasoning'],
    },
    'minimax-m2': {
      family: 'minimax',
      aliases: ['minimax'],
      taskCapabilities: ['code', 'tool-use', 'long-context'],
    },
    'gpt-5': {
      family: 'openai',
      aliases: ['gpt-5-codex'],
      taskCapabilities: ['code', 'reasoning', 'tool-use'],
    },
    'gemini-2.5-pro': {
      family: 'google',
      aliases: ['gemini'],
      taskCapabilities: ['code', 'long-context', 'vision', 'tool-use'],
    },
  },
  harnesses: {
    claude: {
      aliases: ['claude-code'],
      executionCapabilities: ['dispatch', 'subagent', 'tools', 'mcp', 'shell', 'file-edit'],
      skills: ['dev', 'review'],
    },
    codex: {
      aliases: ['codex-cli'],
      executionCapabilities: ['shell', 'file-edit', 'tools'],
      skills: [],
    },
    opencode: {
      aliases: [],
      executionCapabilities: ['shell', 'file-edit', 'tools'],
      skills: [],
    },
  },
};

// ---- construction ------------------------------------------------------------

// Normalize one entry section ({ id → entry }) into a Map keyed by lowercase
// canonical id, plus an alias → id index. `listFields` names the entry fields
// normalized into sorted string lists. Kind 'model' additionally requires a
// `family` reference that resolves to a DECLARED family id or alias (via
// `familyIndex`); the entry stores the canonical family id so consumers never
// compare aliases against canonical ids.
function indexSection(section, kind, listFields, familyIndex) {
  const byId = new Map();
  const aliasToId = new Map();
  const src = isPlainObject(section) ? section : {};
  for (const rawId of Object.keys(src).sort()) {
    const id = norm(rawId);
    const raw = isPlainObject(src[rawId]) ? src[rawId] : {};
    if (!id) throw new Error(`capability-registry: ${kind} entry id must be a non-empty string`);
    if (byId.has(id)) throw new Error(`capability-registry: duplicate ${kind} id "${id}"`);
    const entry = { id };
    if (kind === 'model') {
      const family = norm(raw.family);
      if (!family) throw new Error(`capability-registry: model "${id}" requires a family`);
      const canonical = familyIndex.byId.has(family) ? family : familyIndex.aliasToId.get(family);
      if (!canonical) {
        throw new Error(`capability-registry: model "${id}" references undeclared family "${family}"`);
      }
      entry.family = canonical;
    }
    for (const f of listFields) entry[f] = normList(raw[f]);
    entry.aliases = normList(raw.aliases);
    byId.set(id, entry);
    for (const alias of entry.aliases) {
      if ((byId.has(alias) && alias !== id) || (aliasToId.has(alias) && aliasToId.get(alias) !== id)) {
        throw new Error(`capability-registry: ambiguous ${kind} alias "${alias}"`);
      }
      aliasToId.set(alias, id);
    }
  }
  // A canonical id may itself be another entry's alias target only if the
  // alias points at that same id; an alias equal to a DIFFERENT canonical id
  // is ambiguous and rejected.
  for (const [alias, id] of aliasToId) {
    if (byId.has(alias) && alias !== id) {
      throw new Error(`capability-registry: ${kind} alias "${alias}" collides with canonical id`);
    }
  }
  return { byId, aliasToId };
}

// Shallow per-entry merge of two entry documents: `extra` fields win per id
// (arrays replace wholesale). Unknown sections are ignored. The merged doc is
// validated by createRegistry like any other — this is how callers extend the
// registry without editing built-in data or adapters.
function mergeEntries(base, extra) {
  const b = isPlainObject(base) ? base : {};
  const e = isPlainObject(extra) ? extra : {};
  const out = { schemaVersion: REGISTRY_SCHEMA_VERSION };
  for (const section of ['families', 'models', 'harnesses']) {
    const merged = { ...(isPlainObject(b[section]) ? b[section] : {}) };
    const over = isPlainObject(e[section]) ? e[section] : {};
    for (const [k, v] of Object.entries(over)) {
      merged[k] = isPlainObject(v) && isPlainObject(merged[k]) ? { ...merged[k], ...v } : v;
    }
    out[section] = merged;
  }
  return out;
}

// Build a validated, immutable registry from an entries document. Throws on
// misconfiguration (duplicate ids, ambiguous aliases, missing model family) —
// a bad registry is a build error, never a runtime unknown.
function createRegistry(entries) {
  const doc = isPlainObject(entries) ? entries : DEFAULT_ENTRIES;
  // Families index first: model entries validate their family reference
  // against declared family ids and aliases at build time.
  const families = indexSection(doc.families, 'family', []);
  const models = indexSection(doc.models, 'model', ['taskCapabilities'], families);
  const harnesses = indexSection(doc.harnesses, 'harness', ['executionCapabilities', 'skills']);

  function lookup(section, name, absentReason) {
    const key = norm(name);
    if (!key) return unknown('registry-name-absent');
    const id = section.byId.has(key) ? key : section.aliasToId.get(key);
    const entry = id ? section.byId.get(id) : null;
    if (!entry) return unknown(absentReason);
    const { aliases, ...rest } = entry;
    return configuredFact({ ...rest, aliases: aliases.slice() }, REGISTRY_SOURCE);
  }

  return deepFreeze({
    schemaVersion: REGISTRY_SCHEMA_VERSION,

    // Model identity (canonical id or alias) → entry fact
    // { id, family, taskCapabilities, aliases }, or unknown.
    lookupModel(name) {
      return lookup(models, name, 'registry-model-absent');
    },

    // Harness identity (canonical id or alias) → entry fact
    // { id, executionCapabilities, skills, aliases }, or unknown.
    lookupHarness(name) {
      return lookup(harnesses, name, 'registry-harness-absent');
    },

    // Family name or alias → entry fact { id, aliases }, or unknown. Only
    // registered families resolve; an unregistered name is NOT promoted to a
    // family here (callers needing literal fallback canonicalize themselves).
    lookupFamily(name) {
      return lookup(families, name, 'registry-family-absent');
    },

    // Canonical id for a model/harness/family name or alias, or null. Pure
    // string convenience over the fact lookups for callers that already hold
    // proven evidence.
    canonicalModelId(name) {
      const key = norm(name);
      if (!key) return null;
      return models.byId.has(key) ? key : (models.aliasToId.get(key) || null);
    },
    canonicalHarnessId(name) {
      const key = norm(name);
      if (!key) return null;
      return harnesses.byId.has(key) ? key : (harnesses.aliasToId.get(key) || null);
    },
    canonicalFamilyId(name) {
      const key = norm(name);
      if (!key) return null;
      return families.byId.has(key) ? key : (families.aliasToId.get(key) || null);
    },

    // Immutable snapshot of the normalized entries, for introspection and
    // fixtures. Data only — no functions.
    entries: {
      models: Object.fromEntries([...models.byId].map(([k, v]) => [k, { ...v, aliases: v.aliases.slice(), taskCapabilities: v.taskCapabilities.slice() }])),
      harnesses: Object.fromEntries([...harnesses.byId].map(([k, v]) => [k, { ...v, aliases: v.aliases.slice(), executionCapabilities: v.executionCapabilities.slice(), skills: v.skills.slice() }])),
      families: Object.fromEntries([...families.byId].map(([k, v]) => [k, { ...v, aliases: v.aliases.slice() }])),
    },
  });
}

let defaultReg = null;
function defaultRegistry() {
  if (!defaultReg) defaultReg = createRegistry(DEFAULT_ENTRIES);
  return defaultReg;
}

module.exports = {
  REGISTRY_SCHEMA_VERSION,
  REGISTRY_SOURCE,
  DEFAULT_ENTRIES,
  createRegistry,
  defaultRegistry,
  mergeEntries,
};
