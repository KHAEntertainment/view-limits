'use strict';
// Bounded, allowlisted HTTPS GET for the two Xiaomi console JSON endpoints.
//
// Contract:
//  * Only the two exact URLs below may ever be requested: HTTPS, standard
//    port, no userinfo, no query, no fragment. Anything else throws
//    `url-not-allowlisted` before any transport runs.
//  * GET only with `redirect: 'manual'` — a 3xx is stopped and classified;
//    redirects are never followed and cookies are never forwarded elsewhere.
//  * No Authorization header is ever sent; only `Accept` and the supplied
//    `Cookie` header.
//  * One AbortController timer covers the request AND the body read; the
//    body is streamed under a hard byte cap.
//  * Every failure is a classified enum code (a CookieTransportError code or
//    a returned `outcome` string). Response bodies, headers, cookie values
//    and transport error messages are never copied into an error message or
//    any returned field — provider responses may echo credentials as strings,
//    property names, or numbers, and none of them may escape here.
//
// Returned outcomes: 'json' | 'auth' | 'http-error' | 'not-json'.
// Thrown codes: url-not-allowlisted | cookie-header-invalid |
// console-request-failed | console-request-timeout | response-too-large |
// console-redirect-stopped.

const HOST = 'platform.xiaomimimo.com';
const USAGE_URL = `https://${HOST}/api/v1/tokenPlan/usage`;
const DETAIL_URL = `https://${HOST}/api/v1/tokenPlan/detail`;
const URLS = Object.freeze({ usage: USAGE_URL, detail: DETAIL_URL });
const DASHBOARD_URL = `https://${HOST}/`;

const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;

class CookieTransportError extends Error {
  constructor(code) {
    super(code); // the enum code IS the whole message — never provider data
    this.code = code;
  }
}

// Exact-URL allowlist. Accepts a known kind ('usage' | 'detail') or a full
// URL string; validates scheme/host/port/userinfo/query/fragment before it
// can reach a transport.
function resolveKind(kind) {
  const url = URLS[kind];
  if (!url) throw new CookieTransportError('url-not-allowlisted');
  assertAllowedUrl(url);
  return url;
}

function fixedUrl(input) {
  if (typeof input !== 'string' || !Object.values(URLS).includes(input)) {
    throw new CookieTransportError('url-not-allowlisted');
  }
  assertAllowedUrl(input);
  return input;
}

function assertAllowedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CookieTransportError('url-not-allowlisted');
  }
  const ok = parsed.protocol === 'https:' &&
    parsed.hostname === HOST &&
    parsed.port === '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.search === '' &&
    parsed.hash === '';
  if (!ok || parsed.toString() !== url) throw new CookieTransportError('url-not-allowlisted');
}

async function discardBody(res) {
  try {
    if (res && res.body && typeof res.body.cancel === 'function') await res.body.cancel();
    return;
  } catch { /* fall through */ }
  try {
    if (res && typeof res.text === 'function') await res.text();
  } catch { /* best effort — body is never inspected */ }
}

// Stream the body with a hard byte cap. Returns a string; never logs content.
//
// Wipe scope (F5): every Buffer we touch is overwritten — incoming stream
// chunks after they are consumed (success, read error, cap exit, timeout),
// our owned copies, and the final join buffer once the string is built.
// Strings handed to us by a non-streaming transport (and the immutable
// result string itself) cannot be wiped; that is the documented best-effort
// limit of JavaScript.
async function readBounded(res, maxBytes) {
  const body = res && res.body;
  const reader = body && typeof body.getReader === 'function' ? body.getReader() : null;
  if (!reader) {
    const text = res && typeof res.text === 'function' ? await res.text() : '';
    const value = typeof text === 'string' ? text : '';
    if (value.length > maxBytes) throw new CookieTransportError('response-too-large');
    return value;
  }
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      const value = read.value;
      try {
        const length = value && typeof value.byteLength === 'number' ? value.byteLength : 0;
        size += length;
        if (size > maxBytes) {
          try { await reader.cancel(); } catch { /* already closed */ }
          throw new CookieTransportError('response-too-large');
        }
        if (length) chunks.push(Buffer.from(value)); // owned copy of the chunk
      } finally {
        // A provider may echo credentials into a chunk; wipe the consumed
        // input itself, not just our copy.
        if (value && typeof value.fill === 'function') {
          try { value.fill(0); } catch { /* detached view */ }
        }
      }
    }
    const joined = Buffer.concat(chunks);
    try {
      return joined.toString('utf8');
    } finally {
      joined.fill(0); // the join buffer is an owned allocation too
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0); // consumed copies are wiped
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Perform one bounded console GET.
 *
 * @param {'usage'|'detail'} kind endpoint selector (allowlisted).
 * @param {string} cookieHeader Cookie header value (required, nonempty).
 * @param {object} [options] { transport, timeoutMs, maxBytes }.
 * @returns {Promise<{outcome:'json'|'auth'|'http-error'|'not-json', httpStatus:number, body:object|null}>}
 * @throws {CookieTransportError} classified enum code only.
 */
async function consoleGet(kind, cookieHeader, options = {}) {
  const url = resolveKind(kind);
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    throw new CookieTransportError('cookie-header-invalid');
  }
  const transport = typeof options.transport === 'function'
    ? options.transport
    : typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
  if (!transport) throw new CookieTransportError('console-request-failed');
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs : TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes : MAX_BYTES;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(); } catch { /* already aborted */ }
  }, timeoutMs);
  const fail = (code) => new CookieTransportError(timedOut ? 'console-request-timeout' : code);

  try {
    let res;
    try {
      res = await transport(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { Accept: 'application/json', Cookie: cookieHeader },
        signal: controller.signal,
      });
    } catch {
      throw fail('console-request-failed');
    }
    if (!res || typeof res.status !== 'number') throw fail('console-request-failed');
    if (res.status >= 300 && res.status < 400) {
      await discardBody(res);
      throw fail('console-redirect-stopped'); // never followed
    }
    if (res.status === 401) {
      await discardBody(res);
      return { outcome: 'auth', httpStatus: 401, body: null };
    }
    let text;
    try {
      text = await readBounded(res, maxBytes);
    } catch (e) {
      if (e instanceof CookieTransportError) throw fail(e.code);
      throw fail('console-request-failed');
    }
    if (res.status !== 200) return { outcome: 'http-error', httpStatus: res.status, body: null };
    let body = null;
    try {
      body = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { outcome: 'not-json', httpStatus: 200, body: null };
    }
    return { outcome: 'json', httpStatus: 200, body };
  } finally {
    clearTimeout(timer);
    try { controller.abort(); } catch { /* already aborted */ }
  }
}

module.exports = {
  HOST, URLS, USAGE_URL, DETAIL_URL, DASHBOARD_URL,
  TIMEOUT_MS, MAX_BYTES,
  CookieTransportError, resolveKind, fixedUrl, consoleGet,
};
