'use strict';
// Non-secret configuration: routes, provider endpoints, freshness TTLs, gate
// thresholds, and the native-file import map. Secrets live in lib/vault.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function dataDir() {
  // ${CLAUDE_PLUGIN_DATA} is exported to hook processes by Claude Code.
  if (process.env.CLAUDE_PLUGIN_DATA) return process.env.CLAUDE_PLUGIN_DATA;
  // Standalone fallback (local testing outside a hook).
  return path.join(os.homedir(), '.view-limits');
}

// The routes this plugin SHIPS. They are offered for setup and are what
// `remove` protects from deletion, but they are deliberately NOT present in a
// fresh config: config.json is assembled by setup and pruned by remove, so a
// fresh install shows no provider rows at all. Materializing one is what
// storing its credential does (bin/vl.js), which keeps "configured" and "has a
// credential" from drifting apart — the state that produced rows for providers
// the user never set up.
//
// `id` is the stable identity the cache is keyed on; `provider` selects the
// adapter; `match.model`/`match.harness` are OR'd resolution hints (either may
// trigger, longest model match wins).
// Frozen all the way down: the catalog is exported, and builtInRoute() copies
// from it, so a shallow freeze would let a holder of the export change what
// setup and the migration write (Issue #81). Callers get copies, never rows.
const BUILT_IN_ROUTES = deepFreeze([
  { id: 'minimax-token-plan', provider: 'minimax', account: 'token-plan', match: { model: 'minimax' }, ttlSeconds: 180 },
  { id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 },
  { id: 'glm-coding-plan', provider: 'glm', account: 'coding-plan', match: { model: 'glm' }, ttlSeconds: 180 },
  { id: 'deepseek-direct', provider: 'deepseek', account: 'personal', match: { model: 'deepseek' }, ttlSeconds: 120 },
  { id: 'openrouter-main', provider: 'openrouter', account: 'main', match: { model: 'openrouter', harness: 'openrouter' }, ttlSeconds: 120 },
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// A fresh copy of one shipped route, or null when `id` is not one. Callers get
// their own object: the catalog is the source of truth and is never handed out
// by reference.
function builtInRoute(id) {
  const found = BUILT_IN_ROUTES.find((r) => r.id === id);
  return found ? JSON.parse(JSON.stringify(found)) : null;
}

const DEFAULTS = {
  // Empty by default — see BUILT_IN_ROUTES above. A row exists because setup
  // put it there, never because the plugin assumed it.
  routes: [],

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
    mode: 'off',               // opt in to 'advisory' or 'deny'; Traycer Model Routing owns failover
    injectContext: false,      // allow-path context is separately opt-in
    constrainedThreshold: 0.2, // a window below 20% remaining marks a route constrained
    refreshLockSeconds: 60,    // gate-only throttle: don't spawn another detached refresh within this window
  },

  refreshOnSessionStart: false,

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
  let merged = cfg;
  try {
    const user = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (isPlainObject(user)) merged = deepMerge(cfg, user);
  } catch { /* missing/unreadable/malformed config uses the non-intrusive defaults */ }
  if (!isPlainObject(merged.gate)) merged.gate = { ...DEFAULTS.gate };
  if (!['off', 'advisory', 'deny'].includes(merged.gate.mode)) merged.gate.mode = 'off';
  merged.gate.injectContext = merged.gate.injectContext === true;
  merged.refreshOnSessionStart = merged.refreshOnSessionStart === true;
  return merged;
}

// Publish config.json atomically: write a unique per-writer temp file in the
// same directory, then rename onto the target. `writeFileSync` on the real
// path truncates first, so a failure after truncation (ENOSPC, EIO, a killed
// process) would leave an empty or partial document — and since a malformed
// config silently falls back to DEFAULTS on the next read, that silently
// discards every route and setting the user had. The temp+rename form cannot
// do that: a pre-rename failure leaves the previous document untouched, and a
// reader during the rename sees complete old or complete new JSON.
//
// Same discipline as the status cache in lib/cache.js (writeCache).
//
// CREATING config.json is reserved for the one-time vault→routes migration
// (Issue #81). An absent config.json means that migration has not resolved —
// a migration that resolves writes this file, which is what disarms it — so any
// other publisher that created the file would disarm it with the stored
// credentials never migrated. The guard sits on the write itself rather than
// on a list of commands, so every current and future caller is covered by
// construction. Only a caller holding FIRST_PUBLISH may create the file; it
// fails closed when presence cannot be established.
const FIRST_PUBLISH = Object.freeze({ capability: 'view-limits first config publish' });

function saveConfig(cfg, opts = {}) {
  const dir = dataDir();
  const target = configPath();
  if (!(opts && opts.capability === FIRST_PUBLISH) && !fs.existsSync(target)) {
    const e = new Error('config.json does not exist yet; only the one-time route migration may create it.');
    e.code = 'CONFIG_MIGRATION_PENDING';
    throw e;
  }
  fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(cfg, null, 2) + '\n';
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* temp may already be gone */ }
    throw e;
  }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

module.exports = {
  dataDir, DEFAULTS, BUILT_IN_ROUTES, builtInRoute,
  loadConfig, saveConfig, configPath, deepMerge, expandHome, FIRST_PUBLISH,
};
