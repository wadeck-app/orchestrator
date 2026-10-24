'use strict';

// `ratio`: a counter printed in the log ("3/10", "40%"), rate-extrapolated over a sliding window.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { ratioStrategy, createRatioStrategy } = require('../../src/progress/ratio-strategy');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const SEC = 1000;
const FRACTION = { pattern: '(\\d+)/(\\d+)' };
const PERCENT = { pattern: '(\\d+)%' };

function run({ elapsedSec, lines, options = FRACTION, runs, strategy = ratioStrategy }) {
  const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec, lines }, runs });
  const checked = strategy.validateOptions(options);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const estimate = strategy.estimate(fx.contextOf(c, { options: checked.value }));
  return { c, estimate };
}

const startOf = (c) => Date.parse(c.currentStartedAt);

describe('ratio: options', () => {
  test('a pattern with 1 or 2 groups, an optional window', () => {
    assert.deepEqual(ratioStrategy.validateOptions({ pattern: '(\\d+)%' }), { ok: true, value: { pattern: '(\\d+)%', window: 8 } });
    assert.deepEqual(ratioStrategy.validateOptions({ pattern: '(\\d+)/(\\d+)', window: 3 }), { ok: true, value: { pattern: '(\\d+)/(\\d+)', window: 3 } });
  });

  for (const [name, raw, pattern] of [
    ['no options', undefined, /needs options like \{"pattern": "\(\\\\d\+\)\/\(\\\\d\+\)"\}/],
    ['no pattern', { window: 3 }, /"pattern" is required/],
    ['an unknown key', { pattern: '(\\d+)%', size: 3 }, /unknown option "size" \(accepted: pattern, window\)/],
    ['no capture group', { pattern: '\\d+%' }, /0 capture group\(s\), it needs 1 or 2/],
    ['three groups', { pattern: '(\\d)(\\d)(\\d)' }, /3 capture group\(s\)/],
    ['a catastrophic pattern', { pattern: '((\\d+)+)/(\\d+)' }, /nested quantifiers/],
    ['a window of 1', { pattern: '(\\d+)%', window: 1 }, /"window" must be an integer from 2 to 50/],
    ['a window of 1000', { pattern: '(\\d+)%', window: 1000 }, /"window" must be an integer from 2 to 50/],
  ]) {
    test(`refuses ${name} with the fix`, () => {
      const r = ratioStrategy.validateOptions(raw);
      assert.equal(r.ok, false);
      assert.match(r.error, pattern);
    });
  }
});

describe('ratio: estimate', () => {
  test('no line matched yet: no estimate, the reason names the pattern and where to look', () => {
    const { estimate } = run({ elapsedSec: 20, lines: [[5, 'starting']] });
    assert.equal(estimate.strategyId, 'ratio');
    assert.equal(estimate.progress, null);
    assert.equal(estimate.confidence, 'none');
    assert.match(estimate.reason, /no log line matched \/\(\\d\+\)\\\/\(\\d\+\)\/ in this run yet/);
    assert.match(estimate.reason, /orch job j logs/);
  });

  test('a fraction: progress is a/b and the end follows the rate', () => {
    const { c, estimate } = run({ elapsedSec: 35, lines: [[10, 'file 1/10'], [20, 'file 2/10'], [30, 'file 3/10']] });
    assert.equal(estimate.progress, 0.3);
    assert.equal(estimate.etaAt, new Date(startOf(c) + 100 * SEC).toISOString());
    assert.equal(estimate.detail.method, 'rate');
    assert.match(estimate.reason, /counter at 3\/10 \(30 ?%\)/);
  });

  test('a percentage with one group', () => {
    const { estimate } = run({ elapsedSec: 25, options: PERCENT, lines: [[10, 'Progress: 10%'], [20, 'Progress: 20%']] });
    assert.equal(estimate.progress, 0.2);
  });

  test('only the sliding window sets the rate', () => {
    const lines = [[5, 'at 50%'], [10, 'at 60%'], [20, 'at 62%'], [30, 'at 64%'], [40, 'at 66%']];
    const { c, estimate } = run({ elapsedSec: 45, options: { pattern: 'at (\\d+)%', window: 3 }, lines });
    assert.equal(estimate.etaAt, new Date(startOf(c) + 210 * SEC).toISOString());
  });

  test('a counter that goes down starts a new phase and says so', () => {
    const lines = [[10, 'file 4/10'], [20, 'file 5/10'], [30, 'file 1/20']];
    const { estimate } = run({ elapsedSec: 35, lines });
    assert.equal(estimate.progress, 0.05);
    assert.equal(estimate.detail.resets, 1);
    assert.match(estimate.reason, /counter restarted 1 time\(s\) \(now in phase 2\)/);
  });

  test('a value above its total, or a zero total, is ignored and counted', () => {
    const { estimate } = run({ elapsedSec: 40, lines: [[10, 'file 12/10'], [15, 'file 1/0'], [20, 'file 2/10']] });
    assert.equal(estimate.progress, 0.2);
    assert.equal(estimate.detail.malformed, 2);
    assert.match(estimate.reason, /2 match\(es\) ignored \(value above its total, or a zero total\)/);
  });

  test('a rate that says the end passed is overdue, not a past ETA', () => {
    const { estimate } = run({ elapsedSec: 400, lines: [[10, 'file 5/10'], [20, 'file 6/10']] });
    assert.equal(estimate.etaAt, null);
    assert.equal(estimate.detail.overdue, true);
    assert.match(estimate.reason, /later than the counter predicted/);
  });

  test('a counter at its total while the run is open: 100 %', () => {
    const { estimate } = run({ elapsedSec: 50, lines: [[40, 'file 10/10']] });
    assert.equal(estimate.progress, 1);
  });

  test('a run with no log file yet says so', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 3 } });
    require('node:fs').rmSync(require('node:path').join(c.logDir, require('node:fs').readdirSync(c.logDir)[0]));
    const estimate = ratioStrategy.estimate(fx.contextOf(c, { options: { pattern: '(\\d+)%', window: 8 } }));
    assert.match(estimate.reason, /no log file for this run yet/);
  });

  test('a pattern too slow for the time budget is reported with the fix', () => {
    const slow = createRatioStrategy({ matcherFor: () => ({ matchLines: () => ({ matches: [], timedOut: true }) }) });
    const { estimate } = run({ elapsedSec: 20, lines: [[5, 'x']], strategy: slow });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /exceeded the \d+ ms match budget/);
    assert.match(estimate.reason, /simplify the pattern/);
  });

  test('stored options whose pattern is now refused give a reason, not a throw', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 20, lines: [[5, 'x']] } });
    const estimate = ratioStrategy.estimate(fx.contextOf(c, { options: { pattern: '((a+)+)(b)', window: 8 } }));
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /nested quantifiers/);
  });
});
