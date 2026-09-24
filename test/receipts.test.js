'use strict';
// Credential-submission receipt tests — Issue #19.
//
// Verifies: write on submit/abandon/failure paths, surfacing in report,
// ack/expiry idempotence, zero-write proof for report, truthfulness shape,
// secret exclusion. No real credentials, network, or Traycer involved.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const http = require('http');
const net = require('net');

const {
  writeReceipt, readReceipt, ackReceipt, formatReceipt, receiptFact,
  OUTCOME_SUBMITTED, OUTCOME_ABANDONED, OUTCOME_FAILED,
  FRESHNESS_MS, RECEIPT_FILE,
} = require('../lib/receipts');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const VL = path.join(PLUGIN_ROOT, 'bin', 'vl.js');
const GUARD = path.join(__dirname, 'guard.cjs');

let failures = 0;
const pendingTests = [];
function test(name, fn) {
  let result;
  try { result = fn(); }
  catch (e) { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); return; }
  if (result && typeof result.then === 'function') {
    pendingTests.push(result.then(
      () => { console.log(`  ✓ ${name}`); },
      (e) => { failures += 1; console.log(`  ✗ ${name}\n    ${e.stack || e.message}`); },
    ));
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vl-receipts-'));
}

function writeJson(dir, name, value) {
  fs.writeFileSync(path.join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

// Recursive directory listing with sha256 hashes for zero-write proof.
function listTree(dir) {
  const out = [];
  (function walk(rel) {
    const abs = path.join(dir, rel);
    for (const name of fs.readdirSync(abs).sort()) {
      const p = path.join(rel, name);
      const st = fs.statSync(path.join(abs, name));
      if (st.isDirectory()) {
        out.push(p + '/');
        walk(p);
      } else {
        const digest = crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(abs, name)))
          .digest('hex');
        out.push(`${p}:${digest}`);
      }
    }
  })('');
  return out;
}

function cleanEnv(dir, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('TRAYCER_')) delete env[k];
  }
  Object.assign(env, extra);
  env.CLAUDE_PLUGIN_DATA = dir;
  return env;
}

function runCli(args, dir, { guard = false, env = {}, timeoutMs = 8000 } = {}) {
  const childEnv = cleanEnv(dir, env);
  if (guard) childEnv.NODE_OPTIONS = `--require=${GUARD}`;
  return spawnSync(process.execPath, [VL, ...args], {
    env: childEnv, encoding: 'utf8', timeout: timeoutMs,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function request(port, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: '/',
      headers: body == null ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.once('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function waitForServer(port) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return await request(port); }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  throw new Error('server did not start');
}

function startServer(dir, port, nonce, routeIds) {
  const env = cleanEnv(dir, { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' });
  const child = require('child_process').spawn(process.execPath, [VL, 'serve', String(port), nonce, ...routeIds], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return { child, output: () => stdout + stderr };
}

const SECRET_SENTINELS = ['sk-test-receipt-key-abc123', 'tok-should-not-appear', 'REPLACEMENT_SECRET'];

function assertNoSecrets(text) {
  for (const s of SECRET_SENTINELS) {
    assert.ok(!text.includes(s), `secret leaked: ${s}`);
  }
}

console.log('receipts — library write/read/ack/expiry');

test('writeReceipt produces a receipt with timestamp, routeIds, outcome, and freshUntil', () => {
  const dir = scratch();
  const r = writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['kimi-code-plan', 'openrouter-main'] });
  assert.ok(r);
  assert.strictEqual(r.outcome, OUTCOME_SUBMITTED);
  assert.deepStrictEqual(r.routeIds, ['kimi-code-plan', 'openrouter-main']);
  assert.ok(new Date(r.timestamp).getTime() > 0);
  assert.ok(new Date(r.freshUntil).getTime() > new Date(r.timestamp).getTime());
});

test('readReceipt returns the written receipt when fresh', () => {
  const dir = scratch();
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['kimi-code-plan'] });
  const r = readReceipt(dir);
  assert.ok(r);
  assert.strictEqual(r.outcome, OUTCOME_SUBMITTED);
  assert.deepStrictEqual(r.routeIds, ['kimi-code-plan']);
});

test('readReceipt returns null when absent', () => {
  const dir = scratch();
  assert.strictEqual(readReceipt(dir), null);
});

test('readReceipt returns null when expired', () => {
  const dir = scratch();
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['r'] });
  // Tamper: set freshUntil in the past.
  const receiptPath = path.join(dir, RECEIPT_FILE);
  const doc = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  doc.freshUntil = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(receiptPath, JSON.stringify(doc));
  assert.strictEqual(readReceipt(dir), null, 'expired receipt must be treated as absent');
});

test('ackReceipt removes the receipt file; readReceipt returns null after ack', () => {
  const dir = scratch();
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['r'] });
  assert.ok(readReceipt(dir));
  ackReceipt(dir);
  assert.strictEqual(readReceipt(dir), null);
  // Acking again is safe (idempotent).
  ackReceipt(dir);
  assert.strictEqual(readReceipt(dir), null);
});

