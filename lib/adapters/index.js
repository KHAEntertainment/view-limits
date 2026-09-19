'use strict';
// Adapter registry. Each adapter exports fetchStatus(cfg, token, ctx) → NormalizedStatus.
// Provider-specific response parsing terminates here; nothing downstream re-reads
// raw provider fields.

const minimax = require('./minimax');
const kimi = require('./kimi');
const glm = require('./glm');
const deepseek = require('./deepseek');
const openrouter = require('./openrouter');

const ADAPTERS = { minimax, kimi, glm, deepseek, openrouter };

function getAdapter(provider) {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`unknown provider: ${provider}`);
  return a;
}

module.exports = { ADAPTERS, getAdapter };
