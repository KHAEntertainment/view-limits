'use strict';
// Effective-config resolver. Given a route and the loaded config, returns
// { adapterFn, cfg, monitor, poolIdentity, configRevision, capability } —
// the single shape consumed by both `refresh` and `check` so neither
// command can drift into per-route inconsistency (AC2).
//
// This module deliberately does NOT import `lib/adapters` to avoid the cycle
// `lib/adapters → lib/effective-config → lib/adapters`. Instead the caller
// passes `ctx.getAdapter = (provider) => adapterModule`; for built-in routes
// the resolver invokes it to obtain the wire-family adapter.
//
// Returned shape is uniform across every branch — capability, revision, and
// pool identity are always present (possibly null/empty), and `adapterFn`
// always satisfies `(cfg, token, ctx) → NormalizedStatus`.

const { buildStatus } = require('./normalize');
const { validateMonitor, configRevision, poolIdentity, classifyCapability } = require('./monitor-schema');
const { getRecipe, knownRecipes } = require('./recipes');

// Stable unknown fetch used for invalid monitor, unsupported recipe, and
// unknown provider. Always returns monitorable:false so the gate can never
// treat a recipe we can't honour as healthy.
function stableUnknown(reason) {
  return async function unknownFetch(cfgIgnored, tokenIgnored, ctxIgnored) {
    return buildStatus({
      unknown: true,
      windows: [],
      balance: null,
      resetAt: null,
      detail: { reason, monitorable: false },
    });
  };
}

