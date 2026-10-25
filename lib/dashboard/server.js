'use strict';
// The daemon's loopback control listener (Issue #61).
//
// Contract:
//   GET  /api/status    observation-only: the scheduler's in-memory snapshot.
//                       Polling it never triggers a provider read.
//   GET  /api/identity  { schema, instanceId, pid, startedAt } — what a client
//                       checks before trusting a dashboard.json record. No secret.
//   POST /api/refresh   ask for a collection now; joins the one in flight.
//                       Needs the instance nonce. 202 { accepted, coalesced }.
//   POST /api/stop      graceful shutdown. Needs the instance nonce. 202.
//   anything else       404 (the page is #62's), wrong method on a known path 405.
//
// Every request — not just the POSTs — must come from a loopback socket with an
// exact local Host header (`127.0.0.1|localhost|[::1]` + the bound port), which
// also defeats DNS rebinding. POSTs additionally need the nonce in
// `X-VL-Nonce` (constant-time compare; missing and wrong are one response), no
// Origin or a same-origin one, JSON content type, and a body of at most 1 KiB.
// Forwarded-address headers are never read: the socket is the only evidence of
// where a request came from. The nonce is never written to a response.

const http = require('http');
const crypto = require('crypto');

const MAX_BODY_BYTES = 1024;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function nonceMatches(expected, presented) {
  if (typeof presented !== 'string' || !presented) return false;
  return crypto.timingSafeEqual(digest(expected), digest(presented));
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

// Read at most MAX_BODY_BYTES. → { ok, body } | { ok: false, status }
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const settle = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settle({ ok: false, status: 413 });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ ok: false, status: 400 }));
    req.on('aborted', () => settle({ ok: false, status: 400 }));
  });
}

function createControlServer({ identity, getStatus, refresh, requestStop }) {
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address() && server.address().port;
      const remote = req.socket.remoteAddress;
      if (!LOOPBACK_ADDRESSES.has(remote)) { send(res, 403, { error: 'forbidden' }); return; }
      const allowedHosts = LOCAL_HOSTNAMES.map((h) => `${h}:${port}`);
      if (!allowedHosts.includes(req.headers.host)) { send(res, 403, { error: 'forbidden' }); return; }

      const url = new URL(req.url, 'http://local');
      const route = url.pathname;
      const known = ['/api/status', '/api/identity', '/api/refresh', '/api/stop'];
      if (!known.includes(route)) { send(res, 404, { error: 'not-found' }); return; }

      if (route === '/api/status' || route === '/api/identity') {
        if (req.method !== 'GET') { send(res, 405, { error: 'method-not-allowed' }); return; }
        if (route === '/api/identity') {
          send(res, 200, { schema: 1, instanceId: identity.instanceId, pid: identity.pid, startedAt: identity.startedAt });
        } else {
          send(res, 200, getStatus());
        }
        return;
      }

      // Control endpoints.
      if (req.method !== 'POST') { send(res, 405, { error: 'method-not-allowed' }); return; }
      if (!nonceMatches(identity.nonce, req.headers['x-vl-nonce'])) { send(res, 401, { error: 'unauthorized' }); return; }
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${req.headers.host}`) { send(res, 403, { error: 'forbidden' }); return; }
      const read = await readBody(req);
      if (!read.ok) { send(res, read.status, { error: 'bad-request' }); return; }
      if (read.body.length) {
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        let parsed;
        try { parsed = JSON.parse(read.body); } catch { parsed = undefined; }
        if (type !== 'application/json' || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          send(res, 400, { error: 'bad-request' });
          return;
        }
      }

      if (route === '/api/refresh') {
        const { coalesced } = refresh();
        send(res, 202, { accepted: true, coalesced });
        return;
      }
      res.on('finish', () => { requestStop(); });
      send(res, 202, { stopping: true });
    } catch {
      try { send(res, 500, { error: 'internal' }); } catch { /* connection gone */ }
    }
  });
  // A control listener has no business holding slow or idle connections.
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 50;
  return server;
}

module.exports = { createControlServer, nonceMatches, MAX_BODY_BYTES };
