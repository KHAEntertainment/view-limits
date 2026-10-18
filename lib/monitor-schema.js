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
    // is authoritative. Depth-2 credential-shaped names inside
    // `recipeOptions` (e.g. `recipeOptions.token`) are NOT validated here:
    // the per-recipe option shapes belong to #55 / #56 / #57, and the
    // setup writer that materialises the route is #58 — see the
    // `normalizedMonitor` note below.
    if (SECRET_FIELD_NAMES.has(String(k).toLowerCase())) {
      return { ok: false, error: `route.monitor.${k} is a reserved secret name; store in vault` };
    }
    if (!ALLOWED_MONITOR_FIELDS.includes(k)) {
      return { ok: false, error: `unsupported route.monitor field "${k}"` };
    }
  }
  const m = route.monitor;
  if ('endpoint' in m) {
    const ep = m.endpoint;
    if (typeof ep !== 'string' || !ep) {
      return { ok: false, error: 'route.monitor.endpoint must be a non-empty string' };
    }
    let u;
    try { u = new URL(ep); }
    catch { return { ok: false, error: 'route.monitor.endpoint is not a valid URL' }; }
    // https-only: a custom monitor endpoint is a quota source the user
    // explicitly trusts. http: would silently downgrade to cleartext on
    // shared networks. Matches the convention in lib/jev-openrouter.js
    // (`httpsBase`), where any non-https base URL is rejected.
    if (u.protocol !== 'https:') {
      return { ok: false, error: 'route.monitor.endpoint must be https' };
    }
    if (u.username || u.password) {
      return { ok: false, error: 'route.monitor.endpoint must not embed credentials' };
    }
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
  if ('recipeOptions' in m && !isPlainObject(m.recipeOptions)) {
    return { ok: false, error: 'route.monitor.recipeOptions must be an object' };
  }
  return { ok: true, monitor: m };
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
// `recipeOptions` is INTENTIONALLY EXCLUDED from the revision hash:
// its contents are recipe-private (owned by #55 / #56 / #57) and may
// rotate frequently as the setup writer (#58) refreshes them. Including
// it would force every cache entry to be marked config-obsolete on
// every option churn — false obsolescence, not real rotation. The
// route identity + endpoint + recipe + account/profile/region still
// rotate when those structural fields change, which is the signal the
// gate cares about.
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
  validateLabel,
  configRevision,
  poolIdentity,
  classifyCapability,
};