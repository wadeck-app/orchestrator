'use strict';

// The contract every progress strategy honours (built-in today, external later): never throws, progress in
// [0,1] or null, a non-empty reason when progress is null, etaAt not in the past unless flagged overdue.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { STRATEGIES } = require('../src/progress/engine');
const { T0, finished, usable, context } = require('./helpers/progress-fixtures');

const HISTORIES = {
  empty: [],
  two: usable(2, 600),
  identical: usable(6, 600),
  outlier: [...usable(8, 600), finished(500, 36_000)],
  allFailed: Array.from({ length: 6 }, (_, i) => finished(60 * (i + 2), 10, { exitCode: 2 })),
  zero: usable(5, 0),
  future: [finished(-30, 600), ...usable(4, 600)],
};

for (const strategy of STRATEGIES) {
  describe(`strategy contract: ${strategy.id}`, () => {
    test('has an id like a job id and a numeric version', () => {
      assert.match(strategy.id, /^[a-z0-9-]+$/);
      assert.equal(typeof strategy.version, 'number');
    });

    for (const [name, history] of Object.entries(HISTORIES)) {
      for (const runElapsedSec of [0, 1, 300, 600, 100_000]) {
        test(`${name}, ${runElapsedSec}s elapsed`, () => {
          const e = strategy.estimate(context({ history, runElapsedSec }));
          assert.equal(e.strategyId, strategy.id);
          if (e.progress === null) {
            assert.equal(typeof e.reason, 'string');
            assert.ok(e.reason.trim().length > 0, 'a null progress carries a reason');
            assert.equal(e.etaAt, null);
          } else {
            assert.ok(e.progress >= 0 && e.progress <= 1, `progress ${e.progress}`);
            assert.ok(e.etaAt === null || Date.parse(e.etaAt) >= T0, 'etaAt is not in the past');
            assert.ok(e.etaAt !== null || e.detail?.overdue === true, 'no etaAt means overdue');
          }
          assert.ok(e.confidenceScore >= 0 && e.confidenceScore <= 1);
          assert.ok(['high', 'medium', 'low', 'none'].includes(e.confidence));
          assert.ok(!Number.isNaN(Date.parse(e.serverNow)));
        });
      }
    }

    test('is deterministic for the same input', () => {
      const ctx = context({ history: HISTORIES.outlier });
      assert.deepEqual(strategy.estimate(ctx), strategy.estimate(ctx));
    });
  });
}
