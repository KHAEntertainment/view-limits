'use strict';
// The dashboard page (Issue #62 scaffold), served by the loopback control
// listener (./server). One HTML shell plus a fixed set of static assets under
// /assets/; no build step and no inline script, so the CSP needs no
// 'unsafe-inline' and no per-response nonce.
//
//   GET /            the local page. It carries a REFRESH TOKEN in a <meta>.
//   GET /?view=lan   a PREVIEW of the phone/LAN layout, still on loopback. It
//                    carries no token and the page renders no controls. This
//                    is not the LAN redaction: the LAN listener (after owner
//                    approval) will build a redacted projection on the server.
//
// The refresh token is derived from the instance nonce (HMAC) and authorises
// POST /api/refresh only. The nonce itself — which also authorises /api/stop —
// never leaves dashboard.json, so a process that can read the page cannot stop
// the daemon. Neither value appears in any JSON response.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAGE_DIR = path.join(__dirname, 'page');
// The fixed allowlist: a path not on it is a 404. The fonts are Vercel's Geist
// (npm `geist` 1.8.2, SIL OFL 1.1, fonts/OFL.txt), bundled so the page fetches
// nothing from outside this machine.
const ASSETS = Object.freeze({
  'app.css': 'text/css; charset=utf-8',
  'logic.js': 'text/javascript; charset=utf-8',
  'render.js': 'text/javascript; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'external.svg': 'image/svg+xml',
  // Issue #116: the vendored provider marks and the neutral generic one. The
  // stubs are fixed stems from page/logic.js PROVIDER_LOGOS; nothing here is
  // built from request input (the allowlist is an exact-key lookup).
  'logos/alibaba.svg': 'image/svg+xml',
  'logos/deepseek.svg': 'image/svg+xml',
  'logos/generic.svg': 'image/svg+xml',
  'logos/glm.svg': 'image/svg+xml',
  'logos/kimi.svg': 'image/svg+xml',
  'logos/minimax.svg': 'image/svg+xml',
  'logos/openrouter.svg': 'image/svg+xml',
  'logos/stepfun.svg': 'image/svg+xml',
  'logos/xiaomi.svg': 'image/svg+xml',
  'fonts/Geist-Regular.woff2': 'font/woff2',
  'fonts/Geist-Medium.woff2': 'font/woff2',
  'fonts/Geist-SemiBold.woff2': 'font/woff2',
  'fonts/GeistMono-Regular.woff2': 'font/woff2',
});

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});

function refreshTokenFor(nonce) {
  return crypto.createHmac('sha256', String(nonce)).update('view-limits/dashboard-page-refresh/v1').digest('hex');
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The gate's threshold, if it is a usable ratio; otherwise the page's default.
function thresholdText(threshold) {
  return typeof threshold === 'number' && threshold > 0 && threshold < 1 ? String(threshold) : '0.2';
}

// mode: 'local' | 'lan-preview' | 'lan' (served by ./lan-server). Only the
// local page carries a token; the shell never carries data or config values.
function pageHtml({ mode, threshold, refreshToken }) {
  const metas = [
    `<meta name="vl-mode" content="${escapeAttr(mode)}">`,
    `<meta name="vl-threshold" content="${escapeAttr(thresholdText(threshold))}">`,
  ];
  if (mode === 'local' && refreshToken) metas.push(`<meta name="vl-refresh-token" content="${escapeAttr(refreshToken)}">`);
  const title = mode === 'lan-preview' ? 'view-limits (LAN preview)' : 'view-limits';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
${metas.join('\n')}
<title>${escapeAttr(title)}</title>
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/logic.js" defer></script>
<script src="/assets/render.js" defer></script>
<script src="/assets/app.js" defer></script>
</head>
<body>
<div id="app"><noscript><p>The view-limits dashboard needs JavaScript. <code>vl.js view</code> shows the same status in a terminal.</p></noscript></div>
</body>
</html>
`;
}

function sendText(res, status, type, body) {
  res.writeHead(status, Object.assign({
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
  }, SECURITY_HEADERS));
  res.end(body);
}

// An allowlisted asset's bytes, or null for any other name.
// Read per request: a few small files, and an edit shows on reload.
function assetFor(name) {
  if (!Object.prototype.hasOwnProperty.call(ASSETS, name)) return null;
  return { type: ASSETS[name], body: fs.readFileSync(path.join(PAGE_DIR, name)) };
}

// → true when the request was a page or asset request (and was answered).
function handlePage(req, res, url, { identity, threshold }) {
  const route = url.pathname;
  let asset = null;
  if (route.startsWith('/assets/')) {
    const name = route.slice('/assets/'.length);
    if (!Object.prototype.hasOwnProperty.call(ASSETS, name)) return false;
    asset = name;
  } else if (route !== '/') {
    return false;
  }
  if (req.method !== 'GET') {
    sendText(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n');
    return true;
  }
  if (asset) {
    const a = assetFor(asset);
    sendText(res, 200, a.type, a.body);
    return true;
  }
  const lan = url.searchParams.get('view') === 'lan';
  sendText(res, 200, 'text/html; charset=utf-8', pageHtml({
    mode: lan ? 'lan-preview' : 'local',
    threshold,
    refreshToken: lan || !identity.nonce ? null : refreshTokenFor(identity.nonce),
  }));
  return true;
}

module.exports = { handlePage, pageHtml, refreshTokenFor, sendText, assetFor, ASSETS, CSP, SECURITY_HEADERS };
