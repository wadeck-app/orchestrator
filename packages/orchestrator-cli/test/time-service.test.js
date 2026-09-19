'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { FakeTime, systemTime } = require('../src/time-service');

/**
 * Polls until `condition` holds, or gives up after `timeoutMs`.
 *
 * Only for the systemTime tests below, which exercise the real clock and therefore cannot use
 * FakeTime. Asserting a count inside a fixed wall-clock window makes the machine's load part of the
 * assertion -- which is how "every repeats" failed on windows-latest and nowhere else.
 */
async function waitFor(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
}

/*
 * The fake clock is about to be the basis of the scheduler's tests, so it gets its own.
 *
 * A fake clock that fires a timer twice, or drops one, or reports a time it never reached, makes
 * every test built on it agree with the wrong answer - and they would all still pass. This is the one
 * place that cannot be checked by the tests above it.
 */

describe('FakeTime reports the time it was moved to', () => {
  test('starts fixed and does not drift', () => {
    const time = new FakeTime();
    const first = time.now();

    assert.equal(time.now(), first, 'reading the clock must not advance it');
  });

  test('advance moves it by exactly the amount given', () => {
    const time = new FakeTime();
    const start = time.now();

    time.advance(1500);

    assert.equal(time.now() - start, 1500);
  });

  test('a callback sees the time its timer was due, not the end of the span', () => {
    const time = new FakeTime();
    const start = time.now();
    let seenAt = null;
    time.after(100, () => { seenAt = time.now(); });

    time.advance(1000);

    assert.equal(seenAt - start, 100, 'a timer due at 100 must observe 100, not 1000');
    assert.equal(time.now() - start, 1000, 'and the span still completes');
  });
});

describe('FakeTime one-shot timers', () => {
  test('does not fire before it is due', () => {
    const time = new FakeTime();
    let fired = 0;
    time.after(100, () => { fired++; });

    time.advance(99);

    assert.equal(fired, 0);
  });

  test('fires exactly once, at its due time', () => {
    const time = new FakeTime();
    let fired = 0;
    time.after(100, () => { fired++; });

    time.advance(100);
    time.advance(1000);

    assert.equal(fired, 1, 'a one-shot must not re-arm');
  });

  test('a cancelled timer never fires', () => {
    const time = new FakeTime();
    let fired = 0;
    const timer = time.after(100, () => { fired++; });

    timer.cancel();
    time.advance(1000);

    assert.equal(fired, 0);
  });

  test('runs due timers in due order, not in creation order', () => {
    const time = new FakeTime();
    const order = [];
    time.after(300, () => order.push('third'));
    time.after(100, () => order.push('first'));
    time.after(200, () => order.push('second'));

    time.advance(1000);

    assert.deepEqual(order, ['first', 'second', 'third']);
  });

  // A zero or negative delay is "as soon as possible" for the real timers. NaN mattered: a NaN due
  // time compares false against every target and would never run, which is how a once job with no
  // scheduledAt behaved.
  test('treats zero, negative and NaN delays as due immediately', () => {
    const time = new FakeTime();
    const fired = [];
    time.after(0, () => fired.push('zero'));
    time.after(-5, () => fired.push('negative'));
    time.after(NaN, () => fired.push('nan'));

    time.advance(1);

    assert.deepEqual(fired.sort(), ['nan', 'negative', 'zero']);
  });
});

describe('FakeTime repeating timers', () => {
  test('fires once per interval across the span', () => {
    const time = new FakeTime();
    let fired = 0;
    time.every(100, () => { fired++; });

    time.advance(450);

    assert.equal(fired, 4, 'four whole intervals fit in 450ms');
  });

  test('keeps firing across separate advances', () => {
    const time = new FakeTime();
    let fired = 0;
    time.every(100, () => { fired++; });

    time.advance(100);
    time.advance(100);

    assert.equal(fired, 2);
  });

  test('stops when cancelled', () => {
    const time = new FakeTime();
    let fired = 0;
    const timer = time.every(100, () => { fired++; });

    time.advance(250);
    timer.cancel();
    time.advance(1000);

    assert.equal(fired, 2, 'no further firings after cancel');
  });

  test('a timer cancelled from inside its own callback does not fire again', () => {
    const time = new FakeTime();
    let fired = 0;
    const timer = time.every(100, () => {
      fired++;
      timer.cancel();
    });

    time.advance(1000);

    assert.equal(fired, 1);
  });
});

describe('FakeTime bookkeeping', () => {
  test('reports how many timers are armed', () => {
    const time = new FakeTime();
    const a = time.after(100, () => {});
    time.every(100, () => {});

    assert.equal(time.pending, 2);

    a.cancel();
    assert.equal(time.pending, 1);
  });

  test('a fired one-shot stops being pending', () => {
    const time = new FakeTime();
    time.after(100, () => {});

    time.advance(100);

    assert.equal(time.pending, 0);
  });

  // Work scheduled by a callback inside the same span still runs, so a chain resolves in one advance.
  test('runs work a callback schedules inside the same span', () => {
    const time = new FakeTime();
    const order = [];
    time.after(100, () => {
      order.push('outer');
      time.after(50, () => order.push('inner'));
    });

    time.advance(500);

    assert.deepEqual(order, ['outer', 'inner']);
  });

  // Rather than hanging the suite.
  test('refuses a timer that re-arms at zero forever', () => {
    const time = new FakeTime();
    time.every(0, () => {});

    assert.throws(() => time.advance(1000), /re-arming/);
  });
});

describe('systemTime is the real clock', () => {
  test('now tracks Date.now', () => {
    assert.ok(Math.abs(systemTime.now() - Date.now()) < 50);
  });

  // Same fragility as the test below, one line away: a starved runner can leave `fired` at 0 in a
  // 30ms window. The cancelled timer is what the += 100 catches, and that needs no window at all.
  test('after fires and can be cancelled', async () => {
    let fired = 0;
    systemTime.after(1, () => { fired++; });
    const cancelled = systemTime.after(1, () => { fired += 100; });
    cancelled.cancel();

    await waitFor(() => fired >= 1, 5_000);
    await new Promise(r => setTimeout(r, 50));

    assert.equal(fired, 1, 'either it never fired, or the cancelled timer fired too');
  });

  test('every repeats and can be cancelled', async () => {
    let fired = 0;
    const timer = systemTime.every(5, () => { fired++; });

    // Waits for the property instead of assuming a wall-clock window. A 5ms interval against
    // Windows' ~15.6ms timer resolution fires about three times in 60ms on an idle machine and
    // once on a loaded CI runner -- which is exactly how this failed, on windows-latest only.
    // The deadline is generous because it only has to catch `every` never repeating at all.
    await waitFor(() => fired >= 2, 5_000);
    timer.cancel();
    const afterCancel = fired;
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fired >= 2, `expected repeats within 5s, got ${fired}`);
    assert.equal(fired, afterCancel, 'must stop after cancel');
  });
});
