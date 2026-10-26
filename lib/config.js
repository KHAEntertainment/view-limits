'use strict';
// Non-secret configuration: routes, provider endpoints, freshness TTLs, gate
// thresholds, and the native-file import map. Secrets live in lib/vault.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
// lib/lock.js requires Node built-ins only, so this is not a cycle.
const lock = require('./lock');

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

// Built-in provider region policy (Issue #113). A built-in route may set
// `monitor.region` to pick a regional host. Each provider has a closed list of
// regions; `default` is used when a route carries no region. Host precedence
// for a built-in route is: explicit route region > a user-set
// `providers.<provider>.baseUrl` override > the default region host. Only the
// region-capable providers (kimi/glm) appear here; the other built-ins have no
// region concept.
const PROVIDER_REGIONS = deepFreeze({
  kimi: {
    default: 'global',
    hosts: {
      global: 'https://api.kimi.ai',
      china: 'https://api.kimi.com',
    },
  },
  glm: {
    default: 'international',
    hosts: {
      international: 'https://api.z.ai',
      china: 'https://open.bigmodel.cn',
    },
  },
});

// The canonical region names for a built-in provider, or null when the provider
// has no region concept.
function regionList(provider) {
  const r = PROVIDER_REGIONS[provider];
  return r ? Object.keys(r.hosts) : null;
}

// The default region for a built-in provider, or null when it has none.
function defaultRegion(provider) {
  const r = PROVIDER_REGIONS[provider];
  return r ? r.default : null;
}

// Canonicalize a route's region for a built-in provider: trim + lowercase, then
// membership in the provider's closed list. Returns the canonical name, or null
// when the value is not a string or not a known region. The same function is
// used by validation and by host resolution, so `" GLOBAL "` and `"China"`
// both canonicalize to `global`/`china`.
function normalizeRegion(provider, region) {
  if (typeof region !== 'string') return null;
  const key = region.trim().toLowerCase();
  const r = PROVIDER_REGIONS[provider];
  if (!r || !Object.prototype.hasOwnProperty.call(r.hosts, key)) return null;
  return key;
}

// The host for a canonical region name, or null when unknown.
function regionHost(provider, region) {
  const r = PROVIDER_REGIONS[provider];
  return r && Object.prototype.hasOwnProperty.call(r.hosts, region) ? r.hosts[region] : null;
}

