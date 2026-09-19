'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, num } = require('../normalize');

// GET /api/v1/key → { limit, limit_remaining, limit_reset, usage, is_free_tier, ... }
async function fetchStatus(cfg, token, ctx = {}) {
  const j = await httpJson(`${cfg.baseUrl}/v1/key`, token);
  const limit = j.limit;
  const windows = [];
  let exhausted = false;
  if (limit != null) {
    const remaining = num(j.limit_remaining);
    exhausted = remaining <= 0;
    windows.push(window('credit', remaining, num(limit), null));
  }
  const constrained = !exhausted && isConstrained(windows, ctx.threshold);
  return buildStatus({
    exhausted,
    constrained,
    windows,
    detail: { usage: j.usage, is_free_tier: j.is_free_tier, limit_reset: j.limit_reset },
  });
}

module.exports = { fetchStatus };
