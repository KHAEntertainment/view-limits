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
//   vl.js config                      show effective config (secrets masked).
//   vl.js snapshot --json [--refresh] normalized runtime snapshot; --refresh
//                                     adds bounded Traycer CLI live reads.
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

const { loadConfig, dataDir, expandHome, deepMerge } = require('../lib/config');
const {
  readCache, writeCache, isFresh,
  tryScheduleRefresh, acquireWorker, releaseWorker, spawnRefresh,
} = require('../lib/cache');
const { resolveRoute, dispatchContext } = require('../lib/routes');
const { decide, summarize } = require('../lib/gate');
const vault = require('../lib/vault');
const { getAdapter, ADAPTERS } = require('../lib/adapters');
const { getRuntimeSnapshot } = require('../lib/runtime-snapshot');
const { recommend } = require('../lib/recommend');
const { makeJevTransport } = require('../lib/jev-openrouter');
const { traycerEnvCallerContext } = require('../lib/traycer-adapter');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function log(msg) { process.stderr.write(`view-limits: ${msg}\n`); }
function err(msg) { process.stderr.write(`view-limits: ${msg}\n`); process.exit(1); }

function noCredentialMessage() {
  return 'view-limits: no credentials configured yet.\n\n' +
    'Run /view-limits:setup to add your provider keys (auto-imports MiniMax\n' +
    'from ~/.mmx/config.json, then opens a local browser form for the rest).\n';
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
  const input = await readStdin();
  let evt;
  try { evt = JSON.parse(input); } catch { process.exit(0); } // no/invalid input → no gate

  const cfg = loadConfig();
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

function entryFor(route, status, source) {
  const ttl = route.ttlSeconds != null ? route.ttlSeconds : 180;
  const observedAt = new Date().toISOString();
  const freshUntil = new Date(Date.now() + ttl * 1000).toISOString();
  return { routeId: route.id, observedAt, freshUntil, source, status };
}

function unknownStatus(detail) {
  return { state: 'unknown', windows: [], balance: null, resetAt: null, detail };
}

async function refresh(quiet) {
  const cfg = loadConfig();
  const configured = cfg.routes.filter((r) => cfg.providers[r.provider] && vault.has(r.id));
  if (!configured.length) {
    if (!quiet) process.stdout.write(noCredentialMessage());
    return;
  }

  // Shared refresh worker ownership: manual refresh, SessionStart's refresh,
  // and the gate-spawned refresh child all converge on this lock. Only one
  // worker performs provider calls; the loser prints the cached state plus
  // an in-progress indication and exits without calling any provider.
  const ownerToken = crypto.randomBytes(16).toString('hex');
  const acq = await acquireWorker({
    ownerToken,
  });
  if (!acq.acquired) {
    if (!quiet) {
      const cache = readCache();
      const snap = await getRuntimeSnapshot({ callerContext: cliCallerContext() });
      process.stdout.write(renderInventory(snap, cache.updatedAt) + '\n');
      process.stdout.write(
        `view-limits: ${acq.error ? 'refresh unavailable (' + acq.error + ')' : 'refresh already in progress'}. ` +
        `Showing last cached status.\n`,
      );
    }
    return;
  }

  try {
    const threshold = cfg.gate.constrainedThreshold;
    const statuses = {};
    await Promise.all(configured.map(async (route) => {
      try {
        const st = await getAdapter(route.provider).fetchStatus(cfg.providers[route.provider], vault.get(route.id), { threshold });
        statuses[route.id] = entryFor(route, st, route.provider);
      } catch (e) {
        statuses[route.id] = entryFor(route, unknownStatus({ error: e.message }), route.provider);
      }
    }));

    const doc = writeCache(statuses);
    if (!quiet) {
      const snap = await getRuntimeSnapshot({ callerContext: cliCallerContext() });
      process.stdout.write(renderInventory(snap, doc.updatedAt) + '\n');
    }
  } finally {
    releaseWorker(acq);
  }
}

// ---- report -----------------------------------------------------------------
//
// /view-limits renders the normalized runtime snapshot — the requester, the
// harness pool (harnesses, sessions, native profiles) and the external
// provider routes. Every printed value comes from a snapshot fact: the
// renderer never infers effective models or selected accounts, and unknown /
// stale evidence stays visibly distinct from healthy / exhausted states.

function cliCallerContext() {
  return { host: os.hostname(), surface: 'cli', ...traycerEnvCallerContext(process.env) };
}

function factValue(f) {
  return f && f.provenance !== 'unknown' && f.value !== null && f.value !== undefined
    ? f.value : null;
}

function factText(f) {
  const v = factValue(f);
  return v === null ? 'unknown' : String(v);
}

function renderInventory(snap, updatedAt) {
  const lines = [`view-limits runtime inventory — generated ${snap.generatedAt} · completeness ${snap.completeness}`];

  // Requester — the assembled caller facts, verbatim.
  const c = snap.caller || {};
  const who = [
    factValue(c.ade),
    factValue(c.agentId) != null ? `agent ${factValue(c.agentId)}` : null,
    factValue(c.epicId) != null ? `epic ${factValue(c.epicId)}` : null,
  ].filter(Boolean).join(' · ');
  const where = [factValue(c.harness), factValue(c.surface), factValue(c.host)].filter(Boolean).join(' · ');
  lines.push(`  requester: ${who || 'unknown'}${where ? ` — ${where}` : ''}`);
  lines.push(`    models: configured ${factText(c.configuredModel)} · default ${factText(c.defaultModel)} · effective ${factText(c.effectiveModel)}${factValue(c.differsFromDefault) === true ? ' (differs from default)' : ''}`);
  if (factValue(c.selectedProfile) !== null || factValue(c.selectedAccount) !== null) {
    lines.push(`    selection: profile ${factText(c.selectedProfile)} · account ${factText(c.selectedAccount)}`);
  }

  // Harness pool — harnesses, sessions and native profiles stay separate
  // sections keyed by their own composite identity; nothing here merges with
  // external routes by name.
  lines.push('  harness pool:');
  const harnesses = Array.isArray(snap.harnesses) ? snap.harnesses : [];
  const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
  const profiles = Array.isArray(snap.profiles) ? snap.profiles : [];
  if (!harnesses.length && !sessions.length && !profiles.length) {
    lines.push('    (no runtime harness/session/profile facts)');
  }
  for (const h of harnesses) lines.push('    ' + renderHarness(h));
  for (const s of sessions) lines.push('    ' + renderSession(s));
  for (const p of profiles) lines.push('    ' + renderProfile(p));

  // External provider routes — one line per route with usable identity:
  // configured routes always render; unconfigured cache rows render only when
  // they carry some observed evidence (garbage cache entries never print).
  lines.push('  external routes:');
  const rows = (Array.isArray(snap.routes) ? snap.routes : [])
    .filter(renderableRoute)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!rows.length) lines.push('    (no configured routes)');
  for (const row of rows) lines.push('    ' + renderRoute(row));

  const counts = { healthy: 0, constrained: 0, exhausted: 0, unknown: 0 };
  let stale = 0;
  for (const row of rows) {
    const s = factValue(row.resource && row.resource.state) || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
    if (row.resource && row.resource.freshness === 'stale') stale += 1;
  }
  lines.push('');
  lines.push(`  ${counts.healthy} healthy · ${counts.constrained} constrained · ${counts.exhausted} exhausted · ${counts.unknown} unknown${stale ? ` · ${stale} stale` : ''}`);
  const unobserved = (Array.isArray(snap.routes) ? snap.routes : [])
    .filter((r) => r.configured && r.resource && r.resource.state && r.resource.state.reason === 'no-cached-observation')
    .length;
  if (unobserved) lines.push(`  ${unobserved} configured route(s) have no cached observation — /view-limits refreshes routes with stored keys and provider config (/view-limits:setup)`);
  for (const d of snap.diagnostics || []) {
    lines.push(`  notice [${d.scope || 'snapshot'}] ${d.code} — ${d.summary}`);
  }
  lines.push(`  cache updated ${updatedAt || 'never'}`);
  return lines.join('\n');
}

