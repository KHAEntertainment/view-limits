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
// alibaba / stepfun are added by their owning Phase 2 tickets (#56, #57);
// until then the resolver classifies them as `unsupported-recipe:<id>` and
// returns stable unknown.
//
// Each recipe's recipeOptions shape lives in ./option-specs.js (data only, so
// lib/monitor-schema.js can validate and hash options without loading
// transport code).

const { buildStatus } = require('../normalize');
const { OPTION_SPECS } = require('./option-specs');
const openaiCompat = require('../adapters/openai-compat');
const anthropicCompat = require('../adapters/anthropic-compat');

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
    }),
    fetch: adapter.fetchStatus,
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
    }),
    fetch: builtInFetch,
  }),
  'openai-compat': compatRecipe('openai-compat', openaiCompat),
  'anthropic-compat': compatRecipe('anthropic-compat', anthropicCompat),
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

module.exports = { RECIPES, getRecipe, knownRecipes };
