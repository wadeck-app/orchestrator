'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { Scheduler } = require('../src/scheduler');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { FakeTime } = require('../src/time-service');

/*
 * The scheduler's timing, asserted on a clock the test drives.
 *
 * Everything this class does is about when, and it used the real timers - so its tests slept. The
 * resource-monitor ones waited hundreds of milliseconds each, the peaks test allowed itself 20
 * seconds, and both failed on a loaded CI runner because the machine decided the timing rather than
 * the code. These state the elapsed time they mean instead, and take no real time at all.
 *
 * The behaviour under test is the user-visible bug: a once job configured on a laptop never fired.
 */

const dirs = [];

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.pid = 12345;
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-faketime-'));
  dirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  const time = new FakeTime();
  const spawned = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    time,
    liveness: async () => false,
    spawn: (cmd) => { spawned.push(cmd); return fakeChild(0); },
  });
  return { registry, state, sched, time, spawned, dir };
}

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function onceJob(delayMs, scheduledAt) {
  return {
    id: 'o', type: 'once', command: 'echo once', label: 'O',
    enabled: true, triggerMode: 'fire-and-forget', liveness: null,
    delayMs, scheduledAt,
  };
}

describe('a once job fires at its delay, not before', () => {
  test('does not fire early', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add(onceJob(60_000, new Date(time.now()).toISOString()));

    await sched.start();
    await time.advanceAsync(59_000, 1000);

    assert.deepEqual(spawned, [], 'nothing should have run before the delay elapsed');
    await sched.stop();
  });

  test('fires once the delay elapses', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add(onceJob(60_000, new Date(time.now()).toISOString()));

    await sched.start();
    await time.advanceAsync(60_000, 1000);

    assert.deepEqual(spawned, ['echo once']);
    await sched.stop();
  });

  // A once job is spent when its moment passes.
  test('fires exactly once, however much later time runs on', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add(onceJob(1000, new Date(time.now()).toISOString()));

    await sched.start();
    await time.advanceAsync(600_000, 1000);

    assert.equal(spawned.length, 1, `expected one run, got ${spawned.length}`);
    await sched.stop();
  });

  // Marked spent rather than removed, so the audit and the run history still have a definition to
  // point at. `spent` is what keeps it from being armed a second time.
  test('is marked spent after firing', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(onceJob(1000, new Date(time.now()).toISOString()));

    await sched.start();
    await time.advanceAsync(2000, 500);

    const job = registry.list().find(j => j.id === 'o');
    assert.notEqual(job, undefined, 'the job was deleted rather than marked spent');
    assert.equal(job.spent, true);
    await sched.stop();
  });

  // The daemon was down when the moment passed: it runs on the next start rather than being lost.
  test('runs immediately when its moment already passed while the daemon was down', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    const anHourAgo = new Date(time.now() - 3_600_000).toISOString();
    registry.add(onceJob(60_000, anHourAgo));

    await sched.start();

    assert.deepEqual(spawned, ['echo once'], 'an overdue once job runs at startup');
    await sched.stop();
  });
});

/*
 * The bug the user hit. A job added while the daemon was already running never reached the
 * scheduler, so a once job's single moment passed unnoticed and it sat in the registry unfired.
 */
describe('a once job added while the daemon is running', () => {
  test('fires at its delay', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    await sched.start();

    registry.add(onceJob(30_000, new Date(time.now()).toISOString()));
    sched.scheduleJob(registry.get('o'));
    await time.advanceAsync(30_000, 1000);

    assert.deepEqual(spawned, ['echo once']);
    await sched.stop();
  });

  test('does nothing at all if it is never scheduled - the defect, stated', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    await sched.start();

    registry.add(onceJob(30_000, new Date(time.now()).toISOString()));
    // No scheduleJob call: this is exactly what add-job used to do.
    await time.advanceAsync(600_000, 1000);

    assert.deepEqual(spawned, [], 'without being scheduled, its moment passes unnoticed');
    assert.ok(registry.get('o'), 'and it sits in the registry forever');
    await sched.stop();
  });

  test('unscheduling it before its moment stops it firing', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    await sched.start();
    registry.add(onceJob(30_000, new Date(time.now()).toISOString()));
    sched.scheduleJob(registry.get('o'));

    sched.unscheduleJob('o');
    await time.advanceAsync(60_000, 1000);

    assert.deepEqual(spawned, []);
    await sched.stop();
  });

  // Rescheduling must replace, not accumulate: otherwise editing a job leaves two timers and it
  // fires twice.
  test('scheduling twice leaves one timer, not two', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    await sched.start();
    registry.add(onceJob(30_000, new Date(time.now()).toISOString()));
    const job = registry.get('o');

    sched.scheduleJob(job);
    sched.scheduleJob(job);
    await time.advanceAsync(60_000, 1000);

    assert.equal(spawned.length, 1, `expected one run, got ${spawned.length}`);
    await sched.stop();
  });
});

describe('a startup job added at runtime is not fired', () => {
  // `startup` means "when the daemon starts". Firing it here would contradict the type.
  test('scheduleJob does not run it now', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    await sched.start();

    registry.add({
      id: 's', type: 'startup', delaySeconds: 0, command: 'echo startup',
      enabled: true, triggerMode: 'fire-and-forget', liveness: null,
    });
    sched.scheduleJob(registry.get('s'));
    await time.advanceAsync(60_000, 1000);

    assert.deepEqual(spawned, []);
    await sched.stop();
  });
});

describe('a disabled job is not scheduled', () => {
  test('scheduleJob ignores it', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    await sched.start();
    registry.add({ ...onceJob(10_000, new Date(time.now()).toISOString()), enabled: false });

    sched.scheduleJob(registry.get('o'));
    await time.advanceAsync(60_000, 1000);

    assert.deepEqual(spawned, []);
    await sched.stop();
  });
});

describe('a startup job waits out its delay', () => {
  test('fires after delaySeconds, not before', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add({
      id: 's', type: 'startup', delaySeconds: 30, command: 'echo delayed',
      enabled: true, triggerMode: 'fire-and-forget', liveness: null,
    });

    await sched.start();
    await time.advanceAsync(29_000, 1000);
    assert.deepEqual(spawned, [], 'not before its delay');

    await time.advanceAsync(1000, 500);
    assert.deepEqual(spawned, ['echo delayed']);
    await sched.stop();
  });
});
