'use strict';
// Per-route monitor schema, label/slug validation, quota-pool identity and
// configuration revision.
//
// `route.monitor` carries NON-SECRET per-route overrides for a custom provider
// (endpoint, model, recipe id, account/profile/region). The vault still keys
// secrets by `route.id`; this module never reads or stores credentials and
// rejects any field name that looks credential-shaped so the schema is the
// authoritative block-list. The shape, identity and revision functions are
// pure: same input → same output, no filesystem, no clock.

const crypto = require('crypto');
const { getOptionSpec } = require('./recipes/option-specs');

// Allow-list of route.monitor fields. Names that resemble credentials are
// absent on purpose. Adding a new field means editing this list AND the
// `SECRET_FIELD_NAMES` block-list below stays the authoritative deny.
const ALLOWED_MONITOR_FIELDS = ['endpoint', 'model', 'recipe', 'account', 'profile', 'region', 'recipeOptions'];

// Credential-shaped names. Exhaustive block-list (not a regex) so a future
// non-secret field can be added without silently swallowing a credential.
// Comparison is case-insensitive; the allow-list is the structural guard.
const SECRET_FIELD_NAMES = new Set([
  'token', 'apikey', 'api_key', 'secret', 'password', 'authorization',
  'bearer', 'cookie', 'sessionid', 'session_id', 'credential', 'private_key',
]);

// Reserved label prefixes. Custom routes MUST NOT look like a built-in family
// — otherwise `route.provider` resolution could pick the wrong adapter, and
// `validateLabel` rejects them up-front so setup never publishes a slug the
// rest of the system can't safely disambiguate.
const RESERVED_LABEL_PREFIXES = [
  'openrouter-', 'minimax-', 'kimi-', 'glm-', 'deepseek-', 'xiaomi-',
  'alibaba-', 'stepfun-', 'openai-compat-', 'anthropic-compat-',
];

const MAX_LABEL = 64;
const LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}[a-zA-Z0-9]$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

// Validate `route.monitor` against the allow-list and primitive shape rules.
//
//   { ok: true, monitor }  when absent or well-formed; monitor is the
//                          normalized object or null when absent.
//   { ok: false, error }   when supplied but invalid; the resolver still
//                          produces a route — it just classifies it as
//                          unsupported and returns stable unknown.
//
// Returning ok:false (vs throwing) keeps the resolver total, so a single
// malformed route cannot crash refresh or check.
function validateMonitor(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return { ok: false, error: 'route is not an object' };
  }
  // Normalize `monitor: null` to absent so it agrees with poolIdentity,
  // configRevision and resolveEffectiveConfig (all four treat null as
  // "no monitor"). Anything other than absent/null/plain-object is
  // an invalid monitor shape and surfaces ok:false.
  if (route.monitor === undefined || route.monitor === null) return { ok: true, monitor: null };
  if (!isPlainObject(route.monitor)) {
    return { ok: false, error: 'route.monitor must be an object' };
  }
  for (const k of Object.keys(route.monitor)) {
    // Reject credential-shaped names FIRST so a future allow-list edit can
    // never accidentally whitelist a token-shaped field; the secret block
    // is authoritative. Depth-2 names inside `recipeOptions` are checked by
    // validateRecipeOptions below.
    if (SECRET_FIELD_NAMES.has(String(k).toLowerCase())) {
      return { ok: false, error: `route.monitor.${k} is a reserved secret name; store in vault` };
    }
    if (!ALLOWED_MONITOR_FIELDS.includes(k)) {
      return { ok: false, error: `unsupported route.monitor field "${k}"` };
    }
  }
  const m = route.monitor;
  if ('endpoint' in m) {
    const epError = httpsEndpointError(m.endpoint);
    if (epError) return { ok: false, error: `route.monitor.endpoint ${epError}` };
  }
  if ('model' in m && (typeof m.model !== 'string' || !m.model.trim())) {
    return { ok: false, error: 'route.monitor.model must be a non-empty string' };
  }
  if ('recipe' in m && (typeof m.recipe !== 'string' || !m.recipe.trim())) {
    return { ok: false, error: 'route.monitor.recipe must be a non-empty string' };
  }
  for (const k of ['account', 'profile', 'region']) {
    if (k in m && (typeof m[k] !== 'string' || !m[k].trim())) {
      return { ok: false, error: `route.monitor.${k} must be a non-empty string` };
    }
  }
  // A declared recipe is checked even when recipeOptions is absent, so a
  // required option (e.g. compat `path`) is caught here, not at fetch time.
  if ('recipeOptions' in m || getOptionSpec(m.recipe)) {
    const opts = validateRecipeOptions(m.recipe, 'recipeOptions' in m ? m.recipeOptions : {});
    if (!opts.ok) return opts;
  }
  return { ok: true, monitor: m };
}