const DEFAULTS = {
  // Empty by default — see BUILT_IN_ROUTES above. A row exists because setup
  // put it there, never because the plugin assumed it.
  routes: [],

  providers: {
    minimax:    { baseUrl: 'https://www.minimax.io' },
    // Kimi's default is the global host (Q15-B). A config.json baseUrl that
    // differs from this is a user override; a route region overrides both.
    kimi:       { baseUrl: 'https://api.kimi.ai' },
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

// Two variants, chosen at the call site:
//
//   loadConfig        lax: never takes the lock. A document it could not
//                     confirm (see readConfigTextIn) REFUSES by default: it
//                     throws CONFIG_INCONCLUSIVE (PR #82, owner ruling "fix by
//                     default"), so a call site nobody remembered to wire fails
//                     loudly instead of acting on DEFAULTS. Only a caller that
//                     surfaces the mark itself opts in, by naming why —
//                     { display: true } or { sessionWarmup: true } — and gets
//                     DEFAULTS MARKED inconclusive (configInconclusive(cfg)).
//                     The opt-ins are enumerated and pinned by
//                     test/empty-defaults.test.js.
//   loadConfigStrict  for credential paths (lib/vault.js). Proves absence
//                     under the mutation lock and otherwise throws
//                     CONFIG_INCONCLUSIVE: a backend chosen from DEFAULTS while
//                     a publish is in flight is a misrouted credential.
//
// A document that EXISTS but cannot be used is CORRUPT: any read error other
// than ENOENT (EACCES, EIO, EISDIR…), invalid JSON, or JSON that is not an
// object. Neither variant falls back to DEFAULTS for it: loadConfigStrict
// throws CONFIG_CORRUPT, because the backend choice lives in that very
// document, and DEFAULTS' backend would misroute a file-vault user's
// credential to the Keychain. loadConfig refuses with CONFIG_CORRUPT by
// default, and its opt-ins get DEFAULTS MARKED corrupt (configCorrupt(cfg)).
//
// So, for loadConfig: read → neither mark; absent or being replaced →
// inconclusive (a lock-free read cannot tell the two apart); exists but
// unusable → corrupt. The two marks are mutually exclusive. loadConfigStrict
// returns plain DEFAULTS only for an absence it proved under the lock, and
// throws CONFIG_INCONCLUSIVE or CONFIG_CORRUPT otherwise.
const INCONCLUSIVE_MARK = Symbol('view-limits config inconclusive');
const CORRUPT_MARK = Symbol('view-limits config corrupt');

function buildConfig(strict) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  let merged = cfg;
  let inconclusive = false;
  let corrupt = false;
  let raw = null;
  try {
    raw = readConfigText({ strict });
  } catch (e) {
    if (e && e.code === 'CONFIG_INCONCLUSIVE') {
      if (strict) throw e;
      inconclusive = true;
    } else if (!e || e.code !== 'ENOENT') {
      corrupt = true;
    }
  }
  if (raw !== null) {
    let user;
    try {
      user = JSON.parse(raw);
    } catch {
      user = undefined;
    }
    if (isPlainObject(user)) merged = deepMerge(cfg, user);
    else corrupt = true;
  }
  if (corrupt && strict) throw corruptError();
  if (!isPlainObject(merged.gate)) merged.gate = { ...DEFAULTS.gate };
  if (!['off', 'advisory', 'deny'].includes(merged.gate.mode)) merged.gate.mode = 'off';
  merged.gate.injectContext = merged.gate.injectContext === true;
  merged.refreshOnSessionStart = merged.refreshOnSessionStart === true;
  if (inconclusive) Object.defineProperty(merged, INCONCLUSIVE_MARK, { value: true });
  if (corrupt) Object.defineProperty(merged, CORRUPT_MARK, { value: true });
  return merged;
}

function loadConfig(opts) {
  const cfg = buildConfig(false);
  const optedIn = !!opts && (opts.display === true || opts.sessionWarmup === true);
  if (optedIn) return cfg;
  if (configInconclusive(cfg)) throw inconclusiveError();
  if (configCorrupt(cfg)) throw corruptError();
  return cfg;
}

function loadConfigStrict() {
  return buildConfig(true);
}

function configInconclusive(cfg) {
  return !!(cfg && cfg[INCONCLUSIVE_MARK]);
}

function configCorrupt(cfg) {
  return !!(cfg && cfg[CORRUPT_MARK]);
}

// ---- publication ------------------------------------------------------------
//
// config.json is published so that a caller without FIRST_PUBLISH can never
// CREATE it, even if an outside actor deletes it at any moment (Issue #81, R3-1).
// CREATING it is reserved for the one-time vault→routes migration: an absent
// config.json means that migration has not resolved, and any other publisher
// that created the file would disarm it with stored credentials never migrated.
//
// An existence check followed by rename(2) cannot enforce that — rename creates
// the target when it is absent, and Node exposes no replace-only rename
// (renameat2 RENAME_NOREPLACE/EXCHANGE, macOS renamex_np RENAME_SWAP). So:
//
//   first publish (migration only)   write tmp, then link(tmp -> config.json).
//                                    link is create-only: EEXIST means it lost.
//   every other publish              write tmp; rename(config.json -> .prev) —
//                                    the atomic replace-only proof (ENOENT: there
//                                    is nothing to replace, so refuse); then
//                                    link(tmp -> config.json), create-only; then
//                                    drop .prev. Once config.json has been moved
//                                    aside there is nothing left for an outside
//                                    delete to remove, so no interleaving lets
//                                    this publisher create the file from nothing.
//
// Readers see config.json, or .prev while a swap is in flight, so nobody ever
// observes a transient empty config. A crash between the two steps leaves only
// .prev; the next publisher restores it (create-only) and proceeds, so a crash
// never locks the user out. A .prev left NEXT TO config.json is a stale
// leftover and is removed under the lock — it never counts as "present" once
// config.json is gone, or an outside delete would leave it keeping the
// migration disarmed. No fallback to rename-over on a filesystem without hard
// links: that would reopen the window, so it fails closed.
//
// Every publish runs under the provider mutation lock (lib/lock.js
// acquireMutationLock), so the steps are serialized against every in-protocol
// writer, the migration included.
const FIRST_PUBLISH = Object.freeze({ capability: 'view-limits first config publish' });

function prevPath() {
  return `${configPath()}.prev`;
}

function exists(p) {
  try { fs.lstatSync(p); return true; } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
}

// The current document's raw text for a data dir: config.json, or .prev while
// a swap is in flight (or after a crash between its steps). Read-only. Every
// config reader goes through this.
//
// The mutation lock serializes writers. It does not serialize readers. A sync
// block in one process cannot be interleaved by its own event loop; the
// writers that interleave between the reader's reads are other processes —
// separate CLI or form-server invocations. Between any two of these reads a
// whole publish by another process (move-aside, link, unlink .prev) can
// complete, so config.json missing and then .prev missing is not proof of
// absence. Hence:
//
//   fast path    up to READ_ROUNDS rounds of config.json then .prev, lock-free,
//                with no sleep or yield between reads (a delay only widens the
//                window). This is every normal read, and it never takes a lock.
//   exhausted    no round caught the document. That is NOT absence: N
//                back-to-back publishes can exhaust any N rounds.
//     strict     prove it under the mutation lock: while it is held no
//                in-protocol publish is in flight, so one more miss there IS
//                absence (ENOENT). If this process already holds it, it is
//                already proven. If the lock cannot be had within
//                LOCK_WAIT_MS: CONFIG_INCONCLUSIVE.
//     lax        CONFIG_INCONCLUSIVE, without taking the lock.
//
// Lax readers (loadConfig, the runtime snapshot) never take the lock and
// never write: a truly absent document also reads as inconclusive there,
// which is true — they cannot tell. Credential paths read strictly.
const READ_ROUNDS = 3;
const LOCK_WAIT_MS = 1000;

function readRounds(files, rounds) {
  for (let round = 0; round < rounds; round += 1) {
    for (const file of files) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
      }
    }
  }
  return null;
}

