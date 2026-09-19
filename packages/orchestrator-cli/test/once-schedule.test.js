'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { onceScheduleDisplay } = require('../src/once-schedule');
const { validateJob } = require('../src/registry');

// A fixed clock. Reading the machine's own would make "overdue by 5s" a race against the test.
const NOW = new Date('2026-09-18T12:00:00Z').getTime();
const AT  = '2026-09-18T12:00:00Z';

describe('a once job says whether its moment is coming or gone', () => {
  test('a future moment counts down', () => {
    assert.equal(onceScheduleDisplay(AT, 30_000, NOW), 'in 30s');
  });

  // The defect. It clamped to "in 0s", which reads as "about to fire" - the opposite of the truth,
  // and the state a user needs to see, because an overdue once job means the daemon was not running
  // when its moment passed.
  test('a past moment says it is overdue, not "in 0s"', () => {
    const display = onceScheduleDisplay(AT, 30_000, NOW + 95_000);
    assert.match(display, /overdue/, `an overdue job still reads as pending: ${display}`);
    assert.equal(display, 'overdue by 65s');
  });

  test('the exact moment is not yet overdue', () => {
    assert.equal(onceScheduleDisplay(AT, 30_000, NOW + 30_000), 'in 0s');
  });

  // "in 1209600s" is the right number and the wrong unit.
  test('long waits are readable', () => {
    assert.equal(onceScheduleDisplay(AT, 90 * 60_000, NOW), 'in 90m');
    assert.equal(onceScheduleDisplay(AT, 5 * 3_600_000, NOW), 'in 5h');
    assert.equal(onceScheduleDisplay(AT, 14 * 86_400_000, NOW), 'in 14d');
  });

  // Rather than "in NaNs": a once job with no scheduledAt cannot be placed in time at all.
  test('a job that cannot be placed in time says so', () => {
    assert.equal(onceScheduleDisplay(undefined, 30_000, NOW), 'unscheduled');
    assert.equal(onceScheduleDisplay(AT, undefined, NOW), 'unscheduled');
    assert.equal(onceScheduleDisplay('not-a-date', 30_000, NOW), 'unscheduled');
  });
});

/*
 * No upper bound on delayMs, deliberately.
 *
 * A timer cannot express a delay beyond 2^31-1 ms, but that is the scheduler's constraint to absorb,
 * not a rule to hand the user: the delay is sliced and re-derived from the clock instead (waitUntil,
 * time-service.ts). Asking "how long may a job wait?" should get a product answer, never a number
 * that exists because of setTimeout.
 */
describe('how long a once job may wait is not limited by the timer', () => {
  const base = { id: 'j1', type: 'once', command: 'echo hi', enabled: true, scheduledAt: AT };

  test('a two-month delay is accepted', () => {
    assert.doesNotThrow(() => validateJob({ ...base, delayMs: 60 * 86_400_000 }));
  });

  test('a one-year delay is accepted', () => {
    assert.doesNotThrow(() => validateJob({ ...base, delayMs: 365 * 86_400_000 }));
  });

  // The lower bound is a real rule about the field, and must survive.
  test('zero and negative are still refused', () => {
    assert.throws(() => validateJob({ ...base, delayMs: 0 }), /positive/);
    assert.throws(() => validateJob({ ...base, delayMs: -1 }), /positive/);
  });
});
