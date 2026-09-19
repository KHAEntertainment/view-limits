#!/usr/bin/env node
'use strict';
// view-limits CLI — thin transport wrapper over lib/.
//
//   vl.js gate                        PreToolUse hook: read hook JSON on stdin,
//                                     decide deny / allow+context from cache.
//   vl.js refresh [--quiet] [--debug] query all routes, write the cache.
//   vl.js report [--json]             render the cached status table.
//   vl.js check <routeId>             live-check one route (JSON).
//   vl.js setup [<routeId> [--key K]] audit + auto-import + loopback form / stdin.
//   vl.js remove <routeId>            delete a credential.
//   vl.js config                      show effective config (secrets masked).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');

const { loadConfig, dataDir, expandHome } = require('../lib/config');
const { readCache, writeCache, isFresh, tryAcquireRefreshLock, spawnRefresh } = require('../lib/cache');
const { resolveRoute, dispatchContext } = require('../lib/routes');
const { decide, summarize } = require('../lib/gate');
const vault = require('../lib/vault');
const { getAdapter, ADAPTERS } = require('../lib/adapters');

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

function log(msg) { process.stderr.write(`view-limits: ${msg}\n`); }
function err(msg) { process.stderr.write(`view-limits: ${msg}\n`); process.exit(1); }

function noCredentialMessage() {
  return 'view-limits: no credentials configured yet.\n\n' +
    'Run setup to add your provider keys (auto-imports MiniMax from\n' +
    '~/.mmx/config.json, then opens a local browser form for the rest):\n\n' +
    `    ${PLUGIN_ROOT}/bin/vl.js setup\n`;
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
  if (!ctx.model) process.exit(0); // no explicit model → fail open

  const route = resolveRoute(ctx.model, ctx, cfg.routes);
  if (!route) process.exit(0); // unmapped/native → fail open

  const cache = readCache();
  const entry = (cache.routes || {})[route.id];
  const now = Date.now();
  const d = decide({ route, entry, now, config: cfg });

  if (d.refresh && tryAcquireRefreshLock(now, cfg.gate.refreshLockSeconds)) {
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
  if (!quiet) process.stdout.write(renderReport(doc) + '\n');
}

// ---- report -----------------------------------------------------------------

function renderReport(cache) {
  const routes = cache.routes || {};
  const ids = Object.keys(routes);
  const lines = [
    'ROUTE'.padEnd(22) + 'STATE'.padEnd(12) + 'BALANCE / WINDOWS'.padEnd(42) + 'RESETS',
  ];
  for (const id of ids) lines.push(renderEntry(id, routes[id]));
  if (!ids.length) lines.push('(no cached status — run `vl.js refresh`)');
  lines.push('');
  lines.push(`updated: ${cache.updatedAt || 'never'}`);
  return lines.join('\n');
}

function renderEntry(id, entry) {
  const st = entry.status || {};
  const state = st.state || 'unknown';
  let windows = '—';
  if (st.balance) windows = `balance ${st.balance.available} ${st.balance.currency}`;
  else if (st.windows && st.windows.length) {
    windows = st.windows.map((w) => {
      if (w.limit > 0 && w.remaining != null) return `${w.type} ${Math.round((w.remaining / w.limit) * 100)}%`;
      return `${w.type} ${w.remaining}/${w.limit}`;
    }).join(' · ');
  }
  const reset = st.resetAt ? new Date(st.resetAt).toLocaleString() : '—';
  const note = st.detail && (st.detail.error || st.detail.note) ? `  [${st.detail.error || st.detail.note}]` : '';
  return id.padEnd(22) + state.padEnd(12) + windows.padEnd(42) + reset + note;
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

function formHtml(ids, nonce) {
  const fields = ids.map((id) =>
    `<label for="${escapeHtml(id)}">${escapeHtml(id)}</label>` +
    `<input id="${escapeHtml(id)}" type="password" autocomplete="off" spellcheck="false">`,
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
    `document.body.innerHTML=r.ok?'<h1>Saved</h1><p>Credentials stored. You can close this tab.</p>':'<h1>Error</h1><p>Something went wrong — rerun <code>vl.js setup</code>.</p>';});</script></body></html>`;
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

function launchLoopbackForm(ids) {
  const nonce = crypto.randomBytes(24).toString('hex');
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
        try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('bad request'); server.close(); return; }
        if (data.nonce !== nonce) { res.writeHead(403); res.end('bad nonce'); server.close(); return; }
        const creds = data.credentials || {};
        let saved = 0;
        for (const id of ids) {
          if (creds[id]) { vault.set(id, String(creds[id])); saved += 1; }
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h1>Saved ${saved} credential${saved === 1 ? '' : 's'}</h1><p>You can close this tab.</p>`);
        setTimeout(() => { server.close(); process.exit(0); }, 200);
      });
      return;
    }
    res.writeHead(405); res.end();
  });

  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    log(`opening credential form in your browser: ${url}`);
    openBrowser(url);
    setTimeout(() => { log('setup timed out; auto-imported credentials are kept.'); server.close(); process.exit(0); }, 5 * 60 * 1000);
  });
}

async function promptHeadless(ids) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (const id of ids) {
    const secret = await new Promise((res) => rl.question(`Paste credential for ${id}: `, (a) => res(a.trim())));
    if (secret) vault.set(id, secret);
  }
  rl.close();
  log('done.');
}

function setup(args) {
  const cfg = loadConfig();

  // Single-route form: `vl.js setup <routeId> [--key K]`
  if (args[0] && !args[0].startsWith('--')) {
    const id = args[0];
    if (!cfg.routes.find((r) => r.id === id)) err(`unknown route "${id}" (known: ${cfg.routes.map((r) => r.id).join(', ')})`);
    const keyIdx = args.indexOf('--key');
    let secret = keyIdx >= 0 ? args[keyIdx + 1] : undefined;
    if (!secret && !process.stdin.isTTY) secret = fs.readFileSync(0, 'utf8').trim();
    if (!secret) err(`no secret for "${id}" — pipe via stdin or pass --key`);
    vault.set(id, secret);
    log(`stored credential for "${id}"`);
    return;
  }

  // Full flow: audit → re-import from native files → collect the rest.
  const missing = [];
  const imported = [];
  for (const route of cfg.routes) {
    const imp = cfg.importMap && cfg.importMap[route.id];
    const secret = imp ? readNativeSecret(imp) : null;
    if (secret) { vault.set(route.id, secret); imported.push(route.id); continue; }
    if (!vault.has(route.id)) missing.push(route.id);
  }
  if (imported.length) log(`imported from native config: ${imported.join(', ')}`);
  if (!missing.length) { log('all credentials present.'); return; }
  log(`missing credentials for: ${missing.join(', ')}`);

  if (args.includes('--headless')) { promptHeadless(missing); return; }
  launchLoopbackForm(missing);
}

function remove(routeId) {
  log(vault.remove(routeId) ? `removed credential for "${routeId}"` : `no credential for "${routeId}"`);
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
      return process.stdout.write(renderReport(cache) + '\n');
    }
    case 'check': return check(args[0]);
    case 'setup': return setup(args);
    case 'remove': return remove(args[0]);
    case 'config': return config();
    default:
      return err('usage: vl.js gate|refresh|report|check <routeId>|setup [<routeId>]|remove <routeId>|config');
  }
})();
