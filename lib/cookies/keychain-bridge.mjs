#!/usr/bin/env node
/* Node bridge for the K1 background Keychain helper candidate.
 *
 * Contract:
 *  - The secret arrives ONLY on the helper's private fd3 pipe, framed (KHF1).
 *  - A SUCCESS result is SECRET-BEARING: {ok:true, secret:Buffer}. It must
 *    never be logged, printed, JSON-serialized (Buffer JSON exposes the raw
 *    bytes), or embedded in errors/diagnostics — use describeResult() for any
 *    output. The caller MUST zeroize(result.secret) after use.
 *  - Failure results are redacted: fixed enum codes and integers only. Child
 *    stdout/stderr are length-counted, never stored or echoed.
 *  - Success additionally requires a clean child exit (code 0, no signal),
 *    both child output streams empty through stream completion, and a complete
 *    valid two-frame protocol. Timeout, SIGKILL, nonzero/signal exit, and
 *    trailing bytes are always failures; there is no settle-window shortcut.
 *  - Wipe scope: every parser/transport allocation this module creates is
 *    overwritten when replaced, consumed, or rejected (size cap checked
 *    before concatenation; fd3 chunks zeroized after parsing). JavaScript
 *    zeroization is best effort: it cannot reach GC copies, string interning,
 *    swap/panic artifacts, or memory the runtime copied outside our buffers.
 *  - The default path never prompts: the helper suppresses Keychain
 *    interaction inside its own process. Interactive prompting requires an
 *    explicit `interactive: true` AND `purpose: 'interactive-setup'`;
 *    nothing else auto-grants it.
 *  - Node >= 18, zero dependencies. No node:sqlite here (optional, consumer
 *    side only).
 */
import { spawn } from 'node:child_process';
import { access, constants as fsConstants } from 'node:fs/promises';
import { pbkdf2Sync } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/* Result codes produced by the helper (must match native/kh_proto.h). */
export const RESULT = Object.freeze({
  0: 'ok',
  1: 'guard-failed',
  2: 'denied',
  3: 'restore-failed',
  4: 'cleanup-failed',
  5: 'no-private-pipe',
  6: 'protocol-error',
  7: 'bad-arguments',
  8: 'payload-too-large',
  9: 'runtime-error',
});

/* Bridge-level codes (spawn/framing/timeout side). */
export const BRIDGE = Object.freeze({
  HELPER_MISSING: 'bridge-helper-missing',
  SPAWN_FAILED: 'bridge-spawn-failed',
  TIMEOUT: 'bridge-timeout',
  NO_FRAMES: 'bridge-no-frames',
  BAD_FRAME: 'bridge-bad-frame',
  HELPER_EXIT: 'bridge-helper-exit',
  INTERACTIVE_REFUSED: 'bridge-interactive-refused',
  BAD_ARGS: 'bridge-bad-arguments',
  STDOUT_UNEXPECTED: 'bridge-stdout-unexpected',
  STDERR_UNEXPECTED: 'bridge-stderr-unexpected',
  INTERNAL: 'bridge-internal',
});

const FRAME_MAGIC = Buffer.from('KHF1');
const FRAME_HEADER = 12;
const FRAME_SECRET = 1;
const FRAME_ERROR = 2;
const FRAME_END = 3;
const MAX_PAYLOAD = 4096;
const MAX_BUFFER = FRAME_HEADER + MAX_PAYLOAD + FRAME_HEADER + 4 + FRAME_HEADER;
const DEFAULT_SERVICE = 'Chrome Safe Storage';

const fail = (code, extra) => Object.freeze({ ok: false, code, ...extra });
const isHelperCode = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 9 && RESULT[value] !== undefined;

function wipeFrames(frames) {
  for (const frame of frames) frame.payload.fill(0);
}

/* Owns every fd3 buffer it holds: copies are wiped when replaced, consumed
 * or rejected, and the incoming chunk is wiped after parsing (review
 * finding 3). The size cap is checked BEFORE any concatenation allocation. */
