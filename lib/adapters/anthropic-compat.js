'use strict';
// Anthropic-compatible wire family. Auth is `x-api-key` + `anthropic-version`
// and NEVER `Authorization: Bearer` — this family's header builder is the
// only source of request auth, and boundedGet adds none of its own.
// Quota evidence is the documented `anthropic-ratelimit-*` headers on the
// route's explicit read-only source; see ./compat.js for the shared fetch.

const { fetchCompatStatus } = require('./compat');
const { parseAnthropicHeaders } = require('./ratelimit-headers');

const ANTHROPIC_VERSIONS = Object.freeze(['2023-06-01']);

const FAMILY = Object.freeze({
  id: 'anthropic-compat',
  authHeaders: (token, opts) => {
    // Fail closed rather than send the request without a version header.
    if (!ANTHROPIC_VERSIONS.includes(opts.anthropicVersion)) return { error: 'unsupported-anthropic-version' };
    return { 'x-api-key': token, 'anthropic-version': opts.anthropicVersion };
  },
  parse: (headers, opts, now) => parseAnthropicHeaders(headers, now),
});

function fetchStatus(cfg, token, ctx) {
  return fetchCompatStatus(FAMILY, cfg, token, ctx);
}

module.exports = { fetchStatus, FAMILY, ANTHROPIC_VERSIONS };