// URL policy shared by route.monitor validation and the bounded transport
// (lib/adapters/http.js boundedGet). Returns null when `url` is an absolute
// https URL with no embedded credentials, otherwise a short reason.
//
// https-only: a custom monitor endpoint is a quota source the user explicitly
// trusts. http: would silently downgrade to cleartext on shared networks.
// Matches the convention in lib/jev-openrouter.js (`httpsBase`).
function httpsEndpointError(url) {
  if (typeof url !== 'string' || !url) return 'must be a non-empty string';
  let u;
  try { u = new URL(url); }
  catch { return 'is not a valid URL'; }
  if (u.protocol !== 'https:') return 'must be https';
  if (u.username || u.password) return 'must not embed credentials';
  // Reject query and fragment so a user cannot smuggle a key in `?api_key=…`
  // or pin a stale `#fragment` that future relays could interpret. The bounded
  // fetch helper strips them again at URL time as a defensive backup. Mirrors the
  // pathError() rule (`no query`) so monitor-endpoint and recipe-options path
  // share the same shape: absolute path, no `?…`, no `#…`.
  if (u.search) return 'must not contain a query string';
  if (u.hash) return 'must not contain a fragment';
  return null;
}

// Names inside recipeOptions that look like a credential. Broader than the
// depth-1 SECRET_FIELD_NAMES block-list because option names are recipe-
// private: anything resembling a secret is refused as non-persistable even
// before the recipe's declared shape is consulted.
const SECRET_OPTION_NAME_RE = /(token|secret|passw|api[_-]?key|apikey|auth|bearer|cookie|credential|private[_-]?key|session|signature)/i;

// Values that look like a credential: auth-scheme prefixes, common key
// prefixes and JWTs. Checked on every string option (and each path segment)
// so a key pasted into a non-secret field is never written to config.json.
const SECRET_VALUE_RES = [
  /^\s*(bearer|basic)\s+\S/i,
  // sk- / sk_ prefix with ≥2 chars after the separator (was ≥6). The 6-char
  // floor was an overshoot: a 3-char fragment (e.g. `sk-AAA`) would have
  // slipped past `looksLikeSecretValue` and through `pathError`, so
  // `recipeOptions.path = '/v1/sk-AAA/models'` would have persisted. Real
  // OpenAI / Anthropic keys are far longer (`sk-proj-…`, `sk-ant-api03-…`)
  // and continue to match; the wider floor only catches synthetic fragments.
  /^sk[-_][A-Za-z0-9_-]{2,}/,
  /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/,
  /^(xox[abpr]-|ghp_|gho_|github_pat_|AKIA[0-9A-Z]{8})/,
];

function looksLikeSecretValue(v) {
  return typeof v === 'string' && SECRET_VALUE_RES.some((re) => re.test(v));
}

// A read-only source path appended to route.monitor.endpoint. Absolute,
// no query/fragment (so no `?api_key=`), no `..`/`//`, conservative charset.
const PATH_RE = /^\/[A-Za-z0-9._~\-/]{0,255}$/;
function pathError(p) {
  if (typeof p !== 'string' || !PATH_RE.test(p)) return 'must be an absolute path of [A-Za-z0-9._~-/] with no query';
  if (p.startsWith('//') || p.split('/').some((seg) => seg === '..' || seg === '.')) return 'must not contain "//", "." or ".." segments';
  if (p.split('/').some(looksLikeSecretValue)) return 'contains a credential-shaped segment';
  return null;
}

