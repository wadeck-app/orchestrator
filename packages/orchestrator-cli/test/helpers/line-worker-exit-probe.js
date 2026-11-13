'use strict';

// Asks one question of a LineWorker and then does nothing: no dispose, an idle time far longer than the test. Whether this
// process exits by itself is the test (line-worker.test.js): a worker must never keep a daemon that is leaving alive.
require('tsx/cjs');
const path = require('node:path');
const { LineWorker } = require('../../src/process-table');

const worker = new LineWorker({
  cmd: process.execPath, args: [path.join(__dirname, 'fake-table-worker.js'), 'ok'],
  what: 'the probe query', timeoutMs: 30_000, idleMs: 600_000,
});
worker.query().then((lines) => process.stdout.write(`ANSWERED ${lines.length}\n`));