test('writeReceipt with OUTCOME_ABANDONED and OUTCOME_FAILED', () => {
  const dir = scratch();
  writeReceipt(dir, { outcome: OUTCOME_ABANDONED, routeIds: ['r1'] });
  assert.strictEqual(readReceipt(dir).outcome, OUTCOME_ABANDONED);
  ackReceipt(dir);
  writeReceipt(dir, { outcome: OUTCOME_FAILED, routeIds: ['r1'], detail: 'vault write failure' });
  const r = readReceipt(dir);
  assert.strictEqual(r.outcome, OUTCOME_FAILED);
  assert.strictEqual(r.detail, 'vault write failure');
});

test('invalid outcome throws', () => {
  const dir = scratch();
  assert.throws(() => writeReceipt(dir, { outcome: 'invalid', routeIds: ['r'] }));
  assert.throws(() => writeReceipt(dir, { outcome: null, routeIds: ['r'] }));
});

test('invalid routeIds throws', () => {
  const dir = scratch();
  assert.throws(() => writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: [] }));
  assert.throws(() => writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: [''] }));
  assert.throws(() => writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: [123] }));
});

console.log('\nreceipts — formatReceipt and receiptFact');

test('formatReceipt returns human-readable strings for each outcome', () => {
  const r = formatReceipt({
    outcome: OUTCOME_SUBMITTED, routeIds: ['kimi-code-plan', 'openrouter-main'],
    timestamp: '2026-09-24T12:00:00.000Z',
  });
  assert.ok(r.includes('credentials rotated for kimi-code-plan, openrouter-main'));
  assert.ok(r.length > 30, 'formatted receipt should include time information');

  const a = formatReceipt({
    outcome: OUTCOME_ABANDONED, routeIds: ['r'],
    timestamp: '2026-09-24T12:00:00.000Z',
  });
  assert.ok(a.includes('closed without submission'));

  const f = formatReceipt({
    outcome: OUTCOME_FAILED, routeIds: ['r1', 'r2'],
    timestamp: '2026-09-24T12:00:00.000Z',
    detail: 'vault write failure',
  });
  assert.ok(f.includes('credential storage failed'));
  assert.ok(f.includes('vault write failure'));
});

test('formatReceipt returns null for absent receipt', () => {
  assert.strictEqual(formatReceipt(null), null);
  assert.strictEqual(formatReceipt({}), null);
  assert.strictEqual(formatReceipt({ provenance: 'unknown', value: null }), null);
});

test('receiptFact returns observed fact when receipt exists', () => {
  const dir = scratch();
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['r1'] });
  const f = receiptFact(dir);
  assert.strictEqual(f.provenance, 'observed');
  assert.strictEqual(f.value.outcome, OUTCOME_SUBMITTED);
  assert.deepStrictEqual(f.value.routeIds, ['r1']);
  assert.strictEqual(f.source, 'credential-receipt');
  assert.ok(f.observedAt);
  assert.ok(f.freshUntil);
});

test('receiptFact returns unknown fact with reason when absent', () => {
  const dir = scratch();
  const f = receiptFact(dir);
  assert.strictEqual(f.provenance, 'unknown');
  assert.strictEqual(f.value, null);
  assert.strictEqual(f.reason, 'receipt-absent');
  assert.strictEqual(f.source, null);
});

console.log('\nreceipts — no secrets in receipt content');

