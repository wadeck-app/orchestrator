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
 * On FakeTime, not real timers.
 *
 * This file used to arm a ~10 ms deadline off the real clock and then allow 80 ms for it to land:
 *
 *     scheduledAt: Date.now() - 90, delayMs: 100      // remaining ~10ms
 *     await sched.start();
 *     await new Promise(r => setTimeout(r, 80));
 *
 * `start()` reads the registry and the state from disk and creates the tmp dir before that 80 ms
 * window opens, so on a loaded runner the firing simply did not happen inside it. That is exactly what
 * failed on Windows in CI run 35437205163: 670 pass, one fail, `spawnCount` 0 !== 1, with the suite
 * taking 95.8s. The budget was never the thing under test -- "a once job fires at its moment" is --
 * and a virtual clock states that without asking how fast the host is.
 */

const dirs = [];
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-once-test-'));
  dirs.push(dir);
  const time = new FakeTime();
  const registry = new Registry(path.join(dir, 'registry.json'), { now: () => time.now() });
  const state = new State(path.join(dir, 'state.json'));
  registry.load();
  let spawnCount = 0;
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    time,
    liveness: async () => false,
    spawn: () => {
      spawnCount++;
      const child = new EventEmitter();
      child.pid = 12345;
      process.nextTick(() => child.emit('close', 0));
      return child;
    },
    eventPublisher: { publish: () => {} },
  });
  return { registry, state, sched, time, spawns: () => spawnCount };
}

function makeOnceJob(time, overrides = {}) {
  return {
    id:          'once-a',
    type:        'once',
    delayMs:     5 * SECOND,
    scheduledAt: new Date(time.now()).toISOString(),
    command:     'echo once',
    enabled:     true,
    triggerMode: 'fire-and-forget',
    liveness:    null,
    label:       'once-a',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// once job fires exactly once
// ---------------------------------------------------------------------------

describe('once jobs -- fires exactly once', () => {
  test('fires immediately when its moment already passed', async () => {
    const { registry, sched, time, spawns } = makeEnv();
    // scheduledAt 10s ago, delayMs 5s -> the moment passed while the daemon was down.
    registry.add(makeOnceJob(time, { scheduledAt: new Date(time.now() - 10 * SECOND).toISOString() }));

    try {
      await sched.start();
      assert.equal(spawns(), 1, 'should have fired exactly once');
    } finally {
      await sched.stop();
    }
  });

  test('does not fire a second time after a start/stop cycle', async () => {
    const { registry, sched, time, spawns } = makeEnv();
    registry.add(makeOnceJob(time, { scheduledAt: new Date(time.now() - 10 * SECOND).toISOString() }));

    try {
      await sched.start();
      await sched.stop();
      await sched.start();

      assert.equal(spawns(), 1, `a once job ran ${spawns()} times`);
      // The mark is what prevents the second firing: the job is still listed.
      assert.equal(registry.get('once-a').spent, true, 'job should have been marked spent');
    } finally {
      await sched.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// once job is marked spent after execution, rather than deleted
// ---------------------------------------------------------------------------

describe('once jobs -- marked spent', () => {
  test('marks the job spent after firing, keeping its definition', async () => {
    const { registry, sched, time, spawns } = makeEnv();
    registry.add(makeOnceJob(time, { scheduledAt: new Date(time.now() - 10 * SECOND).toISOString() }));
    assert.equal(registry.get('once-a').spent, undefined, 'a job should not start out spent');

    try {
      await sched.start();

      const after = registry.get('once-a');
      assert.equal(spawns(), 1);
      assert.notEqual(after, null, 'job should still exist after firing');
      assert.equal(after.spent, true, 'job should be marked spent after firing');
      assert.equal(after.spentAt, new Date(time.now()).toISOString(), 'spentAt should record when it fired');
    } finally {
      await sched.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// On restart with time still to run: re-arms with the remaining delay
// ---------------------------------------------------------------------------

describe('once jobs -- restart re-arming', () => {
  test('does NOT fire while its moment is still ahead', async () => {
    const { registry, sched, time, spawns } = makeEnv();
    registry.add(makeOnceJob(time, { delayMs: HOUR }));

    try {
      await sched.start();
      await time.advanceAsync(59 * MINUTE, MINUTE);

      assert.equal(spawns(), 0, 'should not have fired yet');
      assert.equal(registry.get('once-a').spent, undefined, 'job should not be spent since it never fired');
    } finally {
      await sched.stop();
    }
  });

  test('fires at its moment, not before and not late', async () => {
    const { registry, sched, time, spawns } = makeEnv();
    // Half the delay has already elapsed, so the remaining time is what start() must re-derive.
    registry.add(makeOnceJob(time, {
      scheduledAt: new Date(time.now() - 30 * MINUTE).toISOString(),
      delayMs: HOUR,
    }));

    try {
      await sched.start();
      assert.equal(spawns(), 0, 'fired before its moment');

      await time.advanceAsync(29 * MINUTE, MINUTE);
      assert.equal(spawns(), 0, 'fired a minute early');

      await time.advanceAsync(2 * MINUTE, 30 * SECOND);
      assert.equal(spawns(), 1, 'did not fire at its moment');
      assert.equal(registry.get('once-a').spent, true, 'job should be marked spent after firing');
    } finally {
      await sched.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// stop() cancels a pending once-job (no late fire)
// ---------------------------------------------------------------------------

describe('once jobs -- stop() cancels pending', () => {
  test('stop() prevents a pending once-job from firing', async () => {
    const { registry, sched, time, spawns } = makeEnv();
    registry.add(makeOnceJob(time, { delayMs: HOUR }));

    await sched.start();
    await sched.stop();

    // Well past the moment it would have fired at.
    await time.advanceAsync(3 * HOUR, 5 * MINUTE);
    assert.equal(spawns(), 0, 'spawn should not have been called after stop()');
    assert.equal(sched.armedTimers, 0, 'a timer outlived stop()');
  });
});
