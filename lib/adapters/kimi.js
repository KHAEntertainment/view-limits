'use strict';
const { httpJson } = require('./http');
const { buildStatus, window, isConstrained, coerceReset, num } = require('../normalize');

// GET /coding/v1/usages (Kimi Code / Coding Plan, NOT Moonshot). Bearer sk-kimi-*.
// Canonical: { usage:{limit,used,remaining,resetTime}, limits:[{window,detail:{...}}], user:{...} }
// Alternate: { data: [ {model_name, ...} ] } where model_name === "all" is weekly.
async function fetchStatus(cfg, token, ctx = {}) {
  const j = await httpJson(`${cfg.baseUrl}/coding/v1/usages`, token, { 'User-Agent': 'KimiCLI/1.6' });

  let weekly = null;
  let fiveH = null;
  if (j.usage) weekly = j.usage;
  if (Array.isArray(j.limits) && j.limits.length && j.limits[0] && j.limits[0].detail) {
    fiveH = j.limits[0].detail;
  }
  if (!weekly && Array.isArray(j.data)) {
    const all = j.data.find((d) => d && d.model_name === 'all');
    if (all) weekly = all;
  }

  const windows = [];
  if (fiveH) {
    windows.push(window('rolling-5h', num(fiveH.remaining), num(fiveH.limit), coerceReset(fiveH.resetTime)));
  }
  if (weekly) {
    windows.push(window('weekly', num(weekly.remaining), num(weekly.limit), coerceReset(weekly.resetTime)));
  }

  const exhausted = windows.some((w) => w.limit > 0 && Number.isFinite(w.remaining) && w.remaining <= 0);
  const constrained = !exhausted && isConstrained(windows, ctx.threshold);
  const unparsed = windows.length === 0;

  return buildStatus({
    exhausted,
    constrained,
    windows,
    detail: {
      membership: j.user && j.user.membership && j.user.membership.level,
      parallel: j.parallel && j.parallel.limit,
      raw: unparsed ? j : undefined,
    },
  });
}

module.exports = { fetchStatus };