test('receipt files and outputs contain no secret material', () => {
  const dir = scratch();
  writeReceipt(dir, {
    outcome: OUTCOME_SUBMITTED,
    routeIds: ['sk-test-receipt-key-abc123', 'normal-route', 'tok-should-not-appear'],
    detail: 'stored sk-test-receipt-key-abc123 and tok-should-not-appear',
  });
  const raw = fs.readFileSync(path.join(dir, RECEIPT_FILE), 'utf8');
  assertNoSecrets(raw);
  const receipt = readReceipt(dir);
  assertNoSecrets(JSON.stringify(receipt));
  // The routeIds should have been scrubbed (sk-/tok- prefix removed).
  assert.deepStrictEqual(receipt.routeIds, ['normal-route']);
  // The detail should have been scrubbed.
  assert.ok(receipt.detail.includes('[REDACTED]'));
  assert.ok(!receipt.detail.includes('sk-test-receipt-key-abc123'));
});

test('receiptFact output contains no secret material', () => {
  const dir = scratch();
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['sk-leaked', 'safe-route'] });
  const f = receiptFact(dir);
  const text = JSON.stringify(f);
  assertNoSecrets(text);
});

console.log('\nreceipts — surfacing in report');

test('report surfaces fresh submitted receipt', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 }],
    vault: { backend: 'file', service: 'test-receipt' },
  });
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'receipts-test-key';
  try {
    require('../lib/vault').set('kimi-code-plan', 'test-token');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }
  const now = Date.now();
  writeJson(dir, 'status.json', {
    updatedAt: new Date(now).toISOString(),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date(now - 60_000).toISOString(),
        freshUntil: new Date(now + 300_000).toISOString(), source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  // Write a receipt.
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['kimi-code-plan'] });

  const r = runCli(['report'], dir, { env: { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /credentials rotated for kimi-code-plan/);
});

test('report does NOT surface expired receipt', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 }],
    vault: { backend: 'file', service: 'test-expired' },
  });
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'receipts-test-key';
  try {
    require('../lib/vault').set('kimi-code-plan', 'test-token');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }
  const now = Date.now();
  writeJson(dir, 'status.json', {
    updatedAt: new Date(now).toISOString(),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date(now - 60_000).toISOString(),
        freshUntil: new Date(now + 300_000).toISOString(), source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  // Write an expired receipt.
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['kimi-code-plan'] });
  const receiptPath = path.join(dir, RECEIPT_FILE);
  const doc = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  doc.freshUntil = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(receiptPath, JSON.stringify(doc));

  const r = runCli(['report'], dir, { env: { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('credentials rotated'), `expired receipt must not surface: ${r.stdout}`);
});

console.log('\nreceipts — zero-write proof for report');

