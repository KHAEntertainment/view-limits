'use strict';
// IPC barriers keep contenders alive until the parent finishes assertions.
const cache = require('../../lib/cache');
let handle;
process.on('message', async message => {
  if (message === 'go') {
    handle = await cache.acquireWorker({ ownerToken: String(process.pid) });
    if (handle.acquired) cache.writeCache({ winner: { routeId: String(process.pid) } });
    process.send({ type: 'result', handle });
  } else if (message === 'release') {
    if (handle && handle.acquired) cache.releaseWorker(handle);
    process.exit(0);
  }
});
process.send({ type: 'ready' });
