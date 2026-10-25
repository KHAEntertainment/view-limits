'use strict';
// The dashboard's LAN listener (Issue #62 hardening): read-only, redacted,
// and separate from the loopback control listener (./server), whose routes
// and record are unchanged. It is created only when config.dashboard.lan is
// enabled, bound to that one interface and port.
//
// Contract:
//   GET /               the page shell in LAN mode. Static: no data, no route
//                       names, nothing from config, no token. The page keeps
//                       the read token in the phone's storage for this origin.
//   GET /assets/<name>  the same fixed allowlist the loopback page uses.
//   GET /api/lan/status the REDACTED status (./lan-redact). Needs the read
//                       token in `X-VL-Read` (constant-time compare; missing,
//                       wrong and rotated are one 401).
//   anything else       404; any other method on a known path 405.
//
// Every request must carry the exact Host the listener was bound for
// (`<ip>:<port>`, `[<ipv6>]:<port>`), which defeats DNS rebinding. Responses
// send the page's CSP and security headers and no CORS headers. Nothing here
// logs a request, a query string or a header.

const http = require('http');
const { pageHtml, sendText, assetFor, SECURITY_HEADERS } = require('./page');
const { redactForLan } = require('./lan-redact');
const { hostFor, tokenMatches } = require('./lan');

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  }, SECURITY_HEADERS));
  res.end(text);
}

// `currentToken()` returns the token as of now (re-read when the file changes)
// or null, in which case every status request is refused.
function createLanServer({ address, port, getStatus, currentToken, threshold = null }) {
  const host = hostFor(address, port);
  const server = http.createServer((req, res) => {
    try {
      if (req.headers.host !== host) { sendJson(res, 403, { error: 'forbidden' }); return; }
      const url = new URL(req.url, 'http://lan');
      const route = url.pathname;
      const isAsset = route.startsWith('/assets/');
      const asset = isAsset ? assetFor(route.slice('/assets/'.length)) : null;
      const known = route === '/' || route === '/api/lan/status' || asset !== null;
      if (!known) { sendJson(res, 404, { error: 'not-found' }); return; }
      if (req.method !== 'GET') { sendJson(res, 405, { error: 'method-not-allowed' }); return; }
      if (asset) { sendText(res, 200, asset.type, asset.body); return; }
      if (route === '/') { sendText(res, 200, 'text/html; charset=utf-8', pageHtml({ mode: 'lan', threshold })); return; }
      if (!tokenMatches(currentToken(), req.headers['x-vl-read'])) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      sendJson(res, 200, redactForLan(getStatus()));
    } catch {
      try { sendJson(res, 500, { error: 'internal' }); } catch { /* connection gone */ }
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  return server;
}

module.exports = { createLanServer };