function renderHarness(h) {
  const key = h.key || {};
  const avail = factValue(h.available);
  const availability = avail === true ? 'available'
    : avail === false ? 'unavailable'
    : `availability unknown${h.available && h.available.reason ? ` — ${h.available.reason}` : ''}`;
  const refs = Array.isArray(h.sessionRefs) ? h.sessionRefs.length : 0;
  const resources = Array.isArray(h.resourceRefs) ? h.resourceRefs.length : 0;
  const defaults = h.defaults && typeof h.defaults === 'object'
    ? Object.entries(h.defaults).map(([k, f]) => `${k}=${factText(f)}`).join(' ')
    : '';
  return `${key.harness || 'unknown'} (${key.surface || 'unknown'}) @ ${key.host || 'unknown'}: ${availability}` +
    `${refs ? ` · ${refs} session(s)` : ''}${resources ? ` · ${resources} resource ref(s)` : ''}` +
    `${defaults ? ` · defaults: ${defaults}` : ''}`;
}

function renderSession(s) {
  const key = s.key || {};
  const bits = [];
  if (factValue(s.harness) !== null) bits.push(`harness ${factValue(s.harness)}`);
  if (factValue(s.surface) !== null) bits.push(factValue(s.surface));
  if (factValue(s.title) !== null) bits.push(`"${factValue(s.title)}"`);
  const active = factValue(s.active);
  if (active !== null) bits.push(active ? 'active' : 'idle');
  if (factValue(s.isSelf) === true) bits.push('this requester');
  return `session ${key.agentId || 'unknown'} @ ${key.host || 'unknown'}: ${bits.join(' · ') || 'no facts'}`;
}