class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.frames = [];
    this.error = null;
  }
  push(chunk) {
    try {
      if (this.error || !Buffer.isBuffer(chunk) || chunk.length === 0) return;
      if (this.buf.length + chunk.length > MAX_BUFFER) {
        this.fail();
        return;
      }
      const appended = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
      if (this.buf.length) this.buf.fill(0); /* replaced allocation is wiped */
      this.buf = appended;
      this.parseBuffer();
    } finally {
      if (Buffer.isBuffer(chunk)) chunk.fill(0); /* consumed fd3 chunk */
    }
  }
  parseBuffer() {
    while (!this.error) {
      if (this.buf.length === 0) return;
      if (this.frames.length >= 2) {
        this.fail(); /* trailing bytes after the 2-frame contract */
        return;
      }
      if (this.buf.length < FRAME_HEADER) return;
      if (!this.buf.subarray(0, 4).equals(FRAME_MAGIC)) {
        this.fail();
        return;
      }
      const type = this.buf[4];
      const flags = this.buf[5];
      const len = this.buf.readUInt32LE(8);
      if (flags !== 0 || this.buf[6] !== 0 || this.buf[7] !== 0 || len > MAX_PAYLOAD) {
        this.fail();
        return;
      }
      if (type !== FRAME_SECRET && type !== FRAME_ERROR && type !== FRAME_END) {
        this.fail();
        return;
      }
      if (this.buf.length < FRAME_HEADER + len) return;
      const payload = Buffer.from(this.buf.subarray(FRAME_HEADER, FRAME_HEADER + len));
      if (type !== FRAME_SECRET && len !== 4) {
        payload.fill(0);
        this.fail();
        return;
      }
      if (type === FRAME_SECRET && len === 0) {
        payload.fill(0); /* the native core never emits an empty secret */
        this.fail();
        return;
      }
      const rest = Buffer.from(this.buf.subarray(FRAME_HEADER + len));
      this.buf.fill(0); /* source buffer wiped after both owned copies exist */
      this.buf = rest;
      this.frames.push({ type, payload });
    }
  }
  fail() {
    if (!this.error) this.error = BRIDGE.BAD_FRAME;
    this.zeroizeAll();
  }
  zeroizeAll() {
    if (this.buf.length) this.buf.fill(0);
    wipeFrames(this.frames);
  }
}

/* Strict two-frame validation: types, lengths, codes, and legal combinations
 * (review finding 2). Returns:
 *   {kind:'success'}                          SECRET(nonempty) + END(0)
 *   {kind:'failure', code, helperCode}        any precedence-resolved failure
 *   {kind:'bad'}                              anything else (protocol error)
 * The END frame is authoritative when acquisition failed, so ERROR(2)+END(3)
 * classifies as restore-failed, not denied. */
function validatePair(frames) {
  if (frames.length !== 2) return { kind: 'bad' };
  const [first, second] = frames;
  if (second.type !== FRAME_END || second.payload.length !== 4) return { kind: 'bad' };
  const endCode = second.payload.readUInt32LE(0);
  if (!isHelperCode(endCode)) return { kind: 'bad' };
  if (first.type === FRAME_SECRET) {
    if (first.payload.length < 1 || first.payload.length > MAX_PAYLOAD) return { kind: 'bad' };
    if (endCode === 0) return { kind: 'success' };
    return { kind: 'failure', code: RESULT[endCode], helperCode: endCode };
  }
  if (first.type === FRAME_ERROR) {
    if (first.payload.length !== 4) return { kind: 'bad' };
    const errCode = first.payload.readUInt32LE(0);
    if (!isHelperCode(errCode) || errCode === 0) return { kind: 'bad' };
    if (endCode === 0) return { kind: 'bad' }; /* failure cannot end OK */
    /* After a failed acquisition END must be the acquisition code itself or
     * the precedence-resolved restore/cleanup failure. */
    if (endCode !== errCode && endCode !== 3 && endCode !== 4) return { kind: 'bad' };
    return { kind: 'failure', code: RESULT[endCode], helperCode: endCode };
  }
  return { kind: 'bad' };
}

function discardPair(frames) {
  wipeFrames(frames);
}

/* Child exited without a complete valid success pair. Every branch fails. */
function classifyIncomplete(frames, stdoutLen, spawnError, timedOut, exitCode, signal) {
  if (spawnError) return fail(BRIDGE.SPAWN_FAILED);
  if (timedOut) return fail(BRIDGE.TIMEOUT, { timedOut: true });
  if (
    frames.length === 1 &&
    (frames[0].type === FRAME_ERROR || frames[0].type === FRAME_END) &&
    frames[0].payload.length === 4
  ) {
    const code = frames[0].payload.readUInt32LE(0);
    discardPair(frames);
    if (isHelperCode(code) && code !== 0) return fail(RESULT[code], { helperCode: code });
    return fail(BRIDGE.NO_FRAMES);
  }
  if (frames.length > 0) {
    discardPair(frames); /* lone SECRET or otherwise incomplete: wipe first */
    return fail(BRIDGE.NO_FRAMES);
  }
  if (stdoutLen > 0) return fail(BRIDGE.NO_FRAMES);
  if (isHelperCode(exitCode) && exitCode !== 0)
    return fail(RESULT[exitCode], { helperCode: exitCode });
  if (exitCode === 0 && signal == null) return fail(BRIDGE.NO_FRAMES);
  return fail(BRIDGE.HELPER_EXIT, Number.isInteger(exitCode) ? { exitCode } : {});
}

