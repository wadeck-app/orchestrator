'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateJob } = require('../src/registry');

/*
 * No upper bound on timeoutSeconds, deliberately -- same reasoning as delayMs in
 * once-schedule.test.js. The scheduler arms the job-timeout timer through waitUntil
 * (time-service.ts), which absorbs the 2^31-1 ms timer ceiling itself, so a one-year
 * --timeout is a real, working value and not something to cap at the door.
 */
describe('how long a job may run is not limited by the timer', () => {
  const base = { id: 'j1', type: 'startup', command: 'npm run dev', enabled: true };

  test('a one-year timeout is accepted', () => {
    assert.doesNotThrow(() => validateJob({ ...base, timeoutSeconds: 365 * 86_400 }));
  });

  test('zero means no timeout, and is accepted', () => {
    assert.doesNotThrow(() => validateJob({ ...base, timeoutSeconds: 0 }));
  });

  // Negative used to be silently equivalent to 0 (no timeout) in the scheduler, which is the
  // same class of defect as a silent fallback: it does something, but never what was asked.
  test('a negative timeout is refused, not silently treated as "no timeout"', () => {
    assert.throws(() => validateJob({ ...base, timeoutSeconds: -1 }), /non-negative/);
  });

  test('a fractional timeout is refused', () => {
    assert.throws(() => validateJob({ ...base, timeoutSeconds: 1.5 }), /integer/);
  });
});
