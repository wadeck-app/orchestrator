'use strict';

// The `history` strategy: progress = elapsed / D, D = median of the last 10 usable run durations.
// Every "no estimate" must say why and what to do.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { historyStrategy } = require('../src/progress/history-strategy');
const { T0, finished, open, usable, context } = require('./helpers/progress-fixtures');

function estimate(history, over = {}) {
  return historyStrategy.estimate(context({ history, ...over }));
}

describe('history strategy: how many runs it needs', () => {
  for (const k of [0, 1, 2]) {
    test(`${k} usable run(s): no estimate, the reason says how many it has`, () => {
      const e = estimate(usable(k, 600));
      assert.equal(e.progress, null);
      assert.equal(e.etaAt, null);
      assert.equal(e.confidence, 'none');
      assert.match(e.reason, new RegExp(`needs 3 usable runs, has ${k}`));
    });
  }

  test('3 usable runs: an estimate, flagged low confidence because there are fewer than 5', () => {
    const e = estimate(usable(3, 600), { runElapsedSec: 300 });
    assert.equal(e.strategyId, 'history');
    assert.equal(e.progress, 0.5);
    assert.equal(e.etaAt, new Date(T0 - 300_000 + 600_000).toISOString());
    assert.equal(e.confidence, 'low');
    assert.equal(e.serverNow, new Date(T0).toISOString());
  });

  test('5 identical runs: high confidence, score 1', () => {
    const e = estimate(usable(5, 600), { runElapsedSec: 60 });
    assert.equal(e.confidence, 'high');
    assert.equal(e.confidenceScore, 1);
  });
});

describe('history strategy: which runs count', () => {
  test('failed, killed, timed out, orphaned, skipped and cancelled runs are not usable', () => {
    const history = [
      ...usable(2, 600),
      finished(10, 5, { exitCode: 1 }),
      finished(11, 5, { exitCode: null, endReason: 'manual-kill' }),
      finished(12, 5, { exitCode: null, endReason: 'timeout' }),
      finished(13, 5, { orphaned: true }),
      finished(14, 5, { skipped: true }),
      finished(15, 5, { cancelledByUser: true }),
      { ...finished(16, 5), finishedAt: undefined },
    ];
    const e = estimate(history);
    assert.equal(e.progress, null);
    assert.match(e.reason, /needs 3 usable runs, has 2/);
  });

  test('a mix of unusable runs does not move D', () => {
    const history = [...usable(4, 600), finished(10, 5, { exitCode: 1 }), finished(11, 1, { skipped: true })];
    const e = estimate(history, { runElapsedSec: 300 });
    assert.equal(e.progress, 0.5);
    assert.equal(e.detail.usableRuns, 4);
  });

  test('only the 10 newest usable runs feed D', () => {
    const old = Array.from({ length: 5 }, (_, i) => finished(1000 + i, 6000));
    const e = estimate([...usable(10, 600), ...old], { runElapsedSec: 300 });
    assert.equal(e.progress, 0.5);
    assert.equal(e.detail.usableRuns, 10);
  });

  test('history out of order is sorted by startedAt, not trusted', () => {
    const recent = usable(10, 600);
    const old = Array.from({ length: 5 }, (_, i) => finished(1000 + i, 6000));
    const e = estimate([...old, ...recent], { runElapsedSec: 300 });
    assert.equal(e.progress, 0.5);
  });
});

describe('history strategy: spread and outliers', () => {
  test('one huge outlier does not move the median and costs little confidence', () => {
    const history = [...usable(8, 600), finished(500, 36_000)];
    const e = estimate(history, { runElapsedSec: 300 });
    assert.equal(e.progress, 0.5);
    assert.equal(e.confidence, 'high');
  });

  test('widely spread durations lower the confidence score', () => {
    const durations = [100, 200, 300, 400, 500, 600, 700];
    const history = durations.map((d, i) => finished(60 * (i + 2), d));
    const e = estimate(history);
    assert.ok(e.confidenceScore < 0.6, `score ${e.confidenceScore}`);
    assert.notEqual(e.confidence, 'high');
    assert.ok(e.confidenceScore >= 0 && e.confidenceScore <= 1);
  });

  test('all durations zero: no estimate, with a reason', () => {
    const e = estimate(usable(5, 0));
    assert.equal(e.progress, null);
    assert.match(e.reason, /usual duration is 0/);
  });
});

describe('history strategy: past the usual duration', () => {
  test('progress holds at 0.99, no ETA, the reason names the usual duration', () => {
    const e = estimate(usable(5, 600), { runElapsedSec: 900 });
    assert.equal(e.progress, 0.99);
    assert.equal(e.etaAt, null);
    assert.equal(e.detail.overdue, true);
    assert.match(e.reason, /longer than usual \(usual: 10 min\)/);
    assert.notEqual(e.confidence, 'none');
  });

  test('progress stays under 1 just before D, and the ETA is still given', () => {
    const e = estimate(usable(5, 600), { runElapsedSec: 599 });
    assert.ok(e.progress <= 0.99);
    assert.ok(e.etaAt !== null);
  });
});

describe('history strategy: parallel runs', () => {
  test('estimates from the OLDEST open run', () => {
    const ctx = context({ history: usable(5, 600), runElapsedSec: 60 });
    const older = open(T0, 300);
    ctx.history = [...ctx.history, older];
    const e = historyStrategy.estimate(ctx);
    assert.equal(e.progress, 0.5);
    assert.equal(e.detail.runStartedAt, older.startedAt);
  });
});
