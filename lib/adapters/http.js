'use strict';
// Minimal fetch helper for provider endpoints. No dependency on Claude APIs.

const TIMEOUT_MS = 8000;

async function httpJson(url, token, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

module.exports = { httpJson, TIMEOUT_MS };
