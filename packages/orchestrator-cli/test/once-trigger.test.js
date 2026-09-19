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
 * `orch trigger` on a once job used to run it AND leave its timer armed, so the job ran a second
 * time when its moment arrived. A job whose type is "once" ran twice, and nothing said so.
 *
 * Running a once job is what consumes it, whoever asked - the scheduled firing marks it spent, and a
 * manual firing is the same event arriving early.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-once-trigger-'));
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
    eventPublisher: { publish: () => {} },
  });
  return { registry, sched, time, spawned };
}

function onceJob(time, delayMs) {
  return {
    id: 'o1', type: 'once', command: 'echo once', label: 'O',
    enabled: true, triggerMode: 'fire-and-forget', liveness: null, missedFiring: 'skip',
    delayMs, scheduledAt: new Date(time.now()).toISOString(),
  };
}

describe('a once job triggered by hand is consumed', () => {
  test('it does not also fire at its scheduled moment', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add(onceJob(time, HOUR));
    await sched.start();

    await sched.trigger('o1', { kind: 'manual' });
    assert.equal(spawned.length, 1, 'the manual trigger did not run it');

    // Its moment arrives, and well past it.
    await time.advanceAsync(3 * HOUR, 5 * MINUTE);

    assert.equal(spawned.length, 1, `a once job ran ${spawned.length} times`);
    await sched.stop();
  });

  // Marked spent rather than deleted: the definition stays for the audit and the "Past once" view,
  // and `spent` is what stops it being armed again. See once-retention.test.js for the retention
  // bounds that eventually drop it.
  test('the job is marked spent, as it is after a scheduled firing', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(onceJob(time, HOUR));
    await sched.start();

    await sched.trigger('o1', { kind: 'manual' });

    const job = registry.get('o1');
    assert.notEqual(job, null, 'the job was deleted rather than marked spent');
    assert.equal(job.spent, true, 'the run that consumed it left no mark');
    await sched.stop();
  });

  // The run has to be recorded, or consuming the job would erase the evidence that it ever ran.
  test('the run is still in the history', async () => {
    const { registry, sched, time, state } = { ...makeEnv() };
    registry.add(onceJob(time, HOUR));
    await sched.start();

    await sched.trigger('o1', { kind: 'manual' });

    const history = sched._state.get('o1');
    assert.notEqual(history, undefined, 'no run recorded for a job that ran');
    await sched.stop();
  });

  // The reply has to say it, otherwise the job vanishing from the list looks like a bug. Silence on
  // a side effect the user did not ask for is the thing to avoid.
  test('the reply says the job was consumed, so the caller can tell the user', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(onceJob(time, HOUR));
    await sched.start();

    const reply = await sched.trigger('o1', { kind: 'manual' });

    assert.equal(reply.consumed, true, `the reply does not mention it: ${JSON.stringify(reply)}`);
    await sched.stop();
  });

  // A cron job is not consumed by being triggered: it keeps its schedule and fires again.
  test('a cron job is untouched by the same call', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add({
      id: 'c1', type: 'cron', schedule: '*/5 * * * *', command: 'echo tick', label: 'C',
      enabled: true, triggerMode: 'fire-and-forget', liveness: null, missedFiring: 'skip',
    });
    await sched.start();

    const reply = await sched.trigger('c1', { kind: 'manual' });

    assert.notEqual(registry.get('c1'), null, 'a cron job was consumed by a manual trigger');
    assert.notEqual(reply.consumed, true, 'a cron job reported itself as consumed');
    await sched.stop();
  });
});
