'use strict';

/*
 * The job timeout armed its own raw timer with `this._time.after(timeoutMs, ...)` instead of going
 * through `waitUntil` (time-service.ts) the way every other deadline in the scheduler does. A delay
 * above the runtime's 2^31-1 ms ceiling (~24.85 days) is clamped to 1ms, so `--timeout 31536000`
 * (one year) killed the job on the next tick instead of after a year - silently, with
 * `reason=timeout` and a duration near zero, which is exactly what a real user hit in production.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { FakeTime, TIMER_CEILING_MS } = require('../src/time-service');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-timeout-overflow-test-'));
}

// A child that never exits on its own; it emits 'close' only when killed.
function hangingChild() {
  const child = new EventEmitter();
  child.pid    = undefined;
  child.killed = false;
  child.stdout = null;
  child.stderr = null;
  child.kill   = () => {
    child.killed = true;
    process.nextTick(() => child.emit('close', 1));
  };
  return child;
}

const BASE_JOB = {
  type: 'startup', delaySeconds: 0, command: 'node script.js',
  enabled: true, triggerMode: 'fire-and-forget', liveness: null,
};

describe('job timeout beyond the 32-bit timer ceiling', () => {
  test('a one-year timeout does not kill the job on the next tick', async () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();

    const ONE_YEAR_SECONDS = 31_536_000; // well past TIMER_CEILING_MS when converted to ms
    assert.ok(ONE_YEAR_SECONDS * 1000 > TIMER_CEILING_MS, 'test premise: this must exceed the ceiling');

    const job = { ...BASE_JOB, id: 'overflow', timeoutSeconds: ONE_YEAR_SECONDS };
    registry.add(job);

    const time  = new FakeTime();
    const child = hangingChild();
    const sched = new Scheduler(registry, state, {
      spawn: () => child,
      liveness: async () => false,
      configDir: dir,
      time,
    });

    await sched._fire(job);

    // The clamp bug fires almost immediately. Ten seconds in, the job must still be alive.
    await time.advanceAsync(10_000, 1000);
    assert.equal(child.killed, false,
      'job was killed within 10s of a 1-year timeout: the delay overflowed the 32-bit timer ceiling');

    // Confirm the timeout still works at all once it genuinely elapses.
    await time.advanceAsync(ONE_YEAR_SECONDS * 1000, 24 * 60 * 60 * 1000);
    assert.equal(child.killed, true, 'job was never killed once the full year elapsed');
  });
});
