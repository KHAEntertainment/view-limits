'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, coerceReset, num } = require('../normalize');

// GET /v1/token_plan/remains — undocumented. The *_usage_count fields are the
// REMAINING quota (not consumed) — a known upstream quirk.
async function fetchStatus(cfg, token, ctx = {}) {
  const j = await httpJson(`${cfg.baseUrl}/v1/token_plan/remains`, token);
  const intervalRemaining = num(j.current_interval_usage_count);
  const intervalTotal = num(j.current_interval_total_count);
  const weeklyRemaining = num(j.current_weekly_usage_count);
  const weeklyTotal = num(j.current_weekly_total_count);

  const windows = [];
  if (Number.isFinite(intervalTotal) && intervalTotal > 0) {
    windows.push(window('rolling-5h', intervalRemaining, intervalTotal,
      coerceReset(j.remains_time ?? j.end_time)));
  }
  if (Number.isFinite(weeklyTotal) && weeklyTotal > 0) {
    windows.push(window('weekly', weeklyRemaining, weeklyTotal,
      coerceReset(j.weekly_remains_time ?? j.weeklyEndTime)));
  }

  const exhausted = Number.isFinite(weeklyRemaining) && weeklyRemaining <= 0;
  const constrained = !exhausted && isConstrained(windows, ctx.threshold);

  return buildStatus({
    exhausted,
    constrained,
    windows,
    detail: {
      interval_remaining: intervalRemaining,
      interval_total: intervalTotal,
      weekly_remaining: weeklyRemaining,
      weekly_total: weeklyTotal,
      model_remains: j.model_remains ?? j.modelRemains,
    },
  });
}

module.exports = { fetchStatus };
