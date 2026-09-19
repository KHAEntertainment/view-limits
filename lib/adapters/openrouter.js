'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, num } = require('../normalize');

// GET /api/v1/key → { data: { limit, limit_remaining, limit_reset, usage, is_free_tier, ... } }
// OpenRouter wraps responses in a `data` envelope.
async function fetchStatus(cfg, token, ctx = {}) {
  const body = await httpJson(`${cfg.baseUrl}/v1/key`, token);
  const j = body.data || body;
  const limit = j.limit;
  const windows = [];
  let exhausted = false;
  if (limit != null) {
    const remaining = num(j.limit_remaining);
    exhausted = remaining <= 0;
    windows.push(window('credit', remaining, num(limit), null, 'currency'));
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
