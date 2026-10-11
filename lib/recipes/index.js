'use strict';
// Fixed read-only recipe registry. Recipes are bounded adapters that consume
// the resolver-prepared effective config + token + ctx and produce a
// NormalizedStatus. They never read the vault, never perform authentication
// beyond the token argument, and never reach into raw provider response
// shapes — the parser boundary stops here.
//
// The only recipe registered today is `built-in`, a pass-through to the
// route's wire-family adapter so the resolver has a single, uniform contract
// for every route. Future recipes for openai-compat / anthropic-compat /
// alibaba / stepfun are added by their owning Phase 2 tickets (#55, #56,
// #57) and registered into RECIPES at that point — until then the resolver
// classifies them as `unsupported-recipe:<id>` and returns stable unknown.

const { buildStatus } = require('../normalize');

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

const RECIPES = Object.freeze({
  'built-in': Object.freeze({
    id: 'built-in',
    kind: 'adapter',
    capabilities: Object.freeze({
      monitorable: true,
      source: 'wire-family',
      credential: 'route-id-vault',
    }),
    fetch: builtInFetch,
  }),
});

// Look up a recipe by id. Returns null (not undefined, not a thrown error)
// when the id is unknown or invalid, so callers can apply a stable
// `unsupported-recipe` classification rather than aborting.
function getRecipe(id) {
  if (typeof id !== 'string' || !id) return null;
  return RECIPES[id] || null;
}

// Defensive copy of the known recipe ids. A Set is returned (not the internal
// list) so callers cannot mutate the registry by accident.
function knownRecipes() {
  return new Set(Object.keys(RECIPES));
}

module.exports = { RECIPES, getRecipe, knownRecipes };