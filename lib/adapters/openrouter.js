'use strict';
const { httpJson } = require('./http');
const { buildStatus, num } = require('../normalize');

// OpenRouter: the account balance is total_credits − total_usage (from
// /api/v1/credits); spent today/this week are usage_daily/usage_weekly (from
// /api/v1/key). The key endpoint's limit/limit_remaining is a spending *cap*,
// not the balance — intentionally not surfaced.
async function fetchStatus(cfg, token, ctx = {}) {
  let credits = null;
  let key = null;

  try {
    const cb = await httpJson(`${cfg.baseUrl}/v1/credits`, token);
    credits = (cb && cb.data) || cb;
  } catch { /* credits may require a management key; still report usage */ }

  try {
    const kb = await httpJson(`${cfg.baseUrl}/v1/key`, token);
    key = (kb && kb.data) || kb;
  } catch (e) {
    return { state: 'unknown', windows: [], balance: null, resetAt: null, detail: { error: e.message } };
  }

  let balance = null;
  if (credits && Number.isFinite(num(credits.total_credits)) && Number.isFinite(num(credits.total_usage))) {
    balance = {
      currency: 'USD',
      available: (num(credits.total_credits) - num(credits.total_usage)).toFixed(2),
      spent: {
        daily: num(key.usage_daily) || 0,
        weekly: num(key.usage_weekly) || 0,
      },
      // Spending cap, notated only when one is actually set on the key.
      limit: key.limit != null ? { amount: key.limit, reset: key.limit_reset } : null,
    };
  }

  const exhausted = balance != null && num(balance.available) <= 0;

  return buildStatus({
    exhausted,
    balance,
    detail: {
      total_credits: credits ? credits.total_credits : undefined,
      total_usage: credits ? credits.total_usage : undefined,
      usage_monthly: key.usage_monthly,
      is_free_tier: key.is_free_tier,
    },
  });
}

module.exports = { fetchStatus };
