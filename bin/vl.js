#!/usr/bin/env node
'use strict';
// view-limits CLI — thin transport wrapper over lib/.
//
//   vl.js gate                        PreToolUse hook: read hook JSON on stdin,
//                                     decide deny / allow+context from cache.
//   vl.js refresh [--quiet] [--debug] query all routes, write the cache.
//   vl.js report [--json]             render the runtime inventory from the
//                                     normalized snapshot (--json prints the
//                                     raw status cache).
//   vl.js check <routeId>             live-check one route (JSON).
//   vl.js setup [<routeId> [--key K]] audit + auto-import + loopback form / stdin.
//   vl.js remove <routeId>            delete a credential.
//   vl.js provider add|update|remove|list
//                                     shared custom-provider lifecycle (#58):
//                                     validate → read-only probe → persist, with
//                                     stable headless statuses and exit codes.
//   vl.js config                      show effective config (secrets masked).
//   vl.js snapshot --json [--refresh] normalized runtime snapshot; --refresh
//                                     adds bounded Traycer CLI live reads.
//   vl.js dashboard start|stop|status  the persistent dashboard daemon (#61): one
//                                     per data dir, loopback-only, interval
//                                     collection, GET /api/status.
//   vl.js dashboard open [--no-open]   start or reuse that daemon, print its
//                                     address and open it in the browser (#136).
//   vl.js recommend --json [--task J]  advisory harness/model/route/profile
//           [--policy J]               recommendation over configured routes;
//                                     deterministic + zero-I/O (Jev dormant).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');

const { loadConfig: libLoadConfig, loadConfigStrict, dataDir, expandHome, deepMerge, configPath, saveConfig,
  BUILT_IN_ROUTES, builtInRoute, readConfigText, configPresence, configInconclusive, configCorrupt,
  resolveDashboardInterval, hostLabel, parseGlobalOptions } = require('../lib/config');
const { importStandalone, noticeFor: standaloneNotice } = require('../lib/standalone-import');
const {
  readCache, writeCache, isFresh,
  tryScheduleRefresh, spawnRefresh,
} = require('../lib/cache');
const { resolveRoute, dispatchContext } = require('../lib/routes');
const { decide, summarize } = require('../lib/gate');
const vault = require('../lib/vault');
const { getAdapter, ADAPTERS } = require('../lib/adapters');
// Issue #56: a recipe that authenticates through its own approved CLI (the
// Bailian CLI owns its console credential) stores no secret under route.id, so
// it declares `capabilities.vaultCredential === false`. This predicate reads
// that capability flag — never a recipe id — so #57's stepfun-plan (local-only
// fetch, no secret either) is covered without another code change. Every
// route whose recipe does not declare the flag behaves exactly as before.
const { routeNeedsVaultCredential } = require('../lib/recipes');
// Issue #58: one lifecycle service for custom-provider setup / probe / update /
// removal. `bin/vl.js` stays the thin transport: it parses argv, injects the io
// (config, vault, cache, lock, probe) and prints; every decision is the
// service's.
const lifecycle = require('../lib/provider-lifecycle');
const { getOptionSpec } = require('../lib/recipes/option-specs');
const { getRuntimeSnapshot, defaultReadStatus } = require('../lib/runtime-snapshot');
const { basisOf } = require('../lib/normalize');
const { recommend } = require('../lib/recommend');
const { makeJevTransport } = require('../lib/jev-openrouter');
const { traycerEnvCallerContext } = require('../lib/traycer-adapter');
const { writeReceipt, ackReceipt, formatReceipt, receiptFact, OUTCOME_SUBMITTED, OUTCOME_ABANDONED, OUTCOME_FAILED } = require('../lib/receipts');
// Xiaomi live fallback: config-only eligibility + one Chrome read + at most
// one usage/detail pair per operation. Never the legacy vault for xiaomi.
const xiaomiSession = require('../lib/xiaomi-session');
const { validProfile } = require('../lib/cookies/chrome');
const { buildHelper } = require('../lib/helper-install');
// Issue #103: the view's banner dependency. Installed by a user-invoked
// setup or update, and nowhere else.
const { installDependencies, dependencySatisfied } = require('../lib/npm-install');
// Phase 0 (Issue #35): transport-neutral view model — owns the presentation
// layer's rendering; vl.js only joins its pre-formatted text lines.
const { buildViewModel, reauthNote, buildViewSchema, buildCollectionBlock, renderViewText, VIEW_SCHEMA_VERSION, escapeControlChars } = require('../lib/view-model');
// Issue #60: the shared live collector. It is the ONE place a live collection
// happens — the refresh-worker ownership, the adapter fan-out and the cache
// publish — so the refresh and the view cannot drift apart. The gate and the
// snapshot never call it: they stay cache-only and fail-open.
const collector = require('../lib/collector');
// The route-eligibility predicates live with the collector: one definition,
// one truth. (lib/collector.js owns them so the collection and the report
// agree on what "configured" means.)
const { isConfiguredRoute, isCustomMonitored } = collector;

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const XIAOMI_ROUTE_ID = xiaomiSession.XIAOMI_ROUTE_ID;
const XIAOMI_DASHBOARD = xiaomiSession.DASHBOARD_URL;
const isXiaomi = xiaomiSession.isXiaomiRoute;

function log(msg) { process.stderr.write(`view-limits: ${msg}\n`); }
function err(msg) { process.stderr.write(`view-limits: ${msg}\n`); process.exit(1); }

function noCredentialMessage() {
  return 'view-limits: no credentials configured yet.\n\n' +
    'Run /view-limits:setup to add your provider keys (auto-imports MiniMax\n' +
    'from ~/.mmx/config.json, then opens a local browser form for the rest).\n';
}

// ---- xiaomi helpers ----------------------------------------------------------
//
// The Xiaomi console fallback is live-only: every normal report/check/refresh
// reads the selected Chrome profile's cookies once and performs at most one
// usage/detail pair. Cached Xiaomi counts are NEVER used to satisfy a normal
// render — only the diagnostic `snapshot` command reads them (age-explicit).

// Inline reauthNote moved to lib/view-model.js — re-exported above so the
// `check` command and any future caller still format Xiaomi reauth messages
// from a single source of truth.

function defaultChromeSource() {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
}

// Shared recognizability filter (F1): a cache row is Xiaomi when its id is a
// currently-configured Xiaomi route, or it is the canonical Xiaomi route id,
// or its provenance marks it ours — `source: 'xiaomi'` (our writer's stamp)
// or a `tokens` window (a window type only the Xiaomi adapter emits). Normal
// renders (text, JSON, contended) strip every recognizable row; only the
// diagnostic `snapshot` keeps them as age-labelled historical evidence.
function xiaomiCacheFilter(cfg) {
  const configured = new Set(cfg.routes.filter(isXiaomi).map((r) => r.id));
  return (id, entry) => {
    if (configured.has(id)) return true;
    if (id === XIAOMI_ROUTE_ID) return true;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      if (entry.source === 'xiaomi') return true;
      const st = entry.status;
      if (st && typeof st === 'object' && !Array.isArray(st) && Array.isArray(st.windows) &&
        st.windows.some((w) => w && typeof w === 'object' && w.type === 'tokens')) {
        return true;
      }
    }
    return false;
  };
}

// The live Xiaomi session ONCE per operation lives in lib/collector.js
// (Issue #60): it is the ONE live collection path, and it returns the status
// map plus whether the session itself failed.

// Display entries for live Xiaomi statuses. These render as fresh because
// this process just observed them; the cache file itself keeps ttlSeconds 0
// (route schema) so the gate never trusts cached Xiaomi counts.
function xiaomiLiveEntries(cfg, statusById) {
  const entries = {};
  const now = Date.now();
  for (const route of cfg.routes) {
    if (!isXiaomi(route)) continue;
    const status = statusById[route.id];
    if (!status) continue;
    entries[route.id] = {
      routeId: route.id,
      observedAt: new Date(now).toISOString(),
      freshUntil: new Date(now + 1000).toISOString(),
      source: 'xiaomi',
      status,
    };
  }
  return entries;
}

// readStatus overlay for normal renders: strips EVERY recognizable Xiaomi
// cache entry (F1: configured ids, canonical id, orphaned `source:'xiaomi'`
// and `tokens`-window provenance) and substitutes the supplied live/pending
// entries, so stale Xiaomi counts cannot leak into report/refresh text or
// JSON — including under refresh-lock contention. Applies even when no status
// cache exists yet (first-run) or the cache is corrupt: a live Xiaomi
// observation must render either way.
function overlayDoc(cfg, liveEntries, raw) {
  const isXiaomiEntry = xiaomiCacheFilter(cfg);
  const doc = raw && raw.doc && typeof raw.doc === 'object' && !Array.isArray(raw.doc) && raw.doc.routes
    && typeof raw.doc.routes === 'object' && !Array.isArray(raw.doc.routes)
    ? raw.doc
    : { updatedAt: null, routes: {} };
  const routes = {};
  for (const [id, entry] of Object.entries(doc.routes)) {
    if (isXiaomiEntry(id, entry)) continue;
    routes[id] = entry;
  }
  Object.assign(routes, liveEntries || {});
  return { ...raw, doc: { ...doc, routes } };
}

function overlayReader(cfg, liveEntries) {
  return (dir) => overlayDoc(cfg, liveEntries, defaultReadStatus(dir));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

// ---- gate -------------------------------------------------------------------

async function gate() {
  // Opt-in: fail-open by design. DEFAULTS have gate.mode 'off', so an
  // unconfirmed read exits 0 at once and never denies.
  const cfg = loadConfig({ display: true });
  if (cfg.gate.mode === 'off') process.exit(0);

  const input = await readStdin();
  let evt;
  try { evt = JSON.parse(input); } catch { process.exit(0); } // no/invalid input → no gate

  const ctx = dispatchContext(evt);
  if (!ctx.model) process.exit(0); // no/invalid model identity → fail open

  const route = resolveRoute(ctx.model, ctx, cfg.routes);
  if (!route) process.exit(0); // unmapped/native/ambiguous → fail open

  const cache = readCache();
  // Guard the cache envelope before reading `routes`. `readCache` catches
  // parse failures and returns {}, but `JSON.parse('null')` is valid JSON and
  // would otherwise surface here as `null` — accessing `.routes` on null
  // throws and the hook fails on an uncaught exception. Any non-object envelope
  // (null, primitive, array) becomes an empty routes map so we fail open.
  const routes = (cache && typeof cache === 'object' && !Array.isArray(cache) && cache.routes)
    || {};
  const entry = routes[route.id];
  const now = Date.now();
  const d = decide({ route, entry, now, config: cfg });

  if (d.refresh && tryScheduleRefresh(now, cfg.gate.refreshLockSeconds)) {
    spawnRefresh(PLUGIN_ROOT);
  }

  if (d.action === 'deny') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: d.reason,
      },
    }));
  } else if (d.context) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: d.context },
    }));
  }
  process.exit(0);
}

// ---- refresh ----------------------------------------------------------------

// A custom route: a non-null route.monitor that passes schema validation.
// Invalid monitors still resolve (to a stable unknown) via check, but are not
// worth a refresh slot.
// (Issue #60: isCustomMonitored and isConfiguredRoute now live in
// lib/collector.js, next to the collection that uses them.)
function isUnmonitored(route, cfg) {
  try {
    const a = getAdapter(route.provider, route, cfg);
    const cap = a && a.capability;
    return !!(cap && cap.monitorable === false
      && typeof cap.reason === 'string' && cap.reason.startsWith('unmonitored:'));
  } catch {
    return false;
  }
}

function unmonitoredBlock(cfg) {
  // Returns '' or newline-joined lines with NO leading/trailing newline —
  // callers own the separator (renderInventory has no trailing newline).
  //
  // #104: a route id comes from the owner's own config.json, so a control
  // character in it can only come from a hand-edited config — but it reaches
  // stdout raw here, where a newline splits the line and the remainder reads
  // as an extra route row to the agent that parses this text. Both ids go
  // through escapeControlChars, the sanitizer the CLI already uses for
  // stdout text. NOT diagText: diagText is escapeControlChars(oneLine(...)),
  // and oneLine collapses whitespace runs and trims, so it would rewrite an
  // id that carries an ordinary space ("a  b" -> "a b"). escapeControlChars
  // leaves every non-control character untouched, so an ordinary id renders
  // byte-identically, and it covers the whole control class (C0 + DEL + C1).
  const lines = cfg.routes
    .filter((r) => !isXiaomi(r) && isCustomMonitored(r) && isUnmonitored(r, cfg))
    .map((r) => `    ${escapeControlChars(r.id)}: unmonitored — no documented quota source`);
  // #58: a route the user explicitly chose to keep after a probe found nothing
  // to monitor. Its recipe may well be monitorable in principle, so it is NOT
  // covered by the capability filter above — without this line it would render
  // as an ordinary unknown row and the explicit choice would be invisible.
  const kept = new Set(cfg.routes
    .filter((r) => !isXiaomi(r) && r && r.retention === lifecycle.RETENTION.KEEP && !isUnmonitored(r, cfg))
    .map((r) => r.id));
  for (const id of kept) {
    lines.push(`    ${escapeControlChars(id)}: unmonitored — kept by explicit choice (no usable quota signal at setup)`);
  }
  return lines.join('\n');
}

// The cache entry builder (entryFor) and the classified unknown status
// (unknownStatus) live in lib/collector.js (Issue #60): the collector builds
// the entries, so it owns their shape.

async function refresh(quiet, fromSessionStart = false) {
  // A manual refresh refuses an unconfirmed read (the default): it is not "no
  // credentials configured yet". Opt-in for the async SessionStart warm-up
  // only: a hook that exits 9 surfaces as a hook error, so it does nothing,
  // and the `session-start` hook reports the notice instead.
  const cfg = loadConfig(fromSessionStart ? { sessionWarmup: true } : undefined);
  if (fromSessionStart && (configInconclusive(cfg) || configCorrupt(cfg) || !cfg.refreshOnSessionStart)) return;

  // Issue #60: the collection lives in lib/collector.js — the shared
  // refresh-worker ownership, the adapter fan-out and the cache publish.
  // This function is the thin caller: it decides what to PRINT. Its stdout,
  // stderr and exit codes are unchanged for the same inputs; the ONE
  // intended difference is a failed route, which now keeps its prior data
  // (and its age) instead of being overwritten with an unknown status.
  const result = await collector.collect({ cfg });

  if (result.outcome === collector.OUTCOME.NO_CREDENTIALS) {
    if (!quiet) process.stdout.write(noCredentialMessage());
    return;
  }

  // Shared refresh worker ownership: manual refresh, SessionStart's refresh,
  // and the gate-spawned refresh child all converge on this lock. Only one
  // worker performs provider calls; the loser prints the cached state plus
  // an in-progress indication and exits without calling any provider.
  if (result.outcome === collector.OUTCOME.IN_PROGRESS) {
    if (!quiet) {
      const cache = readCache();
      // Contention: Xiaomi shows pending — never the cached counts.
      const pendingById = {};
      for (const route of cfg.routes) {
        if (isXiaomi(route)) pendingById[route.id] = xiaomiSession.pendingStatus();
      }
      const snap = await getRuntimeSnapshot({
        callerContext: cliCallerContext(),
        io: { readStatus: overlayReader(cfg, xiaomiLiveEntries(cfg, pendingById)) },
      });
      process.stdout.write(renderInventory(snap, cache.updatedAt) + '\n');
      process.stdout.write('view-limits: refresh already in progress. Showing last cached status.\n');
    }
    return;
  }

  if (!result.published) {
    // The worker lock could not be taken, or the publish failed. Nothing was
    // published: show the last cached status and say why. A publish failure
    // keeps today's failure mode — the refresh rejects and the CLI exits
    // nonzero.
    if (result.reason === collector.REASON.PUBLISH_FAILED) throw new Error(result.error);
    if (!quiet) {
      const cache = readCache();
      const pendingById = {};
      for (const route of cfg.routes) {
        if (isXiaomi(route)) pendingById[route.id] = xiaomiSession.pendingStatus();
      }
      const snap = await getRuntimeSnapshot({
        callerContext: cliCallerContext(),
        io: { readStatus: overlayReader(cfg, xiaomiLiveEntries(cfg, pendingById)) },
      });
      process.stdout.write(renderInventory(snap, cache.updatedAt) + '\n');
      process.stdout.write(
        `view-limits: refresh unavailable (${result.error || result.reason}). Showing last cached status.\n`,
      );
    }
    return;
  }

  if (!quiet) {
    // Render the just-observed Xiaomi state; the cache keeps ttlSeconds 0
    // for the gate, display freshness marks this process's observation.
    const snap = await getRuntimeSnapshot({
      callerContext: cliCallerContext(),
      io: { readStatus: overlayReader(cfg, xiaomiLiveEntries(cfg, result.statuses)) },
    });
    process.stdout.write(renderInventory(snap, (result.cache && result.cache.updatedAt) || null) + '\n');
    // #57: unmonitored routes are refreshed locally (no request) and get an
    // explicit note; they are never silently dropped.
    const ub = unmonitoredBlock(cfg);
    if (ub) process.stdout.write(ub + '\n');
    // A failed route keeps its prior observation — so the output must still
    // say that the fetch failed. On stdout, where the inventory printed the
    // error before, and never under --quiet.
    for (const line of failedRouteLines(result, 'refresh', true)) process.stdout.write(line + '\n');
  }
}

// ---- report -----------------------------------------------------------------
//
// /view-limits renders the normalized runtime snapshot — the requester, the
// harness pool (harnesses, sessions, native profiles) and the external
// provider routes. Every printed value comes from a snapshot fact: the
// renderer never infers effective models or selected accounts, and unknown /
// stale evidence stays visibly distinct from healthy / exhausted states.
//
// Phase 0 (Issue #35): the rendering logic itself lives in lib/view-model.js.
// This command joins the view model's pre-formatted text lines; the view
// object is the contract for text (today) and JSON / HTML (Phase 3-4).

// #80 — every status exposes its measurement basis in diagnostic JSON:
// `quota-window | token-count | balance | none`. Adapters that declare one
// keep it verbatim; the rest get the derived label. Additive only — no
// existing field is renamed or removed.
function withBasis(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return status;
  return { ...status, basis: basisOf(status) };
}

function withBasisEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
  if (!entry.status || typeof entry.status !== 'object' || Array.isArray(entry.status)) return entry;
  return { ...entry, status: withBasis(entry.status) };
}

function cliCallerContext() {
  return { host: os.hostname(), surface: 'cli', ...traycerEnvCallerContext(process.env) };
}

function renderInventory(snap, updatedAt) {
  return buildViewModel(snap, updatedAt).lines.join('\n');
}

// ---- report ----------------------------------------------------------------
//
// `vl.js report` and its alias `vl.js status` (Phase 1, Issue #37) share one
// implementation: `reportCmd`. The default rendering is the shared view
// model's text lines (preserved byte-identical by #35); `--json` emits the
// raw cache envelope with every recognizable Xiaomi row stripped and live
// Xiaomi observations projected onto every Xiaomi route alias (F1/F4).
//
// No Claude hook APIs on the core path: `reportCmd` never reads stdin and the
// shared view model is transport-neutral. The dispatcher passes its parsed
// `args` array through unchanged, so any flag `--json` is a positional
// concern of the caller — the function does not interpret Claude hook
// envelopes.

async function reportCmd(args) {
  // Opt-in: an unconfirmed read prints the notice below, never DEFAULTS.
  const cfg = loadConfig({ display: true });
  const cache = readCache();
  // [#7] Surface any fresh credential receipt even on first-run (no creds).
  const receiptMsg = formatReceipt(receiptFact(dataDir()));
  // Xiaomi is configured by route presence alone (no vault read). #57:
  // unmonitored-recipe routes are likewise configured by presence alone,
  // because routeNeedsVaultCredential is false for them (capability flag).
  const anyConfigured = cfg.routes.some((r) => (isXiaomi(r) ? true : isConfiguredRoute(r)));
  if (!anyConfigured) {
    // DEFAULTS from a read that could not confirm config.json are not "no
    // credentials": say what actually happened.
    const notice = unconfirmedNotice(cfg);
    process.stdout.write(notice ? `view-limits: ${notice}\n` : noCredentialMessage());
    if (receiptMsg) process.stdout.write('  ' + receiptMsg + '\n');
    return;
  }
  // Normal Xiaomi reports are LIVE: ONE Chrome read + at most one
  // usage/detail pair for the whole operation (F4), projected to every
  // Xiaomi alias. Every recognizable cached Xiaomi row — configured,
  // canonical, orphaned — is stripped from this render (F1).
  const { statusById } = await collector.xiaomiLiveStatuses(cfg, { threshold: cfg.gate.constrainedThreshold });
  const liveEntries = xiaomiLiveEntries(cfg, statusById);
  if (args.includes('--json')) {
    const isXiaomiEntry = xiaomiCacheFilter(cfg);
    const routes = {};
    for (const [id, entry] of Object.entries(cache.routes || {})) {
      if (isXiaomiEntry(id, entry)) continue;
      routes[id] = withBasisEntry(entry);
    }
    for (const [id, entry] of Object.entries(liveEntries)) routes[id] = withBasisEntry(entry);
    process.stdout.write(JSON.stringify({ ...cache, routes }, null, 2) + '\n');
    return;
  }
  const snap = await getRuntimeSnapshot({
    callerContext: cliCallerContext(),
    io: { readStatus: overlayReader(cfg, liveEntries) },
  });
  let report = renderInventory(snap, cache.updatedAt);
  // #57: unmonitored routes get an explicit line (additive; #56's changes to
  // this block must stay additive too).
  const ub = unmonitoredBlock(cfg);
  if (ub) report += '\n' + ub;
  // Surface any fresh credential receipt (read-only, no ack).
  if (receiptMsg) report += '\n  ' + receiptMsg;
  return process.stdout.write(report + '\n');
}

// ---- check ------------------------------------------------------------------

async function check(routeId) {
  const cfg = loadConfig();
  const route = cfg.routes.find((r) => r.id === routeId);
  if (!route) err(`unknown route "${routeId}" (known: ${cfg.routes.map((r) => r.id).join(', ')})`);
  if (isXiaomi(route)) {
    // Live path: one Chrome read + <= one usage/detail pair, no vault.
    const st = await xiaomiSession.fetchStatus(cfg, route, { threshold: cfg.gate.constrainedThreshold });
    const detail = st && st.detail && typeof st.detail === 'object' ? st.detail : {};
    if (detail.reauth) err(`check ${routeId} failed: ${reauthNote(detail.reauth)}`);
    if (detail.error) err(`check ${routeId} failed: ${detail.error}`);
    process.stdout.write(JSON.stringify(withBasis(st), null, 2) + '\n');
    return;
  }
  // #57: unmonitored-recipe routes (vaultCredential:false) document no quota
  // source — no credential exists to fetch, so the vault is not even read.
  const needsVault = routeNeedsVaultCredential(route);
  const token = needsVault ? vault.get(route.id) : null;
  if (!token && needsVault) err(`no credential for "${routeId}" — run: vl.js setup`);
  let st;
  try {
    st = await getAdapter(route.provider, route, cfg).fetchStatus(
      cfg.providers[route.provider], token, { threshold: cfg.gate.constrainedThreshold },
    );
  } catch (e) {
    // One line, no stack: provider bodies can carry newlines.
    const msg = String((e && e.message) || e).replace(/\s+/g, ' ').trim();
    // Q34-A: the route id is context, not an argument — `/view-limits:update`
    // takes none, and the command line below is what a user copies.
    const hint = e && e.status === 401 ? ` (rotate ${routeId} via /view-limits:update)` : '';
    err(`check ${routeId} failed: ${msg}${hint}`);
  }
  process.stdout.write(JSON.stringify(withBasis(st), null, 2) + '\n');
}

// ---- setup ------------------------------------------------------------------

function readNativeSecret(imp) {
  try {
    const obj = JSON.parse(fs.readFileSync(expandHome(imp.file), 'utf8'));
    const val = imp.field.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    return val != null ? String(val) : null;
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function preflightVault() {
  try {
    vault.assertWritable();
  } catch (error) {
    if (error && error.code === 'VIEW_LIMITS_MASTER_KEY_REQUIRED') {
      err('file vault needs VIEW_LIMITS_MASTER_KEY (or a pre-provisioned master.key) before credentials can be stored.');
    }
    err('credential vault is unavailable — verify its configuration and access, then try again.');
  }
}

function storeCredential(id, secret) {
  try {
    vault.set(id, secret);
  } catch {
    return false;
  }
  // config.json is ASSEMBLED by setup: storing a shipped route's credential is
  // what puts its row in the document. Doing it here covers every path that
  // can store one — `setup <id> --key`, the loopback form, the headless
  // prompt and the native-config import — so "has a credential" and
  // "configured" cannot drift apart.
  materializeBuiltInRoute(id);
  return true;
}

// Add a shipped route's row to config.json if it is not already there. Custom
// routes are not handled here: the lifecycle writes those under its own lock.
function materializeBuiltInRoute(id) {
  const catalog = builtInRoute(id);
  if (!catalog) return;
  // Same lock the lifecycle uses: this is a read-modify-write of config.json,
  // so a concurrent `provider add` would otherwise lose one of the two edits.
  const lock = lifecycle.acquireMutationLock(dataDir());
  if (!lock.ok) {
    log(`credential stored, but another provider mutation holds the lock — rerun to add the "${id}" route.`);
    return;
  }
  try {
    // Re-check the prerequisite INSIDE the lock. A caller decided this row was
    // owed before it held the lock (bare setup's repair scans first), and a
    // concurrent `provider remove` can delete the credential in between. A row
    // is published only for a credential that is stored right now.
    let state;
    try { state = vault.probe(id); } catch { state = 'unreadable'; }
    if (state === 'absent') {
      log(`the "${id}" credential is no longer stored, so its route was not added.`);
      return;
    }
    if (state !== 'present') {
      log(`the credential vault could not be re-read to confirm the "${id}" credential, so its route was not added — rerun setup once the vault is accessible.`);
      return;
    }
    // A config we cannot parse is never rewritten, exactly as the lifecycle
    // refuses it: the credential is stored and the row waits for a readable
    // document rather than clobbering a hand-edit.
    const read = readUserConfigStrict();
    if (!read.ok) {
      log(`credential stored, but config.json could not be read (${read.reason}) — fix it and rerun to add the "${id}" route.`);
      return;
    }
    const doc = read.doc && typeof read.doc === 'object' ? read.doc : {};
    const routes = Array.isArray(doc.routes) ? doc.routes : [];
    if (routes.some((r) => r && r.id === id)) return;
    doc.routes = [...routes, catalog];
    saveConfig(doc);
  } catch (e) {
    if (e && e.code === 'CONFIG_MIGRATION_PENDING') {
      // The write-level guard (lib/config.js saveConfig): config.json does not
      // exist, so the one-time migration has not resolved and must create it.
      log(`credential stored, but its route was not added yet: config.json must first be created by the one-time route migration — rerun setup to complete it.`);
      return;
    }
    log(`credential stored, but the "${id}" route could not be added to config.json — verify write access and rerun.`);
  } finally {
    lock.release();
  }
}

// Routes setup may be asked about: everything configured, plus every shipped
// built-in that has not been added yet. A fresh install has no rows, so
// without the catalog here setup could not offer the five built-ins at all —
// and a configured built-in is offered in its CONFIGURED form, not the
// catalog copy, so a user's edits to it are never shadowed.
function offerableRoutes(cfg) {
  const byId = new Map();
  for (const r of (Array.isArray(cfg.routes) ? cfg.routes : [])) {
    if (r && r.id) byId.set(r.id, r);
  }
  for (const r of BUILT_IN_ROUTES) if (!byId.has(r.id)) byId.set(r.id, builtInRoute(r.id));
  return [...byId.values()];
}

// Shipped built-ins whose credential is stored but which have no row in
// config.json. The drift setup exists to prevent, and the state a row that
// failed to materialize after its vault write leaves behind. A vault that
// cannot answer is treated as "nothing found", never as a reason to throw.
function rowlessCredentials(cfg) {
  const configured = new Set((Array.isArray(cfg.routes) ? cfg.routes : []).map((r) => r && r.id));
  return BUILT_IN_ROUTES.map((r) => r.id).filter((id) => {
    if (configured.has(id)) return false;
    try { return vault.has(id); } catch { return false; }
  });
}

function logWriteResults(saved, failed) {
  if (saved.length) log(`stored credentials for: ${saved.join(', ')}`);
  if (failed.length) {
    log(`could not store credentials for: ${failed.join(', ')} — verify vault access and try again.`);
    process.exitCode = 1;
  }
}

function formHtml(ids, nonce) {
  const fields = ids.map((id) =>
    `<label for="${escapeHtml(id)}">${escapeHtml(id)}</label>` +
    `<input id="${escapeHtml(id)}" type="password" autocomplete="off" spellcheck="false" required>`,
  ).join('');
  const reads = ids.map((id) =>
    `credentials[${JSON.stringify(id)}] = document.getElementById(${JSON.stringify(id)}).value;`,
  ).join('\n  ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>view-limits setup</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}label{display:block;margin:14px 0 4px;font-weight:600}input{width:100%;padding:8px;box-sizing:border-box;font-family:monospace}button{margin-top:18px;padding:8px 18px}</style>` +
    `</head><body><h1>view-limits credentials</h1><p>Enter the new key for each route below — existing keys stay valid until you submit; opening this form clears nothing.</p><p>Values are sent only to this local server (127.0.0.1) and stored in your local vault — never through the agent's chat.</p>` +
    `<form id="f">${fields}<button type="submit">Save</button></form>` +
    `<script>document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();if(e.target.dataset.busy)return;e.target.dataset.busy='1';const save=e.target.querySelector('button');if(save)save.disabled=true;try{const credentials={};` +
    reads +
    `const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:${JSON.stringify(nonce)},credentials})});` +
    `if(r.ok){document.body.innerHTML='<h1>Saved</h1><p>Credentials stored. Closing in <span id="n">5</span>s…</p>';let n=5;setInterval(()=>{n--;const e=document.getElementById('n');if(e)e.textContent=n;if(n<=0)window.close();},1000);}else{document.body.innerHTML='<h1>Error</h1><p>Something went wrong — rerun setup or update.</p>';}}finally{delete e.target.dataset.busy;if(save)save.disabled=false;}});</script></body></html>`;
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' });
    else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    else spawn('xdg-open', [url], { stdio: 'ignore' });
  } catch {
    log(`open this URL in your browser: ${url}`);
  }
}

function pickFreePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Detached loopback server for the credential form (runs until the POST or a
// 5-minute abandon timeout, then exits).
function serve(port, nonce, ids) {
  const cfg = loadConfig();
  // The known set is the SETUP CANDIDATES, not only cfg.routes. config.json is
  // assembled by setup, so on a fresh install a built-in has no row until its
  // credential is stored — by this very form. Validating against cfg.routes
  // alone rejected every built-in on an empty config and handed the user a dead
  // page. No row is published here: storeCredential() materializes it on POST.
  const known = new Set(offerableRoutes(cfg).map((route) => route.id));
  if (!Number.isInteger(port) || port < 1 || port > 65535) err('credential form received an invalid port.');
  if (typeof nonce !== 'string' || !nonce) err('credential form received an invalid nonce.');
  if (!ids.length || ids.some((id) => !known.has(id))) err('credential form received an unknown route.');
  // Xiaomi never uses the paste form (Chrome cookies, no stored key).
  const xiaomiFormId = ids.some((id) => {
    if (id === XIAOMI_ROUTE_ID) return true;
    const route = cfg.routes.find((r) => r.id === id);
    return !!(route && isXiaomi(route));
  });
  if (xiaomiFormId) err('credential form cannot include xiaomi-token-plan (no paste form for Chrome cookie sources).');
  preflightVault();

  let abandonTimer = null;
  let settled = false;
  const dataDirPath = dataDir();
  let receiptWritten = false;

  // [#C] Publish a receipt truthfully: receiptWritten is set only when the
  // write actually persisted. A null return (unwritable dataDir) must not
  // suppress later signals or let shutdown relabel the outcome.
  function publishReceipt(opts) {
    const r = writeReceipt(dataDirPath, opts);
    if (r !== null) receiptWritten = true;
    return r;
  }

  // [#C] Credentials were stored but the outcome receipt could not be
  // published — write a truthful failure signal so the agent sees a failed
  // receipt instead of receipt-absent. Never an abandoned receipt: the
  // form DID submit.
  function publishStorageNotice(routeIds) {
    return publishReceipt({
      outcome: OUTCOME_FAILED,
      routeIds,
      detail: 'credentials stored; agent receipt publication failed',
    });
  }

  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(formHtml(ids, nonce));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      let oversized = false;
      req.on('data', (c) => {
        if (oversized) return;
        body += c;
        if (body.length > 64 * 1024) {
          oversized = true;
          const firstTerminal = !settled;
          settled = true; // [#14] prevent race with shutdown window
          res.writeHead(413);
          res.end('payload too large');
          // [#B] The first terminal request owns the receipt — a late
          // oversized POST gets its 413 but never overwrites or re-shuts.
          if (!firstTerminal) return;
          publishReceipt({ outcome: OUTCOME_FAILED, routeIds: ids, detail: 'payload too large' });
          shutdown(0);
        }
      });
      req.on('end', () => {
        if (oversized) return;
        if (settled) {
          res.writeHead(409);
          res.end('already submitted');
          return; // [#2] no receipt — first submission already wrote its outcome
        }
        settled = true;
        let data;
        try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('bad request'); publishReceipt({ outcome: OUTCOME_FAILED, routeIds: ids, detail: 'bad request' }); shutdown(0); return; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          res.writeHead(400);
          res.end('bad request');
          publishReceipt({ outcome: OUTCOME_FAILED, routeIds: ids, detail: 'bad request' });
          shutdown(0);
          return;
        }
        if (data.nonce !== nonce) { res.writeHead(403); res.end('bad nonce'); publishReceipt({ outcome: OUTCOME_FAILED, routeIds: ids, detail: 'nonce mismatch' }); shutdown(0); return; }
        const creds = data.credentials && typeof data.credentials === 'object' && !Array.isArray(data.credentials)
          ? data.credentials : {};
        const saved = [];
        const failed = [];
        let persistenceFailed = false;
        for (const id of ids) {
          const replacement = creds[id];
          if (typeof replacement !== 'string' || !replacement.trim()) {
            failed.push(id);
            continue;
          }
          if (storeCredential(id, replacement)) saved.push(id);
          else {
            failed.push(id);
            persistenceFailed = true;
          }
        }
        if (failed.length) {
          // [#1] writeReceipt must never crash.  Use `ids` as fallback when
          // saved is empty (writeReceipt rejects empty arrays).  [#11] On
          // persistence failure, receipt lists the actually-failed routes.
          // [#16] Mixed submissions stay honest: the receipt names what was
          // stored and what still needs credentials — no invented atomicity.
          const receiptOutcome = persistenceFailed ? OUTCOME_FAILED : (saved.length > 0 ? OUTCOME_SUBMITTED : OUTCOME_FAILED);
          const receiptRoutes = persistenceFailed ? (failed.length > 0 ? failed : ids) : (saved.length > 0 ? saved : ids);
          const receiptDetail = persistenceFailed
            ? (saved.length > 0 ? `vault write failure; stored credentials for ${saved.join(', ')}` : 'vault write failure')
            : (saved.length === 0 ? 'no credentials supplied' : `no credentials supplied for ${failed.join(', ')}`);
          // [#C] Publish BEFORE the response so the page can state whether
          // automatic agent notification landed. Credentials that did store
          // stay stored — a lost publication gets a truthful failure signal,
          // and when the dataDir is unwritable the page is the only channel.
          const published = publishReceipt({ outcome: receiptOutcome, routeIds: receiptRoutes, detail: receiptDetail });
          let notice = '';
          if (published === null && saved.length > 0) {
            notice = publishStorageNotice(saved) !== null
              ? '<p>The automatic agent notification could not be published on the first attempt — a failure notice was recorded instead.</p>'
              : '<p><strong>Automatic agent notification failed: the data directory is not writable, so no filesystem-backed signal is possible.</strong></p>';
          }
          res.writeHead(persistenceFailed ? 500 : 400, { 'Content-Type': 'text/html' });
          const remediation = persistenceFailed
            ? 'Verify vault access, then rerun setup or update.'
            : 'Enter a replacement for every route, then rerun setup or update.';
          res.end(`<h1>Credential storage failed</h1><p>Stored: ${saved.map(escapeHtml).join(', ') || 'none'}.</p><p>Could not store: ${failed.map(escapeHtml).join(', ')}.</p><p>${remediation}</p>${notice}`);
          shutdown(1, 200);
          return;
        }
        // [#C] Publish the receipt BEFORE the success page so the page can
        // state whether automatic agent notification landed. Credentials are
        // already in the vault — a lost publication is never vault failure.
        const published = publishReceipt({ outcome: OUTCOME_SUBMITTED, routeIds: saved });
        let notice = '';
        if (published === null) {
          notice = publishStorageNotice(saved) !== null
            ? '<p>Credentials were stored, but the automatic agent notification could not be published on the first attempt — a failure notice was recorded instead.</p>'
            : '<p><strong>Credentials were stored, but automatic agent notification failed: the data directory is not writable, so no filesystem-backed signal is possible. Run /view-limits to verify.</strong></p>';
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Saved ${saved.length} credential${saved.length === 1 ? '' : 's'}</h1><p>Routes: ${saved.map(escapeHtml).join(', ') || 'none'}.</p>${notice}<p>Closing in <span id="n">5</span>s…</p><script>let n=5;setInterval(()=>{n--;const e=document.getElementById('n');if(e)e.textContent=n;if(n<=0)window.close();},1000);</script>`);
        shutdown(0, 200);
      });
      return;
    }
    res.writeHead(405); res.end();
  });

  server.on('error', () => {
    log('credential form could not start — rerun setup or update.');
    process.exit(1);
  });

  function shutdown(code, delay = 0) {
    if (abandonTimer) clearTimeout(abandonTimer);
    // [#C] Abandoned means no terminal form event ever happened — `settled`,
    // not `receiptWritten`, so a failed publication never relabels a real
    // submission as abandoned.
    if (!settled) {
      publishReceipt({ outcome: OUTCOME_ABANDONED, routeIds: ids });
    }
    setTimeout(() => server.close(() => process.exit(code)), delay);
  }

  server.listen(port, '127.0.0.1', () => {
    abandonTimer = setTimeout(() => {
      if (!settled) {
        publishReceipt({ outcome: OUTCOME_ABANDONED, routeIds: ids });
      }
      server.close(() => process.exit(0));
    }, 5 * 60 * 1000);
  });
}

async function promptHeadless(ids) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const saved = [];
  const failed = [];
  try {
    for (const id of ids) {
      const secret = await new Promise((res) => rl.question(`Paste credential for ${id}: `, (a) => res(a.trim())));
      if (secret && storeCredential(id, secret)) saved.push(id);
      else failed.push(id);
    }
  } finally {
    rl.close();
  }
  logWriteResults(saved, failed);
  // A stored credential whose row did not materialize is not a success, here
  // exactly as for `setup <id> --key`.
  for (const id of saved) requireRowAfterStore(id);
}

async function openForm(ids) {
  let child;
  let port;
  try {
    const nonce = crypto.randomBytes(24).toString('hex');
    port = await pickFreePort();
    child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'vl.js'), 'serve', String(port), nonce, ...ids], { detached: true, stdio: 'ignore' });
  } catch {
    err('credential form could not start — rerun setup or update.');
  }
  // Never hand the user a URL for a server that is not there. The form server
  // is a detached child whose stderr is not ours, so it can fail its own
  // validation (an unknown route, an unusable vault) and exit before it ever
  // listens — and a URL printed blindly is then a dead page with no error.
  // Wait until it is accepting connections or gone, and say which.
  const ready = await waitForFormServer(child, port, FORM_READY_TIMEOUT_MS);
  if (!ready.ok) {
    if (ready.exitCode !== undefined) {
      err(`credential form server exited (code ${ready.exitCode}) before it was ready — nothing was stored; rerun setup or update.`);
    }
    try { child.kill(); } catch { /* already gone */ }
    err('credential form server did not start listening in time — nothing was stored; rerun setup or update.');
  }
  child.unref();
  const url = `http://127.0.0.1:${port}`;
  openBrowser(url);
  log(`credential form: ${url}`);
  log('paste your key(s), then run /view-limits to refresh.');
}

const FORM_READY_TIMEOUT_MS = 3000;

// { ok: true } once the child accepts a TCP connection on `port`;
// { ok: false, exitCode } if it exits first; { ok: false } on timeout. A bare
// connect sends no HTTP request, so it cannot settle or consume the form.
function waitForFormServer(child, port, timeoutMs) {
  const net = require('net');
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    function finish(result) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve(result);
    }
    function onExit(code, signal) { finish({ ok: false, exitCode: code === null ? signal : code }); }
    function onError() { finish({ ok: false, exitCode: 'spawn-error' }); }
    child.once('exit', onExit);
    child.once('error', onError);
    const deadline = Date.now() + timeoutMs;
    (function attempt() {
      if (done) return;
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); finish({ ok: true }); });
      socket.once('error', () => {
        socket.destroy();
        if (done) return;
        if (Date.now() >= deadline) { finish({ ok: false }); return; }
        timer = setTimeout(attempt, 50);
      });
    }());
  });
}

