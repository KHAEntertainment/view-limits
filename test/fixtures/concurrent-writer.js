'use strict';
// Simple writer fixture for cache-concurrency.test.js: writes M entries to
// status.json via cache.writeCache (unique temp + atomic rename). No barrier
// — children race. Env: CLAUDE_PLUGIN_DATA (data dir), VL_WRITER_INDEX (i),
// VL_WRITER_COUNT (N writes per child), VL_WRITER_PREFIX (route id prefix).

const path = require('path');
const cache = require(path.resolve(__dirname, '..', '..', 'lib', 'cache'));

const idx = Number(process.env.VL_WRITER_INDEX || '0');
const count = Number(process.env.VL_WRITER_COUNT || '5');
const prefix = process.env.VL_WRITER_PREFIX || 'r';

const now = Date.now();
for (let i = 0; i < count; i += 1) {
  cache.writeCache({
    [`${prefix}${idx}-${i}`]: {
      routeId: `${prefix}${idx}-${i}`,
      observedAt: new Date(now - 60_000).toISOString(),
      freshUntil: new Date(now + 60_000).toISOString(),
      source: 'test',
      status: { state: 'healthy', balance: { available: 1, currency: 'USD' } },
    },
  });
}
process.exit(0);
