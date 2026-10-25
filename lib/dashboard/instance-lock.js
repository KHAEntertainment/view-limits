'use strict';
// The dashboard daemon's ownership lock (Issue #61): at most one daemon per
// data directory.
//
// Origin: the ticket ("bakery") protocol of lib/lock.js and
// lib/refresh-owner.js, copied rather than reused because those hardcode their
// directories and judge liveness by PID alone. A daemon is long-lived, and a
// crashed one leaves its ticket behind for days; its PID can be reused by an
// unrelated process in that time. So liveness here is the pair (pid, start
// token) from ./identity: a ticket whose pid now belongs to a different
// process is dead and is reaped, while one whose identity cannot be verified is
// conservatively treated as held.
//
// The protocol keeps the properties that make lib/lock.js safe:
//   * every contender owns ONE uniquely named file for its whole lifetime and
//     nobody ever unlinks a path another contender could be using; recovery
//     removes only a ticket whose owner is provably dead, and unique names are
//     never reused;
//   * the holder is elected (lowest number, then id), not seized;
//   * a live peer that has not numbered itself yet is waited for, then
//     treated as indeterminate (refuse), never as permission.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const identity = require('./identity');

const LOCK_DIR = 'dashboard-lock';
const TICKET_NAME = /^(\d+)-[a-f0-9]{32}\.json$/;
const WAIT_MS = 1000;
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Every ticket in `root` except our own, with provably dead contenders reaped.
// number 0 = live but not (yet, or not validly) numbered.
function peers(root, ownId, io) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(root); } catch (e) {
    if (e && e.code === 'ENOENT') return found;
    throw e;
  }
  for (const id of entries) {
    const match = TICKET_NAME.exec(id);
    if (!match || id === ownId) continue;
    const pid = Number(match[1]);
    const file = path.join(root, id);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      doc = null;
    }
    const token = isPlainObject(doc) && doc.pid === pid ? doc.pidStart : null;
    if (identity.classify(pid, token, io) === identity.VERDICT.DEAD) {
      try { fs.unlinkSync(file); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
      continue;
    }
    const number = isPlainObject(doc) && doc.pid === pid && Number.isSafeInteger(doc.number) && doc.number > 0
      ? doc.number : 0;
    found.push({ id, pid, number });
  }
  return found;
}

// → { ok: true, release() } | { ok: false, reason: 'held'|'indeterminate'|'no-identity'|'storage-error', ownerPid?, error? }
async function acquireInstanceLock(dir, io = {}) {
  const root = path.join(dir, LOCK_DIR);
  const tokenOf = io.tokenOf || identity.psStartToken;
  const pidStart = tokenOf(process.pid);
  // Without a start token the daemon could never be told apart from a
  // PID-reusing stranger after a crash. Refuse to become one.
  if (!pidStart) return { ok: false, reason: 'no-identity' };
  const owner = crypto.randomBytes(16).toString('hex');
  const id = `${process.pid}-${owner}.json`;
  const file = path.join(root, id);
  const temp = `${file}.numbering`;
  let acquired = false;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Phase 1 — choosing: claim our unique name before reading anyone else's.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, pidStart, owner, number: 0 }),
      { flag: 'wx', mode: 0o600 });
    const number = 1 + Math.max(0, ...peers(root, id, io).map((t) => t.number));
    if (!Number.isSafeInteger(number)) throw new Error('invalid ticket number');
    // Phase 2 — numbered: published by rename, so no peer reads a half number.
    fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, pidStart, owner, number }),
      { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);

    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const others = peers(root, id, io);
      if (others.some((t) => t.number === 0)) {
        if (Date.now() >= deadline) return { ok: false, reason: 'indeterminate' };
        await pause();
        continue;
      }
      const prior = others.find((t) => t.number < number || (t.number === number && t.id < id));
      if (prior) return { ok: false, reason: 'held', ownerPid: prior.pid };
      acquired = true;
      return {
        ok: true,
        pidStart,
        release() {
          // Only our OWN ticket, and only while it still carries our identity.
          try {
            const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (doc.pid !== process.pid || doc.owner !== owner) return false;
            fs.unlinkSync(file);
            return true;
          } catch { return false; }
        },
      };
    }
  } catch (e) {
    return { ok: false, reason: 'storage-error', error: (e && e.code) || 'lock-unavailable' };
  } finally {
    try { fs.unlinkSync(temp); } catch { /* our own temporary file only */ }
    if (!acquired) { try { fs.unlinkSync(file); } catch { /* retain conservatively */ } }
  }
}

module.exports = { LOCK_DIR, acquireInstanceLock };