function parseCredentialArgs(cfg, args, opts = {}) {
  const parsed = { routeId: null, headless: false, key: null, profile: null, chromeSource: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--headless') {
      if (parsed.headless) err('duplicate --headless option.');
      parsed.headless = true;
      continue;
    }
    if (arg === '--profile' || arg === '--chrome-source') {
      const field = arg === '--profile' ? 'profile' : 'chromeSource';
      if (parsed[field] !== null) err(`duplicate ${arg} option.`);
      const value = args[i + 1];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) err(`${arg} requires a non-empty value.`);
      parsed[field] = value;
      i += 1;
      continue;
    }
    if (arg === '--key') {
      if (parsed.key !== null) err('duplicate --key option.');
      const value = args[i + 1];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) err('--key requires a non-empty value.');
      parsed.key = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) err(`unknown option "${redactFlagToken(arg)}".`);
    if (!arg.trim()) err('route id must not be empty.');
    if (parsed.routeId) err('only one route can be selected at a time.');
    parsed.routeId = arg;
  }
  // xiaomi-token-plan is a known route even before setup appends it (opt-in).
  // A shipped built-in is likewise known to SETUP before its row exists —
  // setup is what creates the row, so refusing the id would make the five
  // built-ins unsettable on a fresh install. `update` is the opposite case:
  // it rotates a credential that already exists, so a built-in nobody has set
  // up is genuinely unknown there and the honest list is the configured one.
  const offerable = opts.offerBuiltIns === true ? offerableRoutes(cfg) : (Array.isArray(cfg.routes) ? cfg.routes : []);
  const known = parsed.routeId === XIAOMI_ROUTE_ID
    || offerable.some((route) => route.id === parsed.routeId);
  if (parsed.routeId && !known) {
    // A shipped built-in whose credential is stored but whose row is missing
    // (a row that failed to materialize after the vault write) is not
    // "unknown": the repair exists, so name it instead.
    if (rowlessCredentials(cfg).includes(parsed.routeId)) {
      err(`"${parsed.routeId}" has a stored credential but no route yet — run: vl.js setup (with no route id) to add it.`);
    }
    err(`unknown route "${parsed.routeId}" (known: ${offerable.map((route) => route.id).join(', ')})`);
  }
  if (parsed.key !== null && !parsed.routeId) err('--key requires a route id.');
  if (parsed.key !== null && parsed.headless) err('--key and --headless cannot be used together.');
  if ((parsed.profile !== null || parsed.chromeSource !== null) && parsed.routeId !== XIAOMI_ROUTE_ID) {
    err('--profile and --chrome-source apply only to xiaomi-token-plan.');
  }
  if (parsed.profile !== null && parsed.headless) err('--profile and --headless cannot be used together.');
  if (parsed.chromeSource !== null && parsed.headless) err('--chrome-source and --headless cannot be used together.');
  if (parsed.profile !== null && parsed.key !== null) err('--profile and --key cannot be used together.');
  if (parsed.chromeSource !== null && parsed.key !== null) err('--chrome-source and --key cannot be used together.');
  return parsed;
}

// A shipped route's credential is only half the job: its row is what makes it
// monitored. Read the row off disk after the store — materializeBuiltInRoute
// reports its own failures by logging, so success is observed, not assumed —
// and exit 1 when it is missing, exactly as bare setup does in that state.
function requireRowAfterStore(id) {
  if (!builtInRoute(id)) return;
  // The store succeeded; an unconfirmed reread proves neither that the row is
  // missing nor that it exists, so it reports neither (the default: exit 9).
  const routes = loadConfig().routes;
  if (Array.isArray(routes) && routes.some((r) => r && r.id === id)) return;
  log(`the credential for "${id}" is stored, but its route is not configured yet — run: vl.js setup (with no route id) to add it.`);
  process.exitCode = 1;
}

function setupOne(cfg, options, allowImport) {
  const id = options.routeId;
  if (options.key !== null) {
    if (!storeCredential(id, options.key)) err(`could not store credential for "${id}" — verify vault access and try again.`);
    log(`stored credential for "${id}"`);
    requireRowAfterStore(id);
    return;
  }
  if (allowImport) {
    const imp = cfg.importMap && cfg.importMap[id];
    const native = imp ? readNativeSecret(imp) : null;
    if (native) {
      if (!storeCredential(id, native)) err(`could not import credential for "${id}" — verify vault access and try again.`);
      log(`imported from native config: ${id}`);
      requireRowAfterStore(id);
      return;
    }
  }
  if (options.headless) return promptHeadless([id]);
  return openForm([id]);
}

// ---- xiaomi setup/update/remove ------------------------------------------------
//
// Chrome-cookie source configuration lives in config.json (route + provider
// settings + selected profile). No paste form, no vault write, no cookie
// persistence. The background key helper is built ONLY here — when the user
// explicitly invokes setup — and is never executed by setup itself.

