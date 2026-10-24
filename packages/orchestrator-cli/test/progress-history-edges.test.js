'use strict';

// Edges of the `history` strategy that progress-history.test.js does not pin: one disqualifying flag at a time, the
// median of an even count, the confidence bands, unreadable dates, a clock that went backwards, the exact cap.
// Every date derives from the fixed T0 of the fixtures: no real clock.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { historyStrategy, isUsableRun, median, formatDuration, usableDurations } = require('../src/progress/history-strategy');
const { T0, finished, open, usable, context } = require('./helpers/progress-fixtures');

function estimate(history, over = {}) {
  return historyStrategy.estimate(context({ history, ...over }));
}

// Four usable runs whose median is 900 s; a fifth one of 6000 s would move it to 1200 s.
const BASE = [finished(120, 600), finished(180, 600), finished(240, 1200), finished(300, 1200)];

describe('isUsableRun: one disqualifying flag at a time, each with a run that would move the median', () => {
  const flags = [
    ['cancelledByUser', { cancelledByUser: true }],
    ['skipped', { skipped: true }],
    ['orphaned', { orphaned: true }],
    // exit code 0 but ended by the daemon: a resource-limit kill that the shell reported as 0
    ['endReason set with exit code 0', { endReason: 'resource-limit' }],
    ['a non-zero exit code', { exitCode: 1 }],
    ['a null exit code', { exitCode: null }],
  ];

  for (const [name, extra] of flags) {
    test(`${name}: the 6000 s run is not counted`, () => {
      const e = estimate([...BASE, finished(60, 6000, extra)], { runElapsedSec: 450 });

      assert.equal(e.detail.usableRuns, 4);
      assert.equal(e.detail.usualMs, 900_000);
      assert.equal(e.progress, 0.5);
    });

    test(`${name}: isUsableRun says no`, () => {
      assert.equal(isUsableRun(finished(60, 6000, extra)), false);
    });
  }

  test('control: the same 6000 s run without any flag IS counted and moves the median', () => {
    const e = estimate([...BASE, finished(60, 6000)], { runElapsedSec: 600 });
    assert.equal(e.detail.usableRuns, 5);
    assert.equal(e.detail.usualMs, 1_200_000);
    assert.equal(e.progress, 0.5);
  });

  test('a run without finishedAt is open, not usable, and is not mistaken for the run being estimated', () => {
    const noEnd = finished(1, 6000);
    delete noEnd.finishedAt;
    assert.equal(isUsableRun(noEnd), false);
    // started after the run under estimation (450 s ago), so the oldest open run is still that one
    const e = estimate([...BASE, noEnd], { runElapsedSec: 450 });
    assert.equal(e.detail.usableRuns, 4);
    assert.equal(e.progress, 0.5);
  });
});

describe('history strategy: the median', () => {
  // durations 100 s, 200 s ... n * 100 s: the median is the mean of the two middle ones, (50n + 50) s
  for (const n of [4, 6, 8, 10]) {
    test(`${n} runs: the two middle durations are averaged`, () => {
      const history = Array.from({ length: n }, (_, k) => finished(60 * (k + 2), 100 * (k + 1)));
      const usualMs = (50 * n + 50) * 1000;

      const e = estimate(history, { runElapsedSec: usualMs / 2000 });

      assert.equal(e.detail.usualMs, usualMs);
      assert.equal(e.progress, 0.5);
    });
  }

  test('the order the runs were recorded in does not change it', () => {
    const history = Array.from({ length: 6 }, (_, k) => finished(60 * (k + 2), 100 * (k + 1)));
    const a = estimate(history, { runElapsedSec: 175 });
    const b = estimate([...history].reverse(), { runElapsedSec: 175 });
    assert.deepEqual(a, b);
  });

  test('median() of an even list is the mean of the middle pair, of an odd one the middle', () => {
    assert.equal(median([1, 2, 3, 10]), 2.5);
    assert.equal(median([1, 2, 10]), 2);
    assert.equal(median([7]), 7);
  });
});

describe('history strategy: confidence bands', () => {
  // Five runs around 1000 s (M-d, M-d, M, M+d, M+d) with a median absolute deviation of d: the score is 1 - d / 1000.
  const around = (d) => [-d, -d, 0, d, d].map((delta, k) => finished(60 * (k + 2), 1000 + delta));

  const cases = [
    [200, 'high', 'exactly 0.8'],
    [201, 'medium', 'just under 0.8'],
    [500, 'medium', 'exactly 0.5'],
    [499, 'medium', 'just over 0.5'],
    [501, 'low', 'just under 0.5'],
  ];
  for (const [d, level, why] of cases) {
    test(`score ${why} (deviation ${d} s): ${level}`, () => {
      const e = estimate(around(d), { runElapsedSec: 100 });
      assert.equal(e.detail.usualMs, 1_000_000);
      assert.equal(e.confidence, level, `score ${e.confidenceScore}`);
    });
  }

  test('a good score with fewer than 5 runs is still low', () => {
    assert.equal(estimate(usable(4, 600), { runElapsedSec: 60 }).confidence, 'low');
  });

  test('the score is clamped to 0..1 when the spread exceeds the median', () => {
    // durations 1, 1, 1, 1000, 1000, 1000 s: median 500.5 s, every deviation ~499.5 s
    const e = estimate([1, 1, 1, 1000, 1000, 1000].map((d, k) => finished(60 * (k + 2), d)), { runElapsedSec: 10 });
    assert.ok(e.confidenceScore >= 0 && e.confidenceScore <= 1, `score ${e.confidenceScore}`);
  });
});

