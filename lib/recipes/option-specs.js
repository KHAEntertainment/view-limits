'use strict';
// Declared `route.monitor.recipeOptions` shape per recipe. Data only, no
// requires, so lib/monitor-schema.js can read it without a cycle through the
// recipe modules (which pull in transport and adapters).
//
// Every option is a flat primitive. `revision: true` options change how the
// source is read or interpreted and are hashed into configRevision, so a
// cached observation made under the old setting reads as config-obsolete.
// `revision: false` options are ephemeral (transport tuning) and may rotate
// without invalidating the cache.
//
// A recipe absent from this table declares no options: any recipeOptions on
// such a route is rejected rather than silently carried.

const COMPAT_PATH = Object.freeze({ type: 'path', required: true, revision: true });
const COMPAT_SCOPE = Object.freeze({
  type: 'enum',
  values: Object.freeze(['diagnostic', 'account', 'model', 'organization']),
  default: 'diagnostic',
  revision: true,
});
const COMPAT_TIMEOUT = Object.freeze({ type: 'integer', min: 1000, max: 15000, default: 8000, revision: false });

const OPTION_SPECS = Object.freeze({
  'built-in': Object.freeze({}),
  'openai-compat': Object.freeze({
    path: COMPAT_PATH,
    scope: COMPAT_SCOPE,
    // OpenAI documents `x-ratelimit-reset-*` as a relative duration ("6m0s");
    // some compatible providers send epoch seconds or RFC 3339 instead. The
    // route declares which one; a value in any other form is malformed.
    resetEncoding: Object.freeze({
      type: 'enum',
      values: Object.freeze(['duration', 'epoch-seconds', 'rfc3339']),
      default: 'duration',
      revision: true,
    }),
    timeoutMs: COMPAT_TIMEOUT,
  }),
  'anthropic-compat': Object.freeze({
    path: COMPAT_PATH,
    scope: COMPAT_SCOPE,
    // Only the documented version is accepted; anything else fails closed
    // (unsupported-anthropic-version) rather than omitting the header.
    anthropicVersion: Object.freeze({
      type: 'enum',
      values: Object.freeze(['2023-06-01']),
      default: '2023-06-01',
      revision: true,
    }),
    timeoutMs: COMPAT_TIMEOUT,
  }),
});

// Declared option spec for a recipe id, or null when the recipe is unknown.
function getOptionSpec(recipeId) {
  if (typeof recipeId !== 'string' || !Object.prototype.hasOwnProperty.call(OPTION_SPECS, recipeId)) return null;
  return OPTION_SPECS[recipeId];
}

module.exports = { OPTION_SPECS, getOptionSpec };
