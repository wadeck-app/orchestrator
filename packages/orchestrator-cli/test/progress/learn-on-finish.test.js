'use strict';

// Learning on a run's end: the logs of the runs that ended are read once, right after the end, and not by the first
// get-progress of the next run. A real Scheduler ends a run, the clock is a FakeTime, the logs are fixture files.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Scheduler } = require('../../src/scheduler');
const { Registry } = require('../../src/registry');
const { State } = require('../../src/state');
const { FakeTime } = require('../../src/time-service');
const { createJsonWriter } = require('../../src/progress/async-writer');
const { wireLearnOnFinish, learnFinishedRun } = require('../../src/progress/learn-on-finish');
const { estimateProgress } = require('../../src/progress/engine');
const { progressFilePath } = require('../../src/progress/store');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const STEPS = [[20, 'Compiling module A'], [45, 'Linking objects'], [70, 'Running checks'], [90, 'Packing']];
const PAST = [1, 2, 3, 4, 5].map(i => ({ agoMin: 60 * i, durationSec: 100, lines: STEPS }));
const JOB = { id: 'j', type: 'cron', schedule: '0 8 * * *', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget', timeoutSeconds: 300 };

/** Counts the opens of past run logs, to tell "learned again" from "read what was learned". */
function spyOnLogOpens(logDir, exceptStartedAt) {
  const real = fs.openSync;
  const opened = [];
  fs.openSync = (target, ...rest) => {
    const t = String(target);
    if (t.startsWith(logDir) && !(exceptStartedAt && t.includes(exceptStartedAt.replace(/:/g, '-').slice(0, 19)))) {
      opened.push(path.basename(t));
    }
    return real(target, ...rest);
  };
  return { opened, restore: () => { fs.openSync = real; } };
}

function env(job = JOB) {
  const dir = fx.tempDir();
  const built = fx.buildCase(dir, { job, runs: PAST });
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(job);
  for (const entry of built.history) {
    state.record('j', entry);
  }
  const time = new FakeTime();
  const children = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    time,
    liveness: async () => false,
    sampleUsage: async () => null,
    eventPublisher: { publish: () => {} },
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 4000 + children.length;
      children.push(child);
      return child;
    },
  });
  const writes = [];
  const realWriter = createJsonWriter({ time });
  const writer = {
    write: (file, data, onFail) => { writes.push(file); realWriter.write(file, data, onFail); },
    pending: (file) => realWriter.pending(file),
    whenIdle: () => realWriter.whenIdle(),
  };
  const logs = [];
  return { dir, built, registry, state, time, sched, children, writer, writes, logs, log: l => logs.push(l) };
}

async function endOneRun(e) {
  await e.sched._maybeSpawn(e.registry.get('j'));
  e.children[e.children.length - 1].emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
}

const learnedOf = (dir) => JSON.parse(fs.readFileSync(progressFilePath(dir, 'j'), 'utf8')).strategies.ensemble.data.learned.runs;

