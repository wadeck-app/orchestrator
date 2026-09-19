'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { FakeTime, waitUntil, MAX_TIMER_CHUNK_MS } = require('../src/time-service');

const DAY = 86_400_000;

/*
 * A single long timer cannot express these waits. A delay above 2^31-1 ms is clamped by the runtime
 * to 1ms, so a job asked to fire in two months fired on the next tick - and nothing reported the
 * clamp, so the only symptom was a job that ran two months early.
 *
 * That ceiling is a property of the timer, not a rule for the user, so it is solved here instead of
 * being validated at the door.
 */
describe('waiting for a moment further away than a timer can express', () => {
  test('a 60-day wait fires at 60 days, not immediately', () => {
    const time = new FakeTime();
    let fired = 0;
    waitUntil(time, time.now() + 60 * DAY, () => { fired++; });

    // The clamp would have fired it here. This is the assertion the bug failed.
    time.advance(1000);
    assert.equal(fired, 0, 'fired on the first tick: the delay was clamped');

    time.advance(59 * DAY);
    assert.equal(fired, 0, 'fired a day early');

    time.advance(DAY);
    assert.equal(fired, 1);
  });

  test('it fires once, not once per slice', () => {
    const time = new FakeTime();
    let fired = 0;
    waitUntil(time, time.now() + 10 * DAY, () => { fired++; });

    time.advance(30 * DAY);
    assert.equal(fired, 1);
  });

  test('a short wait still fires on time, without slicing', () => {
    const time = new FakeTime();
    let fired = 0;
    waitUntil(time, time.now() + 5000, () => { fired++; });

    time.advance(4999);
    assert.equal(fired, 0);
    time.advance(1);
    assert.equal(fired, 1);
  });

  // The deadline is an absolute moment, so a caller that stored it can re-arm after a restart and
  // get the same behaviour. Already past means "as soon as possible", not "skipped": whether that
  // counts as overdue is the caller's question.
  test('a deadline already past fires as soon as possible', () => {
    const time = new FakeTime();
    let fired = 0;
    waitUntil(time, time.now() - 10 * DAY, () => { fired++; });

    assert.equal(fired, 0, 'fired synchronously, before the caller could finish arming it');
    time.advance(1);
    assert.equal(fired, 1);
  });

  test('cancelling stops it, at any point in the wait', () => {
    const time = new FakeTime();
    let fired = 0;
    const timer = waitUntil(time, time.now() + 30 * DAY, () => { fired++; });

    // Part-way through, so a slice is armed and has to be cancelled with it.
    time.advance(10 * DAY);
    timer.cancel();
    time.advance(30 * DAY);

    assert.equal(fired, 0);
    assert.equal(time.pending, 0, 'a cancelled wait left a timer armed');
  });

  /*
   * There is deliberately no test here for a machine that sleeps through the deadline, and no
   * FakeTime.suspend() to write one with. Both existed briefly, on the assumption that a timer
   * under-counts a suspend and that a job would therefore be late by however long the machine slept.
   *
   * The assumption is false on the platforms this ships to. Windows counts suspend in
   * QueryPerformanceCounter, which Microsoft documents explicitly; macOS counts it because libuv
   * chose mach_continuous_time() for exactly that reason; only Linux does not, and there is no
   * native package for Linux here. See MAX_TIMER_CHUNK_MS for the sources.
   *
   * A test modelling a platform we do not ship, written as though it were ours, is worse than no
   * test: it makes a false premise look verified.
   */

  // Re-deriving from the clock rather than counting slices down is what absorbs a wall-clock jump -
  // a system clock moved by hand, which no clock source follows.
  test('a clock that jumps forward is absorbed, not added to the wait', () => {
    const time = new FakeTime();
    let fired = 0;
    const deadline = time.now() + 40 * DAY;
    waitUntil(time, deadline, () => { fired++; });

    // One slice elapses, then the clock jumps past the deadline - the shape of waking from sleep.
    // Written against the slice rather than a hard-coded day, so tightening the slice cannot make
    // this test wrong about the thing it asserts.
    time.advance(MAX_TIMER_CHUNK_MS);
    assert.equal(fired, 0, 'fired after one slice, with the deadline still 40 days out');
    time.advance(40 * DAY);

    assert.equal(fired, 1, 'still waiting after the deadline passed');
    assert.equal(time.now() >= deadline, true);
  });
});
