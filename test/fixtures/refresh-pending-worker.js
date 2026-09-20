'use strict';
// Standalone detached refresh-worker fixture for the F5 pending-worker test.
// Invoked by the gate's refresh spawn when REVIEW_REAL_REFRESH is set and
// CLAUDE_PLUGIN_ROOT points at a tmp plugin root that has placed this
// fixture at `bin/vl.js`. The gate spawns it as:
//
//   node <tmpRoot>/bin/vl.js refresh --quiet
//
// This fixture does NOT inspect argv or read any other production code: it
// is a single-purpose worker that, after the Node runtime has parsed and
// started executing it, writes a readiness marker file and then stays alive
// (via a long-period setInterval). The test waits for the readiness marker
// with a bounded timeout before asserting gate-completion / liveness /
// detached / unref. If the marker never appears, startup failed and the
// test fails explicitly.
//
// Env:
//   WORKER_READY_PATH — absolute path of the marker file to write once
//                       initialization has succeeded.
//   WORKER_READY_FD  — (optional) numeric fd to also write 'ready' to,
//                       useful for catching env-inheritance regressions.

const fs = require('fs');

const readyPath = process.env.WORKER_READY_PATH;
const readyFdStr = process.env.WORKER_READY_FD;

try {
  if (readyPath) {
    fs.writeFileSync(readyPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  }
  if (readyFdStr) {
    const fd = Number(readyFdStr);
    if (Number.isInteger(fd) && fd >= 0) {
      try { fs.writeSync(fd, 'ready\n'); fs.closeSync(fd); } catch { /* fd may not be openable in all envs */ }
    }
  }
} catch (e) {
  // Initialization failed: exit non-zero so the test's "worker never became
  // ready" path fires. Do NOT stay alive — a worker that can't write its
  // readiness marker is not a valid detached child.
  process.exit(2);
}

// Stay alive for the duration of the test (the test bounds its own wait).
// Long period so we don't waste CPU and so the test's kill(pid, 0) liveness
// check is unambiguous.
setInterval(() => {}, 30000);
