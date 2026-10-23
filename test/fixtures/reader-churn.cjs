'use strict';
// Preload: other processes publishing config.json between this CLI's reads
// (PR #82 round 6 consumer-wiring tests). Deterministic, no sleeps.
//
// VL_TEST_CHURN_DOCS  JSON array of documents, one per writer.
// VL_TEST_CHURN_AT    1-based index of the read attempt of config.json (or
//                     .prev) before which writer 1 begins. Default 1.
// VL_TEST_HOOK_JOURNAL  every step is journaled there as one JSON line.
//
// Each writer behaves as a real publisher in another process would: it takes
// the REAL provider mutation lock for its whole publish, moves config.json
// aside, and later completes with the REAL saveConfig. Writer 1 begins before
// read attempt VL_TEST_CHURN_AT; from then on, each config read that misses
// advances the schedule one step (complete writer k, begin writer k+1), so
// both reads of every lock-free round miss. If a writer cannot take the lock —
// this process already holds it — it cannot publish at all: the schedule
// stops, journaled as `blocked`, exactly as a real concurrent writer would be
// refused.
const fs = require('fs');
const path = require('path');

const docs = JSON.parse(process.env.VL_TEST_CHURN_DOCS || '[]');
const at = Number(process.env.VL_TEST_CHURN_AT || 1);
const journalFile = process.env.VL_TEST_HOOK_JOURNAL;
function journal(entry) {
  if (!journalFile) return;
  try { fs.appendFileSync(journalFile, `${JSON.stringify(entry)}\n`); } catch { /* best effort */ }
}

const config = require('../../lib/config');
const lock = require('../../lib/lock');
// Captured now: a later journaling preload must not count the writers' own
// acquires as the command's.
const acquire = lock.acquireMutationLock;
const realRead = fs.readFileSync;
const realRename = fs.renameSync;

const dir = () => config.dataDir();
const target = () => path.join(dir(), 'config.json');
let held = null;
let writer = 0;
let stopped = docs.length === 0;
let attempts = 0;

function begin() {
  writer += 1;
  const l = acquire(dir());
  if (!l.ok) {
    stopped = true;
    journal({ step: 'blocked', writer });
    return;
  }
  held = l;
  try { realRename(target(), `${target()}.prev`); } catch { /* already aside */ }
  journal({ step: 'begin', writer });
}
function complete() {
  config.saveConfig(docs[writer - 1]);
  held.release();
  held = null;
  journal({ step: 'complete', writer });
  if (writer >= docs.length) stopped = true;
}

fs.readFileSync = function readWithChurn(file, ...rest) {
  const name = path.basename(String(file));
  const isConfig = name === 'config.json' || name === 'config.json.prev';
  if (isConfig) {
    attempts += 1;
    journal({ step: 'read', attempt: attempts, name });
    if (!stopped && attempts === at && writer === 0) begin();
  }
  try {
    return realRead.call(this, file, ...rest);
  } catch (e) {
    if (isConfig && writer > 0 && e && e.code === 'ENOENT') {
      journal({ step: 'miss', name });
      if (stopped) throw e;
      if (held) complete();
      else begin();
    }
    throw e;
  }
};
