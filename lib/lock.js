'use strict';
// The provider mutation lock. Every config.json publish, the one-time
// migration and every lifecycle mutation run under it (lib/config.js
// saveConfig refuses to publish without it), and lib/config.js's strict
// reader takes it to prove the document absent (PR #82 round 5).
//
// Its own module so lib/config.js and lib/provider-lifecycle.js can both use
// it without a require cycle. It requires Node built-ins only — nothing in
// lib/ — and test/lock.test.js pins that.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCK_DIR = 'provider-mutations';
const TICKET_NAME = /^(\d+)-[a-f0-9]{32}\.json$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Data dirs whose mutation lock this process currently holds. Maintained by
// acquireMutationLock / release; saveConfig refuses to publish without it.
const heldLocks = new Set();
function noteMutationLock(dir, held) {
  const key = path.resolve(dir);
  if (held) heldLocks.add(key); else heldLocks.delete(key);
}
function holdsMutationLock(dir) {
  return heldLocks.has(path.resolve(dir));
}

// ---- mutation lock -----------------------------------------------------------
//
// Serializes lifecycle mutations so two concurrent `provider` commands cannot
// interleave a read-modify-write of config.json (and so a future collector can
// trust that a published revision belongs to a complete mutation).
//
// This is the bakery protocol of lib/refresh-owner.js, and it is deliberately
// NOT a single shared lock file. A shared lock cannot be broken safely: POSIX
// has no identity-conditional unlink, so "read the lock, confirm its holder is
// dead, unlink it" is a check/use race no matter how carefully the holder is
// identified. Two contenders both confirm the dead holder D; the first unlinks
// D and acquires; the second, resuming inside its own stale observation,
// unlinks the FIRST CONTENDER'S LIVE LOCK and acquires too. Both then believe
// they hold it and write config.json concurrently — a lost update, and an
// orphaned vault credential behind it.
//
// Tickets remove the race by construction:
//
//   * every contender owns ONE uniquely named file (`<pid>-<32 hex>.json`) for
//     its whole lifetime, and no contender ever unlinks a path another
//     contender could be using. Recovery removes only a ticket whose filename
//     pid is PROVABLY absent (process.kill raising ESRCH), and because names
//     are never reused, removing a dead contender's ticket cannot remove a
//     successor even if several recoverers do it at the same moment.
//   * the winner is elected, not seized: ordered tickets pick the lowest
//     (number, id), so concurrent contenders converge on one holder without
//     anyone deleting anyone.
//   * a live peer that has not finished numbering itself is INDETERMINATE and
//     yields a refusal, never permission to proceed. PID reuse and permission
//     errors conservatively retain ownership, exactly as refresh-owner treats
//     them.
//   * no age horizon exists, and none is needed: a live holder is never stolen
//     from however long its probe runs (an Alibaba recipe may legitimately hold
//     the lock through two sequential 30s reads), and a dead one is cleaned by
//     liveness rather than by waiting out a clock.

function lockHolderAbsent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return !!e && e.code === 'ESRCH';
  }
}

// Every ticket in `dir` except our own, with provably dead contenders reaped.
// A ticket is reported with number 0 when it is live but not yet (or not
// validly) numbered — the caller treats that as indeterminate.
function liveTickets(dir, ownId) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return found;
    throw e;
  }
  for (const id of entries) {
    const match = TICKET_NAME.exec(id);
    if (!match || id === ownId) continue;
    const pid = Number(match[1]);
    const file = path.join(dir, id);
    if (lockHolderAbsent(pid)) {
      // Safe precisely because this name belongs to one dead contender and is
      // never reused: this can never remove a live peer or a successor.
      try { fs.unlinkSync(file); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
      continue;
    }
    let doc = null;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      doc = null;
    }
    const number = isPlainObject(doc) && doc.pid === pid
      && Number.isSafeInteger(doc.number) && doc.number > 0
      ? doc.number
      : 0;
    found.push({ id, pid, number });
  }
  return found;
}

function acquireMutationLock(dir) {
  const root = path.join(dir, LOCK_DIR);
  const token = crypto.randomBytes(16).toString('hex');
  const id = `${process.pid}-${token}.json`;
  const file = path.join(root, id);
  const temp = `${file}.numbering`;
  let acquired = false;
  try {
    fs.mkdirSync(root, { recursive: true });
    // Phase 1 — choosing: claim our unique name before reading anyone else's,
    // so a peer can see us competing and will not elect itself behind us.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, owner: token, number: 0 }),
      { flag: 'wx', mode: 0o600 });
    const number = 1 + Math.max(0, ...liveTickets(root, id).map((t) => t.number));
    if (!Number.isSafeInteger(number)) throw new Error('invalid mutation ticket');
    // Phase 2 — numbered: published by rename, so a peer never reads a
    // half-written number.
    fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, owner: token, number }),
      { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);

    const contenders = liveTickets(root, id);
    // A peer still choosing is indeterminate. Yielding is the only safe answer,
    // and costs nothing here: a lifecycle mutation is an interactive command
    // that reports LOCK_BUSY and is simply rerun.
    if (contenders.some((t) => t.number === 0)) return { ok: false, error: 'held' };
    const prior = contenders.find((t) => t.number < number || (t.number === number && t.id < id));
    if (prior) return { ok: false, error: 'held', ownerPid: prior.pid };
    acquired = true;
    // config.json is published only by a process holding this lock
    // (lib/config.js saveConfig checks it).
    noteMutationLock(dir, true);
    return {
      ok: true,
      path: file,
      dir: root,
      owner: token,
      release() {
        // Whatever the ticket says, this process stops publishing as its holder.
        noteMutationLock(dir, false);
        // Only ever remove our OWN ticket, and only while it still carries our
        // identity. Nothing else can be at this path, but a corrupted or
        // rewritten ticket is not ours to delete.
        try {
          const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (doc.pid !== process.pid || doc.owner !== token) return false;
          fs.unlinkSync(file);
          return true;
        } catch {
          return false;
        }
      },
    };
  } catch (e) {
    return { ok: false, error: (e && e.code) || 'lock-unavailable' };
  } finally {
    try { fs.unlinkSync(temp); } catch { /* our own temporary file only */ }
    // A contender that did not win must drop its claim, or it would block
    // every later mutation until this process exits.
    if (!acquired) { try { fs.unlinkSync(file); } catch { /* retain conservatively */ } }
  }
}

// Acquire, waiting up to `timeoutMs` for a live holder to finish. Each attempt
// is the full acquireMutationLock above, so a ticket left by a dead process is
// reaped by its liveness check, never bypassed, and the wait converges.
//
// The wait blocks the THREAD (Atomics.wait), not the event loop: nothing in
// this process is scheduled while it waits, and the caller's read stays one
// synchronous block. Replacing it with a timer or any await would split that
// block. The total wait is bounded by timeoutMs.
const WAIT_STEP_MS = 20;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
function acquireMutationLockWithin(dir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = module.exports.acquireMutationLock(dir);
    if (lock.ok || Date.now() >= deadline) return lock;
    Atomics.wait(waitCell, 0, 0, Math.min(WAIT_STEP_MS, Math.max(1, deadline - Date.now())));
  }
}

module.exports = {
  LOCK_DIR, acquireMutationLock, acquireMutationLockWithin, noteMutationLock, holdsMutationLock,
};
