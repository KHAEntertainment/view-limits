'use strict';
// Adapter registry. Each adapter exports fetchStatus(cfg, token, ctx) → NormalizedStatus.
// Provider-specific response parsing terminates here; nothing downstream re-reads
// raw provider fields.

const minimax = require('./minimax');
const kimi = require('./kimi');
const glm = require('./glm');
const deepseek = require('./deepseek');
const openrouter = require('./openrouter');
// Xiaomi's live path is orchestrated by lib/xiaomi-session.js (one Chrome
// read + one usage/detail pair per operation); the adapter itself stays
// Chrome-agnostic and is registered here so `getAdapter('xiaomi')` resolves.
const xiaomi = require('./xiaomi');
// Alibaba Coding Plan (#56) is intentionally NOT registered here. It is
// reached only through its recipe (`route.monitor.recipe`), never as a
// provider-keyed wire family. Leaving it out is deliberate: a route that names
// `provider: "alibaba-coding-plan"` but forgets `route.monitor` then resolves
// to `unknown-provider:alibaba-coding-plan`, which names the mistake, instead
// of quietly resolving to this module and failing later with `region-required`.
// The alias `bailian` is likewise not registered: the CLI itself documents
// `bl`/`bailian` as the same binary, and recipeOptions.binary selects it.
//
// The recipe is reached under a `family: null` registration in lib/recipes. The
// rule that makes that legal lives in lib/effective-config.js:178 —
// `if (recipe.family && recipe.family !== route.provider)` — which skips the
// family check for a falsy family. Read that line before changing `family`
// here or in lib/recipes.
const openaiCompat = require('./openai-compat');
const anthropicCompat = require('./anthropic-compat');

const ADAPTERS = {
  minimax, kimi, glm, deepseek, openrouter, xiaomi,
  'openai-compat': openaiCompat,
  'anthropic-compat': anthropicCompat,
};

// Provider-keyed adapter lookup. Back-compat: when called with just
// `provider`, returns the wire-family adapter exactly as before. When called
// with `(provider, route, cfg)` (Issue #54), delegates to the route-aware
// resolver so refresh and check converge on a single shared function (AC2).
// `route` must be a non-null route object; null/undefined fall through to the
// provider-keyed lookup so legacy call sites that pass extra positional args
// without a real route keep their old behaviour.
function getAdapter(provider, route, cfg) {
  if (route && typeof route === 'object' && !Array.isArray(route)) {
    return getAdapterForRoute(route, cfg);
  }
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`unknown provider: ${provider}`);
  return a;
}

// Route-aware adapter selection (Issue #54). This is the adapter-layer
// bridge for `bin/vl.js` refresh/check callsites (#54) AND the future
// recipe adapters in #55 (OpenAI/Anthropic compat), #56 (Alibaba) and
// #57 (StepFun). resolveEffectiveConfig is the single source of truth:
// built-in routes resolve to getAdapter(provider); custom routes with a
// `route.monitor.recipe` resolve to that recipe's `fetch`. The returned
// object mirrors the existing adapter contract (`.fetchStatus(cfg, token, ctx)`)
// so every caller can use it identically to `getAdapter(provider).fetchStatus(...)`.
//
// `cfg` and `ctx` are optional for backwards compatibility: when either is
// omitted, behavior falls back to the provider-keyed lookup so legacy
// callers see no change.
function getAdapterForRoute(route, cfg, ctx) {
  // Lazy require to avoid the cycle lib/adapters → lib/effective-config →
  // lib/adapters: this module loads first; effective-config is pulled in
  // only when a route is actually resolved.
  const { resolveEffectiveConfig } = require('../effective-config');
  const eff = resolveEffectiveConfig(route, cfg, Object.assign({}, ctx, { getAdapter }));
  return {
    fetchStatus: (cfgIgnored, token, callCtx) => eff.adapterFn(eff.cfg, token, callCtx || ctx || {}),
    capability: eff.capability,
    poolIdentity: eff.poolIdentity,
    configRevision: eff.configRevision,
    effectiveCfg: eff.cfg,
  };
}

module.exports = { ADAPTERS, getAdapter, getAdapterForRoute };