describe('history strategy: runs with unreadable times are dropped', () => {
  const clean = estimate(usable(5, 600), { runElapsedSec: 300 });

  test('a finishedAt before its startedAt', () => {
    const backwards = finished(10, 0, { finishedAt: new Date(T0 - 10 * 60_000 - 5000).toISOString() });
    assert.deepEqual(estimate([...usable(5, 600), backwards], { runElapsedSec: 300 }), clean);
  });

  test('a finishedAt that is not a date', () => {
    assert.deepEqual(estimate([...usable(5, 600), finished(10, 6000, { finishedAt: 'yesterday-ish' })], { runElapsedSec: 300 }), clean);
  });

  test('a startedAt that is not a date', () => {
    const e = estimate([...usable(5, 600), finished(10, 6000, { startedAt: 'garbage' })], { runElapsedSec: 300 });
    assert.equal(e.detail.usualMs, 600_000);
    assert.equal(e.progress, 0.5);
  });

  test('usableDurations never returns a negative or non-finite duration', () => {
    const durations = usableDurations([
      ...usable(3, 600),
      finished(10, 0, { finishedAt: new Date(T0 - 10 * 60_000 - 1000).toISOString() }),
      finished(11, 1, { finishedAt: 'nope' }),
    ]);
    assert.deepEqual(durations, [600_000, 600_000, 600_000]);
  });

  test('too few readable runs says how many it has, not how many were recorded', () => {
    const e = estimate([...usable(2, 600), finished(10, 0, { finishedAt: 'nope' })]);
    assert.equal(e.progress, null);
    assert.match(e.reason, /needs 3 usable runs, has 2/);
  });
});

describe('history strategy: the clock and the cap', () => {
  test('a run that starts after "now" (clock moved back) has progress exactly 0 and a sensible ETA', () => {
    // started 300 s in the future
    const e = estimate(usable(5, 600), { runElapsedSec: -300 });

    assert.equal(e.progress, 0);
    assert.equal(e.detail.elapsedMs, 0);
    assert.equal(e.detail.overdue, false);
    assert.equal(e.etaAt, new Date(T0 + 300_000 + 600_000).toISOString());
    assert.ok(Date.parse(e.etaAt) > T0);
  });

  test('elapsed exactly equal to the usual duration is already "longer than usual"', () => {
    const e = estimate(usable(5, 600), { runElapsedSec: 600 });
    assert.equal(e.progress, 0.99);
    assert.equal(e.etaAt, null);
    assert.equal(e.detail.overdue, true);
  });

  test('1 ms before the usual duration is not overdue yet, and the progress is capped at 0.99', () => {
    const e = estimate(usable(5, 600), { runElapsedSec: 599.999 });
    assert.equal(e.detail.overdue, false);
    assert.equal(e.progress, 0.99);
    assert.ok(e.etaAt !== null);
  });

  test('at 99 % of the usual duration the progress is exactly 0.99; just below it is the plain ratio', () => {
    assert.equal(estimate(usable(5, 600), { runElapsedSec: 594 }).progress, 0.99);
    assert.equal(estimate(usable(5, 600), { runElapsedSec: 540 }).progress, 0.9);
  });

  test('the answer carries the clock it was computed with', () => {
    const e = estimate(usable(5, 600), { runElapsedSec: 60, now: T0 + 5000 });
    assert.equal(e.serverNow, new Date(T0 + 5000).toISOString());
  });

  test('an open run of its own is never counted in the usual duration', () => {
    const e = estimate([...usable(3, 600), open(T0, 7000, { pid: 9 })], { runElapsedSec: 300 });
    assert.equal(e.detail.usableRuns, 3);
  });
});

describe('formatDuration', () => {
  test('seconds, minutes, hours', () => {
    assert.equal(formatDuration(0), '0 s');
    assert.equal(formatDuration(45_000), '45 s');
    assert.equal(formatDuration(600_000), '10 min');
    assert.equal(formatDuration(3_900_000), '1 h 05 min');
    assert.equal(formatDuration(2 * 3_600_000), '2 h 00 min');
  });

  test('rounds up at the half: 59.5 s is 1 min, 59.5 min is 1 h 00 min, never "60 s" or "60 min"', () => {
    assert.equal(formatDuration(59_499), '59 s');
    assert.equal(formatDuration(59_500), '1 min');
    assert.equal(formatDuration(3_569_000), '59 min');
    assert.equal(formatDuration(3_570_000), '1 h 00 min');
  });
});
