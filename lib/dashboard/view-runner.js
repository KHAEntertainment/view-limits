'use strict';
// One bounded collection for the daemon: run `vl.js view --json` as a child
// process and parse its envelope (Issue #61).
//
// Why a subprocess and not an in-process collectView call: the view's assembly
// (confirmed config read, shared collection under the refresh-worker lock,
// native observation, schema build, cache read) lives in bin/vl.js's `view`
// command. Running that command makes the daemon's view BYTE-IDENTICAL to the
// CLI's, duplicates none of it, and isolates a hung provider read: the child is
// killed at the deadline and the daemon's event loop never waits on it.
//
// The child gets no shell, the daemon's environment (same data dir) and its
// own process group so a timeout kills grandchildren too. Output is bounded.
// Parsing is strict: only a valid envelope of the expected schema version is a
// view; anything else is an `error` outcome and the caller keeps (and marks
// stale) whatever it had. A failed parse is never presented as a good view.
// Exit status 1 with a valid envelope is a normal "collection failed" view.

const { spawn } = require('child_process');
const { VIEW_SCHEMA_VERSION } = require('../view-model');

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// One line, bounded: a child's stderr is diagnostic text, not data.
function oneLine(text, max = 200) {
  const s = String(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// → the envelope, or null when `text` is not a valid view envelope.
function parseEnvelope(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(doc) || doc.schemaVersion !== VIEW_SCHEMA_VERSION) return null;
  if (!Array.isArray(doc.routes)) return null;
  if (!isPlainObject(doc.collection) || typeof doc.collection.outcome !== 'string') return null;
  return doc;
}

function createViewRunner({
  vlPath,
  nodePath = process.execPath,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  cwd,
  spawnFn = spawn,
} = {}) {
  if (typeof vlPath !== 'string' || !vlPath) throw new TypeError('vlPath is required');
  let current = null;

  function kill(child) {
    // The whole group: the view may have spawned a CLI of its own.
    try { process.kill(-child.pid, 'SIGKILL'); } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }

  function collect() {
    return new Promise((resolve) => {
      let settled = false;
      let child;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (current === child) current = null;
        resolve(result);
      };
      try {
        child = spawnFn(nodePath, [vlPath, 'view', '--json'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          env,
          cwd,
        });
      } catch (e) {
        resolve({ ok: false, outcome: 'error', error: `could not start the view: ${oneLine((e && e.code) || (e && e.message) || 'spawn failed')}` });
        return;
      }
      current = child;
      const out = [];
      let outBytes = 0;
      let errText = '';
      let overflow = false;
      const timer = setTimeout(() => {
        kill(child);
        finish({ ok: false, outcome: 'timeout', error: `the view did not finish within ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        outBytes += chunk.length;
        if (outBytes > MAX_STDOUT_BYTES) {
          if (!overflow) { overflow = true; kill(child); }
          return;
        }
        out.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (errText.length < MAX_STDERR_BYTES) errText += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - errText.length);
      });
      child.on('error', (e) => {
        finish({ ok: false, outcome: 'error', error: `the view could not run: ${oneLine((e && e.code) || (e && e.message) || 'error')}` });
      });
      child.on('close', (code, signal) => {
        if (overflow) {
          finish({ ok: false, outcome: 'error', error: 'the view output exceeded its size bound' });
          return;
        }
        const envelope = parseEnvelope(Buffer.concat(out).toString('utf8'));
        if (envelope) { finish({ ok: true, envelope }); return; }
        const why = signal ? `signal ${signal}` : `exit ${code}`;
        const detail = errText ? `: ${oneLine(errText)}` : '';
        finish({ ok: false, outcome: 'error', error: `the view produced no valid envelope (${why})${detail}` });
      });
    });
  }

  // Kill the collection in flight (daemon shutdown). Its promise then settles
  // as an error outcome; the daemon is stopping, so nothing consumes it.
  collect.abort = () => { if (current) kill(current); };
  return collect;
}

module.exports = { createViewRunner, parseEnvelope, DEFAULT_TIMEOUT_MS };
