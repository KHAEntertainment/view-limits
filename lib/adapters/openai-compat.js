'use strict';
// OpenAI-compatible wire family. Auth is `Authorization: Bearer <key>`.
// Quota evidence is the documented `x-ratelimit-*` headers on the route's
// explicit read-only source (route.monitor.endpoint + recipeOptions.path);
// see ./compat.js for the shared fetch and truthfulness rules.

const { fetchCompatStatus } = require('./compat');
const { parseOpenAIHeaders } = require('./ratelimit-headers');

const FAMILY = Object.freeze({
  id: 'openai-compat',
  authHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  parse: (headers, opts, now) => parseOpenAIHeaders(headers, opts.resetEncoding, now),
});

function fetchStatus(cfg, token, ctx) {
  return fetchCompatStatus(FAMILY, cfg, token, ctx);
}

module.exports = { fetchStatus, FAMILY };