// Single entry point. Always returns a fully populated result — no throws.
function resolveEffectiveConfig(route, cfg, ctx = {}) {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return makeResult({
      adapterFn: stableUnknown('invalid-route'),
      cfg: {},
      monitor: null,
      poolIdentity: null,
      configRevision: 'invalid-route',
      capability: { monitorable: false, reason: 'invalid-route' },
    });
  }
  const validation = validateMonitor(route);
  if (!validation.ok) {
    return makeResult({
      // A validator `code` (e.g. unsupported-anthropic-version) is already a
      // stable reason; otherwise the error text names the offending field.
      adapterFn: stableUnknown(validation.code || `invalid-monitor:${validation.error}`),
      cfg: {},
      monitor: null,
      poolIdentity: null,
      configRevision: configRevision(route),
      capability: { monitorable: false, reason: 'invalid-monitor' },
    });
  }
  const monitor = validation.monitor; // null when absent
  const recipes = knownRecipes();
  const capability = classifyCapability(monitor, recipes);
  const revision = configRevision(route);
  const poolId = poolIdentity(route);

  // Branch selection:
  //   monitor absent        → built-in adapter (current behaviour, parity)
  //   monitor.recipe absent → monitor-recipe-required (custom route needs an id)
  //   monitor.recipe = 'built-in' → explicit built-in pass-through
  //   monitor.recipe = known id → recipe fetch
  //   monitor.recipe = unknown id → unsupported-recipe:<id>
  //
  // When monitor is present, the resolver NEVER falls through to the wire-
  // family adapter — a custom route without a recipe is malformed and must
  // surface as monitor-recipe-required, not silently coerce to a built-in.
  if (!monitor) {
    const providerCfg = (cfg && cfg.providers && cfg.providers[route.provider]) || {};
    const getAdapter = typeof ctx.getAdapter === 'function' ? ctx.getAdapter : null;
    if (!getAdapter) {
      return makeResult({
        adapterFn: stableUnknown('no-adapter-factory'),
        cfg: providerCfg,
        monitor,
        poolIdentity: poolId,
        configRevision: revision,
        capability: { monitorable: false, reason: 'no-adapter-factory' },
      });
    }
    let adapterModule;
    try {
      adapterModule = getAdapter(route.provider);
    } catch {
      return makeResult({
        adapterFn: stableUnknown(`unknown-provider:${route.provider}`),
        cfg: providerCfg,
        monitor,
        poolIdentity: poolId,
        configRevision: revision,
        capability: { monitorable: false, reason: `unknown-provider:${route.provider}` },
      });
    }
    const recipe = getRecipe('built-in');
    return makeResult({
      adapterFn: recipe.fetch,
      cfg: { adapter: adapterModule, providerCfg },
      monitor,
      poolIdentity: poolId,
      configRevision: revision,
      capability,
    });
  }
  // monitor present: require a recipe id.
  if (!monitor.recipe) {
    return makeResult({
      adapterFn: stableUnknown('monitor-recipe-required'),
      cfg: {},
      monitor,
      poolIdentity: poolId,
      configRevision: revision,
      capability: { monitorable: false, reason: 'monitor-recipe-required' },
    });
  }
  // Explicit built-in recipe: same wire-family behaviour as the no-monitor
  // branch, but the route still carries monitor fields (account/profile/
  // region/endpoint/recipeOptions) for downstream visibility.
  if (monitor.recipe === 'built-in') {
    const providerCfg = (cfg && cfg.providers && cfg.providers[route.provider]) || {};
    const getAdapter = typeof ctx.getAdapter === 'function' ? ctx.getAdapter : null;
    if (!getAdapter) {
      return makeResult({
        adapterFn: stableUnknown('no-adapter-factory'),
        cfg: providerCfg,
        monitor,
        poolIdentity: poolId,
        configRevision: revision,
        capability: { monitorable: false, reason: 'no-adapter-factory' },
      });
    }
    let adapterModule;
    try {
      adapterModule = getAdapter(route.provider);
    } catch {
      return makeResult({
        adapterFn: stableUnknown(`unknown-provider:${route.provider}`),
        cfg: providerCfg,
        monitor,
        poolIdentity: poolId,
        configRevision: revision,
        capability: { monitorable: false, reason: `unknown-provider:${route.provider}` },
      });
    }
    const recipe = getRecipe('built-in');
    return makeResult({
      adapterFn: recipe.fetch,
      cfg: { adapter: adapterModule, providerCfg },
      monitor,
      poolIdentity: poolId,
      configRevision: revision,
      capability,
    });
  }
  // Custom recipe branch: monitor.recipe is non-built-in. Look up in the
  // fixed registry. Unknown recipes return stable unknown.
  const recipe = getRecipe(monitor.recipe);
  if (!recipe) {
    return makeResult({
      adapterFn: stableUnknown(`unsupported-recipe:${monitor.recipe}`),
      cfg: {},
      monitor,
      poolIdentity: poolId,
      configRevision: revision,
      capability,
    });
  }
  // A wire-family recipe only serves routes of that family: an
  // anthropic-compat route must never be read with openai-compat's Bearer
  // auth (or vice versa), so a mismatch is refused before any request.
  // A null family (`stepfun-plan`) is not a wire-family recipe, so the
  // check short-circuits and any route.provider may carry it.
  if (recipe.family && recipe.family !== route.provider) {
    return makeResult({
      adapterFn: stableUnknown('recipe-family-mismatch'),
      cfg: {},
      monitor,
      poolIdentity: poolId,
      configRevision: revision,
      capability: { monitorable: false, reason: 'recipe-family-mismatch' },
    });
  }
  // A recipe that documents no quota source is first-class unmonitored, not
  // `unsupported-recipe:` (which means the id is unknown to the registry) and
  // not monitorable (which would imply observed capacity). classifyCapability
  // above only knows ids, so the recipe's own capability refines it here.
  const effCapability = recipe.capabilities && recipe.capabilities.monitorable === false
    ? { monitorable: false, reason: `unmonitored:${recipe.id}` }
    : capability;
  const effectiveCfg = {
    baseUrl: monitor.endpoint,
    recipeId: monitor.recipe,
    monitor,
    account: monitor.account,
    profile: monitor.profile,
    region: monitor.region,
    model: monitor.model,
    recipeOptions: monitor.recipeOptions,
  };
  return makeResult({
    adapterFn: recipe.fetch,
    cfg: effectiveCfg,
    monitor,
    poolIdentity: poolId,
    configRevision: revision,
    capability: effCapability,
  });
}

function makeResult(parts) {
  return {
    adapterFn: parts.adapterFn,
    cfg: parts.cfg,
    monitor: parts.monitor === undefined ? null : parts.monitor,
    poolIdentity: parts.poolIdentity === undefined ? null : parts.poolIdentity,
    configRevision: parts.configRevision,
    capability: parts.capability,
  };
}

module.exports = { resolveEffectiveConfig, stableUnknown };