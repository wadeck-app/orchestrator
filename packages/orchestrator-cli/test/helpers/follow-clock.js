'use strict';

// A clock for `orch job <id> logs -f` tests: the follow loop sleeps through `time.after`, so a test can
// wait for "the loop is asleep", change the world (append to the file, finish the run in the history), then
// advance the clock by exactly one poll. No real timer is involved: the test paces the loop.
const { FakeTime } = require('../../src/time-service');

function followClock(startMs = Date.UTC(2026, 9, 24)) {
  const fake = new FakeTime(startMs);
  let armed = 0;
  let consumed = 0;
  let waiter = null;
  const time = {
    now: () => fake.now(),
    every: (ms, fn) => fake.every(ms, fn),
    after(ms, fn) {
      const timer = fake.after(ms, fn);
      armed++;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w();
      }
      return timer;
    },
  };
  return {
    time,
    /**
     * Resolves once the loop is asleep (a sleep is armed that no tick consumed yet), then runs `action` (if any) and advances the clock by
     * `ms`. Rejects if the run finished before going to sleep again, so a test never hangs on a loop that ended.
     */
    async tick(ms, runPromise, action) {
      if (armed === consumed) {
        let finished = false;
        const ended = runPromise.then(() => { finished = true; });
        await Promise.race([new Promise((resolve) => { waiter = resolve; }), ended]);
        waiter = null;
        if (finished && armed === consumed) {
          throw new Error('the command finished before the follow loop went back to sleep');
        }
      }
      consumed++;
      // The loop is asleep: the world changes now, then one poll goes by.
      action?.();
      fake.advance(ms);
    },
    get pending() { return fake.pending; },
  };
}

module.exports = { followClock };
