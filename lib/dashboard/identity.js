'use strict';
// Process identity for the dashboard daemon (Issue #61).
//
// A PID alone proves nothing: after a crash the OS may hand the same number to
// an unrelated process, and `process.kill(pid, 0)` would then report the dead
// daemon "alive" forever. Identity is therefore the pair (pid, start token),
// where the start token is the process start time as `ps -o lstart=` prints it.
// A recorded token that no longer matches means the PID belongs to a different
// process, i.e. the recorded one is dead.
//
// When the token cannot be read (ps missing, unparseable output) the answer is
// UNVERIFIED — never a match. Callers refuse to stop or trust such a process;
// they do not guess.

const { execFileSync } = require('child_process');

// "Mon Oct 24 18:30:12 2026" — `ps -o lstart=` under LC_ALL=C. Anything else
// (a localized or truncated string, an error message) is not a token.
const TOKEN_RE = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9]\d \d\d:\d\d:\d\d \d{4}$/;

function psStartToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { LC_ALL: 'C', LANG: 'C' }),
    }).trim().replace(/\s+/g, ' ');
    return TOKEN_RE.test(out) ? out : null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

const VERDICT = Object.freeze({ SAME: 'same', DEAD: 'dead', UNVERIFIED: 'unverified' });

// `same`       the process with this pid is the one that recorded `token`.
// `dead`       no such process, or the pid now belongs to a different process.
// `unverified` it exists but its identity cannot be established.
function classify(pid, token, io = {}) {
  const exists = io.exists || processExists;
  const tokenOf = io.tokenOf || psStartToken;
  if (!Number.isInteger(pid) || pid <= 0) return VERDICT.DEAD;
  if (!exists(pid)) return VERDICT.DEAD;
  if (typeof token !== 'string' || !token) return VERDICT.UNVERIFIED;
  const now = tokenOf(pid);
  if (now === null) return VERDICT.UNVERIFIED;
  return now === token ? VERDICT.SAME : VERDICT.DEAD;
}

module.exports = { psStartToken, classify, processExists, VERDICT };
