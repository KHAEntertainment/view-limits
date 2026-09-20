'use strict';
// Dummy detached worker fixture. Used by cli-gate.test.js to prove the gate
// exits promptly while a real child process is still alive — i.e., refresh is
// truly detached and non-blocking. Sleeps until killed.
setInterval(() => {}, 1000);
