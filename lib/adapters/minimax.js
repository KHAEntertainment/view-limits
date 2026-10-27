'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, coerceReset, num } = require('../normalize');

// Issue #139 — a completed `/v1/token_plan/remains` response that carries no
// USABLE per-model percent is a real answer, not a missing one. Both observed
// shapes — an empty `model_remains` and entries whose percent fields are
// absent or non-numeric — get ONE fixed reason code (owner ruling Q31-A:
// "empty/unusable" is one reason, not two). Nothing about that shape is
// proven to mean "quota used up" (it may equally mean no plan or a lapsed
// one), so the state stays `unknown` and the gate stays FAIL-OPEN. The raw
// entries stay in `detail` for diagnosis.
const QUOTA_LIST_EMPTY = 'quota-list-empty';

// GET /v1/token_plan/remains (verified live) →
//   { model_remains: [ { model_name, current_interval_remaining_percent,
//       current_weekly_remaining_percent, end_time, weekly_end_time, … } ],
//     base_resp: { status_code, status_msg } }
// The real signal is the per-model *_remaining_percent (0–100). The "general"
// entry is the coding/text model; the *_usage_count fields are 0 and unused.
async function fetchStatus(cfg, token, ctx = {}) {
  const body = await httpJson(`${cfg.baseUrl}/v1/token_plan/remains`, token);
  const j = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const entries = Array.isArray(j.model_remains) ? j.model_remains : [];
  const objects = entries.filter((e) => e && typeof e === 'object' && !Array.isArray(e));
  const general = objects.filter((e) => e.model_name === 'general');
  const candidates = general.length ? general : objects;
  const model = candidates.find((e) =>
    Number.isFinite(num(e.current_interval_remaining_percent)) ||
    Number.isFinite(num(e.current_weekly_remaining_percent))) || candidates[0];

  if (!model) {
    return {
      state: 'unknown',
      windows: [],
      balance: null,
      resetAt: null,
      detail: { model_remains: entries, reason: QUOTA_LIST_EMPTY },
    };
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

  const detail = {
    model: model.model_name,
    interval_remaining_percent: Number.isFinite(intervalPct) ? intervalPct : undefined,
    weekly_remaining_percent: Number.isFinite(weeklyPct) ? weeklyPct : undefined,
    models: objects.map((e) => ({
      name: e.model_name,
      interval_pct: e.current_interval_remaining_percent,
      weekly_pct: e.current_weekly_remaining_percent,
    })),
  };
  // A selected model with no usable percent yields no windows: the SAME
  // "unusable list" reason names it, so no completed fetch is ever unknown
  // with nothing to say why. Only the reason is added — state, windows and
  // the weekly-exhaustion rule above are unchanged.
  if (windows.length === 0) detail.reason = QUOTA_LIST_EMPTY;

  return buildStatus({
    exhausted,
    constrained,
    unknown: windows.length === 0,
    windows,
    detail,
  });
}

module.exports = { fetchStatus };
