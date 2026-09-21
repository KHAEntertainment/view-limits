'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, coerceReset, num } = require('../normalize');

// GET /coding/v1/usages (Kimi Code / Coding Plan, NOT Moonshot). Bearer sk-kimi-*.
// Canonical: { usage:{limit,used,remaining,resetTime}, limits:[{window,detail:{...}}], user:{...} }
// Alternate: { data: [ {model_name, ...} ] } where model_name === "all" is weekly.
async function fetchStatus(cfg, token, ctx = {}) {
  const body = await httpJson(`${cfg.baseUrl}/coding/v1/usages`, token, { 'User-Agent': 'KimiCLI/1.6' });
  const j = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  const parsedWindow = (type, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const remaining = num(value.remaining);
    const limit = num(value.limit);
    if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return null;
    return window(type, remaining, limit, coerceReset(value.resetTime));
  };

  const fiveH = Array.isArray(j.limits)
    ? j.limits.map((row) => parsedWindow('rolling-5h', row && row.detail)).find(Boolean)
    : null;
  let weekly = parsedWindow('weekly', j.usage);
  if (!weekly && Array.isArray(j.data)) {
    weekly = j.data
      .filter((row) => row && typeof row === 'object' && !Array.isArray(row) && row.model_name === 'all')
      .map((row) => parsedWindow('weekly', row))
      .find(Boolean) || null;
  }

  const windows = [];
  if (fiveH) windows.push(fiveH);
  if (weekly) windows.push(weekly);

  const exhausted = windows.some((w) => w.limit > 0 && Number.isFinite(w.remaining) && w.remaining <= 0);
  const constrained = !exhausted && isConstrained(windows, ctx.threshold);
  const unparsed = windows.length === 0;

  return buildStatus({
    exhausted,
    constrained,
    unknown: unparsed,
    windows,
    detail: {
      membership: j.user && j.user.membership && j.user.membership.level,
      parallel: j.parallel && j.parallel.limit,
      raw: unparsed ? j : undefined,
    },
  });
}

module.exports = { fetchStatus };
