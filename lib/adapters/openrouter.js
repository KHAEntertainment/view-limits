'use strict';
const { httpJson } = require('./http');
const { buildStatus, num } = require('../normalize');

// OpenRouter: the account balance is total_credits − total_usage (from
// /api/v1/credits); spent today/this week are usage_daily/usage_weekly (from
// /api/v1/key). The key endpoint's limit/limit_remaining is a spending *cap*,
// not the balance, and is kept as separate limit metadata.
async function fetchStatus(cfg, token, ctx = {}) {
  let credits = null;
  let key = null;
  let creditsError = null;
  let keyError = null;

  const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const payload = (body) => {
    if (!record(body)) return null;
    return record(body.data) ? body.data : body;
  };

  try {
    const cb = await httpJson(`${cfg.baseUrl}/v1/credits`, token);
    credits = payload(cb);
  } catch (e) {
    creditsError = e.message;
  }

  try {
    const kb = await httpJson(`${cfg.baseUrl}/v1/key`, token);
    key = payload(kb);
  } catch (e) {
    keyError = e.message;
  }

  const totalCredits = credits ? num(credits.total_credits) : NaN;
  const totalUsage = credits ? num(credits.total_usage) : NaN;
  const hasBalance = Number.isFinite(totalCredits) && Number.isFinite(totalUsage);
  // Supplemental `detail.usage` is consumption evidence, not capacity. Its
  // self-contained currency lets the report preserve known spend when no
  // balance can be derived without promoting spend into route availability.
  const usage = {};
  if (key && Number.isFinite(num(key.usage_daily))) usage.daily = num(key.usage_daily);
  if (key && Number.isFinite(num(key.usage_weekly))) usage.weekly = num(key.usage_weekly);
  if (key && Number.isFinite(num(key.usage_monthly))) usage.monthly = num(key.usage_monthly);

  let balance = null;
  if (hasBalance) {
    balance = {
      currency: 'USD',
      available: totalCredits - totalUsage,
      // Spending cap, notated only when one is actually set on the key.
      limit: key && Number.isFinite(num(key.limit))
        ? {
            amount: num(key.limit),
            reset: typeof key.limit_reset === 'string' && key.limit_reset.trim()
              ? key.limit_reset.trim() : null,
          }
        : null,
    };
    if ('daily' in usage || 'weekly' in usage) {
      balance.spent = {};
      if ('daily' in usage) balance.spent.daily = usage.daily;
      if ('weekly' in usage) balance.spent.weekly = usage.weekly;
    }
  }

  const exhausted = balance != null && balance.available <= 0;

  return buildStatus({
    exhausted,
    unknown: balance == null,
    balance,
    detail: {
      total_credits: Number.isFinite(totalCredits) ? totalCredits : undefined,
      total_usage: Number.isFinite(totalUsage) ? totalUsage : undefined,
      usage: Object.keys(usage).length ? { currency: 'USD', ...usage } : undefined,
      is_free_tier: key && typeof key.is_free_tier === 'boolean' ? key.is_free_tier : undefined,
      error: keyError || undefined,
      errors: creditsError || keyError
        ? { credits: creditsError || undefined, key: keyError || undefined }
        : undefined,
    },
  });
}

module.exports = { fetchStatus };
