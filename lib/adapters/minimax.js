'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, coerceReset, num } = require('../normalize');

// GET /v1/token_plan/remains (verified live) →
//   { model_remains: [ { model_name, current_interval_remaining_percent,
//       current_weekly_remaining_percent, end_time, weekly_end_time, … } ],
//     base_resp: { status_code, status_msg } }
// The real signal is the per-model *_remaining_percent (0–100). The "general"
// entry is the coding/text model; the *_usage_count fields are 0 and unused.
async function fetchStatus(cfg, token, ctx = {}) {
  const j = await httpJson(`${cfg.baseUrl}/v1/token_plan/remains`, token);
  const entries = Array.isArray(j.model_remains) ? j.model_remains : [];
  const model = entries.find((e) => e && e.model_name === 'general') || entries[0];

  if (!model) {
    return { state: 'unknown', windows: [], balance: null, resetAt: null, detail: { model_remains: entries } };
  }

  const intervalPct = num(model.current_interval_remaining_percent);
  const weeklyPct = num(model.current_weekly_remaining_percent);

  const windows = [];
  if (Number.isFinite(intervalPct)) {
    windows.push(window('rolling-5h', intervalPct, 100, coerceReset(model.end_time)));
  }
  if (Number.isFinite(weeklyPct)) {
    windows.push(window('weekly', weeklyPct, 100, coerceReset(model.weekly_end_time)));
  }

  const exhausted = Number.isFinite(weeklyPct) && weeklyPct <= 0;
  const constrained = !exhausted && isConstrained(windows, ctx.threshold);

  return buildStatus({
    exhausted,
    constrained,
    windows,
    detail: {
      model: model.model_name,
      interval_remaining_percent: intervalPct,
      weekly_remaining_percent: weeklyPct,
      models: entries.map((e) => ({
        name: e.model_name,
        interval_pct: e.current_interval_remaining_percent,
        weekly_pct: e.current_weekly_remaining_percent,
      })),
    },
  });
}

module.exports = { fetchStatus };
