'use strict';

// The save goes through the async writer: get-progress returns before the disk is touched, and a failing disk is
// retried on the injected clock, never by a busy-wait on the event loop.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { openProgressFile, progressFilePath } = require('../../src/progress/store');
const { createJsonWriter } = require('../../src/progress/async-writer');
const { FakeTime } = require('../../src/time-service');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const JOB = { id: 'j', command: 'node a.js', cwd: '/w' };
const S1 = { id: 'log-learned', version: 1 };
const settle = () => new Promise(resolve => setImmediate(resolve));

function failingFs(failures) {
  let remaining = failures;
  const writes = [];
  return {
    writes,
    ops: {
      mkdir: async () => {},
      writeFile: async (file) => { writes.push(file); if (remaining-- > 0) { throw new Error('EBUSY: locked'); } },
      rename: async () => {},
      unlink: async () => {},
    },
  };
}

describe('learned data store: non-blocking saves', () => {
  test('a save returns before the disk is touched, and a reader right after sees it', async () => {
    const dir = fx.tempDir();
    const writer = createJsonWriter({ time: new FakeTime() });
    const f = openProgressFile({ configDir: dir, jobId: 'j', job: JOB, log: () => {}, writer });
    f.storeFor(S1).write({ a: 1 });

    assert.equal(fs.existsSync(progressFilePath(dir, 'j')), false, 'not on disk yet');
    const reader = openProgressFile({ configDir: dir, jobId: 'j', job: JOB, log: () => {}, writer });
    assert.deepEqual(reader.storeFor(S1).read(), { a: 1 }, 'a new handle reads the pending content');
    await writer.whenIdle();
    assert.deepEqual(JSON.parse(fs.readFileSync(progressFilePath(dir, 'j'), 'utf8')).strategies['log-learned'].data, { a: 1 });
  });

  test('a failing disk: the save call returns at once, retries run on the injected clock, the failure is logged once', async () => {
    const time = new FakeTime();
    const bad = failingFs(99);
    const writer = createJsonWriter({ fs: bad.ops, time });
    const lines = [];
    const f = openProgressFile({ configDir: '/c', jobId: 'j', job: JOB, log: l => lines.push(l), writer });

    f.storeFor(S1).write({ a: 1 });
    await settle();
    assert.equal(bad.writes.length, 1);
    assert.deepEqual(lines, [], 'nothing reported while the retries are pending');
    time.advance(100);
    await settle();
    time.advance(200);
    await writer.whenIdle();

    assert.equal(bad.writes.length, 3);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[progress\] job j: could not save learned log-learned data \(.+EBUSY.+\): the estimate continues without it/);
  });
});
