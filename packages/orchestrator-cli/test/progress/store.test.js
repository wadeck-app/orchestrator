'use strict';

// <configDir>/progress/<jobId>.json: learned data, derived and rebuildable. It must never throw into get-progress
// and every drop leaves a "[progress] job <id>: dropped learned ..." line.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { openProgressFile, progressFilePath } = require('../../src/progress/store');
const { progressWriter, createJsonWriter } = require('../../src/progress/async-writer');
const { FakeTime } = require('../../src/time-service');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const JOB = { id: 'j', command: 'node a.js', cwd: '/w' };
const S1 = { id: 'log-learned', version: 1 };

function open(dir, job = JOB, lines = []) {
  return openProgressFile({ configDir: dir, jobId: job.id, job, log: l => lines.push(l) });
}

describe('learned data store', () => {
  test('writes atomically under <configDir>/progress/<jobId>.json and reads it back through a new handle', async () => {
    const dir = fx.tempDir();
    open(dir).storeFor(S1).write({ a: 1 }, { logFingerprint: 'fp', learnedFromRuns: ['r1'] });
    await progressWriter.whenIdle();

    assert.equal(progressFilePath(dir, 'j'), path.join(dir, 'progress', 'j.json'));
    assert.equal(fs.existsSync(path.join(dir, 'progress', 'j.json.tmp')), false);
    const again = open(dir).storeFor(S1);
    assert.deepEqual(again.read(), { a: 1 });
    assert.deepEqual(again.meta(), { logFingerprint: 'fp', learnedFromRuns: ['r1'] });
  });

  test('nothing stored reads as undefined', () => {
    assert.equal(open(fx.tempDir()).storeFor(S1).read(), undefined);
  });

  test('a strategy version change drops the data and says so', () => {
    const dir = fx.tempDir();
    open(dir).storeFor(S1).write({ a: 1 });
    const lines = [];
    const next = open(dir, JOB, lines).storeFor({ id: 'log-learned', version: 2 });
    assert.equal(next.read(), undefined);
    assert.deepEqual(lines, ['[progress] job j: dropped learned log-learned data: strategy version changed (1 -> 2)']);
  });

  test('a changed command, cwd or progress setting drops everything and says so', () => {
    const dir = fx.tempDir();
    open(dir).storeFor(S1).write({ a: 1 });
    for (const changed of [{ ...JOB, command: 'node b.js' }, { ...JOB, cwd: '/other' }, { ...JOB, progress: { strategy: 'ratio', options: { pattern: 'x' } } }]) {
      const lines = [];
      assert.equal(open(dir, changed, lines).storeFor(S1).read(), undefined);
      assert.deepEqual(lines, ['[progress] job j: dropped learned data: the command, cwd or progress setting of the job changed']);
    }
  });

  test('an unreadable file is rebuilt, never thrown, and reported with what to do', () => {
    const dir = fx.tempDir();
    fs.mkdirSync(path.join(dir, 'progress'));
    fs.writeFileSync(progressFilePath(dir, 'j'), '{ not json');
    const lines = [];
    const store = open(dir, JOB, lines).storeFor(S1);
    assert.equal(store.read(), undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[progress\] job j: learned data file unreadable \(.+\); it is rebuilt from the logs and the run history/);
    store.write({ b: 2 });
    assert.deepEqual(open(dir).storeFor(S1).read(), { b: 2 });
  });

  test('a file of another schema is treated as unreadable', () => {
    const dir = fx.tempDir();
    fs.mkdirSync(path.join(dir, 'progress'));
    fs.writeFileSync(progressFilePath(dir, 'j'), JSON.stringify({ schema: 99 }));
    const lines = [];
    assert.equal(open(dir, JOB, lines).storeFor(S1).read(), undefined);
    assert.match(lines[0], /schema/);
  });

  test('invalidate drops one strategy only, with the reason', () => {
    const dir = fx.tempDir();
    const f = open(dir);
    f.storeFor(S1).write({ a: 1 });
    f.storeFor({ id: 'other', version: 1 }).write({ o: 1 });
    const lines = [];
    const g = open(dir, JOB, lines);
    g.storeFor(S1).invalidate('the log format changed');
    assert.deepEqual(lines, ['[progress] job j: dropped learned log-learned data: the log format changed']);
    assert.equal(open(dir).storeFor(S1).read(), undefined);
    assert.deepEqual(open(dir).storeFor({ id: 'other', version: 1 }).read(), { o: 1 });
  });

  test('a write that fails is logged, not thrown', async () => {
    const dir = fx.tempDir();
    // A file where the directory should be makes mkdir fail.
    fs.writeFileSync(path.join(dir, 'progress'), 'in the way');
    const lines = [];
    // The retries wait on a fake clock: the test steps it instead of sleeping.
    const time = new FakeTime();
    const writer = createJsonWriter({ time });
    openProgressFile({ configDir: dir, jobId: JOB.id, job: JOB, log: l => lines.push(l), writer }).storeFor(S1).write({ a: 1 });
    await fx.drainWriter(writer, time);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[progress\] job j: could not save learned log-learned data \(.+\): the estimate continues without it/);
  });
});

describe('the strategy chosen by auto for a run', () => {
  test('is kept for the run and ignored for another run', () => {
    const dir = fx.tempDir();
    const at = new Date(fx.T0);
    open(dir).setChosen('2026-10-20T09:00:00.000Z', 'history', at);
    const f = open(dir);
    assert.deepEqual(f.chosen('2026-10-20T09:00:00.000Z'), { strategyId: 'history', chosenAt: at.toISOString() });
    assert.equal(f.chosen('2026-10-20T09:30:00.000Z'), undefined);
  });

  test('setting the same choice again does not rewrite the file', async () => {
    const dir = fx.tempDir();
    const f = open(dir);
    f.setChosen('r', 'history', new Date(fx.T0));
    await progressWriter.whenIdle();
    const before = fs.statSync(progressFilePath(dir, 'j')).mtimeMs;
    const raw = fs.readFileSync(progressFilePath(dir, 'j'), 'utf8');
    open(dir).setChosen('r', 'history', new Date(fx.T0 + 60_000));
    await progressWriter.whenIdle();
    assert.equal(fs.readFileSync(progressFilePath(dir, 'j'), 'utf8'), raw, 'chosenAt keeps the first time');
    assert.equal(fs.statSync(progressFilePath(dir, 'j')).mtimeMs, before);
  });
});

// A path that goes THROUGH a file (a file where the progress folder should be) reads as ENOTDIR on Linux and macOS and
// as ENOENT on Windows. Both mean "nothing was learned here yet": only the failed save is worth a log line, not an
// "unreadable" one on top of it (the CI saw 2 lines instead of 1 on ubuntu and macOS).
describe('learned data store: reading through a path that is blocked by a file', () => {
  test('ENOTDIR reads as no data, with no log line of its own', () => {
    const dir = fx.tempDir();
    const lines = [];
    const real = fs.readFileSync;
    fs.readFileSync = (target, ...rest) => {
      if (String(target).endsWith('j.json')) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, open '${target}'`), { code: 'ENOTDIR' });
      }
      return real(target, ...rest);
    };
    try {
      assert.equal(open(dir, JOB, lines).storeFor(S1).read(), undefined);
    } finally {
      fs.readFileSync = real;
    }
    assert.deepEqual(lines, []);
  });
});