function renderProfile(p) {
  const key = p.key || {};
  const bits = [];
  if (factValue(p.authStatus) !== null) bits.push(`auth ${factValue(p.authStatus)}`);
  if (factValue(p.rateLimitStatus) !== null) bits.push(`rate limits ${factValue(p.rateLimitStatus)}`);
  const usageAt = factValue(p.usageUpdatedAt);
  bits.push(usageAt ? `usage observed ${usageAt}` : 'usage unobserved');
  if (factValue(p.nativeRateLimits) !== null) bits.push('native rate limits observed');
  return `profile ${key.provider || 'unknown'}/${key.profileId || 'unknown'} @ ${key.host || 'unknown'}: ${bits.join(' · ')}`;
}

// An unconfigured (cache-orphan) row renders only when it carries some known
// evidence; a malformed or empty orphan reproduces the v1 behavior of
// dropping non-object cache entries from the human report.
function renderableRoute(row) {
  if (row.configured) return true;
  const r = row.resource || {};
  return factValue(r.state) !== null || factValue(r.observedAt) !== null ||
    factValue(r.source) !== null || (Array.isArray(r.windows) && r.windows.length > 0) ||
    r.balance != null || r.usage != null;
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMoney(value, currency) {
  const amount = finiteNumber(value);
  if (amount == null) return null;
  const unit = typeof currency === 'string' && currency.trim() ? ` ${currency.trim()}` : '';
  if (amount > 0 && amount < 0.01) return `<0.01${unit}`;
  if (amount < 0 && amount > -0.01) return `${amount.toPrecision(2)}${unit}`;
  return `${amount.toFixed(2)}${unit}`;
}

function renderRoute(row) {
  const res = row.resource || {};
  const state = factValue(res.state) || 'unknown';
  let quota = '—';
  const balance = res.balance && typeof res.balance === 'object' && !Array.isArray(res.balance)
    ? res.balance : null;
  const formattedBalance = balance && formatMoney(balance.available, balance.currency);
  if (formattedBalance) {
    quota = `balance ${formattedBalance}`;
    if (balance.spent && typeof balance.spent === 'object' && !Array.isArray(balance.spent)) {
      const spent = [];
      const daily = formatMoney(balance.spent.daily, balance.currency);
      const weekly = formatMoney(balance.spent.weekly, balance.currency);
      if (daily) spent.push(`${daily} today`);
      if (weekly) spent.push(`${weekly} week`);
      if (spent.length) quota += ` · spent ${spent.join(' / ')}`;
    }
    if (balance.limit && typeof balance.limit === 'object' && !Array.isArray(balance.limit)) {
      const cap = formatMoney(balance.limit.amount, balance.currency);
      if (cap) quota += ` · ${cap} ${balance.limit.reset || 'period'} cap`;
    }
  }
  else if (res.usage && typeof res.usage === 'object' && !Array.isArray(res.usage)) {
    const usage = res.usage;
    const spent = [];
    const daily = formatMoney(usage.daily, usage.currency);
    const weekly = formatMoney(usage.weekly, usage.currency);
    const monthly = formatMoney(usage.monthly, usage.currency);
    if (daily) spent.push(`${daily} today`);
    if (weekly) spent.push(`${weekly} week`);
    if (monthly) spent.push(`${monthly} month`);
    if (spent.length) quota = `spent ${spent.join(' / ')}`;
  }
  else if (res.windows && res.windows.length) {
    quota = res.windows.map((w) => {
      if (w.limit > 0 && w.remaining != null) return `${w.type} ${Math.round((w.remaining / w.limit) * 100)}%`;
      return `${w.type} ${w.remaining}/${w.limit}`;
    }).join(' · ');
  }
  const resetAt = factValue(res.resetAt);
  const reset = resetAt ? ` · resets ${new Date(resetAt).toLocaleString()}` : '';
  let note = '';
  if (state === 'unknown') {
    if (res.error) {
      const msg = String(res.error);
      note = ` — ${msg.length > 80 ? msg.slice(0, 80) + '…' : msg} (rotate via /view-limits:update ${row.id})`;
    } else if (res.state && res.state.reason) {
      note = ` — ${res.state.reason}`;
    }
  }
  // Stale evidence is marked at end of line: a stale exhausted route still
  // says exhausted, but never reads as current.
  const stale = res.freshness === 'stale' ? ' (stale)' : '';
  const binding = Array.isArray(row.boundBy) && row.boundBy.length
    ? ` · bound to ${row.boundBy.map((b) => `${b.harness}@${b.host}`).join(', ')}`
    : '';
  const models = Array.isArray(factValue(row.models)) && factValue(row.models).length
    ? ` · models ${factValue(row.models).join(', ')}`
    : '';
  return `${row.id}: ${state}${quota !== '—' ? ' · ' + quota : ''}${reset}${note}${binding}${models}${stale}`;
}

// ---- check ------------------------------------------------------------------

async function check(routeId) {
  const cfg = loadConfig();
  const route = cfg.routes.find((r) => r.id === routeId);
  if (!route) err(`unknown route "${routeId}" (known: ${cfg.routes.map((r) => r.id).join(', ')})`);
  const token = vault.get(route.id);
  if (!token) err(`no credential for "${routeId}" — run: vl.js setup`);
  const st = await getAdapter(route.provider).fetchStatus(
    cfg.providers[route.provider], token, { threshold: cfg.gate.constrainedThreshold },
  );
  process.stdout.write(JSON.stringify(st, null, 2) + '\n');
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
    return true;
  } catch {
    return false;
  }
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
    `</head><body><h1>view-limits setup</h1><p>Paste each credential below. Values are sent only to this local server (127.0.0.1) and stored in your local vault — never through the agent's chat.</p>` +
    `<form id="f">${fields}<button type="submit">Save</button></form>` +
    `<script>document.getElementById('f').addEventListener('submit',async(e)=>{e.preventDefault();const credentials={};` +
    reads +
    `const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:${JSON.stringify(nonce)},credentials})});` +
    `if(r.ok){document.body.innerHTML='<h1>Saved</h1><p>Credentials stored. Closing in <span id="n">5</span>s…</p>';let n=5;setInterval(()=>{n--;const e=document.getElementById('n');if(e)e.textContent=n;if(n<=0)window.close();},1000);}else{document.body.innerHTML='<h1>Error</h1><p>Something went wrong — rerun <code>vl.js setup</code>.</p>';});</script></body></html>`;
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
  const known = new Set(cfg.routes.map((route) => route.id));
  if (!Number.isInteger(port) || port < 1 || port > 65535) err('credential form received an invalid port.');
  if (typeof nonce !== 'string' || !nonce) err('credential form received an invalid nonce.');
  if (!ids.length || ids.some((id) => !known.has(id))) err('credential form received an unknown route.');
  preflightVault();

  let abandonTimer = null;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(formHtml(ids, nonce));
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('bad request'); shutdown(0); return; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          res.writeHead(400);
          res.end('bad request');
          shutdown(0);
          return;
        }
        if (data.nonce !== nonce) { res.writeHead(403); res.end('bad nonce'); shutdown(0); return; }
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
          res.writeHead(persistenceFailed ? 500 : 400, { 'Content-Type': 'text/html' });
          const remediation = persistenceFailed
            ? 'Verify vault access, then rerun setup or update.'
            : 'Enter a replacement for every route, then rerun setup or update.';
          res.end(`<h1>Credential storage failed</h1><p>Stored: ${saved.map(escapeHtml).join(', ') || 'none'}.</p><p>Could not store: ${failed.map(escapeHtml).join(', ')}.</p><p>${remediation}</p>`);
          shutdown(1, 200);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Saved ${saved.length} credential${saved.length === 1 ? '' : 's'}</h1><p>Routes: ${saved.map(escapeHtml).join(', ') || 'none'}.</p><p>Closing in <span id="n">5</span>s…</p><script>let n=5;setInterval(()=>{n--;const e=document.getElementById('n');if(e)e.textContent=n;if(n<=0)window.close();},1000);</script>`);
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
    setTimeout(() => server.close(() => process.exit(code)), delay);
  }

  server.listen(port, '127.0.0.1', () => {
    abandonTimer = setTimeout(() => server.close(() => process.exit(0)), 5 * 60 * 1000);
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
}

async function openForm(ids) {
  try {
    const nonce = crypto.randomBytes(24).toString('hex');
    const port = await pickFreePort();
    spawn(process.execPath, [path.join(PLUGIN_ROOT, 'bin', 'vl.js'), 'serve', String(port), nonce, ...ids], { detached: true, stdio: 'ignore' }).unref();
    const url = `http://127.0.0.1:${port}`;
    setTimeout(() => openBrowser(url), 150); // let the detached server bind first
    log(`credential form: ${url}`);
    log('paste your key(s), then run /view-limits to refresh.');
  } catch {
    err('credential form could not start — rerun setup or update.');
  }
}