function configError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const absentError = () => configError('ENOENT', 'config.json does not exist.');
const inconclusiveError = () => configError('CONFIG_INCONCLUSIVE',
  'config.json could not be confirmed: it was being replaced while it was read, or does not exist.');
const corruptError = () => configError('CONFIG_CORRUPT',
  'config.json exists but could not be read or parsed as a JSON object.');

function readConfigTextIn(dir, opts = {}) {
  const target = path.join(dir, 'config.json');
  const files = [target, `${target}.prev`];
  const text = readRounds(files, READ_ROUNDS);
  if (text !== null) return text;
  if (!opts.strict) throw inconclusiveError();
  if (lock.holdsMutationLock(dir)) throw absentError();
  const held = lock.acquireMutationLockWithin(dir, LOCK_WAIT_MS);
  if (!held.ok) throw inconclusiveError();
  try {
    const locked = readRounds(files, 1);
    if (locked !== null) return locked;
  } finally {
    held.release();
  }
  throw absentError();
}

function readConfigText(opts) {
  return readConfigTextIn(dataDir(), opts);
}

// 'present' | 'absent' | 'unreadable'. A stale .prev beside config.json is
// irrelevant; a .prev WITHOUT config.json is a swap in flight or an
// interrupted one, so the document exists.
function configPresence() {
  try {
    if (exists(configPath())) return 'present';
    return exists(prevPath()) ? 'present' : 'absent';
  } catch {
    return 'unreadable';
  }
}

function publishError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);
function linkCreateOnly(from, to) {
  try {
    fs.linkSync(from, to);
  } catch (e) {
    if (e && LINK_UNSUPPORTED.has(e.code)) {
      throw publishError('CONFIG_LINK_UNSUPPORTED',
        'config.json cannot be published safely here: the filesystem does not support hard links.');
    }
    throw e;
  }
}