// Validate route.monitor.recipeOptions (QA M-R1, PR #71). Generic rules apply
// to every recipe id; a recipe declared in lib/recipes/option-specs.js is also
// held to its declared shape (unknown keys, wrong types, out-of-range or
// non-enum values rejected). An undeclared recipe id gets only the generic
// rules — the resolver classifies it as unsupported-recipe regardless.
//
//   { ok: true }                     well-formed
//   { ok: false, error, code? }      `code` is a stable reason for failures
//                                    the resolver surfaces verbatim
function validateRecipeOptions(recipeId, opts) {
  if (!isPlainObject(opts)) return { ok: false, error: 'route.monitor.recipeOptions must be an object' };
  for (const [k, v] of Object.entries(opts)) {
    if (SECRET_FIELD_NAMES.has(k.toLowerCase()) || SECRET_OPTION_NAME_RE.test(k)) {
      return { ok: false, error: `route.monitor.recipeOptions.${k} is credential-shaped and non-persistable; store in vault` };
    }
    if (v !== null && typeof v === 'object') {
      return { ok: false, error: `route.monitor.recipeOptions.${k} must be a primitive` };
    }
    if (looksLikeSecretValue(v)) {
      return { ok: false, error: `route.monitor.recipeOptions.${k} holds a credential-shaped value and is non-persistable` };
    }
  }
  const spec = getOptionSpec(recipeId);
  if (!spec) return { ok: true };
  for (const k of Object.keys(opts)) {
    if (!Object.prototype.hasOwnProperty.call(spec, k)) {
      return { ok: false, error: `route.monitor.recipeOptions.${k} is not an option of recipe "${recipeId}"` };
    }
  }
  for (const [k, s] of Object.entries(spec)) {
    const v = opts[k];
    if (v === undefined) {
      if (s.required) return { ok: false, error: `route.monitor.recipeOptions.${k} is required for recipe "${recipeId}"` };
      continue;
    }
    const where = `route.monitor.recipeOptions.${k}`;
    if (s.type === 'path') {
      const e = pathError(v);
      if (e) return { ok: false, error: `${where} ${e}` };
    } else if (s.type === 'enum') {
      if (!s.values.includes(v)) {
        const r = { ok: false, error: `${where} must be one of ${s.values.join(', ')}` };
        if (k === 'anthropicVersion') r.code = 'unsupported-anthropic-version';
        return r;
      }
    } else if (s.type === 'integer') {
      if (!Number.isInteger(v) || v < s.min || v > s.max) {
        return { ok: false, error: `${where} must be an integer in [${s.min}, ${s.max}]` };
      }
    }
  }
  return { ok: true };
}

// Declared recipeOptions with defaults applied. Assumes validateRecipeOptions
// already passed; unknown recipes yield {} (they never reach a fetch).
function resolvedRecipeOptions(recipeId, opts) {
  const spec = getOptionSpec(recipeId) || {};
  const src = isPlainObject(opts) ? opts : {};
  const out = {};
  for (const [k, s] of Object.entries(spec)) {
    if (src[k] !== undefined) out[k] = src[k];
    else if (s.default !== undefined) out[k] = s.default;
  }
  return out;
}

// Validate and normalize a user-supplied label into a safe slug. Reject empty,
// oversized, weird-character, or reserved-prefix labels so two custom routes
// cannot collide on the same identity or impersonate a built-in family.
//
//   { ok: true, slug }    on success; slug is URL/filename safe.
//   { ok: false, error }  on rejection; the slug is never computed when
//                         ok:false, so callers can surface a stable error.
function validateLabel(label) {
  if (typeof label !== 'string') return { ok: false, error: 'label must be a string' };
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: 'label must be non-empty' };
  if (trimmed.length > MAX_LABEL) return { ok: false, error: `label exceeds ${MAX_LABEL} chars` };
  if (!LABEL_RE.test(trimmed)) {
    return { ok: false, error: 'label must match [a-zA-Z0-9][a-zA-Z0-9._-]*[a-zA-Z0-9]' };
  }
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // Slug is URL/filename safe: only [a-z0-9-]. Underscores/dots in the
  // label are normalized to dashes on the boundary so downstream identifiers
  // never carry a character that the vault, filesystem or shell treats
  // specially.
  if (!SLUG_RE.test(slug)) {
    return { ok: false, error: 'label normalizes to an invalid slug' };
  }
  for (const prefix of RESERVED_LABEL_PREFIXES) {
    if (slug.startsWith(prefix)) {
      return { ok: false, error: `label slug "${slug}" uses reserved prefix "${prefix}"` };
    }
  }
  return { ok: true, slug };
}

// Deterministic hash of the route identity + non-secret monitor fields.
// Pure: same input → same revision. Used to detect config-obsolete cache
// entries. Credential rotation never appears here (vault is keyed by
// route.id, not by route.monitor), so a token change is silent at this
// layer — the consumer decides whether to bump the revision externally.
function configRevision(route) {
  const obj = {
    id: route && route.id,
    provider: route && route.provider,
    monitor: route && route.monitor ? normalizedMonitor(route.monitor) : null,
  };
  return sha1Hex(JSON.stringify(obj));
}

