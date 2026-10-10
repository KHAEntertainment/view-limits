'use strict';
// Xiaomi console adapter — NormalizedStatus from the two fixed console JSON
// endpoints. Knows nothing about Chrome, Keychain, or SSO: it receives the
// pre-built cookie headers for each endpoint and performs at most one
// usage/detail pair.
//
// API: fetchStatus(cfg, credential, ctx) — `credential` is
// { usageCookie, detailCookie } (the minimal usage pair and the full detail
// bundle). `ctx.transport` / `ctx.consoleGet` are dependency seams.
//
// Mapping rules (per the adapter design):
//  * code-0 usage + code-0 detail with a valid plan_total_token item and a
//    recognized detail shape → ONE 'tokens' window (remaining = limit − used)
//    while state stays `unknown` because compensation/state semantics are
//    unresolved. No error field: the counts are current and valid.
//  * explicit detail `expired: true` → `unknown`, NO windows (never
//    exhaustion), never a guessed tier/status.
//  * unrecognized shapes → `unknown`, NO windows, classified error string.
//  * HTTP 401 (or code 401) → throws XiaomiFetchError('auth'); transport and
//    envelope failures throw XiaomiFetchError('transport', <enum code>).
//    Error messages are fixed enum codes only — never provider bodies,
//    headers, cookies, or transport error text.
//  * no resetAt guesses, no compensation windows, no monthUsage promotion.

const { consoleGet } = require('../cookies/http-get');
const { buildStatus, window } = require('../normalize');

const RECOGNIZED_ERROR = 'console response unrecognized';

class XiaomiFetchError extends Error {
  constructor(kind, code) {
    super(code); // fixed enum code — never provider data
    this.kind = kind; // 'auth' | 'transport'
    this.code = code;
  }
}

const authFailure = () => new XiaomiFetchError('auth', 'auth');
const transportFailure = (code) => new XiaomiFetchError('transport', code);

// One endpoint request. Throws XiaomiFetchError; returns the parsed body.
async function request(get, kind, cookieHeader, options) {
  let res;
  try {
    res = await get(kind, cookieHeader, options);
  } catch (e) {
    if (e && typeof e.code === 'string' && e.code.length) throw transportFailure(e.code);
    throw transportFailure('console-request-failed');
  }
  if (!res || typeof res !== 'object') throw transportFailure('console-request-failed');
  if (res.outcome === 'auth') throw authFailure();
  if (res.outcome === 'http-error') throw transportFailure('console-http-error');
  if (res.outcome === 'redirect') throw transportFailure('console-redirect-stopped');
  if (res.outcome !== 'json' || !res.body || typeof res.body !== 'object') {
    throw transportFailure('console-response-not-json');
  }
  return res.body;
}

// Envelope evaluation. code 401 → auth (HTTP-200 auth envelopes included).
// `code0` means the server accepted the request (code 0, success !== false);
// data-shape problems are handled downstream as shape failures, not transport
// failures. The numeric code is used for classification only — never emitted.
function envelope(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { code0: false, auth: false, data: null };
  }
  const raw = body.code;
  let code = null;
  if (typeof raw === 'number' && Number.isInteger(raw)) code = raw;
  else if (typeof raw === 'string' && /^-?\d{1,6}$/.test(raw)) code = Number(raw);
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
    ? body.data : null;
  return {
    code0: body.success !== false && code === 0,
    auth: code === 401,
    data,
  };
}

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

// The single verified plan window: plan_total_token used/limit → tokens
// remaining. Returns null when the shape/values are not valid counts.
function planWindow(usageData) {
  if (!usageData || typeof usageData !== 'object') return null;
  const usage = usageData.usage;
  if (!usage || typeof usage !== 'object' || !Array.isArray(usage.items)) return null;
  const plan = usage.items.find((item) =>
    item && typeof item === 'object' && !Array.isArray(item) && item.name === 'plan_total_token');
  if (!plan) return null;
  if (!isCount(plan.used) || !isCount(plan.limit)) return null;
  if (plan.limit <= 0 || plan.used > plan.limit) return null;
  return window('tokens', plan.limit - plan.used, plan.limit, null);
}

// Detail must carry the verified fields before any plan evidence displays.
function detailRecognized(data) {
  return !!data && typeof data.currentPeriodEnd === 'string' && typeof data.expired === 'boolean';
}

async function fetchStatus(cfg, credential, ctx = {}) {
  const cred = credential && typeof credential === 'object' ? credential : {};
  const usageCookie = typeof cred.usageCookie === 'string' ? cred.usageCookie : '';
  const detailCookie = typeof cred.detailCookie === 'string' ? cred.detailCookie : '';
  const get = typeof ctx.consoleGet === 'function' ? ctx.consoleGet : consoleGet;
  const options = ctx.transport ? { transport: ctx.transport } : {};

  const usageBody = await request(get, 'usage', usageCookie, options);
  const usageEnv = envelope(usageBody);
  if (usageEnv.auth) throw authFailure(); // stops BEFORE detail
  if (!usageEnv.code0) throw transportFailure('console-envelope-error');

  const detailBody = await request(get, 'detail', detailCookie, options);
  const detailEnv = envelope(detailBody);
  if (detailEnv.auth) throw authFailure();
  if (!detailEnv.code0) throw transportFailure('console-envelope-error');

  const detailData = detailEnv.data;
  if (detailData && detailData.expired === true) {
    return buildStatus({ unknown: true, windows: [], detail: { expired: true } });
  }
  const plan = planWindow(usageEnv.data);
  if (!plan || !detailRecognized(detailData)) {
    return buildStatus({ unknown: true, windows: [], detail: { error: RECOGNIZED_ERROR } });
  }
  const statusDetail = { expired: detailData.expired };
  return buildStatus({ unknown: true, windows: [plan], detail: statusDetail });
}

module.exports = { fetchStatus, XiaomiFetchError };
