'use strict';
const { httpJson } = require('./http');
const { buildStatus, num } = require('../normalize');

// GET /user/balance → { is_available, balance_infos: [{currency,total_balance,...}] }
async function fetchStatus(cfg, token, ctx = {}) {
  const j = await httpJson(`${cfg.baseUrl}/user/balance`, token);
  const infos = j.balance_infos || [];
  const balance = infos.length
    ? { currency: infos[0].currency || 'CNY', available: infos[0].total_balance }
    : null;
  const exhausted = j.is_available === false;
  const constrained = !exhausted && balance != null && num(balance.available) <= 0;
  return buildStatus({
    exhausted,
    constrained,
    balance,
    detail: { is_available: j.is_available, balance_infos: infos },
  });
}

module.exports = { fetchStatus };
