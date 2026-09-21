'use strict';
// Local-filesystem bakery lock. Each contender owns a UNIQUE file for its
// entire lifetime, first marked choosing (number=0), then atomically numbered.
// Ordered tickets elect one worker. No contender unlinks a shared lock path:
// recovery removes only records whose filename PID is provably absent.
// PID reuse/permission errors conservatively retain ownership. This is worker
// code only; the dispatch gate never enters or waits on this protocol.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('./config');
const NAME = /^(\d+)-[a-f0-9]{32}\.json$/;
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

function dead(pid) {
  try { process.kill(pid, 0); return false; }
  catch (e) { return e.code === 'ESRCH'; }
}

function records(dir, ownId) {
  const result = [];
  for (const id of fs.readdirSync(dir)) {
    const match = NAME.exec(id);
    if (!match || id === ownId) continue;
    const pid = Number(match[1]);
    const file = path.join(dir, id);
    if (dead(pid)) {
      // Unique names are never reused. Removing this dead contender cannot
      // remove a successor, even if multiple recoverers inspect it together.
      try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      continue;
    }
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let doc;
    try { doc = JSON.parse(raw); } catch { doc = null; }
    // A partially initialized or malformed live record is indeterminate,
    // never permission to steal. Bounded admission below yields instead.
    const number = doc && doc.pid === pid && Number.isSafeInteger(doc.number) && doc.number > 0
      ? doc.number : 0;
    result.push({ id, pid, number });
  }
  return result;
}

async function acquireWorker({ ownerToken }) {
  const dir = path.join(dataDir(), 'refresh-workers');
  const id = `${process.pid}-${crypto.randomBytes(16).toString('hex')}.json`;
  const file = path.join(dir, id);
  const temp = `${file}.numbering`;
  let acquired = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, owner: ownerToken, number: 0 }), { flag: 'wx', mode: 0o600 });
    const number = 1 + Math.max(0, ...records(dir, id).map(r => r.number));
    if (!Number.isSafeInteger(number)) throw new Error('invalid ownership ticket');
    fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, owner: ownerToken, number }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);

    const deadline = performance.now() + 1000;
    for (;;) {
      const peers = records(dir, id);
      if (peers.some(r => r.number === 0)) {
        if (performance.now() >= deadline) return { acquired: false, reason: 'in-progress' };
        await pause();
        continue;
      }
      const prior = peers.find(r => r.number < number || (r.number === number && r.id < id));
      if (prior) return { acquired: false, reason: 'in-progress', ownerPid: prior.pid };
      acquired = true;
      return { acquired: true, ownerToken, id, dir };
    }
  } catch (e) {
    return { acquired: false, reason: 'storage-error', error: e.code || e.message };
  } finally {
    try { fs.unlinkSync(temp); } catch { /* own temporary file only */ }
    if (!acquired) { try { fs.unlinkSync(file); } catch { /* retain conservatively on failure */ } }
  }
}

function releaseWorker(handle) {
  if (!handle || !NAME.test(handle.id || '') || !handle.id.startsWith(`${process.pid}-`)) return false;
  const file = path.join(handle.dir, handle.id);
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc.pid !== process.pid || doc.owner !== handle.ownerToken) return false;
    fs.unlinkSync(file);
    return true;
  } catch { return false; }
}

module.exports = { acquireWorker, releaseWorker };
