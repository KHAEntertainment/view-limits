'use strict';
// Non-secret configuration: routes, provider endpoints, freshness TTLs, gate
// thresholds, and the native-file import map. Secrets live in lib/vault.js.

const fs = require('fs');
const path = require('path');
const os = require('os');

function dataDir() {
  // ${CLAUDE_PLUGIN_DATA} is exported to hook processes by Claude Code.
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  // Standalone fallback (local testing outside a hook).
  return path.join(os.homedir(), '.view-limits');
}

const DEFAULTS = {
  // One route per quota/account pool. `id` is the stable identity the cache is
  // keyed on; `provider` selects the adapter; `match.model`/`match.harness` are
  // OR'd resolution hints (either may trigger, longest model match wins).
  routes: [
    { id: 'minimax-token-plan', provider: 'minimax', account: 'token-plan', match: { model: 'minimax' }, ttlSeconds: 180 },
    { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 },
    { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 180 },
    { id: 'deepseek-direct', provider: 'deepseek', account: 'personal', match: { model: 'deepseek' }, ttlSeconds: 120 },
    { id: 'openrouter-main', provider: 'openrouter', account: 'main', match: { model: 'openrouter', harness: 'openrouter' }, ttlSeconds: 120 },
  ],

  providers: {
    minimax:    { baseUrl: 'https://www.minimax.io' },
    kimi:       { baseUrl: 'https://api.kimi.com' },
    glm:        { baseUrl: 'https://api.z.ai' },
    deepseek:   { baseUrl: 'https://api.deepseek.com' },
    openrouter: { baseUrl: 'https://openrouter.ai/api' },
  },

  vault: {
    // 'keychain' = macOS Keychain via `security` (generic password, no biometric).
    // 'file' = AES-256-GCM encrypted blobs keyed by VIEW_LIMITS_MASTER_KEY.
    backend: process.platform === 'darwin' ? 'keychain' : 'file',
    service: 'com.kha.view-limits',
  },

  gate: {
    constrainedThreshold: 0.2, // a window below 20% remaining marks a route constrained
    refreshLockSeconds: 60,    // gate-only throttle: don't spawn another detached refresh within this window
  },

  // Native config files the setup audit can auto-import (one-time; never read at
  // refresh time). Field is a dot-path into the JSON.
  importMap: {
    'minimax-token-plan': { file: '~/.mmx/config.json', field: 'api_key' },
  },
};

function configPath() {
  return path.join(dataDir(), 'config.json');
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(override)) return override === undefined ? out : override;
  for (const [k, v] of Object.entries(override)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function loadConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const user = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    return deepMerge(cfg, user);
  } catch {
    return cfg;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = {
  dataDir, DEFAULTS, loadConfig, saveConfig, configPath, deepMerge, expandHome,
};
