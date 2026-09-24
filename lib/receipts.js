'use strict';
// Credential-submission receipts — Issue #19.
//
// A small, pure, transport-neutral module that writes and reads durable
// completion receipts when credential form submissions finish. Receipts are
// non-secret metadata only (timestamp, route ids, outcome) — never key
// material or token-shaped values.
//
// Design:
//   - Written ONLY by the form server (bin/vl.js serve), never by report/refresh.
//   - Read by report and session-start for surfacing to the agent.
//   - Consumption is idempotent via TTL expiry (stale receipts auto-expire).
//   - Truthfulness: absent receipt = {status:'unknown', reason:'receipt-absent'}.
//   - Zero-network, zero-subprocess — this is a local JSON file only.

const fs = require('fs');
const path = require('path');

const RECEIPT_FILE = 'credential-receipt.json';
// Receipts are fresh for 10 minutes — long enough for the agent's next
// report or session-start to see the notification, short enough to avoid
// stale ghost notifications forever.
const FRESHNESS_MS = 10 * 60 * 1000;

// Stable reason codes for receipt outcomes.
const OUTCOME_SUBMITTED = 'submitted';
const OUTCOME_ABANDONED = 'abandoned';
const OUTCOME_FAILED = 'failed';

const OUTCOMES = new Set([OUTCOME_SUBMITTED, OUTCOME_ABANDONED, OUTCOME_FAILED]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function receiptPath(dataDir) {
  return path.join(dataDir, RECEIPT_FILE);
}

// Write a receipt. Called by the form server on submission/abandon/failure.
// `outcome` must be one of the OUTCOME_* constants.
// `routeIds` is an array of route id strings (non-secret identifiers only).
// `detail` is an optional human-readable string (must NOT contain secrets).
function writeReceipt(dataDir, { outcome, routeIds, detail }) {
  if (!OUTCOMES.has(outcome)) throw new Error(`invalid receipt outcome: ${outcome}`);
  if (!Array.isArray(routeIds) || routeIds.length === 0 || !routeIds.every(nonEmptyString)) {
    throw new Error('routeIds must be a non-empty array of non-empty strings');
  }
  // Scrub any token-shaped values from routeIds (defense in depth).
  const safeIds = routeIds.filter((id) => !/^sk-|^tok-/.test(id));
  const receipt = {
    outcome,
    routeIds: safeIds,
    timestamp: new Date().toISOString(),
    freshUntil: new Date(Date.now() + FRESHNESS_MS).toISOString(),
  };
  if (nonEmptyString(detail)) {
    // Scrub potential secrets from the detail string.
    receipt.detail = detail.replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]').replace(/tok-[a-zA-Z0-9_-]+/g, '[REDACTED]');
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(receiptPath(dataDir), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } catch {
    // If we can't write the receipt, that's not fatal — the credential
    // may already have been saved. Log and continue.
    return null;
  }
}

// Read the current receipt if it exists and is fresh.
// Returns the receipt object, or null if absent/expired/corrupt.
function readReceipt(dataDir) {
  try {
    const raw = fs.readFileSync(receiptPath(dataDir), 'utf8');
    const doc = JSON.parse(raw);
    if (!isPlainObject(doc)) return null;
    if (!OUTCOMES.has(doc.outcome)) return null;
    if (!Array.isArray(doc.routeIds)) return null;
    if (!nonEmptyString(doc.timestamp)) return null;
    // Check freshness — expired receipts are treated as absent.
    if (nonEmptyString(doc.freshUntil)) {
      const deadline = new Date(doc.freshUntil).getTime();
      if (!Number.isNaN(deadline) && Date.now() > deadline) return null;
    }
    return doc;
  } catch {
    return null;
  }
}

// Remove a consumed receipt (explicit ack). Called by session-start or
// refresh after surfacing the notification to the agent.
function ackReceipt(dataDir) {
  try {
    fs.unlinkSync(receiptPath(dataDir));
  } catch {
    // absent or unwritable — both fine
  }
}

// Format a receipt for human/agent consumption.
// Accepts either a raw receipt object or a receiptFact (which has .value).
// Returns null if the receipt is absent or expired.
function formatReceipt(receipt) {
  if (!receipt) return null;
  // Accept receiptFact shape: { value: { outcome, routeIds, timestamp } }
  const r = (receipt.value && typeof receipt.value === 'object' && receipt.value.outcome)
    ? receipt.value
    : receipt;
  if (!r || !r.outcome || !r.timestamp) return null;
  const time = new Date(r.timestamp).toLocaleString();
  const routeIds = Array.isArray(r.routeIds) ? r.routeIds : [];
  const routes = routeIds.join(', ');
  switch (r.outcome) {
    case OUTCOME_SUBMITTED:
      return `credentials rotated for ${routes} at ${time}`;
    case OUTCOME_ABANDONED:
      return `credential form closed without submission at ${time}`;
    case OUTCOME_FAILED:
      return `credential storage failed for ${routes} at ${time}${r.detail ? ': ' + r.detail : ''}`;
    default:
      return null;
  }
}

// The truthfulness-shaped observation: a receipt present = observed fact;
// absent receipt = unknown with reason.
function receiptFact(dataDir) {
  const receipt = readReceipt(dataDir);
  if (receipt) {
    return {
      value: {
        outcome: receipt.outcome,
        routeIds: receipt.routeIds,
        timestamp: receipt.timestamp,
      },
      provenance: 'observed',
      source: 'credential-receipt',
      observedAt: receipt.timestamp,
      freshUntil: receipt.freshUntil,
      reason: null,
    };
  }
  return {
    value: null,
    provenance: 'unknown',
    source: null,
    observedAt: null,
    freshUntil: null,
    reason: 'receipt-absent',
  };
}

module.exports = {
  OUTCOME_SUBMITTED,
  OUTCOME_ABANDONED,
  OUTCOME_FAILED,
  FRESHNESS_MS,
  RECEIPT_FILE,
  writeReceipt,
  readReceipt,
  ackReceipt,
  formatReceipt,
  receiptFact,
};
