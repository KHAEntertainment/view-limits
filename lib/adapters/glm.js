'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, coerceReset, num } = require('../normalize');

// GET /api/monitor/usage/quota/limit → { data: { limits: [{type,unit,percentage,nextResetTime}] } }
// `percentage` is consumed (0–100). The limits[] shape is still fixture-only.
//
// Failures arrive as HTTP 200 with { code, msg, success: false } (verified
// live 2026-10-03). Codes 1000 (bad key) and 1001 (no Authorization header)
// are auth failures and throw with status 401, like an HTTP 401 from httpJson;
// any other code (e.g. 500 "no coding plan" for a lapsed plan) throws with the
// provider's code and message so /view-limits can say why the route is unknown.
const AUTH_CODES = new Set([1000, 1001]);
const KNOWN_MESSAGES = {
  '当前用户不存在coding plan': 'no active coding plan on this account',
};

function envelopeError(j) {
  const code = num(j.code);
  const raw = typeof j.msg === 'string' ? j.msg.trim() : '';
  const msg = KNOWN_MESSAGES[raw] || raw || 'no message';
  const label = Number.isFinite(code) ? `code ${code}` : 'no code';
  if (AUTH_CODES.has(code)) {
    const err = new Error(`Z.ai auth failed (${label}: ${msg})`);
    err.status = 401;
    return err;
  }
  return new Error(`Z.ai ${label}: ${msg}`);
}

async function fetchStatus(cfg, token, ctx = {}) {
  const body = await httpJson(`${cfg.baseUrl}/api/monitor/usage/quota/limit`, token);
  const j = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (j.success === false) throw envelopeError(j);
  const limits = j.data && typeof j.data === 'object' && !Array.isArray(j.data) &&
    Array.isArray(j.data.limits) ? j.data.limits : [];

  if (!limits.length) {
    return { state: 'unknown', windows: [], balance: null, resetAt: null, detail: { limits } };
  }

  const windows = [];
  let exhausted = false;
  for (const row of limits) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const pct = num(row.percentage ?? row.currentValue ?? row.usage);
    if (Number.isFinite(pct)) {
      const remaining = Math.max(0, 100 - pct);
      windows.push(window(String(row.type || row.unit || 'quota'), remaining, 100,
        coerceReset(row.nextResetTime)));
      if (pct >= 100) exhausted = true;
    }
  }

  const constrained = !exhausted && isConstrained(windows, ctx.threshold);
  return buildStatus({ exhausted, constrained, unknown: windows.length === 0, windows, detail: { limits } });
}

module.exports = { fetchStatus };
