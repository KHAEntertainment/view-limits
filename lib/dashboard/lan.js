'use strict';
// The dashboard's LAN view (Issue #62 hardening): its configuration and its
// read token. Transport-neutral: no HTTP here (see ./lan-server).
//
// Configuration (non-secret, config.json):
//   dashboard.lan = { enabled: boolean, interface: "<IP literal>", port: N }
// Absent means off. When enabled, `interface` is a LAN or Tailscale address
// that is on this machine right now (never loopback, never a wildcard) and
// `port` is fixed, so a phone's bookmark survives restarts. A present but
// invalid value REFUSES; it is never replaced by a default.
//
// Read token (secret): <dataDir>/dashboard-lan-token, 64 hex, mode 0600,
// owned by this user, a regular file (never a symlink). It is never written to
// config.json, never logged and never printed except by `dashboard lan url`.
// `rotate` replaces it atomically; the daemon re-reads it when the file
// changes, so the old token stops working at once.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const TOKEN_FILE = 'dashboard-lan-token';
const TOKEN_RE = /^[a-f0-9]{64}$/;
const PORT_MIN = 1024;
const PORT_MAX = 65535;
// How to recover from a present but invalid dashboard.lan. `lan disable`
// refuses such a value rather than rewriting it, so the fix is `enable`.
const LAN_FIX = 'run `vl.js dashboard lan enable --interface <ip>` to replace it, or remove the "dashboard.lan" section from config.json';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function tokenPath(dir) { return path.join(dir, TOKEN_FILE); }

// ---- addresses ---------------------------------------------------------------

// Every non-loopback address on this machine right now.
function localAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces || {})) {
    for (const i of list || []) if (i && !i.internal && typeof i.address === 'string') out.push(i.address);
  }
  return out;
}

// The one spelling of an IP literal: the form a browser puts in the URL and
// the Host header (IPv6 lowercase and compressed). Config, printed links, the
// bind and the Host check all use it, so they cannot disagree. Not an IP → as is.
function canonicalAddress(address) {
  if (typeof address !== 'string' || !net.isIP(address)) return address;
  const v6 = net.isIPv6(address);
  try {
    const host = new URL(`http://${v6 ? `[${address}]` : address}/`).hostname;
    return v6 ? host.slice(1, -1) : host;
  } catch { return address; }
}

function sameAddress(a, b) { return canonicalAddress(a) === canonicalAddress(b); }

// Why an IP literal is not a usable LAN interface, or null when it is. The
// checks run on the canonical spelling, so an IPv4-mapped loopback such as
// ::ffff:127.0.0.1 (canonically ::ffff:7f00:1) is still loopback.
function addressProblem(address) {
  if (typeof address !== 'string' || !net.isIP(address)) return 'is not an IP address (a hostname is not accepted)';
  const c = canonicalAddress(address);
  const v6 = net.isIPv6(c);
  if (v6 ? (c === '::' || c === '::ffff:0:0') : c === '0.0.0.0') return 'is a wildcard address, which would listen on every interface';
  if (v6 ? (c === '::1' || /^::ffff:7f[0-9a-f]{2}:/.test(c)) : c.startsWith('127.')) return 'is a loopback address; the loopback page is already at the address `vl.js dashboard start` prints';
  if (v6 && /^fe[89ab]/.test(c)) return 'is an IPv6 link-local address, which needs a zone and cannot be bookmarked';
  return null;
}

// The Host header a LAN client sends for this address and port.
function hostFor(address, port) {
  const a = canonicalAddress(address);
  return `${net.isIPv6(a) ? `[${a}]` : a}:${port}`;
}

function lanUrl(address, port, token) {
  return `http://${hostFor(address, port)}/?t=${token}`;
}

// ---- configuration -------------------------------------------------------------

