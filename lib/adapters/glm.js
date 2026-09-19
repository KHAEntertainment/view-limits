'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, coerceReset, num } = require('../normalize');

// GET /api/monitor/usage/quota/limit → { data: { limits: [{type,unit,percentage,nextResetTime}] } }
// `percentage` is consumed (0–100).
async function fetchStatus(cfg, token, ctx = {}) {
  const j = await httpJson(`${cfg.baseUrl}/api/monitor/usage/quota/limit`, token);
  const limits = (j.data && j.data.limits) || [];

  if (!limits.length) {
    return { state: 'unknown', windows: [], balance: null, resetAt: null, detail: { limits } };
  }

  const windows = [];
  let exhausted = false;
  for (const row of limits) {
    const pct = num(row.percentage ?? row.currentValue ?? row.usage);
    if (Number.isFinite(pct)) {
      const remaining = Math.max(0, 100 - pct);
      windows.push(window(String(row.type || row.unit || 'quota'), remaining, 100,
        coerceReset(row.nextResetTime)));
      if (pct >= 100) exhausted = true;
    }
  }

  const constrained = !exhausted && isConstrained(windows, ctx.threshold);
  return buildStatus({ exhausted, constrained, windows, detail: { limits } });
}

module.exports = { fetchStatus };