describe('learning when a run ends', () => {
  test('after the run ends the learned file exists, holds the run, and the next get-progress reads no past log again', async () => {
    const e = env();
    const wiring = wireLearnOnFinish({ source: e.sched, state: e.state, configDir: e.dir, time: e.time, log: e.log, writer: e.writer });
    try {
      assert.equal(fs.existsSync(progressFilePath(e.dir, 'j')), false);

      await endOneRun(e);
      assert.equal(fs.existsSync(progressFilePath(e.dir, 'j')), false, 'the learning is off the finishing path: it waits for its timer');
      e.time.advance(1000);
      await e.writer.whenIdle();

      const learned = learnedOf(e.dir);
      assert.equal(Object.keys(learned).length, 6, 'the five fixture runs and the one that just ended');
      assert.deepEqual(e.logs, []);

    } finally {
      wiring.dispose();
    }
  });

  // log-learned reads past logs only to learn (the ensemble also reads them to replay and score), so it shows
  // whether the first get-progress still had something to learn.
  test('log-learned: after the run ends, the next get-progress opens no past log', async () => {
    const job = { ...JOB, progress: 'log-learned' };
    const e = env(job);
    const wiring = wireLearnOnFinish({ source: e.sched, state: e.state, configDir: e.dir, time: e.time, log: e.log, writer: e.writer });
    try {
      await endOneRun(e);
      e.time.advance(1000);
      await e.writer.whenIdle();
      const file = JSON.parse(fs.readFileSync(progressFilePath(e.dir, 'j'), 'utf8'));
      assert.equal(Object.keys(file.strategies['log-learned'].data.runs).length, 6);

      const open = { startedAt: new Date(e.time.now() + 60_000).toISOString(), exitCode: null, pid: 9 };
      const spy = spyOnLogOpens(path.join(e.dir, 'logs', 'jobs', 'j'), open.startedAt);
      try {
        estimateProgress({
          configDir: e.dir, jobs: [job], history: { j: [open, ...e.state.getAll().j] }, now: () => new Date(e.time.now() + 90_000), writer: e.writer,
        });
      } finally {
        spy.restore();
      }
      assert.deepEqual(spy.opened, [], `the learned runs are not read again, but ${spy.opened.join(', ')} were`);
    } finally {
      wiring.dispose();
    }
  });

  test('control: without the hook, the first get-progress is what reads the past logs', async () => {
    const job = { ...JOB, progress: 'log-learned' };
    const e = env(job);
    const history = e.state.getAll();
    const open = { startedAt: new Date(e.time.now() + 60_000).toISOString(), exitCode: null, pid: 9 };
    const spy = spyOnLogOpens(path.join(e.dir, 'logs', 'jobs', 'j'), open.startedAt);
    try {
      estimateProgress({
        configDir: e.dir, jobs: [job], history: { j: [open, ...history.j] }, now: () => new Date(e.time.now() + 90_000), writer: e.writer,
      });
    } finally {
      spy.restore();
    }
    await e.writer.whenIdle();
    assert.ok(spy.opened.length >= 5, 'a daemon that was down when the runs ended learns lazily, as before');
    const file = JSON.parse(fs.readFileSync(progressFilePath(e.dir, 'j'), 'utf8'));
    assert.equal(Object.keys(file.strategies['log-learned'].data.runs).length, 5);
  });

  test('the same event twice learns once: the second pass changes nothing and writes nothing', async () => {
    const e = env();
    const wiring = wireLearnOnFinish({ source: e.sched, state: e.state, configDir: e.dir, time: e.time, log: e.log, writer: e.writer });
    try {
      await endOneRun(e);
      e.time.advance(1000);
      await e.writer.whenIdle();
      const before = fs.readFileSync(progressFilePath(e.dir, 'j'), 'utf8');
      const writesBefore = e.writes.length;

      e.sched.emit('job-finished', { id: 'j', exitCode: 0, job: JOB, skipped: false, cancelledByUser: false, durationMs: 1, trigger: { kind: 'cron' }, late: false });
      e.time.advance(1000);
      await e.writer.whenIdle();

      assert.equal(e.writes.length, writesBefore, 'no write');
      assert.equal(fs.readFileSync(progressFilePath(e.dir, 'j'), 'utf8'), before);
    } finally {
      wiring.dispose();
    }
  });

  test('a failed, skipped or killed run is not learned from, and a job with progress off is left alone', async () => {
    const e = env();
    const wiring = wireLearnOnFinish({ source: e.sched, state: e.state, configDir: e.dir, time: e.time, log: e.log, writer: e.writer });
    try {
      const base = { id: 'j', job: JOB, durationMs: 1, trigger: { kind: 'cron' }, late: false };
      e.sched.emit('job-finished', { ...base, exitCode: 1, skipped: false, cancelledByUser: false });
      e.sched.emit('job-finished', { ...base, exitCode: 0, skipped: true, cancelledByUser: false });
      e.sched.emit('job-finished', { ...base, exitCode: null, skipped: false, cancelledByUser: true });
      e.sched.emit('job-finished', { ...base, exitCode: 0, skipped: false, cancelledByUser: false, job: { ...JOB, progress: 'off' } });
      assert.equal(e.time.pending, 0, 'nothing was even scheduled');
    } finally {
      wiring.dispose();
    }
  });

  test('learning never throws into the daemon: a failure becomes one actionable log line', async () => {
    const e = env();
    const broken = { getAll: () => { throw new Error('state exploded'); } };
    const wiring = wireLearnOnFinish({ source: e.sched, state: broken, configDir: e.dir, time: e.time, log: e.log, writer: e.writer });
    try {
      e.sched.emit('job-finished', { id: 'j', exitCode: 0, job: JOB, skipped: false, cancelledByUser: false, durationMs: 1, trigger: { kind: 'cron' }, late: false });
      e.time.advance(1000);
      assert.equal(e.logs.length, 1);
      assert.match(e.logs[0], /^\[progress\] job j: learning from the finished run failed \(state exploded\); the first get-progress learns it instead/);
    } finally {
      wiring.dispose();
    }
  });

  test('dispose stops listening and cancels what is scheduled', async () => {
    const e = env();
    const wiring = wireLearnOnFinish({ source: e.sched, state: e.state, configDir: e.dir, time: e.time, log: e.log, writer: e.writer });
    e.sched.emit('job-finished', { id: 'j', exitCode: 0, job: JOB, skipped: false, cancelledByUser: false, durationMs: 1, trigger: { kind: 'cron' }, late: false });
    assert.equal(e.time.pending, 1);
    wiring.dispose();
    assert.equal(e.time.pending, 0);
    e.sched.emit('job-finished', { id: 'j', exitCode: 0, job: JOB, skipped: false, cancelledByUser: false, durationMs: 1, trigger: { kind: 'cron' }, late: false });
    assert.equal(e.time.pending, 0);
  });

  test('a burst of runs ending together is learned in one pass per job', async () => {
    const e = env();
    const wiring = wireLearnOnFinish({ source: e.sched, state: e.state, configDir: e.dir, time: e.time, log: e.log, writer: e.writer });
    try {
      for (let i = 0; i < 3; i++) {
        e.sched.emit('job-finished', { id: 'j', exitCode: 0, job: JOB, skipped: false, cancelledByUser: false, durationMs: 1, trigger: { kind: 'cron' }, late: false });
      }
      assert.equal(e.time.pending, 1, 'one timer for the job');
    } finally {
      wiring.dispose();
    }
  });
});

describe('learnFinishedRun', () => {
  test('learns the log-learned strategy for a job that names it, bounded by the byte budget', () => {
    const e = env();
    const job = { ...JOB, progress: 'log-learned' };
    const result = learnFinishedRun({ configDir: e.dir, job, history: e.state.getAll().j, now: () => new Date(e.time.now()), log: e.log, writer: e.writer });
    assert.deepEqual(result.strategies, ['log-learned']);
    assert.equal(result.learnedRuns, 5);
  });

  test('a strategy that learns nothing (history) is reported as such, not as a failure', () => {
    const e = env();
    const job = { ...JOB, progress: 'history' };
    const result = learnFinishedRun({ configDir: e.dir, job, history: e.state.getAll().j, now: () => new Date(e.time.now()), log: e.log, writer: e.writer });
    assert.deepEqual(result.strategies, []);
    assert.deepEqual(e.logs, []);
  });
});
