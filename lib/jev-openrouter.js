'use strict';
// OpenRouter wire adapter for the Jev classifier path — Issue #11.
//
// This module is the ONLY place the OpenRouter wire shape exists:
// lib/jev-client.js builds a transport-neutral classifier document and this
// adapter translates it into a chat-completions request, including
// OpenRouter's documented structured-output envelope —
//   response_format: { type:'json_schema', json_schema:{ name, schema } }.
//
// PRESENT BUT DORMANT — same contract as lib/jev-client.js: the transport is
// only ever invoked behind the OPEN readiness gate in lib/recommend.js.
// Security posture (fail closed on construction):
//   - HTTPS only: a non-HTTPS baseUrl yields NO transport at all — the
//     factory returns {} rather than send task text + bearer token in
//     cleartext (CWE-319).
//   - redirect:'error' on every fetch: a redirect cannot downgrade or
//     re-target a credential/task-bearing hop.
//   - Every fetch carries a deadline, INCLUDING the catalog body read —
//     a stalling server cannot hang `vl recommend` forever; it degrades to
//     'jev-catalog-timeout' / 'jev-timeout' instead.
//
// makeJevTransport(cfg, deps?) returns {} (transport absent — classify()
// reports 'jev-transport-absent' and verifyModelSupport() reports
// 'jev-catalog-transport-absent') unless cfg.jev carries a non-empty `model`
// AND an https `baseUrl`. `deps.fetch` is injectable for tests; it defaults
// to the global fetch. `deps.env` provides the apiKeyEnv lookup and defaults
// to process.env.

const DEFAULT_CATALOG_TIMEOUT_MS = 15000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// A base URL is usable only when it parses AND is https. Anything else is a
// non-starter — the transport must not exist.
function httpsBase(v) {
  if (!nonEmptyString(v)) return null;
  let url;
  try { url = new URL(v); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  return v.replace(/\/+$/, '');
}

// Race a body read against a deadline — AbortSignal.abort() is not relied on
// to bound res.json() on every transport; the explicit race makes the bound
// unconditional.
function readJsonBounded(res, timeoutMs) {
  let timer;
  return Promise.race([
    res.json(),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`jev catalog read timed out after ${timeoutMs}ms`);
        e.timedOut = true;
        reject(e);
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function makeJevTransport(cfg, deps) {
  const j = isPlainObject(cfg) && isPlainObject(cfg.jev) ? cfg.jev : null;
  if (!j || !nonEmptyString(j.model)) return {};
  const base = httpsBase(j.baseUrl);
  if (base === null) return {};

  const fetchImpl = isPlainObject(deps) && typeof deps.fetch === 'function' ? deps.fetch : fetch;
  const env = isPlainObject(deps) && isPlainObject(deps.env) ? deps.env : process.env;
  const catalogTimeoutMs = Number.isFinite(j.catalogTimeoutMs) ? j.catalogTimeoutMs
    : (Number.isFinite(j.timeoutMs) ? j.timeoutMs : DEFAULT_CATALOG_TIMEOUT_MS);

  return {
    request: async (requestDoc, { timeoutMs, apiKey, baseUrl }) => {
      const key = apiKey || (nonEmptyString(j.apiKeyEnv) ? env[j.apiKeyEnv] : undefined);
      // The caller may pass a baseUrl override; it is still constrained to
      // https — a non-https override falls back to the validated configured
      // base rather than ride a cleartext hop.
      const target = httpsBase(baseUrl) || base;
      const res = await fetchImpl(`${target}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model: requestDoc.model,
          messages: [{
            role: 'user',
            content: JSON.stringify({
              instructions: requestDoc.instructions,
              criteria: requestDoc.criteria,
              state: requestDoc.state,
            }),
          }],
          // OpenRouter's documented structured-output envelope: the schema
          // from the transport-neutral requestDoc is nested exactly once
          // under json_schema.
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'task_profile',
              schema: isPlainObject(requestDoc.responseFormat)
                ? requestDoc.responseFormat.schema
                : undefined,
            },
          },
        }),
        signal: AbortSignal.timeout(Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_CATALOG_TIMEOUT_MS),
        redirect: 'error',
      });
      const text = await res.text();
      // Chat-completions wraps the classifier document in message content;
      // anything else is passed through and fails schema validation honestly.
      try {
        const parsed = JSON.parse(text);
        const content = parsed && parsed.choices && parsed.choices[0] &&
          parsed.choices[0].message && parsed.choices[0].message.content;
        if (typeof content === 'string') return { statusCode: res.status, body: content };
      } catch { /* fall through to raw body */ }
      return { statusCode: res.status, body: text };
    },
    fetchCatalog: async (url) => {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(catalogTimeoutMs),
        redirect: 'error',
      });
      return readJsonBounded(res, catalogTimeoutMs);
    },
  };
}

module.exports = { makeJevTransport, DEFAULT_CATALOG_TIMEOUT_MS };
