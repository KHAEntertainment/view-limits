'use strict';
// Fixed read-only recipe registry. Recipes are bounded adapters that consume
// the resolver-prepared effective config + token + ctx and produce a
// NormalizedStatus. They never read the vault, never perform authentication
// beyond the token argument, and never reach into raw provider response
// shapes — the parser boundary stops here.
//
// Registered recipes:
//   built-in          pass-through to the route's wire-family adapter, so the
//                     resolver has one uniform contract for every route.
//   openai-compat     (#55) bounded GET of an explicit read-only source,
//   anthropic-compat  (#55) documented rate-limit headers, family-fixed auth.
//   alibaba-coding-plan (#56) bounded `bl usage coding-plan --output json`
//                     subprocess; auth is the CLI's own console login.
//   stepfun-plan      (#57) explicit UNMONITORED classification: the StepFun
//                     docs (platform.stepfun.ai/step-plan, /step-code, and
//                     the full API reference) document no read-only quota API
//                     for Step Plan subscription Credits, so the recipe makes
//                     no request, needs no credential, and returns stable
//                     unknown with a fixed reason. The only documented
//                     endpoint (GET /v1/accounts) reports Open Platform cash
//                     balance — a different system from subscription Credits,
//                     so it is deliberately never read (no-conflation rule).
//
// Each recipe's recipeOptions shape lives in ./option-specs.js (data only, so
// lib/monitor-schema.js can validate and hash options without loading
// transport code).

const { buildStatus } = require('../normalize');
const { OPTION_SPECS } = require('./option-specs');
const openaiCompat = require('../adapters/openai-compat');
const anthropicCompat = require('../adapters/anthropic-compat');
const alibabaCodingPlan = require('../adapters/alibaba-coding-plan');

// Stable reason for a recipe that documents no quota source. Never promoted
// into healthy/exhausted: the fetch is local-only (no HTTP, no subprocess,
// no credential) and always answers the same shape.
const UNMONITORED_REASON = 'unmonitored-no-documented-quota-source';

// `built-in` recipe: cfg.adapter is the wire-family adapter module; cfg.providerCfg
// is cfg.providers[route.provider]. The recipe's fetch is the same signature as
// every other adapter — (cfg, token, ctx) → NormalizedStatus — so future custom
// recipes can be substituted without changing the call site.
async function builtInFetch(cfg, token, ctx) {
  if (!cfg || !cfg.adapter || typeof cfg.adapter.fetchStatus !== 'function') {
    return buildStatus({
      unknown: true,
      windows: [],
      balance: null,
      resetAt: null,
      detail: { reason: 'built-in-recipe-missing-adapter', monitorable: false },
    });
  }
  return cfg.adapter.fetchStatus(cfg.providerCfg, token, ctx);
}

// Compat recipe capabilities. `inference: false` is a contract: the fetch
// makes one read-only GET and never calls a generation endpoint. Discovery-
// time inference (an explicit, bounded opt-in) belongs to the setup/probe
// lifecycle (#58), not to routine refresh/check.
function compatRecipe(id, adapter) {
  return Object.freeze({
    id,
    kind: 'adapter',
    family: id,
    options: OPTION_SPECS[id],
    capabilities: Object.freeze({
      monitorable: true,
      source: 'read-only-http-headers',
      credential: 'route-id-vault',
      signal: 'throughput',
      inference: false,
      // Every recipe holds its credential in the vault, keyed by route.id.
      // alibaba-coding-plan and stepfun-plan are the documented exceptions
      // (see routeNeedsVaultCredential below).
      vaultCredential: true,
    }),
    fetch: adapter.fetchStatus,
  });
}

// Unmonitored recipe: a documentation-based provider with NO supported quota
// source. `monitorable: false` is a contract the resolver surfaces as a
// first-class capability (`unmonitored:<id>`); `inference: false` plus the
// local-only fetch means refresh/check/gate can never send a request or claim
// observed capacity. `family: null` means no wire family constrains the route
// (the resolver's family check is `recipe.family && …`, so it is skipped).
function unmonitoredRecipe(id, reason) {
  return Object.freeze({
    id,
    kind: 'adapter',
    family: null,
    options: OPTION_SPECS[id],
    capabilities: Object.freeze({
      monitorable: false,
      source: 'none-documented',
      credential: 'none',
      inference: false,
      // The fetch is local-only: there is no secret to store under route.id,
      // so the CLI's capability-driven credential hook (routeNeedsVaultCredential
      // in this file) must exempt this route without naming the recipe id.
      vaultCredential: false,
    }),
    unmonitoredReason: reason,
    fetch: async function unmonitoredFetch() {
      return buildStatus({
        unknown: true,
        windows: [],
        balance: null,
        resetAt: null,
        detail: { reason, monitorable: false },
      });
    },
  });
}

