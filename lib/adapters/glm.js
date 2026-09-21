'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, coerceReset, num } = require('../normalize');

// GET /api/monitor/usage/quota/limit → { data: { limits: [{type,unit,percentage,nextResetTime}] } }
// `percentage` is consumed (0–100).
async function fetchStatus(cfg, token, ctx = {}) {
  const body = await httpJson(`${cfg.baseUrl}/api/monitor/usage/quota/limit`, token);
  const j = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
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