test('report does NOT write to dataDir (zero-write contract)', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 }],
    vault: { backend: 'file', service: 'test-zero-write' },
  });
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'receipts-test-key';
  try {
    require('../lib/vault').set('kimi-code-plan', 'test-token');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }
  const now = Date.now();
  writeJson(dir, 'status.json', {
    updatedAt: new Date(now).toISOString(),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date(now - 60_000).toISOString(),
        freshUntil: new Date(now + 300_000).toISOString(), source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  // Write a receipt first (before report), then record the tree.
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['kimi-code-plan'] });
  const before = listTree(dir);

  // Run without guard (guard.cjs blocks vault.has which report needs). The
  // zero-write contract is about filesystem writes, not vault reads.
  const r = runCli(['report'], dir, { env: { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(listTree(dir), before, 'report must not create or modify any files in dataDir');
});

test('report --json does NOT write to dataDir', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 }],
    vault: { backend: 'file', service: 'test-zero-write-json' },
  });
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'receipts-test-key';
  try {
    require('../lib/vault').set('kimi-code-plan', 'test-token');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }
  const now = Date.now();
  writeJson(dir, 'status.json', {
    updatedAt: new Date(now).toISOString(),
    routes: {
      'kimi-code-plan': {
        routeId: 'kimi-code-plan', observedAt: new Date(now - 60_000).toISOString(),
        freshUntil: new Date(now + 300_000).toISOString(), source: 'kimi',
        status: { state: 'healthy', windows: [], balance: null, resetAt: null },
      },
    },
  });
  const before = listTree(dir);

  const r = runCli(['report', '--json'], dir, { env: { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(listTree(dir), before, 'report --json must not create or modify any files in dataDir');
});

console.log('\nreceipts — session-start surfacing and ack');

test('session-start surfaces receipt and acks it (second run has no receipt)', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'kimi-code-plan', provider: 'kimi', account: 'code-plan', match: { model: 'kimi' }, ttlSeconds: 180 }],
    vault: { backend: 'file', service: 'test-ack' },
  });
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'receipts-test-key';
  try {
    require('../lib/vault').set('kimi-code-plan', 'test-token');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['kimi-code-plan'] });

  const r1 = runCli(['session-start'], dir, { env: { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' } });
  assert.strictEqual(r1.status, 0, r1.stderr);
  const msg1 = JSON.parse(r1.stdout);
  assert.ok(msg1.systemMessage.includes('credentials rotated'), `expected receipt in session-start: ${r1.stdout}`);
  assert.ok(msg1.systemMessage.includes('kimi-code-plan'));

  // Second run: receipt was acked, so it should not repeat.
  const r2 = runCli(['session-start'], dir, { env: { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' } });
  assert.strictEqual(r2.status, 0, r2.stderr);
  // No stdout expected when credentials are configured and no receipt.
  assert.strictEqual(r2.stdout, '', `second session-start should produce no output: ${r2.stdout}`);
});

console.log('\nreceipts — integration: server writes receipt on submit');

test('serve: successful POST writes submitted receipt', async () => {
  if (!await freePort().then(() => true).catch(() => false)) {
    console.log('    (loopback unavailable; skipped)');
    return;
  }
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'test-route', provider: 'fake', account: 'test', match: { model: 'test-route' } }],
    vault: { backend: 'file', service: 'test-integration' },
  });
  const prevData = process.env.CLAUDE_PLUGIN_DATA;
  const prevKey = process.env.VIEW_LIMITS_MASTER_KEY;
  process.env.CLAUDE_PLUGIN_DATA = dir;
  process.env.VIEW_LIMITS_MASTER_KEY = 'receipts-test-key';
  try {
    require('../lib/vault');
  } finally {
    if (prevData === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = prevData;
    if (prevKey === undefined) delete process.env.VIEW_LIMITS_MASTER_KEY; else process.env.VIEW_LIMITS_MASTER_KEY = prevKey;
  }

  const port = await freePort();
  const env = cleanEnv(dir, { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' });
  const child = require('child_process').spawn(process.execPath, [VL, 'serve', String(port), 'test-nonce', 'test-route'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the server to be ready.
  await waitForServer(port);

  // Submit credentials.
  const res = await request(port, {
    method: 'POST',
    body: JSON.stringify({ nonce: 'test-nonce', credentials: { 'test-route': 'sk-test-receipt-key-abc123' } }),
  });
  assert.strictEqual(res.status, 200, `POST failed: ${res.body}`);
  assertNoSecrets(res.body);

  // Wait for server exit.
  await new Promise((resolve) => child.on('exit', resolve));

  // Check the receipt was written.
  const receipt = readReceipt(dir);
  assert.ok(receipt, 'receipt must be written after successful submit');
  assert.strictEqual(receipt.outcome, OUTCOME_SUBMITTED);
  assert.deepStrictEqual(receipt.routeIds, ['test-route']);
  assertNoSecrets(JSON.stringify(receipt));
});

test('serve: bad-nonce POST triggers shutdown path that writes failed receipt', async () => {
  if (!await freePort().then(() => true).catch(() => false)) {
    console.log('    (loopback unavailable; skipped)');
    return;
  }
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'test-route', provider: 'fake', account: 'test', match: { model: 'test-route' } }],
    vault: { backend: 'file', service: 'test-nonce-fail' },
  });
  const port = await freePort();
  const env = cleanEnv(dir, { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' });
  const child = require('child_process').spawn(process.execPath, [VL, 'serve', String(port), 'expected-nonce', 'test-route'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForServer(port);

  // Send a bad nonce — this triggers the shutdown path with a failed receipt.
  const res = await request(port, {
    method: 'POST',
    body: JSON.stringify({ nonce: 'wrong-nonce', credentials: { 'test-route': 'x' } }),
  });
  assert.strictEqual(res.status, 403);

  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  // The nonce mismatch writes a failed receipt.
  const receipt = readReceipt(dir);
  assert.ok(receipt, 'receipt must be written after nonce mismatch shutdown');
  assert.strictEqual(receipt.outcome, OUTCOME_FAILED);
  assert.deepStrictEqual(receipt.routeIds, ['test-route']);
});

test('serve: 413 oversized body writes a failed receipt', async () => {
  if (!await freePort().then(() => true).catch(() => false)) {
    console.log('    (loopback unavailable; skipped)');
    return;
  }
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'test-route', provider: 'fake', account: 'test', match: { model: 'test-route' } }],
    vault: { backend: 'file', service: 'test-oversized' },
  });
  const port = await freePort();
  const env = cleanEnv(dir, { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' });
  const child = require('child_process').spawn(process.execPath, [VL, 'serve', String(port), 'test-nonce', 'test-route'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForServer(port);

  const res = await request(port, {
    method: 'POST',
    body: JSON.stringify({ nonce: 'test-nonce', credentials: { 'test-route': 'x'.repeat(80 * 1024) } }),
  });
  assert.strictEqual(res.status, 413);

  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const receipt = readReceipt(dir);
  assert.ok(receipt, 'receipt must be written after 413 oversized');
  assert.strictEqual(receipt.outcome, OUTCOME_FAILED);
  assert.deepStrictEqual(receipt.routeIds, ['test-route']);
});

test('serve: 409 double-submit writes exactly ONE receipt (first outcome preserved)', async () => {
  if (!await freePort().then(() => true).catch(() => false)) {
    console.log('    (loopback unavailable; skipped)');
    return;
  }
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'test-route', provider: 'fake', account: 'test', match: { model: 'test-route' } }],
    vault: { backend: 'file', service: 'test-double-submit' },
  });
  const port = await freePort();
  const env = cleanEnv(dir, { VIEW_LIMITS_MASTER_KEY: 'receipts-test-key' });
  const child = require('child_process').spawn(process.execPath, [VL, 'serve', String(port), 'test-nonce', 'test-route'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForServer(port);

  // First POST — successful submission.
  const res1 = await request(port, {
    method: 'POST',
    body: JSON.stringify({ nonce: 'test-nonce', credentials: { 'test-route': 'sk-test-receipt-key-abc123' } }),
  });
  assert.strictEqual(res1.status, 200);

  // Second POST — should get 409 (already submitted).
  const res2 = await request(port, {
    method: 'POST',
    body: JSON.stringify({ nonce: 'test-nonce', credentials: { 'test-route': 'another-key' } }),
  });
  assert.strictEqual(res2.status, 409);

  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Exactly ONE receipt — the first submission's outcome.
  const receipt = readReceipt(dir);
  assert.ok(receipt, 'receipt must exist');
  assert.strictEqual(receipt.outcome, OUTCOME_SUBMITTED, 'first outcome is submitted');
  assert.deepStrictEqual(receipt.routeIds, ['test-route']);
  assertNoSecrets(JSON.stringify(receipt));
});

console.log('\nreceipts — idempotence: stale receipt consumed once');

test('report surfaces receipt once; expired receipt is not repeated', () => {
  const dir = scratch();
  writeJson(dir, 'config.json', {
    routes: [{ id: 'test-route', provider: 'fake', account: 'test', match: { model: 'test-route' } }],
    vault: { backend: 'file', service: 'test-idempotent' },
  });
  // Write a receipt with very short TTL.
  writeReceipt(dir, { outcome: OUTCOME_SUBMITTED, routeIds: ['test-route'] });
  const receiptPath = path.join(dir, RECEIPT_FILE);
  const doc = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  doc.freshUntil = new Date(Date.now() + 50).toISOString(); // 50ms TTL
  fs.writeFileSync(receiptPath, JSON.stringify(doc));

  // Read immediately — should be present.
  const f1 = receiptFact(dir);
  assert.strictEqual(f1.provenance, 'observed', 'receipt must be observable before TTL');

  // Wait for expiry.
  const r = readReceipt(dir);
  // It might still be fresh (50ms is short but race-prone). Force-expire.
  doc.freshUntil = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(receiptPath, JSON.stringify(doc));
  const r2 = readReceipt(dir);
  assert.strictEqual(r2, null, 'expired receipt must be absent');
});

console.log('\nreceipts — truthfulness: absent = unknown with reason');

test('no receipt → unknown receipt-absent, never fabricated', () => {
  const dir = scratch();
  const f = receiptFact(dir);
  assert.strictEqual(f.value, null);
  assert.strictEqual(f.provenance, 'unknown');
  assert.strictEqual(f.reason, 'receipt-absent');
  assert.strictEqual(f.source, null);
  assert.strictEqual(f.observedAt, null);
  assert.strictEqual(f.freshUntil, null);
});

Promise.all(pendingTests).then(() => {
  if (failures) { console.error(`\n${failures} receipt test(s) failed`); process.exit(1); }
  console.log('\nall receipt tests passed');
});
