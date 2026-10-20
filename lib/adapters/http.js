'use strict';
// Minimal fetch helper for provider endpoints. No dependency on Claude APIs.

const { httpsEndpointError } = require('../monitor-schema');

const TIMEOUT_MS = 8000;

async function httpJson(url, token, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---- bounded transport for custom (route.monitor) sources ------------------
//
// Unlike httpJson, boundedGet never throws and never surfaces provider text:
// the caller gets a fixed error code, the HTTP status, and only allowlisted
// rate-limit headers. It refuses non-https URLs and redirects, caps the
// response body, and bounds the whole exchange (headers + body) by one
// timeout. Auth headers are built by the caller's fixed family code; this
// function adds none of its own, so an Anthropic-family request can never
// pick up a Bearer token here.
//
// GET only: routine refresh/check reads are read-only by construction.

const MAX_BODY_BYTES = 64 * 1024;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;
const MAX_HEADER_VALUE = 128;
const RETAINED_HEADER_RE = /^(x-ratelimit-|anthropic-ratelimit-|retry-after$)/;

function retainedHeaders(res) {
  const out = {};
  res.headers.forEach((value, name) => {
    const n = name.toLowerCase();
    if (!RETAINED_HEADER_RE.test(n)) return;
    if (typeof value !== 'string' || value.length > MAX_HEADER_VALUE) return;
    out[n] = value;
  });
  return out;
}

function clampTimeout(ms) {
  if (!Number.isFinite(ms)) return TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(ms)));
}

function isTimeout(e) {
  return e && (e.name === 'TimeoutError' || e.name === 'AbortError');
}

// Read at most `max` bytes; `null` means the body exceeded the cap.
async function readCapped(res, max) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    return null;
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function failure(error, status = null, headers = {}) {
  return { ok: false, status, headers, json: null, error };
}

// GET `url` with the given request headers.
//   → { ok, status, headers, json, error }
// `error` is one of: insecure-url, timeout, network-error, redirect-refused,
// auth-rejected, http-429, http-<status>, body-too-large, or null. `json` is
// the parsed 2xx body, or null when empty / not JSON (a header-only source
// does not need one).
async function boundedGet(url, { headers = {}, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BODY_BYTES } = {}) {
  if (httpsEndpointError(url)) return failure('insecure-url');
  const signal = AbortSignal.timeout(clampTimeout(timeoutMs));
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers, redirect: 'manual', signal });
  } catch (e) {
    return failure(isTimeout(e) ? 'timeout' : 'network-error');
  }
  const status = res.status;
  const kept = retainedHeaders(res);
  if (status < 200 || status >= 300) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    // A redirect is never followed: the next hop could be another host that
    // would receive the credential headers.
    if (status >= 300 && status < 400) return failure('redirect-refused', status);
    if (status === 401 || status === 403) return failure('auth-rejected', status);
    return failure(`http-${status}`, status, kept);
  }
  let buf;
  try {
    buf = await readCapped(res, maxBytes);
  } catch (e) {
    return failure(isTimeout(e) ? 'timeout' : 'network-error', status);
  }
  if (buf === null) return failure('body-too-large', status);
  let json = null;
  if (buf.length) {
    try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
  }
  return { ok: true, status, headers: kept, json, error: null };
}

module.exports = { httpJson, boundedGet, TIMEOUT_MS, MAX_BODY_BYTES };