// → { ok: true, enabled: false }
//   { ok: true, enabled: true, address, port }
//   { ok: false, error }   (the error names the fix)
// `interfaces` is os.networkInterfaces()-shaped; pass null to skip the
// on-this-machine check (validating a document, not starting a listener).
function resolveLanConfig(cfg, { interfaces } = {}) {
  const section = cfg ? cfg.dashboard : undefined;
  if (section === undefined) return { ok: true, enabled: false };
  if (!isPlainObject(section)) return { ok: false, error: 'config.json "dashboard" must be an object.' };
  const lan = section.lan;
  if (lan === undefined) return { ok: true, enabled: false };
  const fix = LAN_FIX;
  if (!isPlainObject(lan)) return { ok: false, error: `config.json "dashboard.lan" must be an object; ${fix}.` };
  if (typeof lan.enabled !== 'boolean') return { ok: false, error: `config.json "dashboard.lan.enabled" must be true or false; ${fix}.` };
  if (!lan.enabled) return { ok: true, enabled: false };
  const problem = addressProblem(lan.interface);
  if (problem) return { ok: false, error: `config.json "dashboard.lan.interface" ${JSON.stringify(lan.interface)} ${problem}; ${fix}.` };
  if (!Number.isInteger(lan.port) || lan.port < PORT_MIN || lan.port > PORT_MAX) {
    return { ok: false, error: `config.json "dashboard.lan.port" must be a whole number from ${PORT_MIN} to ${PORT_MAX}; got ${JSON.stringify(lan.port)}; ${fix}.` };
  }
  if (interfaces !== null) {
    const here = localAddresses(interfaces === undefined ? os.networkInterfaces() : interfaces);
    if (!here.some((a) => sameAddress(a, lan.interface))) {
      return { ok: false, error: `the LAN interface ${lan.interface} is not an address on this machine right now (connected to that network or Tailscale?); run \`vl.js dashboard lan disable\` or pick another interface with \`vl.js dashboard lan enable --interface <ip>\`.` };
    }
  }
  return { ok: true, enabled: true, address: canonicalAddress(lan.interface), port: lan.port };
}

// ---- token -----------------------------------------------------------------------

// → { ok: true, token } | { ok: false, reason: 'absent'|'unsafe'|'malformed'|'unreadable' }
// The checks run on the path itself (lstat), so a symlink is refused rather
// than followed.
function readToken(dir) {
  const file = tokenPath(dir);
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    return { ok: false, reason: e && e.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (!st.isFile()) return { ok: false, reason: 'unsafe' };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'unsafe' };
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false, reason: 'unsafe' };
  if (st.size > 256) return { ok: false, reason: 'malformed' };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ok: false, reason: 'unreadable' }; }
  const token = text.trim();
  return TOKEN_RE.test(token) ? { ok: true, token, stat: st } : { ok: false, reason: 'malformed' };
}

// A fresh token, written atomically (private temporary file, then rename).
// → { ok: true, token } | { ok: false, error }
function writeToken(dir) {
  const file = tokenPath(dir);
  const token = crypto.randomBytes(32).toString('hex');
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, `${token}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
    return { ok: true, token };
  } catch (e) {
    try { fs.unlinkSync(temp); } catch { /* ours */ }
    return { ok: false, error: (e && e.code) || 'write-failed' };
  }
}

// What a token read failure means to the user, with the fix. Never the token.
function tokenProblem(reason) {
  const what = {
    absent: 'the LAN read token is missing',
    unsafe: `the LAN read token file (${TOKEN_FILE} in the data directory) is not a private regular file owned by you`,
    malformed: `the LAN read token file (${TOKEN_FILE} in the data directory) is malformed`,
    unreadable: `the LAN read token file (${TOKEN_FILE} in the data directory) could not be read`,
  }[reason] || 'the LAN read token could not be read';
  return `${what}; run \`vl.js dashboard lan rotate\` to issue a new one, or \`vl.js dashboard lan disable\`.`;
}

// The daemon's view of the token: re-read whenever the file changes (inode,
// size or mtime), so `rotate` takes effect on the next request. → token | null
function createTokenReader(dir) {
  let cached = null;
  let sig = null;
  return function currentToken() {
    let st;
    try { st = fs.lstatSync(tokenPath(dir)); } catch { cached = null; sig = null; return null; }
    const now = `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}`;
    if (now !== sig) {
      const read = readToken(dir);
      cached = read.ok ? read.token : null;
      sig = now;
    }
    return cached;
  };
}

// Constant-time comparison of a presented token with the current one.
function tokenMatches(expected, presented) {
  if (typeof expected !== 'string' || !expected || typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

// A free port on `address`, chosen once by `lan enable` and then persisted.
function pickFreePort(address) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (e) => resolve({ ok: false, error: (e && e.code) || 'bind-failed' }));
    server.listen(0, address, () => {
      const { port } = server.address();
      server.close(() => resolve({ ok: true, port }));
    });
  });
}

module.exports = {
  TOKEN_FILE, TOKEN_RE, PORT_MIN, PORT_MAX, LAN_FIX,
  tokenPath, addressProblem, canonicalAddress, localAddresses, hostFor, lanUrl,
  resolveLanConfig, readToken, writeToken, tokenProblem, createTokenReader, tokenMatches, pickFreePort,
};