/**
 * Retrieve the Chrome Safe Storage secret through the native helper.
 * Resolves {ok:true, secret:Buffer} — a SECRET-BEARING result that must never
 * be logged or serialized; the caller MUST zeroize(secret) — or a redacted
 * {ok:false, code[, exitCode, timedOut, helperCode, signalExit]}.
 * Success additionally requires a clean child exit and fully observed empty
 * output streams; timeout/kill/nonzero/signal exits always fail.
 */
export async function acquireKey(options = {}) {
  const {
    helperPath,
    service = DEFAULT_SERVICE,
    account,
    keychainPath,
    interactive = false,
    purpose,
    timeoutMs = 5000,
    spawnImpl = spawn,
  } = options;

  if (interactive === true && purpose !== 'interactive-setup')
    return fail(BRIDGE.INTERACTIVE_REFUSED);
  if (typeof interactive !== 'boolean') return fail(BRIDGE.BAD_ARGS);
  if (typeof helperPath !== 'string' || helperPath.length === 0) return fail(BRIDGE.BAD_ARGS);
  if (typeof service !== 'string' || service.length === 0) return fail(BRIDGE.BAD_ARGS);
  if (account !== undefined && (typeof account !== 'string' || account.length === 0))
    return fail(BRIDGE.BAD_ARGS);
  if (keychainPath !== undefined && (typeof keychainPath !== 'string' || keychainPath.length === 0))
    return fail(BRIDGE.BAD_ARGS);
  const timeout = Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 200), 60000) : 5000;

  try {
    await access(helperPath, fsConstants.X_OK);
  } catch {
    return fail(BRIDGE.HELPER_MISSING);
  }

  const args = ['--fd', '3', '--service', service];
  if (account !== undefined) args.push('--account', account);
  if (keychainPath !== undefined) args.push('--keychain', keychainPath);
  if (interactive === true) args.push('--interactive');

  return await new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawnImpl(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    } catch {
      resolve(fail(BRIDGE.SPAWN_FAILED));
      return;
    }

    const parser = new FrameParser();
    let stdoutLen = 0;
    let stderrLen = 0;
    let spawnError = false;
    let timedOut = false;
    let exitCode = null;
    let exitSignal = null;
    let closed = false;
    let successCandidate = false;
    let killTimer;
    let hardTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardTimer);
      if (!result.ok) parser.zeroizeAll();
      if (child && !closed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      /* Detach owned streams and listeners on final settlement so a late
       * chunk or error event can never mutate a resolved result. */
      if (child) {
        for (const stream of [child.stdout, child.stderr, child.stdio && child.stdio[3]]) {
          if (stream && typeof stream.removeAllListeners === 'function') {
            stream.removeAllListeners();
            if (typeof stream.destroy === 'function') {
              try {
                stream.destroy();
              } catch {
                /* already closed */
              }
            }
          }
        }
        child.removeAllListeners();
        child.on('error', () => {
          /* swallow post-settlement spawn/kill errors: never an unhandled
           * 'error' event after listeners were detached */
        });
      }
      resolve(result);
    };

    const onPipe = (chunk) => {
      if (settled) {
        chunk.fill(0);
        return;
      }
      parser.push(chunk); /* push wipes the chunk itself */
      if (parser.error) return finish(fail(parser.error));
      if (successCandidate || parser.frames.length !== 2) return;
      const verdict = validatePair(parser.frames);
      if (verdict.kind === 'bad') {
        parser.zeroizeAll();
        return finish(fail(BRIDGE.BAD_FRAME));
      }
      if (verdict.kind === 'failure') {
        const failure = fail(verdict.code, { helperCode: verdict.helperCode });
        discardPair(parser.frames);
        return finish(failure);
      }
      /* Complete success pair: keep the SECRET payload private until the
       * child exits cleanly with both output streams observed empty. */
      successCandidate = true;
      parser.frames[1].payload.fill(0);
    };

    /* Evaluated exactly once, from the child 'close' event: process exit and
     * all stdio streams are complete at this point. Timeout/abnormal exit
     * take precedence over an otherwise valid success pair (review finding 4). */
    const evaluateAtClose = () => {
      if (spawnError) return finish(fail(BRIDGE.SPAWN_FAILED));
      if (timedOut) return finish(fail(BRIDGE.TIMEOUT, { timedOut: true }));
      if (parser.error) return finish(fail(parser.error));
      if (successCandidate && parser.frames.length === 2) {
        if (exitSignal != null) {
          parser.zeroizeAll();
          return finish(
            fail(BRIDGE.HELPER_EXIT, {
              ...(Number.isInteger(exitCode) ? { exitCode } : {}),
              signalExit: true,
            }),
          );
        }
        if (exitCode !== 0) {
          parser.zeroizeAll();
          return finish(fail(BRIDGE.HELPER_EXIT, { exitCode }));
        }
        if (stdoutLen > 0) {
          parser.zeroizeAll();
          return finish(fail(BRIDGE.STDOUT_UNEXPECTED));
        }
        if (stderrLen > 0) {
          parser.zeroizeAll();
          return finish(fail(BRIDGE.STDERR_UNEXPECTED));
        }
        return finish(Object.freeze({ ok: true, secret: parser.frames[0].payload }));
      }
      finish(
        classifyIncomplete(parser.frames, stdoutLen, spawnError, timedOut, exitCode, exitSignal),
      );
    };

    /* Bounded kill, then a bounded shutdown fallback if close never arrives. */
    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeout);
    hardTimer = setTimeout(() => {
      if (!settled) finish(fail(BRIDGE.TIMEOUT, { timedOut: true }));
    }, timeout + 2000);

    child.on('error', () => {
      spawnError = true;
      finish(fail(BRIDGE.SPAWN_FAILED));
    });

    child.stdout?.on('data', (chunk) => {
      stdoutLen = Math.min(stdoutLen + chunk.length, 65536);
      chunk.fill(0);
    });
    child.stderr?.on('data', (chunk) => {
      stderrLen = Math.min(stderrLen + chunk.length, 65536);
      chunk.fill(0);
    });
    child.stdio[3]?.on('data', onPipe);

    child.on('close', (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      if (settled) return;
      evaluateAtClose();
    });
  });
}

