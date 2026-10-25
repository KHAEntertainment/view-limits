'use strict';
// The daemon's published record: <dataDir>/dashboard.json.
//
// Contract (Issue #61):
//   {
//     schema: 1,
//     instanceId: <32 hex>,   // identifies THIS run of the daemon
//     pid, pidStart,          // process identity (see ./identity)
//     host, port,             // the BOUND loopback address and port
//     startedAt: <ISO>,
//     nonce: <64 hex>         // control secret — see below
//   }
//
// It is published only after the listener has bound, atomically (write a
// private temporary file, then rename), mode 0600. The nonce authorises the
// loopback control endpoints (stop, refresh). It lives ONLY in this private file:
// no endpoint serves it, `status` never prints it and nothing logs it. Anyone
// who can read it already runs as the same user and could signal the daemon
// directly, so the file's permissions are the trust boundary.
//
// The record is a CLAIM, never proof: a reader confirms it over loopback
// (instanceId + pid answered by the live listener) before trusting or acting
// on it, and never signals a PID taken from it.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RECORD_NAME = 'dashboard.json';
const RECORD_SCHEMA = 1;

function recordPath(dir) { return path.join(dir, RECORD_NAME); }

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function newRecord({ host, port, pid = process.pid, pidStart, startedAt = new Date().toISOString() }) {
  return {
    schema: RECORD_SCHEMA,
    instanceId: crypto.randomBytes(16).toString('hex'),
    pid,
    pidStart,
    host,
    port,
    startedAt,
    nonce: crypto.randomBytes(32).toString('hex'),
  };
}

function validRecord(r) {
  return isPlainObject(r)
    && r.schema === RECORD_SCHEMA
    && /^[a-f0-9]{32}$/.test(r.instanceId || '')
    && Number.isInteger(r.pid) && r.pid > 0
    && typeof r.pidStart === 'string' && r.pidStart.length > 0
    && typeof r.host === 'string' && r.host.length > 0
    && Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535
    && typeof r.startedAt === 'string' && Number.isFinite(Date.parse(r.startedAt))
    && /^[a-f0-9]{64}$/.test(r.nonce || '');
}

function writeRecord(dir, record) {
  const file = recordPath(dir);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
    return { ok: true };
  } catch (e) {
    try { fs.unlinkSync(temp); } catch { /* ours */ }
    return { ok: false, error: (e && e.code) || 'write-failed' };
  }
}

// → { ok: true, record } | { ok: false, reason: 'absent'|'corrupt' }
function readRecord(dir) {
  let raw;
  try { raw = fs.readFileSync(recordPath(dir), 'utf8'); } catch (e) {
    return { ok: false, reason: e && e.code === 'ENOENT' ? 'absent' : 'corrupt' };
  }
  let doc;
  try { doc = JSON.parse(raw); } catch { return { ok: false, reason: 'corrupt' }; }
  return validRecord(doc) ? { ok: true, record: doc } : { ok: false, reason: 'corrupt' };
}

// Remove the record only if it is still OURS. Called while the daemon still
// holds the ownership lock, so no successor can have replaced it.
function removeRecordIf(dir, instanceId) {
  const read = readRecord(dir);
  if (!read.ok || read.record.instanceId !== instanceId) return false;
  try { fs.unlinkSync(recordPath(dir)); return true; } catch { return false; }
}

module.exports = { RECORD_NAME, RECORD_SCHEMA, recordPath, newRecord, validRecord, writeRecord, readRecord, removeRecordIf };