function readUserConfig() {
  // A writer's base document. Only a PROVEN-absent document is {}: starting
  // from {} because a publish was in flight, or because the file is
  // unreadable or malformed, would publish a document with everything else in
  // it dropped. Those refuse (exit 9 / exit 10), writing nothing.
  let raw;
  try {
    raw = readConfigText({ strict: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return {};
    if (e && e.code === 'CONFIG_INCONCLUSIVE') exitInconclusive();
    exitCorrupt();
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    exitCorrupt();
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) exitCorrupt();
  return doc;
}

// Like readUserConfig, but tells absent apart from broken (Issue #58).
//
// readUserConfig exits on a broken document; this variant RETURNS the reason
// instead, for callers that report it themselves. A lifecycle write replaces
// config.json wholesale, so starting from `{}` because of one typo would
// silently discard every setting the user put there. The lifecycle refuses in
// that case; see userConfigBlocked in lib/provider-lifecycle.js.
//
//   { ok: true, doc }            absent (first run, doc = {}) or well-formed
//   { ok: false, reason }        'malformed' | 'not-an-object' | 'unreadable' | 'inconclusive'
function readUserConfigStrict() {
  let raw;
  try {
    raw = readConfigText({ strict: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, doc: {} };
    if (e && e.code === 'CONFIG_INCONCLUSIVE') return { ok: false, reason: 'inconclusive' };
    return { ok: false, reason: 'unreadable' };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, reason: 'not-an-object' };
  }
  return { ok: true, doc };
}

// Append/refresh the opt-in route + pinned provider settings + explicit
// chrome source/profile. `routes` merge is by replacement, so the effective
// route list is written back in full. Called ONLY inside withConfigLock, so
// both reads are strict and exact: no other publish can be in flight, and the
// document it returns is written back in the same lock hold.
function planXiaomiConfig(patch) {
  const user = readUserConfig();
  const effective = loadConfigStrict();
  const routes = effective.routes.slice();
  const existing = routes.find((route) => route.id === XIAOMI_ROUTE_ID);
  if (existing) {
    // Keep schema guarantees on an existing entry.
    existing.provider = 'xiaomi';
    existing.ttlSeconds = 0;
    existing.credentialSource = 'chrome-cookies';
  } else {
    routes.push({
      id: XIAOMI_ROUTE_ID,
      provider: 'xiaomi',
      account: 'token-plan',
      match: { model: 'mimo' },
      ttlSeconds: 0,
      credentialSource: 'chrome-cookies',
    });
  }
  user.routes = routes;
  user.providers = user.providers && typeof user.providers === 'object' && !Array.isArray(user.providers)
    ? { ...user.providers } : {};
  user.providers.xiaomi = { baseUrl: 'https://platform.xiaomimimo.com' };
  user.xiaomi = user.xiaomi && typeof user.xiaomi === 'object' && !Array.isArray(user.xiaomi)
    ? { ...user.xiaomi } : {};
  Object.assign(user.xiaomi, patch);
  return user;
}

// F2 (round 6): revalidation persists ONLY the shared source/profile
// selection. It must never resurrect a removed canonical route or touch
// providers — route append + provider pinning remain setup's job.
function writeXiaomiSourceProfile(patch) {
  withConfigLock(() => {
    const user = readUserConfig();
    user.xiaomi = user.xiaomi && typeof user.xiaomi === 'object' && !Array.isArray(user.xiaomi)
      ? { ...user.xiaomi } : {};
    Object.assign(user.xiaomi, patch);
    saveConfig(user);
  });
}

// config.json is published only under the provider mutation lock (lib/config.js
// saveConfig). A Xiaomi writer reads its base document, modifies it and
// publishes it inside ONE hold of the lock, so the document it writes back is
// never built from a read made before another process's publish — not a
// partial one (an unconfirmed read) and not a stale one (a lost update).
// err() exits mid-hold; the exit hook releases the lock so no ticket outlives
// the command. Returns fn's result (a promise when fn is async).
function withConfigLock(fn) {
  const lock = lifecycle.acquireMutationLock(dataDir());
  if (!lock.ok) err('another provider change is in progress, so config.json was not changed — rerun shortly.');
  const release = () => lock.release();
  process.once('exit', release);
  const done = () => { process.removeListener('exit', release); release(); };
  let out;
  try {
    out = fn();
  } catch (e) {
    done();
    throw e;
  }
  if (out && typeof out.then === 'function') return out.finally(done);
  done();
  return out;
}

// Private state reset with the F2 refusal surfaced as one fixed actionable
// error. Used by setup/update/remove; unsafe metadata never gets followed.
// N1: a REAL unlink failure is surfaced as its own classified message (never
// mistaken for absence/success); N2: callers run this BEFORE saving config,
// so any refusal here leaves the prior selection untouched.
function resetXiaomiStateOrFail() {
  try {
    xiaomiSession.resetXiaomiState(dataDir());
  } catch (e) {
    const code = e && e.code === 'metadata-remove-failed'
      ? 'metadata-remove-failed' : 'metadata-unsafe';
    err(xiaomiSession.message(code));
  }
}

// Interactive key grant (round 4) — EXPLICIT setup/update only. The macOS
// dialog is answered by the USER; nothing here automates or bypasses it.
// One instruction line before the prompt (single line, no stack trace); a
// denial refuses the command via err() BEFORE any config is saved, keeping
// the F3/N2 "config only after required steps succeed" invariant.
async function grantInteractiveKeyOrFail() {
  log('Approve Chrome key access: click "Always Allow" (not "Allow") in the macOS dialog.');
  try {
    await xiaomiSession.grantInteractiveKey(dataDir());
  } catch {
    err('Chrome key access was not granted — rerun /view-limits:setup-xiaomi, then click "Always Allow" (not "Allow") in the macOS dialog.');
  }
}

// Round 5 (P2-1): READ-ONLY prevalidation — refuse unsafe/read-only private
// state BEFORE the interactive prompt, with the same classified messages the
// reset uses. Nothing is mutated and config is untouched.
function prevalidateXiaomiStateOrFail() {
  try {
    xiaomiSession.prevalidateXiaomiStateForReset(dataDir());
  } catch (e) {
    const code = e && e.code === 'metadata-remove-failed'
      ? 'metadata-remove-failed' : 'metadata-unsafe';
    err(xiaomiSession.message(code));
  }
}

async function setupXiaomi(cfg, options) {
  if (options.key !== null) {
    err('xiaomi-token-plan stores no key — Chrome console cookies are read at refresh time (no paste form).');
  }
  if (options.headless) err('xiaomi-token-plan stores no key — --headless does not apply.');
  // F1 (round 6): NO hardcoded profile. Priority: explicit --profile → the
  // SAVED selection (a rerun must not clobber it) → 'Default'. An invalid
  // saved value degrades to 'Default'; an invalid EXPLICIT value still errs.
  const savedProfile = cfg && cfg.xiaomi && typeof cfg.xiaomi === 'object'
    ? cfg.xiaomi.chromeProfile : undefined;
  const profile = options.profile !== null && options.profile !== undefined
    ? options.profile
    : (validProfile(savedProfile) ? savedProfile : 'Default');
  if (!validProfile(profile)) err('invalid Chrome profile — use "Default" or "Profile <number>".');
  const source = options.chromeSource ? expandHome(options.chromeSource) : defaultChromeSource();
  if (typeof source !== 'string' || !source.trim()) err('chrome source must be a non-empty path.');

  // F3: STAGE the intended config first, build/install the helper, and only
  // after a successful build commit the config and clear private state. A
  // compile/install/platform failure therefore preserves the prior
  // source/config/suppression — a first setup fails without enabling the
  // route at all, and a failed reconfigure keeps the prior selection.
  // N2: the owned-state reset must COMPLETE before the selection is
  // published — a metadata refusal exits here with config untouched.
  // Round 4: an unchanged native source REUSES the installed helper (its
  // identity — and the user's "Always Allow" grant — survives), and the
  // interactive grant runs before reset+save so the first background read
  // is not denied on a fresh machine.
  // PR #82 round 6: the whole plan → build → grant → reset → commit runs in
  // ONE hold of the provider mutation lock, so the staged document is written
  // back exactly as planned from the document it was planned against.
  await withConfigLock(async () => {
    const planned = planXiaomiConfig({ chromeSource: source, chromeProfile: profile });
    let built;
    try {
      built = await buildHelper({ pluginRoot: PLUGIN_ROOT, dataDir: dataDir() });
    } catch (e) {
      const code = e && typeof e.code === 'string' ? e.code : 'helper-build-failed';
      if (code === 'unsupported-platform') {
        err('helper build requires macOS — the Chrome cookie fallback is macOS-only.');
      }
      if (code === 'helper-build-failed') {
        err('helper build failed — install the Xcode command line tools (xcode-select --install), then rerun /view-limits:setup-xiaomi.');
      }
      err('helper build failed — rerun /view-limits:setup-xiaomi.');
    }
    log(built && built.skippedRebuild
      ? 'helper unchanged — identity preserved'
      : 'background key helper built (non-interactive reads only)');
    // Round 5: refuse unsafe state BEFORE prompting; user-driven Keychain grant
    // next; a denial exits here (no config change). The mutating reset runs
    // only AFTER the grant succeeds.
    prevalidateXiaomiStateOrFail();
    await grantInteractiveKeyOrFail();
    // A successful explicit setup makes the source eligible again: drop any
    // stale rejected-bundle digest or key-failure suppression. Runs BEFORE the
    // config commit so a refusal cannot leave a switched selection behind (N2).
    resetXiaomiStateOrFail();
    saveConfig(planned);
  });
  log(`configured Chrome cookie source for ${XIAOMI_ROUTE_ID} (profile ${profile})`);
  log('run /view-limits to fetch current usage.');
}

// Validate/refresh the configured source+profile (update path). No vault, no
// form, no helper build. Round 4: update DELIBERATELY performs the same
// user-approved interactive key grant as setup (a profile/source change can
// invalidate which store the ACL must cover) — background reads still never
// prompt. Round 5 (P2-1): order is READ-ONLY prevalidation → interactive
// grant → MUTATING reset → publish the selection, so a denied update leaves
// prior config AND both private markers (rejection digest + suppression)
// intact — nothing mutating runs before the grant succeeds.
async function revalidateXiaomiSource(cfg, options) {
  const current = cfg.xiaomi && typeof cfg.xiaomi === 'object' ? cfg.xiaomi : {};
  const profile = options.profile !== null && options.profile !== undefined ? options.profile : current.chromeProfile;
  const source = options.chromeSource ? expandHome(options.chromeSource) : current.chromeSource;
  if (!validProfile(profile)) {
    err('Chrome profile not configured — run /view-limits:setup-xiaomi (use "Default" or "Profile <number>").');
  }
  if (typeof source !== 'string' || !source.length) {
    err('Chrome source not configured — run /view-limits:setup-xiaomi.');
  }
  prevalidateXiaomiStateOrFail();
  await grantInteractiveKeyOrFail();
  resetXiaomiStateOrFail();
  writeXiaomiSourceProfile({ chromeSource: source, chromeProfile: profile });
  log(`Chrome cookie source revalidated for ${XIAOMI_ROUTE_ID} (profile ${profile}).`);
}

async function updateXiaomi(cfg, options) {
  const route = cfg.routes.find((r) => r.id === options.routeId);
  if (!route) err(`${XIAOMI_ROUTE_ID} is not configured — run /view-limits:setup-xiaomi first.`);
  if (options.key !== null) err('xiaomi-token-plan stores no key — no paste form.');
  if (options.headless) err('xiaomi-token-plan stores no key — --headless does not apply.');
  await revalidateXiaomiSource(cfg, options);
}

function removeXiaomi(cfg, routeId) {
  const aliasStillConfigured = withConfigLock(() => {
    const user = readUserConfig();
    const routes = Array.isArray(user.routes) ? user.routes : [];
    const remaining = routes.filter((route) => !(route && route.id === routeId));
    const aliasStillConfigured = remaining.some((route) => route && route.provider === 'xiaomi');
    if (!aliasStillConfigured) {
      // F7: the FINAL Xiaomi route goes — drop its private state first so an
      // unsafe-metadata refusal leaves the config untouched, then remove the
      // saved source/profile and provider metadata with it.
      resetXiaomiStateOrFail();
      delete user.xiaomi;
      if (user.providers && typeof user.providers === 'object' && !Array.isArray(user.providers)) {
        delete user.providers.xiaomi;
      }
    }
    // When another Xiaomi alias still needs the shared source/profile/provider
    // metadata, it is intentionally retained.
    user.routes = remaining;
    saveConfig(user);
    return aliasStillConfigured;
  });
  // Drop any cached counts so no orphan row can render old Xiaomi numbers.
  try {
    const cache = readCache();
    if (cache.routes && Object.prototype.hasOwnProperty.call(cache.routes, routeId)) {
      const cached = { ...cache.routes };
      delete cached[routeId];
      writeCache(cached);
    }
  } catch { /* cache rewrite is best effort */ }
  log(aliasStillConfigured
    ? `disabled route "${routeId}" (shared Chrome cookie source kept for other Xiaomi routes)`
    : `disabled Chrome cookie source for "${routeId}" and removed private metadata`);
}

// Issue #103: the view's banner dependency, installed on a user-invoked setup
// or update. A failure is a notice, never a failure: the view keeps its
// static banner. The line before the install says what is happening, so a
// slow install does not look like a hang.
function installBannerDependency() {
  if (dependencySatisfied(PLUGIN_ROOT)) return true;
  log('installing the view banner dependency…');
  const result = installDependencies({ pluginRoot: PLUGIN_ROOT });
  if (result.ok) {
    log('installed the view banner dependency.');
    return true;
  }
  log('could not install the view banner dependency — the view keeps its static banner.');
  return false;
}

function setup(args) {
  installBannerDependency();
  const cfg = loadConfig();
  const options = parseCredentialArgs(cfg, args, { offerBuiltIns: true });

  // Xiaomi: config + helper build, never the vault or a paste form.
  if (options.routeId === XIAOMI_ROUTE_ID) return setupXiaomi(cfg, options);
  const setupTarget = options.routeId ? cfg.routes.find((r) => r.id === options.routeId) : null;
  if (setupTarget && isXiaomi(setupTarget)) {
    err(`only ${XIAOMI_ROUTE_ID} is supported as a Chrome-cookie source route.`);
  }

  preflightVault();

  // Single route: `vl.js setup <routeId> [--key K]`
  if (options.routeId) return setupOne(cfg, options, true);

  // Repair first: a shipped route whose credential is stored but whose row
  // never materialized (the lock was busy, or config.json was unreadable, after
  // the vault write) gets its row now. materializeBuiltInRoute is idempotent,
  // and this is the rerun its own failure message tells the user to do.
  const rowlessBefore = rowlessCredentials(cfg);
  for (const id of rowlessBefore) materializeBuiltInRoute(id);

  // Initial setup: re-import native, then open the form for whatever's missing.
  const missing = [];
  const imported = [];
  const failed = [];
  for (const route of offerableRoutes(cfg)) {
    if (isXiaomi(route)) continue; // Chrome-cookie source: no vault credential
    const imp = cfg.importMap && cfg.importMap[route.id];
    const secret = imp ? readNativeSecret(imp) : null;
    if (secret) {
      if (storeCredential(route.id, secret)) imported.push(route.id);
      else failed.push(route.id);
      continue;
    }
    if (!vault.has(route.id)) missing.push(route.id);
  }
  if (imported.length) log(`imported from native config: ${imported.join(', ')}`);
  if (failed.length) {
    log(`could not import credentials for: ${failed.join(', ')} — verify vault access and try again.`);
    process.exitCode = 1;
  }
  // Report from the POST-state, re-read from disk: "present" is only true if
  // every stored credential also has its row.
  const after = loadConfig();
  const rowlessAfter = rowlessCredentials(after);
  // "Added" is read off the rows that now exist, not inferred from leaving the
  // row-less set: a credential removed meanwhile leaves that set too, with no row.
  const rowsAfter = new Set((Array.isArray(after.routes) ? after.routes : []).map((r) => r && r.id));
  const repaired = rowlessBefore.filter((id) => rowsAfter.has(id));
  if (repaired.length) log(`added the missing route for stored credentials: ${repaired.join(', ')}`);
  if (rowlessAfter.length) {
    log(`stored credentials still have no route: ${rowlessAfter.join(', ')} — rerun setup once no other provider change is running and config.json is readable.`);
    process.exitCode = 1;
  }
  if (!missing.length) {
    if (!failed.length && !rowlessAfter.length) log('all credentials present.');
    return;
  }
  log(`missing credentials for: ${missing.join(', ')}`);
  if (options.headless) return promptHeadless(missing);
  return openForm(missing);
}

async function update(args) {
  installBannerDependency();
  const cfg = loadConfig();
  const options = parseCredentialArgs(cfg, args);

  // Xiaomi: revalidate source/profile — no vault preflight, no form.
  if (options.routeId === XIAOMI_ROUTE_ID) return updateXiaomi(cfg, options);
  const updateTarget = options.routeId ? cfg.routes.find((r) => r.id === options.routeId) : null;
  if (updateTarget && isXiaomi(updateTarget)) {
    err(`only ${XIAOMI_ROUTE_ID} is supported as a Chrome-cookie source route.`);
  }

  preflightVault();

  // Single route: `vl.js update <routeId>` — rotate one existing key.
  if (options.routeId) return setupOne(cfg, options, false);

  // Bare update: revalidate a configured xiaomi source alongside the others.
  const xiaomiConfigured = cfg.routes.find(isXiaomi) || null;
  // Round 5 (P2-2): the xiaomi revalidate carries the interactive grant and
  // must RESOLVE before any sibling credential is touched — a denial aborts
  // the whole update, so no other bearer key is rotated first.
  if (xiaomiConfigured) await revalidateXiaomiSource(cfg, options);

  // Rotate existing credentials: open the form for configured routes.
  const existing = cfg.routes.filter((r) => !isXiaomi(r) && vault.has(r.id));
  const rowless = rowlessCredentials(cfg);
  if (rowless.length) log(`stored credentials with no route yet: ${rowless.join(', ')} — run: vl.js setup (with no route id) to add them.`);
  if (!existing.length) {
    if (!xiaomiConfigured && !rowless.length) log('no credentials to update — run /view-limits:setup first.');
    return;
  }
  log(`updating credentials for: ${existing.map((r) => r.id).join(', ')}`);
  if (options.headless) return promptHeadless(existing.map((r) => r.id));
  return openForm(existing.map((r) => r.id));
}

function remove(routeId) {
  const cfg = loadConfig();
  const route = cfg.routes.find((r) => r.id === routeId);
  if (routeId === XIAOMI_ROUTE_ID || (route && isXiaomi(route))) {
    if (!route) {
      log(`no Chrome cookie source configured for "${routeId}"`);
      return;
    }
    removeXiaomi(cfg, routeId);
    return;
  }
  // Issue #58: one removal service for every non-Xiaomi route. It clears the
  // vault key, the cached observation, and — for a CUSTOM (monitor-bearing)
  // route — the config entry. A shipped built-in keeps today's semantics: its
  // credential and cache row go, the configured route stays.
  //
  // It performs NO native logout: no subprocess is spawned and no other tool's
  // credential store is read or written, so a recipe that authenticates
  // through its own CLI keeps that CLI's session untouched.
  //
  // `remove` keeps its documented exit codes (0 on success or nothing-to-do,
  // 1 on failure); the stable lifecycle exit-code map belongs to
  // `vl.js provider remove`.
  const result = lifecycle.removeProvider({ routeId }, lifecycleIo(cfg));
  if (result.status === lifecycle.STATUS.NOT_FOUND) {
    log(`no credential for "${routeId}"`);
    return;
  }
  if (!result.ok) {
    log(`could not remove "${routeId}": ${result.error}`);
    if (result.recovery) log(result.recovery);
    process.exitCode = 1;
    return;
  }
  const cleared = [];
  if (result.removed.credential) cleared.push('credential');
  if (result.removed.config) cleared.push('route config');
  if (result.removed.cache) cleared.push('cached status');
  log(cleared.length
    ? `removed ${cleared.join(', ')} for "${routeId}"`
    : `no credential for "${routeId}"`);
  if (result.status === lifecycle.STATUS.CACHE_STALE_WARNING) log(result.error);
}

// ---- provider lifecycle (#58) ------------------------------------------------
//
// `vl.js provider add|update|remove|list` is the shared custom-provider
// lifecycle surface. Everything here is argv parsing, io injection and
// rendering; the ordering, validation, probe classification, retention gate and
// partial-write recovery all live in lib/provider-lifecycle.js so a future
// dashboard can reuse them unchanged.
//
// Headless by construction: no prompt, no stdin read. A non-monitorable probe
// outcome returns `retention-choice-required` (exit 2) with nothing persisted
// rather than waiting for an answer.

function lifecycleIo(cfg) {
  return {
    // Re-read on every call so a step that follows a config write sees it.
    // Strict: every caller (setupProvider/updateProvider/removeProvider) HOLDS
    // the mutation lock, so no publish can be in flight and a miss is proven
    // absence. `provider list` passes the cfg it already read instead.
    effectiveRoutes: () => loadConfigStrict().routes,
    readUserConfig,
    readUserConfigStrict,
    saveConfig,
    // Three-way, like the vault probe. A stat that fails for any reason other
    // than ENOENT is NOT absence, so the migration must never treat it as one.
    // An in-flight or interrupted publish (config.json.prev alone) is present.
    configPresence,
    vault: {
      assertWritable: () => vault.assertWritable(),
      get: (id) => vault.get(id),
      // DIRECT on purpose — never route this through storeCredential(). That
      // helper returns false instead of throwing, so a failed write would be
      // read as stored and a route published with no credential behind it; and
      // for a shipped id it takes the mutation lock to materialize a row, which
      // the lifecycle already HOLDS here — the lock never waits, so that nested
      // acquire would fail busy.
      set: (id, secret) => vault.set(id, secret),
      remove: (id) => vault.remove(id),
      // Strict three-way presence. The lifecycle needs it to tell an absent
      // secret from one it merely could not read: `get`/`remove` report both
      // the same way, so without this a failed delete would be announced as a
      // successful removal.
      probe: (id) => vault.probe(id),
    },
    readCache,
    writeCache,
    lock: () => lifecycle.acquireMutationLock(dataDir()),
    // The probe is the recipe's OWN read-only fetch, resolved exactly as
    // refresh and check resolve it. There is no separate discovery transport
    // and no inference path: see the D1 decision in docs/providers.md.
    probe: async (route, token) => {
      const adapter = getAdapter(route.provider, route, cfg);
      const status = await adapter.fetchStatus(
        cfg.providers[route.provider], token, { threshold: cfg.gate.constrainedThreshold },
      );
      return { status, capability: adapter.capability };
    },
    now: () => Date.now(),
  };
}

const PROVIDER_VALUE_FLAGS = Object.freeze({
  '--label': 'label',
  '--provider': 'provider',
  '--recipe': 'recipe',
  '--endpoint': 'endpoint',
  '--model': 'model',
  '--account': 'account',
  '--profile': 'profile',
  '--region': 'region',
  '--key': 'key',
});

// `--key=sk-…` is not supported syntax (values are separate argv tokens), but
// a user will type it, and the unknown-option error echoes the token back. Any
// `--flag=value` form therefore has its value half redacted before it is
// printed: a mistyped credential must not land in stderr, a terminal
// scrollback or a captured log.
function redactFlagToken(arg) {
  const text = String(arg);
  const eq = text.indexOf('=');
  return eq < 0 ? text : `${text.slice(0, eq)}=<redacted>`;
}

function parseProviderArgs(args) {
  const out = {
    json: false, routeId: null, retention: null, optionPairs: [], matchPairs: {},
    ttlSeconds: undefined,
  };
  for (const field of Object.values(PROVIDER_VALUE_FLAGS)) out[field] = undefined;
  const needValue = (flag, value) => {
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      err(`${flag} requires a non-empty value.`);
    }
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--keep-unmonitored' || arg === '--clear-credential') {
      const choice = arg === '--keep-unmonitored' ? lifecycle.RETENTION.KEEP : lifecycle.RETENTION.CLEAR;
      if (out.retention !== null && out.retention !== choice) {
        err('--keep-unmonitored and --clear-credential cannot be used together.');
      }
      out.retention = choice;
      continue;
    }
    if (arg === '--option') {
      const value = needValue(arg, args[i + 1]);
      const eq = value.indexOf('=');
      if (eq < 1) err('--option requires key=value.');
      out.optionPairs.push([value.slice(0, eq), value.slice(eq + 1)]);
      i += 1;
      continue;
    }
    if (arg === '--match-model' || arg === '--match-harness') {
      const key = arg === '--match-model' ? 'model' : 'harness';
      out.matchPairs[key] = needValue(arg, args[i + 1]);
      i += 1;
      continue;
    }
    if (arg === '--ttl') {
      const value = needValue(arg, args[i + 1]);
      if (!/^\d+$/.test(value)) err('--ttl requires a non-negative integer (seconds).');
      out.ttlSeconds = Number(value);
      i += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(PROVIDER_VALUE_FLAGS, arg)) {
      const field = PROVIDER_VALUE_FLAGS[arg];
      if (out[field] !== undefined) err(`duplicate ${arg} option.`);
      out[field] = needValue(arg, args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) err(`unknown option "${redactFlagToken(arg)}".`);
    if (!arg.trim()) err('route id must not be empty.');
    if (out.routeId) err('only one route can be selected at a time.');
    out.routeId = arg;
  }
  return out;
}

// Coerce `--option k=v` strings using the recipe's declared option spec, so an
// integer option (timeoutMs) is not rejected for arriving as a string. An
// option the recipe does not declare is passed through unchanged and refused by
// the schema with its own message.
function coerceRecipeOptions(recipeId, pairs) {
  if (!pairs.length) return undefined;
  const spec = getOptionSpec(recipeId) || {};
  const out = {};
  for (const [k, v] of pairs) {
    const s = spec[k];
    if (s && s.type === 'integer') {
      if (!/^-?\d+$/.test(v)) err(`--option ${k} must be an integer.`);
      out[k] = Number(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function providerUsage() {
  return 'usage: vl.js provider add --label <label> --recipe <recipe> [--provider P] [--endpoint URL] ' +
    '[--model M] [--account A] [--profile P] [--region R] [--option k=v]... [--match-model M] ' +
    '[--match-harness H] [--ttl S] [--key K] [--keep-unmonitored|--clear-credential] [--json]\n' +
    '       vl.js provider update <routeId> [same mutable flags] [--key K] ' +
    '[--keep-unmonitored|--clear-credential] [--json]\n' +
    '       vl.js provider remove <routeId> [--json]\n' +
    '       vl.js provider list [--json]';
}

// Xiaomi's Chrome-cookie source has its own bespoke setup/update/remove paths
// (helper build, Keychain grant, private-state reset). Routing it through the
// generic lifecycle would clear the wrong state, so it is refused here.
function refuseXiaomiLifecycle(cfg, routeId) {
  if (!routeId) return;
  const route = cfg.routes.find((r) => r.id === routeId);
  if (routeId === XIAOMI_ROUTE_ID || (route && isXiaomi(route))) {
    err(`${routeId} is a Chrome-cookie source — use /view-limits:setup, :update or "vl.js remove ${routeId}".`);
  }
}

function renderLifecycleText(result) {
  const lines = [];
  if (result.command === 'list') {
    for (const row of result.routes) {
      const bits = [row.custom ? `recipe ${row.recipe}` : 'built-in'];
      if (row.retention) bits.push(row.retention);
      bits.push(row.needsCredential ? (row.hasCredential ? 'credential stored' : 'no credential') : 'no credential needed');
      if (row.configObsolete) bits.push('cached status is config-obsolete');
      lines.push(`  ${row.id} (${row.provider}) — ${bits.join(', ')}`);
    }
    if (!result.routes.length) lines.push('  no routes configured');
    return lines.join('\n');
  }
  lines.push(`  ${result.command} ${result.id || ''} → ${result.status}`.trimEnd());
  if (result.probe) lines.push(`  probe: ${result.probe.outcome}${result.probe.reason ? ` (${result.probe.reason})` : ''}`);
  if (result.persisted) {
    const done = Object.entries(result.persisted).filter(([, v]) => v).map(([k]) => k);
    lines.push(`  persisted: ${done.length ? done.join(', ') : 'nothing'}`);
  }
  if (result.removed) {
    const done = Object.entries(result.removed).filter(([, v]) => v === true).map(([k]) => k);
    lines.push(`  removed: ${done.length ? done.join(', ') : 'nothing'}`);
    lines.push('  native CLI login: untouched (no logout is ever performed)');
  }
  if (result.configRevision) lines.push(`  configRevision: ${result.configRevision}`);
  if (result.error) lines.push(`  ${result.error}`);
  if (result.recovery) lines.push(`  recovery: ${result.recovery}`);
  if (result.detail) lines.push(`  ${result.detail}`);
  return lines.join('\n');
}

function emitLifecycleResult(result, json) {
  // One refusal text for an unresolved migration, wherever it was detected.
  if (result && result.status === lifecycle.STATUS.MIGRATION_PENDING) result = { ...result, error: MIGRATION_PENDING_REFUSAL };
  process.stdout.write(json
    ? JSON.stringify(result, null, 2) + '\n'
    : renderLifecycleText(result) + '\n');
  process.exitCode = lifecycle.exitCodeFor(result.status);
}

async function providerCmd(args) {
  const sub = args[0];
  if (!['add', 'update', 'remove', 'list'].includes(sub)) err(providerUsage());
  const cfg = loadConfig();
  const opts = parseProviderArgs(args.slice(1));
  const io = lifecycleIo(cfg);

  if (sub === 'list') {
    if (opts.routeId) err(providerUsage());
    // List exactly the document just confirmed, not a second read of it.
    return emitLifecycleResult(lifecycle.listProviders({ ...io, effectiveRoutes: () => cfg.routes }), opts.json);
  }
  if (sub === 'remove') {
    if (!opts.routeId) err('vl.js provider remove requires a route id.');
    refuseXiaomiLifecycle(cfg, opts.routeId);
    return emitLifecycleResult(lifecycle.removeProvider({ routeId: opts.routeId }, io), opts.json);
  }

  const match = Object.keys(opts.matchPairs).length ? opts.matchPairs : undefined;
  if (sub === 'add') {
    if (opts.routeId) err('vl.js provider add takes --label, not a route id.');
    if (!opts.label) err('vl.js provider add requires --label.');
    if (!opts.recipe) err('vl.js provider add requires --recipe.');
    const result = await lifecycle.setupProvider({
      label: opts.label,
      provider: opts.provider,
      recipe: opts.recipe,
      endpoint: opts.endpoint,
      model: opts.model,
      account: opts.account,
      profile: opts.profile,
      region: opts.region,
      recipeOptions: coerceRecipeOptions(opts.recipe, opts.optionPairs),
      match,
      ttlSeconds: opts.ttlSeconds,
      key: opts.key,
      retention: opts.retention,
    }, io);
    return emitLifecycleResult(result, opts.json);
  }
  // update
  if (!opts.routeId) err('vl.js provider update requires a route id.');
  refuseXiaomiLifecycle(cfg, opts.routeId);
  const existing = cfg.routes.find((r) => r.id === opts.routeId);
  const existingRecipe = existing && existing.monitor && existing.monitor.recipe;
  const result = await lifecycle.updateProvider({
    routeId: opts.routeId,
    provider: opts.provider,
    recipe: opts.recipe,
    endpoint: opts.endpoint,
    model: opts.model,
    account: opts.account,
    profile: opts.profile,
    region: opts.region,
    // `--option` replaces the recipe's full option set rather than merging, so
    // what is written is exactly what was asked for.
    recipeOptions: coerceRecipeOptions(opts.recipe || existingRecipe || '', opts.optionPairs),
    match,
    ttlSeconds: opts.ttlSeconds,
    key: opts.key,
    retention: opts.retention,
  }, io);
  return emitLifecycleResult(result, opts.json);
}

// ---- snapshot ---------------------------------------------------------------
//
// Normalized runtime snapshot. Emits exactly one JSON document on stdout;
// per-diagnostic notices go to stderr. Without --refresh the snapshot path
// performs no provider calls, subprocesses, refresh scheduling, or cache
// writes; --refresh adds only bounded supported Traycer CLI reads.
// Traycer launch-environment identity is request-local evidence about this
// process; it is seeded into the caller context as traycer-env facts (the
// variable names themselves live in lib/traycer-adapter.js).

async function snapshot(args) {
  const allowed = new Set(['--json', '--refresh']);
  if (!args.includes('--json') || args.some((a) => !allowed.has(a))) {
    err('usage: vl.js snapshot --json [--refresh]');
  }
  const snap = await getRuntimeSnapshot({
    refresh: args.includes('--refresh'),
    callerContext: cliCallerContext(),
  });
  for (const d of snap.diagnostics || []) {
    process.stderr.write(`view-limits snapshot: ${d.code} — ${d.summary}\n`);
  }
  process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
}

// ---- view (Phase 3, Issue #59) ----------------------------------------------
//
// `vl.js view [--condensed] [--json]` renders the versioned view schema
// (lib/view-model.js) as the approved text format or as exactly one
// always-valid JSON envelope.
//
// It is cache-only: no provider network, no refresh, no subprocess and no
// write — the same guarantee the report/status/snapshot reads carry. The
// configuration is read through the CONFIRMED reader (the #81 fix-by-default
// path), and the states it can be in map onto the dispatch's own exit codes:
//
//   a confirmed document            -> the view (exit 0)
//   the document is ABSENT          -> the one-time vault->routes migration
//                                       has not resolved: nothing was ever
//                                       published, so a rerun cannot help
//                                       (exit 8)
//   the document is UNCONFIRMABLE   -> it is there but could not be read: a
//                                       publish is in flight, so a rerun may
//                                       (exit 9)
//   a document that cannot be parsed-> CONFIG_CORRUPT (exit 10)
//
// The absence is RE-CONFIRMED after the refused read: lib/config.js's
// presence check (an lstat, never a document read) tells a document that was
// never published (neither config.json nor the .prev a swap leaves behind)
// from one that exists but could not be read. The credential store is NOT
// consulted: an absent configuration is the migration-pending class on its
// own, and a read command must not touch the credential store.
//
// The dispatch-time migration is NOT run for `view`: `view` is a read, and
// the migration publishes config.json. report/status/snapshot do not take it
// either.

// The notice for each refusing state. It is a function, not a constant: the
// fixed config notices are declared further down the file, and reading them
// at call time keeps the module free of a declaration-order trap.
function viewFailureNotice(kind) {
  if (kind === 'config-absent') {
    return 'No configuration yet: run /view-limits:setup to add a provider, or start a new session to finish first-run setup.';
  }
  if (kind === 'config-corrupt') return CONFIG_CORRUPT_NOTICE;
  return CONFIG_INCONCLUSIVE_NOTICE;
}

const VIEW_FAILURE_STATUS = {
  'config-absent': lifecycle.STATUS.MIGRATION_PENDING,
  'config-inconclusive': lifecycle.STATUS.CONFIG_INCONCLUSIVE,
  'config-corrupt': lifecycle.STATUS.CONFIG_CORRUPT,
};

// The always-valid envelope for a refusing state: `not-configured` names the
// absent document, `failed` the two unreadable ones.
function viewFailureEnvelope(kind) {
  const reasonCodes = kind === 'config-corrupt' ? ['config-corrupt']
    : kind === 'config-absent' ? ['config-absent']
    : ['config-inconclusive'];
  return {
    schemaVersion: VIEW_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    status: kind === 'config-absent' ? 'not-configured' : 'failed',
    reasonCodes,
    routes: [],
    // Issue #60: every envelope carries a collection block. The collection
    // never ran here — the configuration was refused before it could — so
    // the block says exactly that.
    collection: buildCollectionBlock({
      outcome: kind === 'config-absent' ? 'no-credentials' : 'not-run',
      published: false,
      reason: reasonCodes[0],
      routes: [],
    }),
  };
}

// One line per FAILED route.
//
// A failed route keeps its prior observation — that is the point — but an old
// fact is never a SILENT substitute for a failure: the output has to say that
// the fetch failed, which route it was and what the error was.
//
// The rotate hint appears where the inventory printed it (the report's route
// line carried it for every provider error); the view never carried one.
//
// Every interpolated value passes through the #88 control-character escaper
// (lib/view-model.js#escapeControlChars): a provider error body may carry
// ESC / C1 / BEL, and those bytes must never reach a terminal raw (B2).
function failedRouteLines(result, what, withRotate) {
  const lines = [];
  for (const r of (result && result.routes) || []) {
    if (r.outcome !== collector.ROUTE_OUTCOME.FAILED) continue;
    const error = diagText(r.error || 'unknown error');
    const entry = result.entries && result.entries[r.id];
    const observedAt = entry && typeof entry.observedAt === 'string' ? entry.observedAt : null;
    const kept = (r.retained === true && observedAt)
      ? `showing the last observation from ${diagText(observedAt)}`
      : 'no cached observation to fall back to';
    // Q34-A: id first, command last — the slash command takes no argument, and
    // `vl.js update <id>` remains the way to rotate exactly one route.
    const rotate = withRotate ? ` (rotate ${diagText(r.id)} via /view-limits:update)` : '';
    lines.push(`view-limits: ${diagText(r.id)} ${what} failed (${error}); ${kept}${rotate}`);
  }
  return lines;
}

// The diagnostic text boundary: fold whitespace, then escape control
// characters (B2). Every diagnostic sink — the refresh failure line and the
// view's stderr notices — uses it.
function diagText(value) {
  return escapeControlChars(collector.oneLine(value === null || value === undefined ? '' : String(value)));
}

// The collection diagnostic. It goes to STDERR: the view's stdout is the
// approved text layout (or the one JSON envelope) and nothing else, so a
// machine consumer never has to parse a human line.
function collectionNotice(result) {
  if (!result) return null;
  const lines = [];
  if (result.outcome === collector.OUTCOME.PARTIAL) {
    const failed = (result.routes || []).filter((r) => r.outcome === collector.ROUTE_OUTCOME.FAILED);
    lines.push(`view-limits: collection partial — ${failed.length} route(s) failed`);
  } else if (result.outcome === collector.OUTCOME.IN_PROGRESS) {
    lines.push('view-limits: collection in progress — another worker is refreshing; showing the last cached status');
  } else if (result.outcome === collector.OUTCOME.FAILED) {
    const detail = result.error ? ` (${diagText(result.error)})` : '';
    lines.push(`view-limits: collection failed — ${diagText(result.reason || 'unknown')}${detail}`);
  } else if (result.outcome === collector.OUTCOME.NO_CREDENTIALS) {
    lines.push('view-limits: no credentials configured yet — showing the last cached status');
  }
  // A native failure is disclosed beside any external outcome that is not
  // itself a collection failure (round-2 R2-1), with the diagnostic codes.
  if (result.native && result.native.outcome === 'failed' && result.outcome !== collector.OUTCOME.FAILED) {
    const codes = (result.native.codes || []).join(', ');
    lines.push(`view-limits: native collection failed — ${diagText(codes || result.native.error || 'unknown error')}`);
  }
  // The failed routes are named, with their errors, on every outcome.
  for (const line of failedRouteLines(result, 'collection', false)) lines.push(line);
  return lines.length ? lines.join('\n') : null;
}

function viewFailure(kind, asJson) {
  if (asJson) process.stdout.write(JSON.stringify(viewFailureEnvelope(kind), null, 2) + '\n');
  process.stderr.write(`view-limits: ${viewFailureNotice(kind)}\n`);
  // The exit code is set, not forced: the JSON envelope on stdout must be
  // flushed before the process ends.
  process.exitCode = lifecycle.exitCodeFor(VIEW_FAILURE_STATUS[kind]);
}

// Issue #103 — the view's live banner.
//
// The banner is drawn by ascii.rest (MIT, Copyright 2026 bas3line —
// https://ascii.rest), loaded HERE and nowhere else: a dynamic import inside
// viewCmd, on a terminal only. No module in lib/ imports it, and the static
// banner in lib/view-model.js stands in whenever it is not loaded.
//
// The options are the README banner's: the same colour, font and shadow, and
// the glint the banner ships with by default.
const BANNER_TEXT = 'View-Limits';
const BANNER_OPTIONS = Object.freeze({ color: ['#3be858', '#ea2f1a'], font: 'tall', shadow: 'heavy' });

// Whether the live banner may be drawn: a real terminal, a full-text view,
// and colour allowed.
//
//   * --json and --condensed never carry a banner — their bytes are fixed.
//   * A pipe or a capture is not a terminal: the static banner stands in.
//   * TERM=dumb is a terminal that cannot show colour.
//   * NO_COLOR, per no-color.org, counts as set when it is present AND
//     non-empty; an empty NO_COLOR is not set.
function bannerAllowed(asJson, condensed) {
  if (asJson || condensed) return false;
  if (process.stdout.isTTY !== true) return false;
  if (process.env.TERM === 'dumb') return false;
  const noColor = process.env.NO_COLOR;
  if (typeof noColor === 'string' && noColor !== '') return false;
  return true;
}

// Draws the live banner: one glint pass, then it rests.
//
// The result says whether the banner was DRAWN and whether it WROTE anything.
// A failure after the first write leaves a half-drawn banner on the screen,
// and the caller must not print a second banner under it — so a write, drawn
// or half-drawn, claims the header.
async function drawBanner() {
  let banner;
  try {
    ({ banner } = await import('ascii.rest/terminal'));
  } catch {
    return { drawn: false, wrote: false };
  }
  // The banner draws to this wrapper, so the writes are observable. The
  // terminal's own TTY flag, size and resize events pass through unchanged.
  let wrote = false;
  const out = {
    isTTY: process.stdout.isTTY,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    write(text) {
      wrote = true;
      return process.stdout.write(text);
    },
    on(event, listener) { return process.stdout.on(event, listener); },
    off(event, listener) { return process.stdout.off(event, listener); },
  };
  try {
    await banner(BANNER_TEXT, { ...BANNER_OPTIONS, seconds: 1, out });
  } catch {
    return { drawn: false, wrote };
  }
  return { drawn: true, wrote };
}

async function viewCmd(args) {
  const allowed = new Set(['--condensed', '--json']);
  if (args.some((a) => !allowed.has(a))) err('usage: vl.js view [--condensed] [--json]');
  const asJson = args.includes('--json');
  const condensed = args.includes('--condensed');

  // The confirmed reader: a document it could not confirm REFUSES instead of
  // falling back to the built-in defaults (#81). The refusal happens BEFORE
  // the collector: a refused configuration never reaches a provider and
  // never writes the cache.
  let cfg;
  try {
    cfg = libLoadConfig();
  } catch (e) {
    if (e && e.code === 'CONFIG_CORRUPT') { viewFailure('config-corrupt', asJson); return; }
    if (!e || e.code !== 'CONFIG_INCONCLUSIVE') throw e;
    // The read was refused. Re-confirm the document's presence: a document
    // that was never published means the one-time vault->routes migration has
    // not resolved (a rerun cannot fix that); a document that IS there but
    // could not be read is unconfirmable (a publish is in flight, so a rerun
    // may).
    const presence = configPresence();
    viewFailure(presence === 'absent' ? 'config-absent' : 'config-inconclusive', asJson);
    return;
  }

  // Issue #60: the view runs the SHARED full-view collection
  // (`collectView`) — the external collection under the worker lock, then
  // the bounded NATIVE observation outside it — and renders what the
  // collection published, or what it kept. The gate and the snapshot stay
  // cache-only (round-2 R2-3).
  //
  // The native snapshot is assembled with the display-only Xiaomi overlay
  // (round-2 R2-2): the just-observed Xiaomi statuses are projected so a
  // successful live collection renders healthy/fresh, while the gate keeps
  // reading the raw zero-TTL cache.
  const result = await collector.collectView({
    cfg,
    io: {
      callerContext: cliCallerContext(),
      readConfig: () => ({ cfg, corrupt: false, inconclusive: false }),
      // `external` is the whole external result. On the two lock outcomes the
      // collection observed nothing, so the Xiaomi rows would vanish from the
      // overlay; they show pending instead (CR4), like refresh's contention
      // path. Every other missing status stays missing. Built lazily, when
      // the status reader runs (F1).
      readStatusFor: (external) => {
        const lockHeld = external.outcome === collector.OUTCOME.IN_PROGRESS
          || (external.outcome === collector.OUTCOME.FAILED
            && external.reason === collector.REASON.LOCK_UNAVAILABLE);
        let statuses = external.statuses;
        if (lockHeld) {
          statuses = {};
          for (const route of cfg.routes) {
            if (isXiaomi(route)) statuses[route.id] = xiaomiSession.pendingStatus();
          }
        }
        return overlayReader(cfg, xiaomiLiveEntries(cfg, statuses));
      },
    },
  });

  // The cache is read AFTER the collection, so the view describes what was
  // published (or what was kept). It is read once and used for BOTH the
  // snapshot and the gate's own freshness decision, so the two can never
  // describe different data.
  const statusDoc = defaultReadStatus(dataDir());
  const doc = statusDoc && statusDoc.doc && typeof statusDoc.doc === 'object' ? statusDoc.doc : null;
  const cacheRoutes = doc && doc.routes && typeof doc.routes === 'object' && !Array.isArray(doc.routes)
    ? doc.routes
    : {};

  const routesById = {};
  const recipeOf = {};
  for (const r of (Array.isArray(cfg.routes) ? cfg.routes : [])) {
    if (!r || typeof r.id !== 'string') continue;
    routesById[r.id] = r;
    // A recipe route's provider id is free-form; the recipe is its stable
    // identity, and the product name keys on it.
    if (r.monitor && typeof r.monitor.recipe === 'string') recipeOf[r.id] = r.monitor.recipe;
  }

  // The snapshot the collector ran is the one the view renders. If the
  // native observation itself threw (defensive — the snapshot service
  // degrades by contract), fall back to the cache-only snapshot so the view
  // still renders.
  const snap = result.snapshot || await getRuntimeSnapshot({
    callerContext: cliCallerContext(),
    io: {
      readConfig: () => ({ cfg, corrupt: false, inconclusive: false }),
    },
  });
  const schema = buildViewSchema(snap, {
    generatedAt: snap.generatedAt,
    gate: { entries: cacheRoutes, routes: routesById, now: Date.now() },
    recipeOf,
    // The same threshold the gate marks a route constrained at.
    threshold: (cfg.gate && typeof cfg.gate.constrainedThreshold === 'number')
      ? cfg.gate.constrainedThreshold : 0.2,
    now: Date.now(),
    collection: buildCollectionBlock({
      outcome: result.outcome,
      published: result.published === true,
      reason: result.reason,
      error: result.error,
      routes: result.routes,
      native: result.native,
    }),
  });

  const notice = collectionNotice(result);
  if (notice) process.stderr.write(`${notice}\n`);

  if (asJson) {
    process.stdout.write(JSON.stringify(schema, null, 2) + '\n');
  } else {
    // Issue #103: on a terminal the header is the live banner — one glint
    // pass, then it rests — and the body starts under the banner it already
    // printed. Everywhere else the static banner is part of the text.
    let header;
    if (bannerAllowed(asJson, condensed)) {
      const drawn = await drawBanner();
      // A banner that wrote anything — drawn, or half-drawn before a failure
      // — owns the header: the static banner must not print under it.
      if (drawn.drawn || drawn.wrote) header = [];
    }
    process.stdout.write(renderViewText(schema, { condensed, header }).join('\n') + '\n');
  }
  // A collection that FAILED — the lock errored, the publish failed, or
  // every attempted route failed — prints the envelope AND exits nonzero.
  // The envelope is always valid; the data behind it is not current.
  if (result.outcome === collector.OUTCOME.FAILED) process.exitCode = 1;
}

// ---- dashboard (Issue #61, launch path Issue #136) ---------------------------
//
//   vl.js dashboard start [--port N] [--host 127.0.0.1] [--interval SECONDS]
//   vl.js dashboard open  [--port N] [--host 127.0.0.1] [--interval SECONDS] [--no-open]
//   vl.js dashboard stop
//   vl.js dashboard status [--json]
//
// The persistent dashboard daemon, one per data directory (lib/dashboard/).
// This is the Claude-free wrapper: flag parsing, the confirmed config read,
// the daemon's collection (`vl.js view --json` as a bounded subprocess — see
// lib/dashboard/view-runner.js) and printing. `__daemon` is the detached
// process `start` spawns; it is not a user command.

const DASHBOARD_USAGE = 'usage: vl.js dashboard start [--port N] [--host 127.0.0.1] [--interval SECONDS] | stop | status [--json]\n' +
  '       vl.js dashboard open [--port N] [--host 127.0.0.1] [--interval SECONDS] [--no-open]\n' +
  '       vl.js dashboard lan enable --interface IP [--port N] | lan disable | lan rotate | lan url';

// Exit codes: 0 ok · 1 failure or refusal · 2 usage · 3 status: not running
// (stopped, stale or unverified) · 9/10 config refused (shared with view).
const DASHBOARD_EXIT_USAGE = 2;
const DASHBOARD_EXIT_NOT_RUNNING = 3;
// How long `open` waits for the browser opener to answer. An opener that has
// not answered by then already has the address, so `open` never blocks on a
// browser; the child is detached and outlives this process.
const OPENER_WAIT_MS = 3000;

function dashboardUsage(msg) {
  process.stderr.write(`view-limits: ${msg}\n${DASHBOARD_USAGE}\n`);
  process.exit(DASHBOARD_EXIT_USAGE);
}

// `--flag value` and `--flag=value`; unknown, repeated or valueless flags are usage errors.
function parseDashboardFlags(args, allowed) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const eq = args[i].indexOf('=');
    const name = eq === -1 ? args[i] : args[i].slice(0, eq);
    if (!allowed.includes(name)) dashboardUsage(`unknown option ${JSON.stringify(args[i])}.`);
    if (Object.prototype.hasOwnProperty.call(out, name)) dashboardUsage(`${name} was given twice.`);
    let value = eq === -1 ? args[i + 1] : args[i].slice(eq + 1);
    if (eq === -1) i += 1;
    if (value === undefined || value === '') dashboardUsage(`${name} needs a value.`);
    out[name] = value;
  }
  return out;
}

// A whole decimal number or nothing: "30s", "1e2", "0x10" and " 5" are not numbers here.
function strictInteger(text) {
  return /^\d{1,9}$/.test(text) ? Number(text) : NaN;
}

function printDashboardStatus(info, asJson) {
  if (asJson) {
    // Never the record's nonce: the status shape is built from named fields.
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }
  const lines = [];
  if (info.state === 'running') {
    lines.push(`dashboard: running at ${info.url} (pid ${info.pid}, up ${info.uptimeSeconds}s, interval ${info.intervalSeconds}s)`);
    const c = info.collection;
    if (!c || !c.lastAttempt) {
      lines.push('collection: pending — no result yet');
    } else {
      const a = c.lastAttempt;
      const age = c.observationAgeSeconds === null ? 'no successful observation yet' : `last good observation ${c.observationAgeSeconds}s ago`;
      lines.push(`collection: last attempt ${a.finishedAt} → ${a.outcome}${a.reason ? ` (${a.reason})` : ''}${a.error ? `: ${a.error}` : ''}; ${age}${c.stale ? ' — STALE' : ''}`);
    }
  } else if (info.state === 'stopped') {
    lines.push('dashboard: not running');
  } else if (info.state === 'stale') {
    lines.push(`dashboard: not running — a stale record names pid ${info.pid} at ${info.url} (${info.reason}); \`dashboard start\` recovers it`);
  } else if (info.state === 'unverified') {
    lines.push(`dashboard: UNVERIFIED — a record names pid ${info.pid} at ${info.url} but its identity could not be established (${info.reason}); it was not trusted and nothing was signalled`);
  } else {
    lines.push('dashboard: dashboard.json is unreadable — not running as far as can be verified; `dashboard start` replaces it once it holds the ownership lock');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

// The browser opener for `dashboard open` (Issue #136). ONE argv array, never a
// shell string: the URL is its own element, so nothing in it can be read back as
// shell syntax. macOS `open`, Linux `xdg-open`, Windows `cmd /c start "" <url>`
// — the empty element is `start`'s window title, which is what keeps the URL a
// title argument rather than the thing to open. What is handed over is always
// the loopback page URL: never the LAN link, the LAN read token or the control
// nonce.
//
// This is a second opener rather than a reuse of the credential form's
// `openBrowser` on purpose: that one fires the spawn and forgets it, so it can
// neither report a missing browser (which `open` must do in one line without
// failing the command) nor detach, and a browser process that outlives the CLI
// would hold `dashboard open` in the foreground. Fixing that means editing the
// setup path, which is not this command's file.
function openerCommand(url, platform) {
  if (platform === 'win32') return { file: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { file: 'open', args: [url] };
  return { file: 'xdg-open', args: [url] };
}

// → { ok: true } | { ok: false, error }. Detached with no stdio, so the
// opener cannot hold this process open, and a slow one is not waited on past
// OPENER_WAIT_MS: the address has already been handed over.
function openDashboardPage(url, { platform = process.platform, spawnFn = spawn, waitMs = OPENER_WAIT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      const cmd = openerCommand(url, platform);
      child = spawnFn(cmd.file, cmd.args, { detached: true, stdio: 'ignore' });
    } catch (e) {
      resolve({ ok: false, error: escapeControlChars(openerProblem(e)) });
      return;
    }
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // No answer in the window: treated as opened, and the detached child
    // keeps the browser after this process exits.
    const timer = setTimeout(() => settle({ ok: true }), waitMs);
    child.on('error', (e) => settle({ ok: false, error: escapeControlChars(openerProblem(e)) }));
    child.on('exit', (code) => settle(code === 0
      ? { ok: true }
      : { ok: false, error: `the browser opener exited ${code}` }));
    if (typeof child.unref === 'function') child.unref();
  });
}

// A diagnostic is one line and free of control characters: it reaches stdout
// and, through the command shim, a chat transcript. Node names the failing
// command in the message (`spawn open ENOENT`), which is what a user needs:
// a bare errno code says only that something is missing, not what.
function openerProblem(e) {
  if (!e) return 'the browser opener could not be started';
  return String(e.message || e.code || e).replace(/^Error:\s*/, '');
}

// Issue #148: the confirmed config read for the dashboard's start path.
//
// lib/config.js's lax read cannot tell a config.json that was never published
// from one being replaced while it was read (#81): both throw
// CONFIG_INCONCLUSIVE. `view` separates the two by re-confirming the
// document's presence after the refusal, and the dashboard does the same here,
// so a data directory that has never been set up is no longer reported as a
// retry that can never help:
//
//   absent        -> nothing was ever published: `view`'s own first-run notice
//                    and exit 8 (the migration-pending class)
//   anything else -> unconfirmable (a publish is in flight, so a rerun may
//                    help): the mid-write notice and exit 9, unchanged
//   corrupt       -> the corrupt notice and exit 10, unchanged
//
// The presence check is an lstat, never a document read, and takes no lock. An
// lstat that finds nothing is not yet proof, though: a FIRST publish in flight
// has written its temp file but not linked config.json in. So "absent" is
// confirmed before it is believed. Every publisher holds the provider mutation
// lock, which it makes the directory for first; with no such directory nothing
// has ever published or is publishing, and absence is proven without writing
// anything. With one, the #81 strict reader proves it under the lock: ENOENT is
// the proof (exit 8); a lock that cannot be had within its wait, or any other
// inconclusive answer, is a publish in flight (exit 9); a document that has
// appeared is read normally.
// The notices are read at call time, like viewFailureNotice's, so the
// declaration order further down the file costs nothing.
function dashboardConfig() {
  try {
    return libLoadConfig();
  } catch (e) {
    if (e && e.code === 'CONFIG_INCONCLUSIVE') {
      if (configPresence() !== 'absent') exitInconclusive();
      dashboardConfirmAbsent();
      try {
        return libLoadConfig();
      } catch (again) {
        if (again && again.code === 'CONFIG_CORRUPT') exitCorrupt();
        exitInconclusive();
      }
    }
    if (e && e.code === 'CONFIG_CORRUPT') exitCorrupt();
    throw e;
  }
}

// Exits 8 (proven absent) or 9 (cannot be proven); returns only when the
// document turns out to be there.
function dashboardConfirmAbsent() {
  let lockDirExists = true;
  try {
    fs.lstatSync(path.join(dataDir(), lifecycle.LOCK_DIR));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') exitInconclusive();
    lockDirExists = false;
  }
  if (lockDirExists) {
    try {
      readConfigText({ strict: true });
      return;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') exitInconclusive();
    }
  }
  log(viewFailureNotice('config-absent'));
  process.exit(lifecycle.exitCodeFor(lifecycle.STATUS.MIGRATION_PENDING));
}

// The start path, shared by `dashboard start` and `dashboard open` (Issue
// #136) so the two cannot drift: the confirmed config read, the LAN
// validation, the daemon spawn and every refusal message, unchanged. A
// failure still exits through `err` with the same text and the same code.
// On success it returns the loopback URL. `opts.quiet` (set by `open`)
// prints neither success line; `opts.reuse` (set by `open`) answers a
// verified running instance with its URL instead of the refusal.
async function dashboardStart(dir, rest, dashboard, lanLib, opts) {
  const quiet = opts.quiet === true;
  const reuse = opts.reuse === true;
  const flags = parseDashboardFlags(rest, ['--port', '--host', '--interval']);
  const port = flags['--port'] === undefined ? 0 : strictInteger(flags['--port']);
  const flagInterval = flags['--interval'] === undefined ? undefined : strictInteger(flags['--interval']);
  const bind = dashboard.validateBind({ host: flags['--host'], port });
  if (!bind.ok) err(`dashboard start: ${bind.error}`);
  // The confirmed config read: a configuration that cannot be proven
  // refuses (exit 8 / 9 / 10) instead of starting a daemon on guessed
  // defaults, and a data dir that was never set up is the first-run case
  // (Issue #148), not a mid-write retry.
  const cfg = dashboardConfig();
  const interval = resolveDashboardInterval(cfg, Number.isNaN(flagInterval) ? -1 : flagInterval);
  if (!interval.ok) err(`dashboard start: ${interval.error}`);
  // The LAN view (off unless config.dashboard.lan.enabled): a bad value or
  // an interface not on this machine refuses; a missing or unsafe read
  // token refuses with exit 10. The token itself never goes into argv.
  const lanCfg = lanLib.resolveLanConfig(cfg);
  if (!lanCfg.ok) err(`dashboard start: ${lanCfg.error}`);
  if (lanCfg.enabled) {
    const tok = lanLib.readToken(dir);
    if (!tok.ok) exitLanToken(`dashboard start: ${lanLib.tokenProblem(tok.reason)}`);
  }
  const t = cfg.gate && cfg.gate.constrainedThreshold;
  const started = await dashboard.startDaemon({
    dir,
    daemonArgs: [__filename, 'dashboard', '__daemon', '--host', bind.host, '--port', String(bind.port), '--interval', String(interval.seconds),
      ...(typeof t === 'number' && t > 0 && t < 1 ? ['--threshold', String(t)] : []),
      ...(lanCfg.enabled ? ['--lan-address', lanCfg.address, '--lan-port', String(lanCfg.port)] : [])],
  });
  if (started.ok) {
    if (!quiet) {
      process.stdout.write(`dashboard: started at ${started.url} (pid ${started.pid}, interval ${started.intervalSeconds}s${interval.source === 'default' ? '' : `, from ${interval.source}`})\n`);
      if (started.lan) process.stdout.write(`dashboard: LAN view (read-only) on http://${lanLib.hostFor(started.lan.address, started.lan.port)}/ — \`vl.js dashboard lan url\` prints the phone link\n`);
    }
    return started.url;
  }
  if (started.reason === 'already-running' || started.reason === 'held') {
    const info = started.info || await waitForDashboard(dashboard, dir);
    if (info && info.state === 'running') {
      // `open` got here after `status` reported nothing running, so an
      // instance that appeared in the meantime is reused, not refused.
      if (reuse) return info.url;
      err(`dashboard start: already running at ${info.url} (pid ${info.pid})`);
    }
    err('dashboard start: another start is in progress or holds the ownership lock; run `dashboard status`');
  }
  const reasons = {
    unverified: 'a record names an instance that could not be verified; nothing was signalled — run `dashboard status`',
    'bind-failed': `could not listen on ${bind.host}:${bind.port}${started.code ? ` (${started.code})` : ''}; nothing was published`,
    'no-identity': 'the process start time could not be read (is `ps` available?), so the daemon would be unverifiable after a crash',
    'ready-timeout': 'the daemon did not report ready in time (see dashboard.log in the data directory)',
    'lan-bind-failed': `could not listen on the LAN interface${lanCfg.enabled ? ` ${lanLib.hostFor(lanCfg.address, lanCfg.port)}` : ''}${started.code ? ` (${started.code})` : ''}; nothing was published — run \`vl.js dashboard lan disable\`, or pick another port with \`vl.js dashboard lan enable --interface <ip> --port N\``,
    'lan-token-unreadable': lanLib.tokenProblem('unreadable'),
  };
  err(`dashboard start: ${reasons[started.reason] || `${started.reason}${started.error ? ` (${started.error})` : ''}`}`);
}

async function dashboardCmd(args) {
  const sub = args[0];
  const rest = args.slice(1);
  const dashboard = require('../lib/dashboard/daemon');
  const lanLib = require('../lib/dashboard/lan');
  const dir = dataDir();

  if (sub === 'status') {
    const flags = rest.length ? parseDashboardFlags(rest.map((a) => (a === '--json' ? '--json=1' : a)), ['--json']) : {};
    const info = await dashboard.statusDaemon(dir);
    printDashboardStatus(info, flags['--json'] !== undefined);
    if (info.state !== 'running') process.exitCode = DASHBOARD_EXIT_NOT_RUNNING;
    return;
  }

  if (sub === 'stop') {
    if (rest.length) dashboardUsage('stop takes no options.');
    const res = await dashboard.stopDaemon(dir);
    if (res.ok) { process.stdout.write('dashboard: stopped\n'); return; }
    if (res.reason === 'not-running') {
      const why = res.state === 'stopped' ? 'it is not running' : `no verified instance (${res.state}${res.detail ? `: ${res.detail}` : ''}); nothing was signalled`;
      err(`dashboard stop: ${why}`);
    }
    if (res.reason === 'stop-timeout') err('dashboard stop: the daemon accepted the request but did not exit in time; nothing was signalled');
    err(`dashboard stop: refused (${res.reason}${res.status ? ` ${res.status}` : ''})`);
  }

  if (sub === 'start') { await dashboardStart(dir, rest, dashboard, lanLib, {}); return; }

  if (sub === 'open') {
    // Issue #136: start-or-reuse, print the address, then hand it to the
    // browser. `--no-open` is the headless form: the address and nothing
    // else, and it launches nothing.
    const flags = parseDashboardFlags(rest.map((a) => (a === '--no-open' ? '--no-open=1' : a)),
      ['--port', '--host', '--interval', '--no-open']);
    const startArgs = rest.filter((a) => a !== '--no-open' && !a.startsWith('--no-open='));
    // Reuse only a VERIFIED running instance: statusDaemon confirms the
    // process identity and the loopback answer before it reports `running`
    // (C-002), and reuse starts nothing. A stale record, an absent one and a
    // corrupt one all go through the start path, which recovers the stale
    // record and refuses an unverified one with the existing message and code.
    const info = await dashboard.statusDaemon(dir);
    const url = info.state === 'running'
      ? info.url
      : await dashboardStart(dir, startArgs, dashboard, lanLib, { quiet: true, reuse: true });
    process.stdout.write(`dashboard: running at ${url}\n`);
    if (flags['--no-open'] === undefined) {
      // A missing or failing opener is not a failed command: the address is
      // printed, the daemon stays running, and the exit stays 0.
      const opened = await openDashboardPage(url);
      if (!opened.ok) process.stdout.write(`dashboard: browser not opened (${opened.error})\n`);
    }
    return;
  }

  if (sub === '__daemon') {
    // `--threshold` is internal: `start` hands the daemon the gate's threshold
    // from the config it has already confirmed, so the page colours bars at it.
    const flags = parseDashboardFlags(rest, ['--port', '--host', '--interval', '--threshold', '--lan-address', '--lan-port']);
    const port = flags['--port'] === undefined ? 0 : strictInteger(flags['--port']);
    const bind = dashboard.validateBind({ host: flags['--host'], port });
    if (!bind.ok) err(`dashboard daemon: ${bind.error}`);

    // __daemon: the detached process. It reports through fd 3 (the ready
    // channel) and logs to stderr, which `start` pointed at dashboard.log.
    const interval = strictInteger(flags['--interval']);
    const ready = (payload) => {
      try { fs.writeSync(3, `${JSON.stringify(payload)}\n`); fs.closeSync(3); } catch { /* run without a ready channel */ }
    };
    const log = (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);
    const { createViewRunner } = require('../lib/dashboard/view-runner');
    process.on('uncaughtException', (e) => {
      log(`fatal: ${(e && e.message) || e}`);
      process.exit(1);
    });
    // Absent or malformed, the page keeps its 0.2 default (the gate's own).
    const threshold = /^0\.\d+$/.test(flags['--threshold'] || '') ? Number(flags['--threshold']) : null;
    // `start` validated the LAN interface and the token; the daemon re-reads
    // the token file itself (never argv) whenever it changes.
    let lan = null;
    if (flags['--lan-address'] !== undefined) {
      const lanPort = strictInteger(flags['--lan-port'] || '');
      if (lanLib.addressProblem(flags['--lan-address']) || !(lanPort >= lanLib.PORT_MIN && lanPort <= lanLib.PORT_MAX)) {
        ready({ ok: false, reason: 'invalid-lan', error: 'invalid LAN address or port' });
        process.exit(1);
      }
      lan = { address: lanLib.canonicalAddress(flags['--lan-address']), port: lanPort, currentToken: lanLib.createTokenReader(dir) };
    }
    const handle = await dashboard.runDaemon({
      dir, host: bind.host, port: bind.port, intervalSeconds: interval, log, threshold, lan,
      collect: createViewRunner({ vlPath: __filename, cwd: dir }),
      // After the record is published and BEFORE the first collection spawns:
      // answer `start` and close fd 3, so no collection child can inherit it.
      onReady: (h) => {
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { h.shutdown(signal); });
        process.removeAllListeners('uncaughtException');
        process.on('uncaughtException', (e) => {
          log(`fatal: ${(e && e.message) || e}`);
          h.shutdown('fatal').finally(() => process.exit(1));
        });
        ready({ ok: true, url: h.url, instanceId: h.instanceId, intervalSeconds: h.intervalSeconds, lan: h.lan });
      },
    });
    if (!handle.ok) {
      ready({ ok: false, reason: handle.reason, code: handle.code || null, error: handle.error || null });
      process.exit(1);
    }
    await handle.stopped;
    process.exit(0);
  }

  if (sub === 'lan') { await dashboardLanCmd(dir, rest, dashboard); return; }

  dashboardUsage(sub ? `unknown dashboard command ${JSON.stringify(sub)}.` : 'a dashboard command is required.');
}

// A read token that cannot be trusted refuses like an unreadable config (10).
function exitLanToken(msg) {
  log(msg);
  process.exit(10);
}

// Read-modify-write config.json's dashboard.lan under the provider mutation
// lock. `mutate(lanSection|undefined, doc)` returns the new section, or
// undefined to write nothing. → what `mutate` returned. A broken document is
// never rewritten: it refuses with exit 9 / 10.
function writeLanConfig(mutate) {
  const lock = lifecycle.acquireMutationLock(dataDir());
  if (!lock.ok) err('dashboard lan: another provider or config change holds the lock; rerun in a moment.');
  let outcome;
  try {
    const read = readUserConfigStrict();
    if (!read.ok) outcome = { refuse: read.reason };
    else {
      const doc = read.doc;
      if (doc.dashboard !== undefined && (doc.dashboard === null || typeof doc.dashboard !== 'object' || Array.isArray(doc.dashboard))) {
        outcome = { error: 'config.json "dashboard" must be an object; fix it by hand, then rerun.' };
      } else {
        const section = doc.dashboard ? doc.dashboard.lan : undefined;
        const next = mutate(section, doc);
        if (next !== undefined) {
          doc.dashboard = Object.assign({}, doc.dashboard || {}, { lan: next });
          saveConfig(doc);
        }
        outcome = { value: next };
      }
    }
  } catch (e) {
    outcome = { error: e && e.lanRefusal ? e.lanRefusal : e && e.code === 'CONFIG_MIGRATION_PENDING'
      ? 'config.json does not exist yet; run /view-limits:setup to add a provider first.'
      : `config.json could not be written (${(e && e.code) || 'write-failed'}).` };
  } finally {
    lock.release();
  }
  if (outcome.refuse === 'inconclusive') exitInconclusive();
  if (outcome.refuse) exitCorrupt();
  if (outcome.error) err(`dashboard lan: ${outcome.error}`);
  return outcome.value;
}

async function dashboardLanCmd(dir, args, dashboard) {
  const lanLib = require('../lib/dashboard/lan');
  const action = args[0];
  const rest = args.slice(1);
  const running = async () => (await dashboard.statusDaemon(dir)).state === 'running';

  if (action === 'enable') {
    const flags = parseDashboardFlags(rest, ['--interface', '--port']);
    const address = lanLib.canonicalAddress(flags['--interface']);
    if (address === undefined) dashboardUsage('lan enable needs --interface <ip> (a LAN or Tailscale address of this machine).');
    const flagPort = flags['--port'] === undefined ? undefined : strictInteger(flags['--port']);
    if (Number.isNaN(flagPort)) dashboardUsage(`--port must be a whole number; got ${JSON.stringify(flags['--port'])}.`);
    const here = lanLib.localAddresses();
    const choices = here.length ? `this machine's addresses: ${here.join(', ')}` : 'this machine has no LAN or Tailscale address right now';
    const problem = lanLib.addressProblem(address);
    if (problem) err(`dashboard lan enable: ${address} ${problem}; pick one of ${choices}.`);
    if (!here.some((a) => lanLib.canonicalAddress(a) === address)) err(`dashboard lan enable: ${address} is not an address on this machine right now; pick one of ${choices}.`);
    if (flagPort !== undefined && (flagPort < lanLib.PORT_MIN || flagPort > lanLib.PORT_MAX)) err(`dashboard lan enable: --port must be from ${lanLib.PORT_MIN} to ${lanLib.PORT_MAX}; got ${flagPort}.`);

    const tok = lanLib.readToken(dir);
    if (!tok.ok && tok.reason !== 'absent') exitLanToken(`dashboard lan enable: ${lanLib.tokenProblem(tok.reason)}`);

    // The port is chosen once and then kept, so a bookmark survives restarts:
    // --port, else the port already in config, else a free one picked now.
    let free = null;
    if (flagPort === undefined) {
      free = await lanLib.pickFreePort(address);
      if (!free.ok) err(`dashboard lan enable: could not find a free port on ${address} (${free.error}); give one with --port N.`);
    }
    const written = writeLanConfig((section) => {
      const prev = section && typeof section === 'object' ? section.port : undefined;
      const keep = Number.isInteger(prev) && prev >= lanLib.PORT_MIN && prev <= lanLib.PORT_MAX ? prev : undefined;
      return { enabled: true, interface: address, port: flagPort !== undefined ? flagPort : (keep !== undefined ? keep : free.port) };
    });
    const port = written.port;
    if (!tok.ok) {
      const wrote = lanLib.writeToken(dir);
      if (!wrote.ok) err(`dashboard lan enable: the LAN read token could not be written (${wrote.error}); the LAN view stays unusable until \`vl.js dashboard lan rotate\` succeeds.`);
    }
    process.stdout.write(`dashboard: LAN view enabled on http://${lanLib.hostFor(address, port)}/ (read-only, redacted). \`vl.js dashboard lan url\` prints the phone link.\n`);
    process.stdout.write(await running()
      ? 'dashboard: takes effect at the next start: the running daemon is not serving it yet. Run `vl.js dashboard stop`, then `vl.js dashboard start`.\n'
      : 'dashboard: it starts with the daemon: `vl.js dashboard start`.\n');
    return;
  }

  if (action === 'disable') {
    if (rest.length) dashboardUsage('lan disable takes no options.');
    // The interface, port and token are kept, so enabling again restores the
    // same phone link. An absent section is a no-op; a present but invalid
    // one is refused and left as it is, never rewritten (fail loudly). The
    // check is the document's, not this machine's: an interface that is gone
    // can still be disabled.
    const next = writeLanConfig((section, doc) => {
      if (section === undefined) return undefined;
      const check = lanLib.resolveLanConfig(doc, { interfaces: null });
      if (!check.ok) throw Object.assign(new Error('invalid dashboard.lan'), { lanRefusal: check.error });
      return Object.assign({}, section, { enabled: false });
    });
    if (next === undefined) { process.stdout.write('dashboard: the LAN view is already off.\n'); return; }
    process.stdout.write('dashboard: LAN view disabled. The same phone link works again if you re-enable it; `vl.js dashboard lan rotate` replaces it.\n');
    process.stdout.write(await running()
      ? 'dashboard: takes effect at the next start: the running daemon keeps serving the LAN view until you run `vl.js dashboard stop` (then `vl.js dashboard start` for the loopback page alone).\n'
      : 'dashboard: nothing is serving it now.\n');
    return;
  }

  if (action === 'rotate') {
    if (rest.length) dashboardUsage('lan rotate takes no options.');
    const wrote = lanLib.writeToken(dir);
    if (!wrote.ok) err(`dashboard lan rotate: the new read token could not be written (${wrote.error}); the previous link still works.`);
    process.stdout.write('dashboard: LAN read token rotated. Every phone link issued before now stopped working (at once, if the daemon is running). `vl.js dashboard lan url` prints the new link.\n');
    return;
  }

  if (action === 'url') {
    if (rest.length) dashboardUsage('lan url takes no options.');
    const cfg = loadConfig();
    const lanCfg = lanLib.resolveLanConfig(cfg);
    if (!lanCfg.ok) err(`dashboard lan url: ${lanCfg.error}`);
    if (!lanCfg.enabled) err('dashboard lan url: the LAN view is off; run `vl.js dashboard lan enable --interface <ip>` first.');
    const tok = lanLib.readToken(dir);
    if (!tok.ok) exitLanToken(`dashboard lan url: ${lanLib.tokenProblem(tok.reason)}`);
    // The ONE place the token is printed.
    process.stdout.write(`${lanLib.lanUrl(lanCfg.address, lanCfg.port, tok.token)}\n`);
    log('anyone on your network with this link can read the dashboard (read-only, no identifiers); `vl.js dashboard lan rotate` revokes it.');
    return;
  }

  dashboardUsage(action ? `unknown lan command ${JSON.stringify(action)}.` : 'a lan command is required (enable, disable, rotate or url).');
}

// After losing the ownership lock the winner may not have published yet.
async function waitForDashboard(dashboard, dir) {
  const end = Date.now() + 5000;
  for (;;) {
    const info = await dashboard.statusDaemon(dir);
    if (info.state === 'running' || Date.now() >= end) return info;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---- recommend ---------------------------------------------------------------
//
// Advisory recommendation over the cache-only snapshot. One configured route
// becomes one candidate; model/harness/profile/route facts come straight from
// the snapshot (configured bindings stay configured, observed state stays
// observed, absent stays unknown — nothing is substituted). The Jev path is
// present but dormant: the readiness gate evaluates CLOSED on current
// evidence, so no Jev transport is ever invoked on this path.

async function recommendCmd(args) {
  const usage = 'usage: vl.js recommend --json [--task <json>] [--policy <json>]';
  let taskInput = {};
  let policyInput = {};
  let sawJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { sawJson = true; continue; }
    if (a === '--task' || a === '--policy') {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) err(usage);
      let parsed;
      try {
        parsed = JSON.parse(v);
      } catch {
        err(`invalid JSON for ${a}`);
      }
      // A non-object document is not a task/policy — merging it would discard
      // the strict defaults wholesale and silently disable requirement
      // checks. Reject it rather than fail open.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        err(`${a} must be a JSON object`);
      }
      if (a === '--task') taskInput = parsed;
      else policyInput = parsed;
      i += 1;
      continue;
    }
    err(usage);
  }
  if (!sawJson) err(usage);

  // Opt-in: fails safe. The candidates come only from the snapshot, which
  // carries its own config-inconclusive diagnostic and lists no configured
  // route; cfg feeds only cfg.jev, absent from DEFAULTS, so Jev gets {} behind
  // its readiness gate.
  const cfg = loadConfig({ display: true });
  const snap = await getRuntimeSnapshot({ callerContext: cliCallerContext() });
  const candidates = (Array.isArray(snap.routes) ? snap.routes : [])
    .filter((r) => r && r.configured)
    .map((row) => ({
      id: row.id,
      model: row.modelBinding,
      harness: row.harnessBinding,
      profile: row.account,
      route: {
        id: row.id,
        state: row.resource && row.resource.state,
        freshUntil: row.resource && row.resource.freshUntil,
      },
    }));
  const policy = deepMerge(
    { require: { route: true, usableRoute: true } },
    policyInput,
  );
  const result = await recommend({
    task: taskInput,
    candidates,
    policy,
    caller: snap.caller,
    // The OpenRouter transport lives in lib/jev-openrouter.js — requireable,
    // so the wire shape / HTTPS-only / deadline behavior is unit-testable.
    // It still only ever runs behind an OPEN readiness gate.
    jev: { config: (cfg && cfg.jev) || {}, io: makeJevTransport(cfg) },
    now: Date.now(),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// ---- config -----------------------------------------------------------------

function config() {
  const cfg = loadConfig();
  const out = {
    dataDir: dataDir(),
    vaultBackend: cfg.vault.backend,
    routes: cfg.routes.map((r) => (isXiaomi(r)
      ? {
        // Config metadata only — no vault, Chrome, or Keychain read, and no
        // claim that a server-side session is currently valid.
        id: r.id, provider: r.provider, account: r.account, match: r.match,
        ttlSeconds: r.ttlSeconds,
        credentialSource: r.credentialSource || 'chrome-cookies',
        cookieSourceConfigured: xiaomiSession.sourceConfigured(cfg),
        ...(cfg.xiaomi && typeof cfg.xiaomi === 'object'
          ? { chromeProfile: cfg.xiaomi.chromeProfile, chromeSource: cfg.xiaomi.chromeSource }
          : {}),
      }
      : {
        id: r.id, provider: r.provider, account: r.account, match: r.match,
        ttlSeconds: r.ttlSeconds, hasCredential: vault.has(r.id),
        // Issue #113: region-capable built-ins (kimi/glm) report the resolved
        // canonical region and effective host, plus the refusal reason when
        // the route does not resolve to a monitorable built-in.
        ...(r.provider === 'kimi' || r.provider === 'glm'
          ? (() => {
              // The resolver's adapter wrapper carries capability + effective
              // cfg; a stubbed adapters module (test preload) may not, so
              // guard both before reaching into them.
              const eff = getAdapter(r.provider, r, cfg);
              if (!eff || !eff.capability || !eff.effectiveCfg) return {};
              const pc = eff.effectiveCfg.providerCfg || {};
              // Never echo a secret-bearing override: strip userinfo/path/
              // query/fragment down to a display-safe host label. When there is
              // no baseUrl to label (refused route), omit effectiveHost.
              const host = typeof pc.baseUrl === 'string' ? hostLabel(pc.baseUrl) : undefined;
              return {
                region: pc.region,
                ...(host !== undefined ? { effectiveHost: host } : {}),
                ...(!eff.capability.monitorable ? { reason: eff.capability.reason } : {}),
              };
            })()
          : {}),
      })),
    providers: Object.fromEntries(Object.entries(cfg.providers).map(([k, v]) => [k, v.baseUrl])),
    gate: cfg.gate,
    refreshOnSessionStart: cfg.refreshOnSessionStart,
    importMap: cfg.importMap,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// ---- session-start (first-run nudge) ----------------------------------------

function sessionStart() {
  // Opt-in: an unconfirmed read is reported through the systemMessage below;
  // exit 9 from a hook would surface as a hook error instead.
  const cfg = loadConfig({ display: true });
  // Every exit below either carries this notice or defers to it: a branch
  // that acknowledged something else and exited first would leave the user
  // with reassurance and no word that config.json was not read.
  const notice = unconfirmedNotice(cfg);
  const say = (msg) => {
    process.stdout.write(JSON.stringify({ systemMessage: `view-limits: ${msg}` }));
    process.exit(0);
  };
  // Xiaomi counts as configured from config metadata alone — never vault.has.
  const hasCreds = cfg.routes.some((r) => (isXiaomi(r) ? true : vault.has(r.id)));
  // Surface any fresh credential receipt and ack it (session-start already
  // performs writes in some paths, so acking here is consistent).
  const receiptMsg = formatReceipt(receiptFact(dataDir()));
  if (receiptMsg) {
    ackReceipt(dataDir());
    // The rotation happened and is reported either way. On an unconfirmed
    // read the notice replaces the refresh/add-keys guidance, which assumes
    // the document was read.
    if (notice) say(`${receiptMsg}. ${notice}`);
    if (hasCreds) say(`${receiptMsg}.`);
    say(`${receiptMsg}. Run /view-limits to refresh, or /view-limits:setup to add more provider keys.`);
  }
  if (hasCreds && !notice) process.exit(0);
  // The two migration branches below run only when the migration found
  // config.json absent. A lock-free read of an absent file is marked
  // inconclusive, and that is the absence the branch already accounts for,
  // so only a corrupt mark (a file that appeared, unreadable, since) is
  // added to them.
  const corrupt = configCorrupt(cfg) ? notice : null;
  // The one-time migration could not run this session. "No credentials
  // configured" would be false on an upgrade whose keys are stored but
  // unreadable, so say what actually happened. systemMessage is shown to the
  // user and never enters the model's context; the text is fixed, with no
  // path, error text or credential material in it.
  // The standalone import could not complete this time (#148) and the vault
  // migration was held back with it. A busy lock is another process at work,
  // so say nothing; anything else is one fixed line.
  if (migration && migration.reason === 'import-pending' && !corrupt) {
    if (/lock-busy$/.test(migration.importReason)) process.exit(0);
    say(standaloneNotice(migration.importClass === 'permanent' ? 'refused' : 'failed', migration.importReason));
  }
  if (migration && migration.reason === 'vault-unreadable') {
    say(corrupt ? `${MIGRATION_VAULT_UNREADABLE} ${corrupt}` : MIGRATION_VAULT_UNREADABLE);
  }
  // Another process (the async SessionStart refresh) holds the migration
  // lock and may be migrating right now: the state is in flux, so say nothing
  // rather than a nudge that could be wrong. It is re-evaluated next session.
  if (migration && migration.reason === 'lock-busy' && !corrupt) process.exit(0);
  if (notice) say(notice);
  say('no credentials configured yet. Run /view-limits:setup to add your provider keys.');
}

// ---- dispatch ---------------------------------------------------------------

// ---- the shim-only exit waiver (`--relay`, D2-a) -----------------------------
//
// A command shim's injected `!` exec is run by Claude Code while the file
// renders, and the skills docs are explicit about what a non-zero exit means
// there: "A failed command aborts the entire skill invocation, not just its own
// placeholder. Claude never sees the skill content for that invocation." (See
// https://code.claude.com/docs/en/skills#when-an-injected-command-fails.) For a
// surface whose whole job is to REPORT state, that turns the ordinary answers
// into an error banner: `dashboard status` exits 3 when nothing runs, `dashboard
// stop` exits 1, and `view`/`setup`/`update` exit 8/9/10 when the configuration
// is refused. Those exit codes are a contract for terminals, scripts and the
// gate, so they cannot change. `--relay` is a per-invocation waiver for the
// surfaces that cannot read an exit code:
//
//   · the output is byte-identical — same bytes, same order, same streams:
//     nothing in the flag touches rendering, collection or side effects;
//   · the process exit is 0 whatever the command decided;
//   · it is accepted ONLY on the six calls the shims actually make. Everywhere
//     else it is a usage refusal that itself exits 2, before the waiver is
//     installed — a waiver that also covered `serve`, `provider`, `check` or the
//     detached `__daemon` would silently change behaviour those paths depend on,
//     which is more than an exit code.
const RELAY_FLAG = '--relay';
const RELAY_COMMANDS = new Set(['view', 'setup', 'update']);
const RELAY_DASHBOARD_SUBS = new Set(['open', 'stop', 'status']);

// Validate the waiver before anything else runs. Not allowed → one line and exit
// 2, with the process untouched, so the refusal behaves like any other usage
// error rather than a waived one.
function relayWanted(cmdName, argv) {
  const at = argv.indexOf(RELAY_FLAG);
  if (at === -1) return -1;
  const allowed = RELAY_COMMANDS.has(cmdName)
    || (cmdName === 'dashboard' && RELAY_DASHBOARD_SUBS.has(argv[0]));
  if (!allowed) {
    process.stderr.write(`view-limits: ${RELAY_FLAG} is the command-surface exit waiver only — it belongs on view, setup, update or dashboard open|stop|status\n`);
    process.exit(2);
  }
  return at;
}

// Global options (Issue #148), parsed before anything is dispatched, read or
// written: `--data-dir <abs path>` names the data directory for this whole
// process and wins over the environment; `--claude-plugin` opts this call into
// the one-time import of the standalone data dir. Claude Code exports
// ${CLAUDE_PLUGIN_DATA} to hooks but not to a `!` exec line, so the shims pass
// it as this argument. The directory travels to anything vl.js spawns (the
// dashboard daemon, `serve`) through the environment those children inherit.
const GLOBAL = parseGlobalOptions(process.argv.slice(2));
if (!GLOBAL.ok) {
  process.stderr.write(`view-limits: ${GLOBAL.message}\n`);
  // A shim's `!` exec aborts the whole invocation on a non-zero exit, which
  // would hide this line from the person who has to fix it; --relay is the
  // waiver for exactly that.
  process.exit(process.argv.includes(RELAY_FLAG) ? 0 : 2);
}
if (GLOBAL.dataDir !== null) process.env.CLAUDE_PLUGIN_DATA = GLOBAL.dataDir;

const cmd = GLOBAL.rest[0];
const args = GLOBAL.rest.slice(1);
const hasFlag = (n) => args.includes(n);

// The waiver: taken out of argv so no command's own flag parser sees an unknown
// option, then `process.exit` reports 0 for every explicit exit. Sites that set
// `process.exitCode` and return are handled at the foot of the dispatch, where
// the code is reset before the event loop drains — so stdout/stderr still flush
// in full and the bytes a user sees are exactly the bytes the unflagged run
// wrote.
const RELAY_AT = relayWanted(cmd, args);
const RELAY = RELAY_AT !== -1;
if (RELAY) {
  args.splice(RELAY_AT, 1);
  const realExit = process.exit;
  process.exit = function relayExit() { return realExit.call(process, 0); };
}

// Commands that may run the one-time route migration (see
// lib/provider-lifecycle.js migrateFromVault). The list is an ALLOWLIST, not an exclusion, because
// the commands left out carry a contract the migration would break:
//
//   gate     — cache-only and side-effect-free by design, and the hot path.
//   report / status / snapshot / recommend / config — cache-only reads. The
//              cross-harness surfaces (#38/#39) assert zero filesystem writes
//              under dataDir for these, and a migration write would violate
//              that guarantee for a command whose whole promise is that it
//              observes without touching anything.
//
// `serve` IS in the list, although it reads no routes: its POST writes config.json
// (it materializes a built-in row), so a directly invoked `serve` must migrate or
// be refused like every other config writer. A parent-spawned child finds
// config.json already present and pays one stat.
//
// So a fresh install that has credentials but no config.json resolves no route
// in `gate` (null -> fail-open, exit 0, which is the designed default) and
// shows no rows in `report` until the first command below runs. `session-start`
// is in the list and runs every session, so in practice that window is one
// session at most. Stated in the PR body because it is a real, visible
// consequence of keeping cache-only reads write-free.
const MIGRATING_COMMANDS = new Set(['setup', 'update', 'provider', 'remove', 'refresh', 'check', 'session-start', 'serve']);

// Fixed text, pinned verbatim by the tests: no path, no vault error text and
// no credential material, because it reaches the user on the SessionStart path.
const MIGRATION_VAULT_UNREADABLE = 'the credential vault could not be read, so stored credentials were not migrated into routes and no configuration was written — this retries on the next command.';
// A config read that could not confirm config.json (lib/config.js
// readConfigTextIn): it was being replaced by another process while it was
// read, or it does not exist. Fixed text — no path or error detail.
const CONFIG_INCONCLUSIVE_NOTICE = 'config unreadable mid-write; retry. (config.json could not be confirmed — it was being replaced while it was read, or does not exist — so the configured providers are not shown.)';
// config.json exists but cannot be read or parsed as an object. A rerun reads
// the same file, so the action is different. Fixed text — no path, no parser
// or errno detail.
const CONFIG_CORRUPT_NOTICE = 'config.json could not be read or parsed — fix it or move it aside, then rerun. (It exists, so the built-in defaults are not used in its place: its routes and its vault backend are unknown.)';

// The notice for DEFAULTS an opt-in caller received in place of config.json,
// or null when the document was read. The two marks are mutually exclusive.
function unconfirmedNotice(cfg) {
  if (configCorrupt(cfg)) return CONFIG_CORRUPT_NOTICE;
  if (configInconclusive(cfg)) return CONFIG_INCONCLUSIVE_NOTICE;
  return null;
}

// A command that would act on — or display — built-in DEFAULTS from a config
// read that could not confirm config.json refuses instead: never "unknown
// route", an empty list or DEFAULTS presented as the real configuration. The
// exit code is distinct (9). Read-only: it never takes the lock.
//
// That is the DEFAULT of every config read (owner ruling "fix by default"):
// lib/config.js loadConfig throws CONFIG_INCONCLUSIVE unless the call site
// opts in by naming why, and this wrapper turns the throw into exit 9 AT the
// call, so no surrounding try/catch can swallow it into DEFAULTS. A corrupt
// document (CONFIG_CORRUPT) is refused the same way, with its own notice and
// exit 10.
function loadConfig(opts) {
  try {
    return libLoadConfig(opts);
  } catch (e) {
    if (e && e.code === 'CONFIG_INCONCLUSIVE') exitInconclusive();
    if (e && e.code === 'CONFIG_CORRUPT') exitCorrupt();
    throw e;
  }
}
function exitInconclusive() {
  log(CONFIG_INCONCLUSIVE_NOTICE);
  process.exit(lifecycle.exitCodeFor(lifecycle.STATUS.CONFIG_INCONCLUSIVE));
}
function exitCorrupt() {
  log(CONFIG_CORRUPT_NOTICE);
  process.exit(lifecycle.exitCodeFor(lifecycle.STATUS.CONFIG_CORRUPT));
}

// Commands that can write config.json. While the migration is unresolved they
// are refused: any document they published would disarm the migration for
// good, and the credentials it exists to rescue would never get their routes.
// Read-only and cache-only commands (refresh, check, session-start, report,
// status, snapshot, recommend, gate, provider list) never write config and
// keep running.
function writesConfig(command, rest) {
  if (command === 'provider') return ['add', 'update', 'remove'].includes(rest[0]);
  // `serve` too: its POST stores a credential and materializes a built-in row.
  // setup/update only spawn it after they passed this gate, but the dispatcher
  // accepts `serve <port> <nonce> <ids…>` directly, so the gate must be here,
  // before it listens — not assumed from the parent.
  return command === 'setup' || command === 'update' || command === 'remove' || command === 'serve';
}

// Fixed text: no path, no errno, no vault error text, no credential material.
const IMPORT_PENDING_REFUSAL = 'not run: your existing settings have not been copied into the plugin data folder yet, and this command would change the configuration before they are. Nothing was written. Rerun this command in a moment; if this keeps happening, run /view-limits to see why the copy failed.';
const MIGRATION_PENDING_REFUSAL = 'not run: stored credentials have not been migrated into routes yet (the credential vault could not be read, or another provider change is in progress), and this command would change the configuration before they are. Your stored credentials are untouched and nothing was written. Make sure the vault is accessible (for example, unlock the Keychain), then rerun this command.';

// It fires only when config.json is genuinely absent, and the document it
// writes is what makes it stop firing. Notices go to stderr so a `--json`
// command's stdout stays machine-readable. `session-start` is the exception:
// a hook's stderr is not shown to the user, so it reports through its own
// systemMessage instead (see sessionStart).
// Issue #148: a plugin data dir that was never set up inherits the standalone
// ~/.view-limits once, on the Claude path only (--claude-plugin: the command
// shims and the SessionStart hooks pass it; Codex, OpenCode and a terminal
// never do). It runs BEFORE the migration below, in the same process, so that
// a present config.json is what the migration finds. Skipped is silent; a
// copy, or a failed copy that changed nothing, is one fixed line.
//
// While the import is OWED (the plugin dir has no config.json and the standalone
// dir has one) and did not complete, for ANY reason, nothing is published over
// it: the vault migration does not run and config-writing commands are
// refused. Whatever they wrote would make the plugin dir "present" and disarm
// the import for good. The way out is to fix ~/.view-limits or move it aside;
// the import is then not owed and the migration runs as it always did.
let importPending = null;
let importClass = null;
if (GLOBAL.claudePlugin) {
  const imported = importStandalone({ target: GLOBAL.dataDir });
  if (imported.status === 'copied') process.stderr.write(`view-limits: ${standaloneNotice('copied')}\n`);
  else if (imported.status === 'failed') {
    process.stderr.write(`view-limits: ${standaloneNotice(imported.class === 'permanent' ? 'refused' : 'failed', imported.reason)}\n`);
  }
  if (imported.owed === true) { importPending = imported.reason; importClass = imported.class || 'transient'; }
}

let migration = null;
if (MIGRATING_COMMANDS.has(cmd)) {
  // No config read: the migration decides presence by lstat under its own
  // lock (io.configPresence) and never uses the cfg, which only the
  // provider probe needs.
  migration = importPending
    ? { migrated: false, reason: 'import-pending', importReason: importPending, importClass, retry: true }
    : lifecycle.migrateFromVault(lifecycleIo(null));
  if (migration.migrated && migration.ids.length) {
    process.stderr.write(`view-limits: migrated existing credentials into routes: ${migration.ids.join(', ')}\n`);
  } else if (migration.reason === 'vault-unreadable') {
    if (cmd !== 'session-start') process.stderr.write(`view-limits: ${MIGRATION_VAULT_UNREADABLE}\n`);
  } else if (migration.reason === 'lock-busy') {
    process.stderr.write('view-limits: another provider change is in progress, so existing routes were not migrated yet — this retries on the next command.\n');
  } else if (migration.reason === 'write-failed') {
    process.stderr.write('view-limits: could not write the migrated route list — nothing was changed; rerun once the data dir is writable.\n');
  }
  // One predicate, keyed on `retry` rather than on the reason string, so a
  // future retry reason cannot be forgotten here.
  if (migration.retry === true && writesConfig(cmd, args)) {
    const status = lifecycle.STATUS.MIGRATION_PENDING;
    const refusal = migration.reason === 'import-pending' ? IMPORT_PENDING_REFUSAL : MIGRATION_PENDING_REFUSAL;
    if (cmd === 'provider' && args.includes('--json')) {
      process.stdout.write(JSON.stringify({ command: args[0], ok: false, status, error: refusal }, null, 2) + '\n');
    } else {
      process.stderr.write(`view-limits: ${refusal}\n`);
    }
    process.exit(lifecycle.exitCodeFor(status));
  }
}

(async () => {
  switch (cmd) {
    case 'gate': return gate();
    case 'refresh': return refresh(hasFlag('--quiet'), hasFlag('--session-start'));
    case 'report': return reportCmd(args);
    // Phase 1 (Issue #37): `status` is a real subcommand and a strict alias for
    // `report` — same flags, same rendering, same exit codes. Issue #38 / #39
    // (Codex + OpenCode harness surfaces) will wire their "gating + status"
    // commands to this name; the alias keeps the surface stable without
    // introducing a divergent JSON shape or a second text renderer.
    case 'status': return reportCmd(args);
    case 'check': return check(args[0]);
    case 'setup': return setup(args);
    case 'update': return update(args);
    case 'provider': return providerCmd(args);
    case 'serve': return serve(Number(args[0]), args[1], args.slice(2));
    case 'session-start': return sessionStart();
    case 'remove': return remove(args[0]);
    case 'config': return config();
    case 'snapshot': return snapshot(args);
    case 'view': return viewCmd(args);
    case 'recommend': return recommendCmd(args);
    case 'dashboard': return dashboardCmd(args);
    default:
      return err('usage: vl.js [--data-dir <abs path>] [--claude-plugin] status|report [--json]|view [--condensed] [--json]|gate|refresh [--quiet]|check <routeId>|setup [<routeId>]|update [<routeId>]|provider add|update|remove|list|remove <routeId>|config|snapshot --json [--refresh]|recommend --json|dashboard start [--port N] [--host 127.0.0.1] [--interval S]|open [--no-open]|stop|status [--json]|session-start|serve <port> <nonce> <ids...>');
  }
})().then(() => {
  // D2-a: the commands that report a state through `process.exitCode` (status
  // not running = 3, a refused configuration = 8/9/10, a store failure = 1) are
  // waived here rather than at the writer, so no call site has to remember the
  // flag and no unflagged path can be affected by it.
  if (RELAY) process.exitCode = 0;
});
