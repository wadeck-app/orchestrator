'use strict';

// The learned-data file is written from inside a daemon request (get-progress) and from the run-end hook. The old
// atomicWriteJson busy-waited up to 300 ms between retries on the event loop. This writer never blocks: the call
// returns at once, the write and its retries happen later, and the retry waits are timers of the injected TimeService.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createJsonWriter } = require('../../src/progress/async-writer');
const { FakeTime } = require('../../src/time-service');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

/** A fake fs whose failures are scripted: `failures` write attempts fail, then it records into `files`. */
function fakeFs(failures = 0) {
  const files = new Map();
  const calls = [];
  let remaining = failures;
  return {
    files,
    calls,
    ops: {
      mkdir: async (dir) => { calls.push(['mkdir', dir]); },
      writeFile: async (file, content) => {
        calls.push(['writeFile', file]);
        if (remaining > 0) {
          remaining--;
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        }
        files.set(file, content);
      },
      rename: async (from, to) => {
        calls.push(['rename', from, to]);
        files.set(to, files.get(from));
        files.delete(from);
      },
      unlink: async (file) => { calls.push(['unlink', file]); files.delete(file); },
    },
  };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('async JSON writer', () => {
  test('write() returns at once; the content is readable as pending until it is on disk', async () => {
    const time = new FakeTime();
    const f = fakeFs();
    const writer = createJsonWriter({ fs: f.ops, time });

    const returned = writer.write('/c/progress/j.json', { a: 1 }, () => assert.fail('no failure expected'));

    assert.equal(returned, undefined);
    assert.equal(f.files.has('/c/progress/j.json'), false, 'nothing is on disk when write() returns');
    assert.deepEqual(writer.pending('/c/progress/j.json'), { a: 1 });
    await writer.whenIdle();
    assert.deepEqual(JSON.parse(f.files.get('/c/progress/j.json')), { a: 1 });
    assert.equal(writer.pending('/c/progress/j.json'), undefined, 'on disk now: reads go to the file');
    assert.deepEqual(f.calls.map(c => c[0]), ['mkdir', 'writeFile', 'rename'], 'tmp file then rename: atomic');
  });

  test('a failing disk: the call returns at once, the retries wait on the injected clock, never on the event loop', async () => {
    const time = new FakeTime();
    const f = fakeFs(2);
    const writer = createJsonWriter({ fs: f.ops, time });
    const failures = [];

    const startedAt = time.now();
    writer.write('/c/progress/j.json', { a: 1 }, (err) => failures.push(err));
    await settle();

    assert.equal(time.now(), startedAt, 'the clock did not move: nothing waited');
    assert.equal(f.calls.filter(c => c[0] === 'writeFile').length, 1, 'first attempt made, now waiting for a timer');
    assert.equal(time.pending, 1, 'the retry wait is a timer of the injected clock');

    time.advance(100);
    await settle();
    assert.equal(f.calls.filter(c => c[0] === 'writeFile').length, 2);
    time.advance(200);
    await writer.whenIdle();

    assert.equal(f.calls.filter(c => c[0] === 'writeFile').length, 3, 'third attempt succeeds');
    assert.deepEqual(JSON.parse(f.files.get('/c/progress/j.json')), { a: 1 });
    assert.deepEqual(failures, []);
    assert.equal(f.files.has('/c/progress/j.json.tmp'), false, 'the tmp file of a failed attempt is removed');
  });

  test('every attempt failing: the failure is reported once with the cause and what it means', async () => {
    const time = new FakeTime();
    const f = fakeFs(99);
    const writer = createJsonWriter({ fs: f.ops, time });
    const failures = [];

    writer.write('/c/progress/j.json', { a: 1 }, (err) => failures.push(err.message));
    await settle();
    time.advance(100);
    await settle();
    time.advance(200);
    await writer.whenIdle();

    assert.equal(failures.length, 1);
    assert.match(failures[0], /after 3 attempts.*EBUSY/);
    assert.equal(writer.pending('/c/progress/j.json'), undefined, 'a write that failed is not served as if it had landed');
    assert.equal(time.pending, 0, 'no timer left behind');
  });

  test('writes to one file are serialised and the latest content wins', async () => {
    const time = new FakeTime();
    const f = fakeFs();
    const writer = createJsonWriter({ fs: f.ops, time });

    writer.write('/c/progress/j.json', { v: 1 }, () => {});
    writer.write('/c/progress/j.json', { v: 2 }, () => {});
    writer.write('/c/progress/j.json', { v: 3 }, () => {});
    assert.deepEqual(writer.pending('/c/progress/j.json'), { v: 3 }, 'read-your-writes: the newest content');
    await writer.whenIdle();

    assert.deepEqual(JSON.parse(f.files.get('/c/progress/j.json')), { v: 3 });
    const writes = f.calls.filter(c => c[0] === 'writeFile').length;
    assert.ok(writes <= 2, `queued content is coalesced, not written ${writes} times`);
  });

  test('other files are independent', async () => {
    const time = new FakeTime();
    const f = fakeFs();
    const writer = createJsonWriter({ fs: f.ops, time });
    writer.write('/c/progress/a.json', { a: 1 }, () => {});
    writer.write('/c/progress/b.json', { b: 1 }, () => {});
    await writer.whenIdle();
    assert.deepEqual(JSON.parse(f.files.get('/c/progress/a.json')), { a: 1 });
    assert.deepEqual(JSON.parse(f.files.get('/c/progress/b.json')), { b: 1 });
  });

  test('the content is snapshotted when write() is called: a later mutation of the object does not leak in', async () => {
    const f = fakeFs();
    const writer = createJsonWriter({ fs: f.ops, time: new FakeTime() });
    const data = { list: [1] };
    writer.write('/c/progress/j.json', data, () => {});
    data.list.push(2);
    await writer.whenIdle();
    assert.deepEqual(JSON.parse(f.files.get('/c/progress/j.json')), { list: [1] });
  });

  test('the real fs: lands atomically, creates the folder, leaves no tmp file', async () => {
    const dir = fx.tempDir();
    const file = path.join(dir, 'progress', 'j.json');
    const writer = createJsonWriter({ time: new FakeTime() });
    writer.write(file, { real: true }, (err) => assert.fail(err.message));
    await writer.whenIdle();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { real: true });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });
});
