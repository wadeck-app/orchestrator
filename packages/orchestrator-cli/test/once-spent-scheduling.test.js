'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { FakeTime }  = require('../src/time-service');

/*
 * A spent `once` job now stays in the registry, which means every reader that used to be able to
 * assume "present ⇒ still to fire" has to be told otherwise. Two of them would misbehave loudly:
 * the scheduler would re-arm a job whose moment is long past and run it again on every daemon start,
 * and `orch timers` would report "enabled but NOTHING is armed for it: it will never fire" about a
 * job that has already done exactly what it was asked to.
 */

const dirs = [];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.pid = 4242;
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-once-spent-'));
  dirs.push(dir);
  const time = new FakeTime();
  // The registry reads the same clock as the scheduler, so `spentAt` lands on the virtual moment the
  // job fired rather than on wall-clock time. Production passes neither and both use Date.now().
  const registry = new Registry(path.join(dir, 'registry.json'), { now: () => time.now() });
  const state = new State(path.join(dir, 'state.json'));
  const spawned = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    time,
    liveness: async () => false,
    spawn: (cmd) => { spawned.push(cmd); return fakeChild(0); },
    eventPublisher: { publish: () => {} },
  });
  return { registry, state, sched, time, spawned, dir };
}

function onceJob(time, delayMs, overrides = {}) {
  return {
    id: 'o1', type: 'once', command: 'echo once', label: 'O',
    enabled: true, triggerMode: 'fire-and-forget', liveness: null,
    delayMs, scheduledAt: new Date(time.now()).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The scheduled firing marks instead of deleting
// ---------------------------------------------------------------------------

describe('a once job that fires on schedule is marked spent', () => {
  test('it stays in the registry, with spent and spentAt', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    const firesAt = time.now() + HOUR;
    registry.add(onceJob(time, HOUR));
    await sched.start();

    await time.advanceAsync(2 * HOUR, 5 * MINUTE);

    assert.equal(spawned.length, 1, `fired ${spawned.length} times`);
    const job = registry.get('o1');
    assert.notEqual(job, null, 'the job was deleted rather than marked');
    assert.equal(job.spent, true);
    // The moment it fired, not the moment the test stopped advancing -- spentAt is when the job was
    // consumed, and reading it as "whenever the daemon next looked" would make the audit useless.
    assert.equal(job.spentAt, new Date(firesAt).toISOString());
    await sched.stop();
  });

  test('an overdue job fired at daemon start is marked, not deleted', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    // Its moment passed while the daemon was down.
    registry.add(onceJob(time, HOUR, { scheduledAt: new Date(time.now() - 3 * HOUR).toISOString() }));

    await sched.start();

    assert.equal(spawned.length, 1, 'the overdue job did not fire');
    assert.equal(registry.get('o1').spent, true);
    await sched.stop();
  });
});

// ---------------------------------------------------------------------------
// A spent job is never armed again
// ---------------------------------------------------------------------------

describe('a spent once job is never armed again', () => {
  test('a restart does not re-fire it, however far past its moment', async () => {
    const { registry, state, sched, time, spawned, dir } = makeEnv();
    registry.add(onceJob(time, HOUR));
    await sched.start();
    await time.advanceAsync(2 * HOUR, 5 * MINUTE);
    assert.equal(spawned.length, 1);
    await sched.stop();

    // A second daemon, reading the same registry: the job is still there and long overdue.
    const sched2 = new Scheduler(registry, state, {
      configDir: dir,
      time,
      liveness: async () => false,
      spawn: () => { spawned.push('restart'); return fakeChild(0); },
      eventPublisher: { publish: () => {} },
    });
    try {
      await sched2.start();
      await time.advanceAsync(HOUR, 5 * MINUTE);
      assert.equal(spawned.length, 1, `a spent once job ran again: ${spawned.join(', ')}`);
      assert.equal(sched2.armedTimers, 0, 'a timer was armed for a spent job');
    } finally {
      await sched2.stop();
    }
  });

  test('scheduleJob declines a spent job rather than arming it', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add(onceJob(time, HOUR));
    registry.markSpent('o1');

    sched.scheduleJob(registry.get('o1'));

    await time.advanceAsync(4 * HOUR, 5 * MINUTE);
    assert.equal(spawned.length, 0, 'a spent job was armed and fired');
    assert.equal(sched.armedTimers, 0);
    await sched.stop();
  });
});

// ---------------------------------------------------------------------------
// orch timers must not call a finished job a problem
// ---------------------------------------------------------------------------

describe('orch timers on a spent once job', () => {
  test('no problem is reported -- it has done what it was asked to', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(onceJob(time, HOUR));
    await sched.start();
    await time.advanceAsync(2 * HOUR, 5 * MINUTE);

    const report = sched.inspectTimers().find(r => r.jobId === 'o1');
    assert.notEqual(report, undefined, 'the spent job is missing from orch timers');
    assert.equal(report.problem, null, `orch timers called a finished job broken: ${report.problem}`);
    assert.equal(report.armed, null);
    await sched.stop();
  });

  test('an unspent once job with nothing armed is still reported', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(onceJob(time, HOUR));
    // Deliberately never started: nothing is armed and the job has not fired.
    const report = sched.inspectTimers().find(r => r.jobId === 'o1');
    assert.match(report.problem ?? '', /NOTHING is armed/, 'a genuinely un-armed once job went unreported');
    await sched.stop();
  });

  test('the report says the job is spent, so the CLI can say so too', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(onceJob(time, HOUR));
    await sched.start();
    await time.advanceAsync(2 * HOUR, 5 * MINUTE);

    const report = sched.inspectTimers().find(r => r.jobId === 'o1');
    assert.equal(report.spent, true, `spent absent from the timer report: ${JSON.stringify(report)}`);
    await sched.stop();
  });
});

// ---------------------------------------------------------------------------
// Manual trigger
// ---------------------------------------------------------------------------

describe('a once job triggered by hand', () => {
  test('is marked spent and keeps its run history', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(onceJob(time, HOUR));
    await sched.start();

    const reply = await sched.trigger('o1', { kind: 'manual' });

    assert.equal(reply.consumed, true);
    assert.equal(registry.get('o1').spent, true);
    assert.notEqual(sched._state.get('o1'), undefined, 'the run that consumed it was not recorded');
    await sched.stop();
  });

  test('a spent job triggered again runs, and keeps its original spentAt', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add(onceJob(time, HOUR));
    await sched.start();
    await sched.trigger('o1', { kind: 'manual' });
    const firstSpentAt = registry.get('o1').spentAt;

    await time.advanceAsync(HOUR, 5 * MINUTE);
    await sched.trigger('o1', { kind: 'manual' });

    assert.equal(spawned.length, 2, 'an explicit re-trigger was refused');
    assert.equal(registry.get('o1').spentAt, firstSpentAt, 'spentAt was rewritten by a re-trigger');
    await sched.stop();
  });
});