// Does a cached entry describe a configuration the route no longer has?
//
// This is the READER half of configRevision (#54 shipped the writer half and
// left it inert; #58 wires both ends). `lib/gate.js` consults it so a cached
// `exhausted` observation made under a previous endpoint / account / profile /
// region / revision-bearing recipe option can never keep denying dispatch
// after the route was edited.
//
// The two cases are deliberately asymmetric, and both fail OPEN at the gate:
//
//   * NO revision on the entry — every cache file written before #58 — is
//     never obsolete, so existing installs keep their exact behaviour
//     (time-freshness only). This is the back-compat case and it stays
//     deny-capable.
//   * A revision IS present but cannot be checked (the route is missing or
//     unusable, or its revision cannot be computed at all) ⇒ OBSOLETE. An
//     entry that claims to describe a specific configuration, against a route
//     we cannot verify it against, is not evidence worth denying on. Treating
//     it as current would be the only branch here that could produce a deny
//     nobody can justify.
//
// Never throws, so a corrupt cache cannot crash the hook.
function isConfigObsolete(entry, route) {
  if (!isPlainObject(entry)) return false;
  const cached = entry.configRevision;
  if (typeof cached !== 'string' || !cached) return false;
  if (!isPlainObject(route)) return true;
  let current;
  try {
    current = configRevision(route);
  } catch {
    return true;
  }
  if (typeof current !== 'string' || !current) return true;
  return cached !== current;
}

// Quota-pool identity: routes with identical recipe + account + profile +
// region share one verified identical quota pool. Protocol/model variants
// sharing this identity reuse one observation; matching model names alone
// do not prove two subscriptions share a pool (the design rule).
//
// Returns null when the route has no monitor (built-in family has no
// synthetic pool key, and built-ins are not deduplicated).
function poolIdentity(route) {
  if (!route || !route.monitor || typeof route.monitor !== 'object') return null;
  const m = route.monitor;
  if (!m.recipe) return null;
  const parts = [
    String(m.recipe),
    typeof m.account === 'string' ? m.account : '',
    typeof m.profile === 'string' ? m.profile : '',
    typeof m.region === 'string' ? m.region : '',
  ];
  return sha1Hex(parts.join('|'));
}

// Classify a route's monitorability given the set of recipe ids known to the
// fixed registry. Returns { monitorable, reason } where reason is a stable
// identifier suitable for diagnostics (never a free-form error string).
//
//   absent monitor           → built-in adapter, monitorable
//   monitor with no recipe   → monitor-recipe-required, not monitorable
//   unknown recipe id        → unsupported-recipe:<id>, not monitorable
//   known recipe id          → recipe:<id>, monitorable
function classifyCapability(monitor, knownRecipes) {
  if (!monitor) return { monitorable: true, reason: 'built-in-adapter' };
  if (!monitor.recipe) return { monitorable: false, reason: 'monitor-recipe-required' };
  if (!(knownRecipes instanceof Set)) return { monitorable: false, reason: 'invalid-known-recipes' };
  if (!knownRecipes.has(monitor.recipe)) {
    return { monitorable: false, reason: `unsupported-recipe:${monitor.recipe}` };
  }
  return { monitorable: true, reason: `recipe:${monitor.recipe}` };
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Sort monitor keys into a deterministic order so configRevision is stable
// across JSON key insertion order. Only allow-listed keys are kept.
//
// `recipeOptions` contributes only the options its recipe declares
// `revision: true` (QA M-R2, PR #71), with defaults applied so an omitted
// option and its explicit default hash the same. Ephemeral options (transport
// tuning such as timeoutMs) and options of undeclared recipes are excluded,
// so their churn never marks a cache entry config-obsolete. Recipes with no
// revision-bearing options (built-in) hash exactly as before #55.
//
// Tolerates non-object inputs by returning null; callers that produce
// configRevision from an invalid route still get a stable string instead of
// a thrown TypeError.
function normalizedMonitor(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  for (const k of ALLOWED_MONITOR_FIELDS) {
    if (k === 'recipeOptions') continue;
    if (k in m) out[k] = m[k];
  }
  const spec = getOptionSpec(m.recipe);
  if (spec) {
    const resolved = resolvedRecipeOptions(m.recipe, m.recipeOptions);
    const revisioned = {};
    for (const k of Object.keys(spec).sort()) {
      if (spec[k].revision && resolved[k] !== undefined) revisioned[k] = resolved[k];
    }
    if (Object.keys(revisioned).length) out.recipeOptions = revisioned;
  }
  return out;
}

function sha1Hex(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

module.exports = {
  ALLOWED_MONITOR_FIELDS,
  SECRET_FIELD_NAMES,
  RESERVED_LABEL_PREFIXES,
  validateMonitor,
  validateRecipeOptions,
  resolvedRecipeOptions,
  httpsEndpointError,
  validateLabel,
  configRevision,
  isConfigObsolete,
  poolIdentity,
  classifyCapability,
};