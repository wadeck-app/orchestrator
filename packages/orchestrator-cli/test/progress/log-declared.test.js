'use strict';

// `log-declared`: the user lists milestones (regexes on log lines); progress is interpolated between the
// milestones seen, with their expected position from `at`, from `weight`, or learned from past runs.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { logDeclaredStrategy, createLogDeclaredStrategy } = require('../../src/progress/log-declared-strategy');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const SEC = 1000;
const startOf = (c) => Date.parse(c.currentStartedAt);
const STEPS = (...pairs) => pairs.map(([sec, name]) => [sec, name]);

function milestones(...names) {
  return names.map(pattern => ({ pattern }));
}

function pastRuns(n, durationSec, lines, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({ agoMin: 60 * (i + 2), durationSec, lines, ...extra }));
}

function run({ elapsedSec, lines, runs, options, strategy = logDeclaredStrategy, store, jobExtra }) {
  const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec, lines }, runs, job: jobExtra });
  const checked = strategy.validateOptions(options);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const ctx = fx.contextOf(c, { options: checked.value, store });
  return { c, ctx, estimate: strategy.estimate(ctx) };
}

describe('log-declared: options', () => {
  test('milestones with at, with weight, or with neither', () => {
    assert.equal(logDeclaredStrategy.validateOptions({ milestones: [{ pattern: 'a', at: 0.5 }, { pattern: 'b', at: 1 }] }).ok, true);
    assert.equal(logDeclaredStrategy.validateOptions({ milestones: [{ pattern: 'a', weight: 1 }, { pattern: 'b', weight: 3 }] }).ok, true);
    assert.equal(logDeclaredStrategy.validateOptions({ milestones: [{ pattern: 'a' }, { pattern: 'b' }] }).ok, true);
  });

  const bad = [
    ['no options', undefined, /needs options like \{"milestones": \[\{"pattern": "Step 1", "at": 0.3\}/],
    ['not an object', 'x', /options must be an object/],
    ['no milestones', {}, /"milestones" is required/],
    ['an empty list', { milestones: [] }, /"milestones" must be a list of 1 to 30/],
    ['31 milestones', { milestones: Array.from({ length: 31 }, () => ({ pattern: 'a' })) }, /1 to 30/],
    ['an unknown top-level key', { milestones: [{ pattern: 'a' }], steps: 1 }, /unknown option "steps" \(accepted: milestones\)/],
    ['an unknown milestone key', { milestones: [{ pattern: 'a', when: 1 }] }, /milestones\[0\]: unknown key "when" \(accepted: pattern, at, weight\)/],
    ['no pattern', { milestones: [{ at: 0.5 }] }, /milestones\[0\]: "pattern" is required/],
    ['a catastrophic pattern', { milestones: [{ pattern: 'ok' }, { pattern: '(a+)+$' }] }, /milestones\[1\]: pattern "\(a\+\)\+\$" has a quantified group/],
    ['at of 0', { milestones: [{ pattern: 'a', at: 0 }] }, /milestones\[0\]: "at" must be a number above 0 and at most 1/],
    ['at of 1.5', { milestones: [{ pattern: 'a', at: 1.5 }] }, /"at" must be a number above 0 and at most 1/],
    ['at not increasing', { milestones: [{ pattern: 'a', at: 0.5 }, { pattern: 'b', at: 0.4 }] }, /milestones\[1\]: "at" 0.4 must be above the previous one \(0.5\)/],
    ['weight of 0', { milestones: [{ pattern: 'a', weight: 0 }] }, /"weight" must be a number above 0/],
    ['at and weight on one milestone', { milestones: [{ pattern: 'a', at: 0.5, weight: 1 }] }, /milestones\[0\]: give "at" or "weight", not both/],
    ['at on some and weight on others', { milestones: [{ pattern: 'a', at: 0.5 }, { pattern: 'b', weight: 1 }] }, /use "at" on every milestone, "weight" on every milestone, or neither/],
    ['at on some only', { milestones: [{ pattern: 'a', at: 0.5 }, { pattern: 'b' }] }, /use "at" on every milestone, "weight" on every milestone, or neither/],
  ];
  for (const [name, raw, pattern] of bad) {
    test(`refuses ${name} with the fix`, () => {
      const r = logDeclaredStrategy.validateOptions(raw);
      assert.equal(r.ok, false);
      assert.match(r.error, pattern);
    });
  }
});

describe('log-declared: expected positions given by `at`', () => {
  const AT = { milestones: [{ pattern: 'Step A', at: 0.25 }, { pattern: 'Step B', at: 0.5 }, { pattern: 'Step C', at: 0.75 }] };

  test('from the first run: the pace to the last milestone gives the end', () => {
    const { c, estimate } = run({ elapsedSec: 30, options: AT, lines: STEPS([25, 'Step A done']) });
    assert.equal(estimate.strategyId, 'log-declared');
    assert.equal(estimate.etaAt, new Date(startOf(c) + 100 * SEC).toISOString());
    assert.ok(Math.abs(estimate.progress - 0.3) < 1e-9, `progress ${estimate.progress}`);
    assert.notEqual(estimate.confidence, 'none');
    assert.match(estimate.reason, /milestone 1 of 3 reached \("Step A"\)/);
  });

  test('no milestone reached and nothing to compare with: no end, progress 0, and why', () => {
    const { estimate } = run({ elapsedSec: 10, options: AT, lines: STEPS([5, 'starting']) });
    assert.equal(estimate.progress, 0);
    assert.equal(estimate.etaAt, null);
    assert.equal(estimate.detail.etaUnknown, true);
    assert.equal(estimate.confidence, 'low');
    assert.match(estimate.reason, /waiting for the first milestone \("Step A"\)/);
  });

  test('no milestone reached yet but past runs exist: the usual duration gives the end', () => {
    const { c, estimate } = run({ elapsedSec: 10, options: AT, runs: pastRuns(3, 100, STEPS([25, 'Step A'], [50, 'Step B'], [75, 'Step C'])), lines: [] });
    assert.equal(estimate.etaAt, new Date(startOf(c) + 100 * SEC).toISOString());
    assert.ok(estimate.progress > 0 && estimate.progress <= 0.25);
  });

  test('late for the next milestone: progress waits below it and the end moves out', () => {
    const { c, estimate } = run({ elapsedSec: 80, options: AT, lines: STEPS([25, 'Step A']) });
    assert.ok(Math.abs(estimate.progress - 0.4875) < 1e-9, `progress ${estimate.progress}`);
    assert.ok(Date.parse(estimate.etaAt) > startOf(c) + 100 * SEC, 'later than the pace alone said');
    assert.ok(Date.parse(estimate.etaAt) > startOf(c) + 80 * SEC);
  });

  test('past the expected end: overdue, no past ETA', () => {
    const { estimate } = run({ elapsedSec: 150, options: AT, lines: STEPS([25, 'Step A']) });
    assert.equal(estimate.etaAt, null);
    assert.equal(estimate.detail.overdue, true);
    assert.match(estimate.reason, /longer than the milestones predicted/);
  });

  test('a milestone reached in the first second says nothing about the pace: the usual duration is used', () => {
    const { c, estimate } = run({ elapsedSec: 20, options: AT, runs: pastRuns(3, 100, []), lines: STEPS([0, 'Step A']) });
    assert.equal(estimate.etaAt, new Date(startOf(c) + 100 * SEC).toISOString());
  });

  test('the last milestone is the end: the run should finish any moment', () => {
    const options = { milestones: [{ pattern: 'Step A', at: 0.5 }, { pattern: 'Finishing', at: 1 }] };
    const { estimate } = run({ elapsedSec: 90, options, lines: STEPS([40, 'Step A'], [80, 'Finishing now']) });
    assert.equal(estimate.progress, 0.99);
    assert.equal(estimate.etaAt, null);
    assert.equal(estimate.detail.overdue, true);
    assert.match(estimate.reason, /last milestone reached/);
  });
});

describe('log-declared: expected positions given by `weight`', () => {
  test('weights are relative step sizes; the last milestone is the end', () => {
    const options = { milestones: [{ pattern: 'Step A', weight: 1 }, { pattern: 'Step B', weight: 1 }, { pattern: 'Step C', weight: 2 }] };
    const { c, estimate } = run({ elapsedSec: 45, options, lines: STEPS([40, 'Step B ok']) });
    assert.equal(estimate.etaAt, new Date(startOf(c) + 80 * SEC).toISOString());
    assert.match(estimate.reason, /milestone 2 of 3/);
  });
});

describe('log-declared: expected positions learned from past runs', () => {
  const STEADY = STEPS([20, 'Step A'], [50, 'Step B'], [80, 'Step C']);
  const LEARN = { milestones: milestones('Step A', 'Step B', 'Step C') };

  test('the median relative time of each milestone gives its position', () => {
    const { c, estimate } = run({ elapsedSec: 55, options: LEARN, runs: pastRuns(6, 100, STEADY), lines: STEPS([20, 'Step A'], [50, 'Step B']) });
    assert.equal(estimate.etaAt, new Date(startOf(c) + 100 * SEC).toISOString());
    assert.equal(estimate.confidence, 'high');
    assert.deepEqual(estimate.detail.positions, [0.2, 0.5, 0.8]);
  });

  test('runs only the log files remember count too', () => {
    const { estimate } = run({ elapsedSec: 25, options: LEARN, runs: pastRuns(4, 100, STEADY, { inHistory: false }), lines: STEPS([20, 'Step A']) });
    assert.notEqual(estimate.confidence, 'none');
  });

  test('fewer than 3 usable runs with logs: no estimate, and the way out is named', () => {
    const { estimate } = run({ elapsedSec: 25, options: LEARN, runs: pastRuns(1, 100, STEADY), lines: STEPS([20, 'Step A']) });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /needs 3 usable runs to learn where the milestones fall, has 1/);
    assert.match(estimate.reason, /"at" on every milestone/);
  });

  test('a milestone seen in fewer than half of the runs is not used, and the reason says so', () => {
    const runs = [
      ...pastRuns(1, 100, STEPS([20, 'Step A'], [40, 'Rare'], [80, 'Step C'])),
      ...pastRuns(3, 100, STEPS([20, 'Step A'], [80, 'Step C'])).map((r, i) => ({ ...r, agoMin: 200 + 60 * i })),
    ];
    const { estimate } = run({ elapsedSec: 30, options: { milestones: milestones('Step A', 'Rare', 'Step C') }, runs, lines: STEPS([20, 'Step A']) });
    assert.deepEqual(estimate.detail.positions, [0.2, null, 0.8]);
    assert.match(estimate.reason, /warning: milestone 2 \("Rare"\) matched in only 1 of the last 4 usable runs/);
  });

  test('learned positions are cached in the store and reused without reading the logs again', () => {
    const store = fx.memoryStore();
    const first = run({ elapsedSec: 25, options: LEARN, runs: pastRuns(4, 100, STEADY), lines: STEPS([20, 'Step A']), store });
    assert.ok(store.read() !== undefined, 'something was cached');
    // The same context with the past logs deleted: the answer comes from the cache.
    for (const f of fs.readdirSync(first.c.logDir)) {
      if (f !== fs.readdirSync(first.c.logDir).find(n => n.includes(first.c.currentStartedAt.slice(0, 19).replace(/:/g, '-')))) {
        fs.rmSync(`${first.c.logDir}/${f}`);
      }
    }
    const second = logDeclaredStrategy.estimate(first.ctx);
    assert.deepEqual(second.detail.positions, first.estimate.detail.positions);
    assert.equal(second.etaAt, first.estimate.etaAt);
  });

  test('a scan byte budget spreads the learning over several estimates, and says so', () => {
    const strategy = createLogDeclaredStrategy({ scanByteBudget: 1 });
    const store = fx.memoryStore();
    const a = run({ elapsedSec: 25, options: LEARN, runs: pastRuns(5, 100, STEADY), lines: STEPS([20, 'Step A']), strategy, store });
    assert.match(a.estimate.reason, /learning: 1 of 5 past runs scanned/);
    const b = strategy.estimate(a.ctx);
    assert.match(b.reason, /learning: 2 of 5 past runs scanned/);
  });
});

describe('log-declared: warnings and limits', () => {
  test('a pattern that never matched in the usable runs is a visible warning, in every mode', () => {
    const options = { milestones: [{ pattern: 'Step A', at: 0.25 }, { pattern: 'Step Z', at: 0.5 }] };
    const { estimate } = run({ elapsedSec: 30, options, runs: pastRuns(4, 100, STEPS([25, 'Step A'])), lines: STEPS([25, 'Step A']) });
    assert.match(estimate.reason, /warning: milestone 2 \("Step Z"\) never matched in the last 4 usable runs/);
    assert.match(estimate.reason, /orch job j logs/);
    assert.deepEqual(estimate.detail.warnings.length, 1);
  });

  test('runs under 10 s: the one-second log resolution is stated and the confidence stays low', () => {
    const options = { milestones: [{ pattern: 'Step A', at: 0.5 }, { pattern: 'Step B', at: 1 }] };
    const { estimate } = run({ elapsedSec: 3, options, runs: pastRuns(5, 6, STEPS([3, 'Step A'], [5, 'Step B'])), lines: STEPS([3, 'Step A']) });
    assert.equal(estimate.confidence, 'low');
    assert.match(estimate.reason, /runs last under 10 s: log timestamps have a 1 s resolution, so the estimate is coarse/);
  });

  test('a pattern too slow for the time budget is reported with the fix', () => {
    const slow = createLogDeclaredStrategy({ matcherFor: () => ({ matchLines: () => ({ matches: [], timedOut: true }) }) });
    const { estimate } = run({ elapsedSec: 20, options: { milestones: [{ pattern: 'a', at: 0.5 }] }, lines: STEPS([5, 'x']), strategy: slow });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /exceeded the \d+ ms match budget/);
  });

  test('stored options with a pattern that is now refused give a reason, not a throw', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 20, lines: [] } });
    const estimate = logDeclaredStrategy.estimate(fx.contextOf(c, { options: { milestones: [{ pattern: '(a+)+$', at: 0.5 }] } }));
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /milestones\[0\]/);
  });

  test('without options (an auto job cannot reach it) the reason says how to configure it', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 20, lines: [] } });
    const estimate = logDeclaredStrategy.estimate(fx.contextOf(c));
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /--progress log-declared --progress-options/);
  });
});