function parseCredentialArgs(cfg, args) {
  const parsed = { routeId: null, headless: false, key: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--headless') {
      if (parsed.headless) err('duplicate --headless option.');
      parsed.headless = true;
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
    if (arg.startsWith('--')) err(`unknown option "${arg}".`);
    if (parsed.routeId) err('only one route can be selected at a time.');
    parsed.routeId = arg;
  }
  if (parsed.routeId && !cfg.routes.some((route) => route.id === parsed.routeId)) {
    err(`unknown route "${parsed.routeId}" (known: ${cfg.routes.map((route) => route.id).join(', ')})`);
  }
  if (parsed.key !== null && !parsed.routeId) err('--key requires a route id.');
  if (parsed.key !== null && parsed.headless) err('--key and --headless cannot be used together.');
  return parsed;
}

function setupOne(cfg, options, allowImport) {
  const id = options.routeId;
  if (options.key !== null) {
    if (!storeCredential(id, options.key)) err(`could not store credential for "${id}" — verify vault access and try again.`);
    log(`stored credential for "${id}"`);
    return;
  }
  if (allowImport) {
    const imp = cfg.importMap && cfg.importMap[id];
    const native = imp ? readNativeSecret(imp) : null;
    if (native) {
      if (!storeCredential(id, native)) err(`could not import credential for "${id}" — verify vault access and try again.`);
      log(`imported from native config: ${id}`);
      return;
    }
  }
  if (options.headless) return promptHeadless([id]);
  return openForm([id]);
}