/** Zeroize a secret buffer. Always call this when done. */
export function zeroize(buffer) {
  if (Buffer.isBuffer(buffer)) buffer.fill(0);
}

/**
 * Safe diagnostic projection of an acquireKey result: fixed enum codes and
 * integers only, never the secret. This is the ONLY form of a result that may
 * be logged, printed, or JSON-serialized; the raw success object is
 * secret-bearing.
 */
export function describeResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, code: BRIDGE.INTERNAL };
  if (result.ok === true) return { ok: true, code: RESULT[0] };
  const out = { ok: false };
  if (typeof result.code === 'string') out.code = result.code;
  if (Number.isInteger(result.helperCode)) out.helperCode = result.helperCode;
  if (Number.isInteger(result.exitCode)) out.exitCode = result.exitCode;
  if (result.timedOut === true) out.timedOut = true;
  if (result.signalExit === true) out.signalExit = true;
  return out;
}

/**
 * Chrome cookie AES key from the Safe Storage secret (macOS v10 scheme,
 * matching the verified reference: PBKDF2-SHA1, 1003 iterations, 16 bytes).
 * Caller must zeroize the returned key.
 */
export function deriveAesKey(secret) {
  if (!Buffer.isBuffer(secret) || secret.length === 0) throw new Error('bad-arguments');
  return pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
}

/* ---- CLI: diagnostic check only. Prints describeResult(); NEVER the secret. ---- */
const USAGE =
  'usage: keychain-helper.mjs check --helper PATH [--service NAME] '
  + '[--account NAME] [--keychain PATH] [--timeout MS] [--interactive]\n';

async function cli(input) {
  const argv = input[0] === 'check' ? input.slice(1) : input;
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--helper') opts.helperPath = argv[++i];
    else if (arg === '--service') opts.service = argv[++i];
    else if (arg === '--account') opts.account = argv[++i];
    else if (arg === '--keychain') opts.keychainPath = argv[++i];
    else if (arg === '--timeout') opts.timeoutMs = Number(argv[++i]);
    else if (arg === '--interactive') {
      opts.interactive = true;
      opts.purpose = 'interactive-setup';
    } else {
      process.stdout.write(USAGE);
      return 2;
    }
  }
  if (opts.helperPath === undefined) {
    process.stdout.write(USAGE);
    return 2;
  }
  const result = await acquireKey(opts);
  const safe = describeResult(result);
  if (result.ok) zeroize(result.secret);
  process.stdout.write(`${JSON.stringify(safe)}\n`);
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
