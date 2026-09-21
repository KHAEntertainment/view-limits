'use strict';
const { httpJson } = require('./http');
const { buildStatus, num } = require('../normalize');

// GET /user/balance → { is_available, balance_infos: [{currency,total_balance,...}] }
async function fetchStatus(cfg, token, ctx = {}) {
  const body = await httpJson(`${cfg.baseUrl}/user/balance`, token);
  const j = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
  const info = infos.find((row) => row && typeof row === 'object' && !Array.isArray(row) &&
    Number.isFinite(num(row.total_balance)));
  const balance = info
    ? {
        currency: typeof info.currency === 'string' && info.currency.trim() ? info.currency.trim() : null,
        available: info.total_balance,
      }
    : null;
  const availabilityKnown = typeof j.is_available === 'boolean';
  const exhausted = j.is_available === false;
  const constrained = j.is_available === true && balance != null && num(balance.available) <= 0;
  return buildStatus({
    exhausted,
    constrained,
    unknown: !availabilityKnown,
    balance,
    detail: { is_available: j.is_available, balance_infos: infos },
  });
}

module.exports = { fetchStatus };