function setup(args) {
  const cfg = loadConfig();
  const options = parseCredentialArgs(cfg, args);
  preflightVault();

  // Single route: `vl.js setup <routeId> [--key K]`
  if (options.routeId) return setupOne(cfg, options, true);

  // Initial setup: re-import native, then open the form for whatever's missing.
  const missing = [];
  const imported = [];
  const failed = [];
  for (const route of cfg.routes) {
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
  if (!missing.length) {
    if (!failed.length) log('all credentials present.');
    return;
  }
  log(`missing credentials for: ${missing.join(', ')}`);
  if (options.headless) return promptHeadless(missing);
  return openForm(missing);
}

function update(args) {
  const cfg = loadConfig();
  const options = parseCredentialArgs(cfg, args);
  preflightVault();

  // Single route: `vl.js update <routeId>` — rotate one existing key.
  if (options.routeId) return setupOne(cfg, options, false);

  // Rotate existing credentials: open the form for configured routes.
  const existing = cfg.routes.filter((r) => vault.has(r.id));
  if (!existing.length) { log('no credentials to update — run /view-limits:setup first.'); return; }
  log(`updating credentials for: ${existing.map((r) => r.id).join(', ')}`);
  if (options.headless) return promptHeadless(existing.map((r) => r.id));
  return openForm(existing.map((r) => r.id));
}

function remove(routeId) {
  log(vault.remove(routeId) ? `removed credential for "${routeId}"` : `no credential for "${routeId}"`);
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

  const cfg = loadConfig();
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
    routes: cfg.routes.map((r) => ({
      id: r.id, provider: r.provider, account: r.account, match: r.match,
      ttlSeconds: r.ttlSeconds, hasCredential: vault.has(r.id),
    })),
    providers: Object.fromEntries(Object.entries(cfg.providers).map(([k, v]) => [k, v.baseUrl])),
    gate: cfg.gate,
    importMap: cfg.importMap,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// ---- session-start (first-run nudge) ----------------------------------------

function sessionStart() {
  const cfg = loadConfig();
  if (cfg.routes.some((r) => vault.has(r.id))) process.exit(0);
  process.stdout.write(JSON.stringify({
    systemMessage: 'view-limits: no credentials configured yet. Run /view-limits:setup to add your provider keys.',
  }));
  process.exit(0);
}

// ---- dispatch ---------------------------------------------------------------

const cmd = process.argv[2];
const args = process.argv.slice(3);
const hasFlag = (n) => args.includes(n);

(async () => {
  switch (cmd) {
    case 'gate': return gate();
    case 'refresh': return refresh(hasFlag('--quiet'));
    case 'report': {
      const cfg = loadConfig();
      const cache = readCache();
      if (!cfg.routes.some((r) => vault.has(r.id))) {
        process.stdout.write(noCredentialMessage());
        return;
      }
      if (hasFlag('--json')) return process.stdout.write(JSON.stringify(cache, null, 2) + '\n');
      const snap = await getRuntimeSnapshot({ callerContext: cliCallerContext() });
      return process.stdout.write(renderInventory(snap, cache.updatedAt) + '\n');
    }
    case 'check': return check(args[0]);
    case 'setup': return setup(args);
    case 'update': return update(args);
    case 'serve': return serve(Number(args[0]), args[1], args.slice(2));
    case 'session-start': return sessionStart();
    case 'remove': return remove(args[0]);
    case 'config': return config();
    case 'snapshot': return snapshot(args);
    case 'recommend': return recommendCmd(args);
    default:
      return err('usage: vl.js gate|refresh|report|check <routeId>|setup [<routeId>]|update [<routeId>]|remove <routeId>|config|snapshot --json [--refresh]|recommend --json|session-start|serve <port> <nonce> <ids...>');
  }
})();