const RECIPES = Object.freeze({
  'built-in': Object.freeze({
    id: 'built-in',
    kind: 'adapter',
    family: null,
    options: OPTION_SPECS['built-in'],
    capabilities: Object.freeze({
      monitorable: true,
      source: 'wire-family',
      credential: 'route-id-vault',
      vaultCredential: true,
    }),
    fetch: builtInFetch,
  }),
  'openai-compat': compatRecipe('openai-compat', openaiCompat),
  'anthropic-compat': compatRecipe('anthropic-compat', anthropicCompat),
  'stepfun-plan': unmonitoredRecipe('stepfun-plan', UNMONITORED_REASON),
  // family is null ON PURPOSE. The family check in lib/effective-config.js
  // (`recipe.family && recipe.family !== route.provider`) exists to stop an
  // Anthropic-family route being read with OpenAI-family Bearer auth; this
  // recipe puts no auth on the wire at all (the CLI owns its own console
  // credential), so there is no credential family to confuse and an Alibaba
  // route's `provider` is a free-form custom id. Registering it as a family
  // would instead force every such route to be named exactly
  // `alibaba-coding-plan`.
  'alibaba-coding-plan': Object.freeze({
    id: 'alibaba-coding-plan',
    kind: 'adapter',
    family: null,
    options: OPTION_SPECS['alibaba-coding-plan'],
    capabilities: Object.freeze({
      monitorable: true,
      source: 'bailian-cli-json',
      // The command's credential (`access_token`) is resolvable only from the
      // CLI's own config file — no flag, no env — so view-limits can neither
      // inject nor honestly hold one, and reading that file is out of scope.
      credential: 'cli-managed-auth',
      signal: 'quota',
      inference: false,
      // Signals "this recipe stores no secret under route.id". See
      // routeNeedsVaultCredential below; the CLI auth hook keys on this flag,
      // NOT on the recipe id.
      vaultCredential: false,
    }),
    fetch: alibabaCodingPlan.fetchStatus,
  }),
});

// Look up a recipe by id. Returns null (not undefined, not a thrown error)
// when the id is unknown or invalid, so callers can apply a stable
// `unsupported-recipe` classification rather than aborting.
function getRecipe(id) {
  if (typeof id !== 'string' || !id) return null;
  return Object.prototype.hasOwnProperty.call(RECIPES, id) ? RECIPES[id] : null;
}

// Defensive copy of the known recipe ids. A Set is returned (not the internal
// list) so callers cannot mutate the registry by accident.
function knownRecipes() {
  return new Set(Object.keys(RECIPES));
}

// Does this route need a vault credential under its route.id?
//
// Default is true, so every route that predates this predicate — including one
// whose recipe id is unknown or whose monitor is absent — behaves exactly as
// before. Only a route whose registered recipe explicitly declares
// `capabilities.vaultCredential === false` is exempted, because that recipe
// authenticates through its own approved CLI and holds no secret for us. The
// check is on the capability flag, never on the recipe id, so a future
// credential-free recipe is covered without a code change (both #56
// alibaba-coding-plan and #57 stepfun-plan declare it).
//
// Callers use this for two things and only these: deciding whether a route is
// worth a refresh slot, and whether `check` should demand a credential. The
// adapter itself is unaffected — it never receives a token either way.
function routeNeedsVaultCredential(route) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) return true;
  const monitor = route.monitor;
  if (!isPlainObject(monitor) || typeof monitor.recipe !== 'string' || !monitor.recipe) return true;
  const recipe = getRecipe(monitor.recipe);
  return !recipe || recipe.capabilities.vaultCredential !== false;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = { RECIPES, getRecipe, knownRecipes, routeNeedsVaultCredential };
