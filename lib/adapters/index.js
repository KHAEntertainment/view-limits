'use strict';
// Adapter registry. Each adapter exports fetchStatus(cfg, token, ctx) → NormalizedStatus.
// Provider-specific response parsing terminates here; nothing downstream re-reads
// raw provider fields.

const minimax = require('./minimax');
const kimi = require('./kimi');
const glm = require('./glm');
const deepseek = require('./deepseek');
const openrouter = require('./openrouter');
// Xiaomi's live path is orchestrated by lib/xiaomi-session.js (one Chrome
// read + one usage/detail pair per operation); the adapter itself stays
// Chrome-agnostic and is registered here so `getAdapter('xiaomi')` resolves.
const xiaomi = require('./xiaomi');

const ADAPTERS = { minimax, kimi, glm, deepseek, openrouter, xiaomi };

function getAdapter(provider) {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`unknown provider: ${provider}`);
  return a;
}

module.exports = { ADAPTERS, getAdapter };