function saveConfig(cfg, opts = {}) {
  const dir = dataDir();
  const target = configPath();
  const prev = prevPath();
  if (!lock.holdsMutationLock(dir)) {
    throw publishError('CONFIG_LOCK_REQUIRED', 'config.json is published only under the provider mutation lock.');
  }
  const first = !!(opts && opts.capability === FIRST_PUBLISH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (first) {
      if (exists(prev)) throw publishError('EEXIST', 'config.json already exists.');
      linkCreateOnly(tmp, target);
      return;
    }
    // A .prev beside a live config.json is a leftover of an interrupted
    // cleanup, never a document: the move-aside below replaces it atomically
    // and the final unlink removes it, so it cannot outlive config.json.
    if (!exists(target) && exists(prev)) {
      // Interrupted between move-aside and link: the document is .prev.
      // Restore it create-only, then publish over it as normal.
      try { linkCreateOnly(prev, target); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      fs.unlinkSync(prev);
    }
    try {
      fs.renameSync(target, prev);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        throw publishError('CONFIG_MIGRATION_PENDING',
          'config.json does not exist yet; only the one-time route migration may create it.');
      }
      throw e;
    }
    try {
      linkCreateOnly(tmp, target);
    } catch (e) {
      // Put the previous document back. config.json is absent (it was moved
      // aside by us), so this restores what existed rather than creating.
      try { linkCreateOnly(prev, target); fs.unlinkSync(prev); } catch { /* .prev stays the document */ }
      throw e;
    }
    try { fs.unlinkSync(prev); } catch { /* stale .prev beside config.json: removed by the next publish */ }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ---- dashboard interval (Issue #61) ------------------------------------------
//
// `config.dashboard.intervalSeconds` is the daemon's collection cadence: a
// non-secret whole number of seconds. It is deliberately NOT in DEFAULTS —
// config.json is assembled by setup and pruned by remove, and a default here
// would be written into every published document. The default lives with the
// resolver instead.
//
// A value that is present and invalid REFUSES; it is never replaced by the
// default. The bounds protect provider quota endpoints from an aggressive poll.
const DASHBOARD_INTERVAL = Object.freeze({ default: 30, min: 15, max: 3600 });

function validDashboardInterval(v) {
  return Number.isInteger(v) && v >= DASHBOARD_INTERVAL.min && v <= DASHBOARD_INTERVAL.max;
}

// Flag > config > default. `flag` is a number or undefined (the caller has
// already rejected a malformed flag). → { ok: true, seconds, source } | { ok: false, error }
function resolveDashboardInterval(cfg, flag) {
  if (flag !== undefined) {
    return validDashboardInterval(flag)
      ? { ok: true, seconds: flag, source: 'flag' }
      : { ok: false, error: `--interval must be a whole number of seconds from ${DASHBOARD_INTERVAL.min} to ${DASHBOARD_INTERVAL.max}.` };
  }
  const section = cfg ? cfg.dashboard : undefined;
  if (section === undefined) return { ok: true, seconds: DASHBOARD_INTERVAL.default, source: 'default' };
  if (!isPlainObject(section)) return { ok: false, error: 'config.json "dashboard" must be an object.' };
  if (section.intervalSeconds === undefined) return { ok: true, seconds: DASHBOARD_INTERVAL.default, source: 'default' };
  if (!validDashboardInterval(section.intervalSeconds)) {
    return { ok: false, error: `config.json "dashboard.intervalSeconds" must be a whole number of seconds from ${DASHBOARD_INTERVAL.min} to ${DASHBOARD_INTERVAL.max}; got ${JSON.stringify(section.intervalSeconds)}.` };
  }
  return { ok: true, seconds: section.intervalSeconds, source: 'config' };
}

module.exports = {
  dataDir, DEFAULTS, BUILT_IN_ROUTES, builtInRoute,
  PROVIDER_REGIONS, regionList, defaultRegion, normalizeRegion, regionHost,
  loadConfig, loadConfigStrict, configInconclusive, configCorrupt, saveConfig, configPath, deepMerge, expandHome, FIRST_PUBLISH,
  readConfigText, readConfigTextIn, configPresence, prevPath,
  DASHBOARD_INTERVAL, resolveDashboardInterval,
};
