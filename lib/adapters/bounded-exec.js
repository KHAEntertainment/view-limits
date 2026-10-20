'use strict';
// Bounded read-only subprocess runner — the CLI-backed counterpart to
// boundedGet (./http.js), with the same discipline: never throws, never
// surfaces child text, returns fixed error codes, and bounds both time and
// output. Used by the Alibaba Coding Plan recipe (Issue #56), whose only
// documented quota source is the official Bailian CLI.
//
// Hardening, and why each part matters:
//
//   shell: false      argv is always an array, never a command string, so no
//                     metacharacter in a route field can reach a shell. Callers
//                     additionally restrict which flags may be passed at all.
//   env allowlist     the child gets ONLY the keys the caller passes. It never
//                     inherits process.env, so the vault, the harness's API
//                     keys and every other secret this process holds stay here.
//   stdio             stdin is closed: no recipe can be tricked into feeding
//                     the child a credential on stdin.
//   deadline          SIGKILL at the deadline, then a short grace period so a
//                     child that never emits `close` cannot wedge the read.
//   output caps       stdout is capped hard (over-cap kills the child and fails
//                     the read); stderr is capped and truncated. Callers treat
//                     child output as untrusted data, never as evidence.
//
// It is deliberately NOT a general-purpose exec helper: it has no stdin
// writer, no shell, and no working-directory option, so a caller cannot use it
// to run an interactive, mutating or file-touching command by accident.

const { spawn } = require('child_process');

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;
// A CLI that prints a JSON document is small; 256 KiB is generous for any
// documented quota view and small enough that a runaway child cannot exhaust
// memory before the deadline does.
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const KILL_GRACE_MS = 2000;

function clampTimeout(ms) {
  if (!Number.isFinite(ms)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(ms)));
}

function outcome(extra) {
  return Object.assign({
    ok: false,
    // 'cli-missing' | 'spawn-error' | 'timeout' | 'stdout-too-large' | null
    error: null,
    // Exit status, or null when the child never exited (spawn error/timeout).
    code: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    overflow: false,
  }, extra);
}

function isMissing(err) {
  return !!err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

// Run `bin` with `args` (an argv array) under one deadline.
//
//   → { ok, error, code, stdout, stderr, timedOut, overflow }
//
// `ok` is true only for a clean exit 0 that stayed inside every bound.
// Callers map `error`/`code` to their own stable reasons and must never put
// `stdout` or `stderr` into a status detail.
function runBounded(bin, args, opts = {}) {
  if (typeof bin !== 'string' || !bin) return Promise.resolve(outcome({ error: 'spawn-error' }));
  const argv = Array.isArray(args) ? args.map(String) : [];
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const maxStdout = Number.isFinite(opts.maxStdoutBytes) ? opts.maxStdoutBytes : MAX_STDOUT_BYTES;
  const maxStderr = Number.isFinite(opts.maxStderrBytes) ? opts.maxStderrBytes : MAX_STDERR_BYTES;
  const env = opts.env && typeof opts.env === 'object' ? opts.env : {};

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch {
      resolve(outcome({ error: 'spawn-error' }));
      return;
    }

    const out = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let killGrace = null;

    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGKILL');
      // A child that never emits `close` after SIGKILL must not hang the read.
      killGrace = setTimeout(() => finish(outcome({
        error: 'timeout', timedOut: true, overflow,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      })), KILL_GRACE_MS);
      if (killGrace.unref) killGrace.unref();
    }, timeoutMs);

    function kill(signal) {
      try { child.kill(signal); } catch { /* already gone */ }
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killGrace) clearTimeout(killGrace);
      resolve(result);
    }

    if (child.stdout) {
      child.stdout.on('data', (c) => {
        outBytes += c.length;
        // Over cap: stop reading, kill, and fail. A partial JSON document must
        // never be parsed as if it were complete.
        if (outBytes > maxStdout) {
          if (!overflow) {
            overflow = true;
            try { child.stdout.destroy(); } catch { /* already closed */ }
            kill('SIGKILL');
          }
          return;
        }
        out.push(Buffer.from(c));
      });
      child.stdout.on('error', () => { /* treated as a truncated read below */ });
    }
    if (child.stderr) {
      child.stderr.on('data', (c) => {
        if (errBytes >= maxStderr) return;
        const room = maxStderr - errBytes;
        const take = c.length <= room ? c : c.subarray(0, room);
        errBytes += take.length;
        errChunks.push(Buffer.from(take));
      });
      child.stderr.on('error', () => { /* stderr is never evidence */ });
    }

    child.on('error', (error) => {
      finish(outcome({ error: isMissing(error) ? 'cli-missing' : 'spawn-error' }));
    });
    child.on('close', (code) => {
      finish(outcome({
        ok: !timedOut && !overflow && code === 0,
        error: overflow ? 'stdout-too-large' : (timedOut ? 'timeout' : null),
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
        overflow,
      }));
    });
  });
}

module.exports = {
  runBounded,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_STDOUT_BYTES,
  MAX_STDERR_BYTES,
};