'use strict';
// The daemon's collection loop and in-memory view (Issue #61).
//
// `collect()` is injected and resolves to
//   { ok: true, envelope }                      a valid view envelope, or
//   { ok: false, outcome: 'timeout'|'error', error }
// so this module never knows how a collection is made. At most ONE collection
// is in flight: a tick that fires while one runs is SKIPPED (counted), and a
// refresh request joins the run in flight (COALESCED) instead of starting
// another. Cross-process exclusion against other refresh workers stays with
// the shared collector's own ownership lock (lib/refresh-owner.js), which each
// collection takes; this in-process guard only stops the daemon from queueing
// collections behind a slow one.
//
// What the status document says is deliberately conservative:
//   * a valid envelope is adopted whatever its collection outcome — it is the
//     CLI view's truthful rendering of the cache, with per-route ages and the
//     collection diagnostics;
//   * a failed run (timeout, crash, unparseable output) keeps the previous
//     view and marks it stale;
//   * observation age counts from the last GOOD collection (completed or
//     partial) and is never renewed by a failed, contended or skipped one.
//
// Reading the status never calls collect(): polling cannot reach a provider.

const GOOD_OUTCOMES = new Set(['completed', 'partial']);
const STATUS_SCHEMA_VERSION = 1;

function createScheduler({ collect, intervalSeconds, now = Date.now, timers = { setInterval, clearInterval }, onAttempt }) {
  if (typeof collect !== 'function') throw new TypeError('collect must be a function');
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) throw new RangeError('intervalSeconds must be positive');

  let view = null;
  let lastAttempt = null;
  let lastGood = null; // { startedAt, finishedAt } in ms
  let inFlight = null;
  let skippedTicks = 0;
  let coalescedRefreshes = 0;
  let attempts = 0;
  let timer = null;
  let stopped = false;

  const iso = (ms) => new Date(ms).toISOString();

  async function attempt(trigger) {
    const startedAt = now();
    attempts += 1;
    let res;
    try {
      res = await collect();
    } catch (e) {
      res = { ok: false, outcome: 'error', error: e && e.message ? String(e.message) : 'collection threw' };
    }
    const finishedAt = now();
    const record = { trigger, startedAt: iso(startedAt), finishedAt: iso(finishedAt) };
    if (res && res.ok === true && res.envelope && res.envelope.collection) {
      const c = res.envelope.collection;
      view = res.envelope;
      record.outcome = String(c.outcome);
      record.reason = c.reason || null;
      record.error = c.error || null;
      record.good = GOOD_OUTCOMES.has(record.outcome);
    } else {
      record.outcome = res && (res.outcome === 'timeout' || res.outcome === 'error') ? res.outcome : 'error';
      record.reason = null;
      record.error = res && typeof res.error === 'string' && res.error ? res.error : 'no result';
      record.good = false;
    }
    if (record.good) lastGood = { startedAt, finishedAt };
    lastAttempt = record;
    if (onAttempt) { try { onAttempt(record); } catch { /* a logger must not break the loop */ } }
    return record;
  }

  // Start a collection, or join the one in flight. → { joined, done }
  function run(trigger) {
    // A stopped scheduler starts nothing: a refresh that races shutdown joins
    // whatever is left rather than launching a collection nobody will read.
    if (stopped && !inFlight) return { joined: true, done: Promise.resolve() };
    if (inFlight) {
      if (trigger === 'tick') skippedTicks += 1; else coalescedRefreshes += 1;
      return { joined: true, done: inFlight };
    }
    inFlight = attempt(trigger).finally(() => { inFlight = null; });
    return { joined: false, done: inFlight };
  }

  function start() {
    run('start');
    timer = timers.setInterval(() => { if (!stopped) run('tick'); }, intervalSeconds * 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // Stop ticking. Resolves once the run in flight (if any) has settled.
  async function stop() {
    stopped = true;
    if (timer) { timers.clearInterval(timer); timer = null; }
    if (inFlight) { try { await inFlight; } catch { /* attempt() never rejects */ } }
  }

  function snapshot(extra = {}) {
    const t = now();
    const good = lastGood ? lastGood.startedAt : null;
    let status;
    if (!lastAttempt) status = 'pending';
    else if (!view) status = 'unavailable';
    else status = lastAttempt.good ? 'ok' : 'stale';
    return {
      schemaVersion: STATUS_SCHEMA_VERSION,
      status,
      daemon: Object.assign({ intervalSeconds }, extra),
      collection: {
        state: inFlight ? 'collecting' : 'idle',
        attempts,
        skippedTicks,
        coalescedRefreshes,
        lastAttempt,
        lastGoodAt: good === null ? null : iso(good),
        // From the START of the last good collection: the observation cannot
        // be older than that, and no later failure renews it.
        observationAgeSeconds: good === null ? null : Math.max(0, Math.round((t - good) / 1000)),
        stale: status === 'stale',
      },
      view,
    };
  }

  return { start, stop, run, snapshot, isRunning: () => inFlight !== null };
}

module.exports = { createScheduler, GOOD_OUTCOMES, STATUS_SCHEMA_VERSION };
