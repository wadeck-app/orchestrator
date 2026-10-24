'use strict';

// `ensemble`: replays history, log-learned and declared on the job's own usable runs and answers with the one
// whose end time was closest to the truth; the reason always names the pick and the replay error of each.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { ensembleStrategy, autoEnsembleStrategy, createEnsembleStrategy } = require('../../src/progress/ensemble-strategy');
const { STRATEGIES, AUTO_STRATEGIES, PROGRESS_STRATEGY_IDS } = require('../../src/progress/registry');
const { estimateProgress } = require('../../src/progress/engine');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const UNBOUNDED = { learnByteBudget: Infinity, evalByteBudget: Infinity };

function milestoneLines(durationSec, salt = 0) {
  const at = (f) => Math.round(f * durationSec);
  return [
    [at(0.15), `Reading input ${salt}`],
    [at(0.35), `Parsed ${100 + salt} rows`],
    [at(0.65), `Computed ${100 + salt} aggregates`],
    [at(0.9), `Wrote report ${salt}`],
  ];
}

/** An input-dependent job: the duration changes a lot from run to run, the log milestones keep their place. */
function inputDependent(durations = [300, 900, 450, 1200, 600, 750, 360, 1000]) {
  return durations.map((d, i) => ({ agoMin: 120 * (i + 1), durationSec: d, lines: milestoneLines(d, i) }));
}

function steady(n, durationSec) {
  return Array.from({ length: n }, (_, i) => ({ agoMin: 120 * (i + 1), durationSec, lines: [] }));
}

function build(runs, current) {
  return fx.buildCase(fx.tempDir(), { runs, current });
}

describe('ensemble: options and registration', () => {
  test('takes no options', () => {
    assert.equal(ensembleStrategy.validateOptions(undefined).ok, true);
    const r = ensembleStrategy.validateOptions({ a: 1 });
    assert.equal(r.ok, false);
    assert.match(r.error, /the ensemble strategy takes no options/);
  });

  test('log-learned and ensemble are registered; auto tries declared, ensemble, history', () => {
    assert.ok(PROGRESS_STRATEGY_IDS.includes('log-learned'));
    assert.ok(PROGRESS_STRATEGY_IDS.includes('ensemble'));
    assert.deepEqual(AUTO_STRATEGIES.map(s => s.id), ['declared', 'ensemble', 'history']);
    assert.deepEqual(STRATEGIES.map(s => s.id).sort(), ['declared', 'ensemble', 'history', 'log-declared', 'log-learned', 'ratio']);
  });
});

describe('ensemble: too few runs to compare', () => {
  test('under 3 usable runs: no estimate, with the count and the way out', () => {
    const c = build(steady(2, 600), { elapsedSec: 100, lines: [] });
    const e = ensembleStrategy.estimate(fx.contextOf(c));
    assert.equal(e.strategyId, 'ensemble');
    assert.equal(e.progress, null);
    assert.match(e.reason, /needs 3 usable runs, has 2/);
  });

  test('3 or 4 runs, explicit: history answers, and the reason says why nothing was compared', () => {
    const c = build(steady(4, 600), { elapsedSec: 100, lines: [] });
    const e = ensembleStrategy.estimate(fx.contextOf(c));
    assert.notEqual(e.progress, null);
    assert.equal(e.detail.chosen, 'history');
    assert.match(e.reason, /^ensemble: history/);
    assert.match(e.reason, /needs 5 usable runs to compare strategies, has 4/);
  });

  test('3 or 4 runs, in auto: no estimate (history is the next candidate anyway)', () => {
    const c = build(steady(4, 600), { elapsedSec: 100, lines: [] });
    const e = autoEnsembleStrategy.estimate(fx.contextOf(c));
    assert.equal(e.progress, null);
    assert.equal(e.confidence, 'none');
    assert.match(e.reason, /needs 5 usable runs to compare strategies, has 4/);
  });
});

describe('ensemble: the pick', () => {
  test('an input-dependent job: log-learned beats history, and the reason shows both errors', () => {
    const strategy = createEnsembleStrategy(UNBOUNDED);
    const c = build(inputDependent(), { elapsedSec: 520, lines: milestoneLines(800, 9).slice(0, 2) });
    const e = strategy.estimate(fx.contextOf(c));
    assert.equal(e.strategyId, 'ensemble');
    assert.equal(e.detail.chosen, 'log-learned');
    assert.match(e.reason, /^ensemble: log-learned \(replay error \d+(\.\d+)? % of the run over \d+ runs; history \d+(\.\d+)? %\)/);
    const { members } = e.detail;
    assert.ok(members['log-learned'].maePct < members.history.maePct, JSON.stringify(members));
    assert.notEqual(e.progress, null);
  });

  test('in auto it is taken when it is better than history', () => {
    const strategy = createEnsembleStrategy({ ...UNBOUNDED, gate: true });
    const c = build(inputDependent(), { elapsedSec: 520, lines: milestoneLines(800, 9).slice(0, 2) });
    const e = strategy.estimate(fx.contextOf(c));
    assert.notEqual(e.progress, null);
    assert.equal(e.detail.chosen, 'log-learned');
  });

  test('a steady job without useful log lines: history wins; explicit still answers, auto steps aside', () => {
    const c = build(steady(8, 600), { elapsedSec: 200, lines: [] });
    const explicit = createEnsembleStrategy(UNBOUNDED).estimate(fx.contextOf(c));
    assert.equal(explicit.detail.chosen, 'history');
    assert.notEqual(explicit.progress, null);
    assert.match(explicit.reason, /^ensemble: history/);
    const gated = createEnsembleStrategy({ ...UNBOUNDED, gate: true }).estimate(fx.contextOf(c));
    assert.equal(gated.progress, null);
    assert.match(gated.reason, /history has the lowest replay error/);
  });

  test('a tie goes to the priority order: log-learned before history', () => {
    // Identical durations and identical stable lines: both are exact.
    const runs = Array.from({ length: 8 }, (_, i) => ({ agoMin: 120 * (i + 1), durationSec: 600, lines: milestoneLines(600, i) }));
    const c = build(runs, { elapsedSec: 400, lines: milestoneLines(600, 9).slice(0, 3) });
    const e = createEnsembleStrategy(UNBOUNDED).estimate(fx.contextOf(c));
    assert.equal(e.detail.chosen, 'log-learned');
  });

  test('when the pick has nothing to say now, the next best answers and the reason says who was skipped', () => {
    // The usual log format, but the current run logs something else entirely.
    const c = build(inputDependent(), { elapsedSec: 300, lines: [[50, 'phase=a'], [100, 'phase=b'], [150, 'phase=c']] });
    const e = createEnsembleStrategy(UNBOUNDED).estimate(fx.contextOf(c));
    assert.equal(e.detail.chosen, 'history');
    assert.match(e.reason, /log-learned skipped: log format changed/);
  });
});

describe('ensemble: cost', () => {
  test('the comparison is kept in the store: a second estimate changes nothing', () => {
    const strategy = createEnsembleStrategy(UNBOUNDED);
    const c = build(inputDependent(), { elapsedSec: 520, lines: milestoneLines(800, 9).slice(0, 2) });
    const store = fx.memoryStore();
    const first = strategy.estimate(fx.contextOf(c, { store }));
    const snapshot = JSON.stringify(store.read());
    assert.ok(Object.keys(store.read().scores).length > 0);
    const second = strategy.estimate(fx.contextOf(c, { store }));
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(store.read()), snapshot);
  });

  test('a small budget spreads the work over several estimates; meanwhile history answers and the reason says so', () => {
    const strategy = createEnsembleStrategy({ learnByteBudget: 1, evalByteBudget: 1 });
    const gated = createEnsembleStrategy({ learnByteBudget: 1, evalByteBudget: 1, gate: true });
    const c = build(inputDependent(), { elapsedSec: 520, lines: milestoneLines(800, 9).slice(0, 2) });
    const store = fx.memoryStore();
    const first = strategy.estimate(fx.contextOf(c, { store }));
    assert.equal(first.detail.chosen, 'history');
    assert.match(first.reason, /comparing strategies \(.+\); history meanwhile/);
    const gatedStore = fx.memoryStore();
    assert.equal(gated.estimate(fx.contextOf(c, { store: gatedStore })).progress, null);

    let e = first;
    let calls = 1;
    while (e.detail.chosen !== 'log-learned' && calls < 60) {
      e = strategy.estimate(fx.contextOf(c, { store }));
      calls++;
    }
    assert.equal(e.detail.chosen, 'log-learned', `still ${e.detail.chosen} after ${calls} estimates: ${e.reason}`);
  });

  test('learned data is dropped when a member strategy changes version', () => {
    const strategy = createEnsembleStrategy(UNBOUNDED);
    const c = build(inputDependent(), { elapsedSec: 520, lines: milestoneLines(800, 9).slice(0, 2) });
    const store = fx.memoryStore();
    strategy.estimate(fx.contextOf(c, { store }));
    const data = store.read();
    data.members = { ...data.members, 'log-learned': 999 };
    store.write(data);
    const e = strategy.estimate(fx.contextOf(c, { store }));
    assert.equal(e.detail.chosen, 'log-learned');
    assert.notEqual(store.read().members['log-learned'], 999);
  });
});

describe('ensemble: in auto, end to end', () => {
  test('estimateProgress picks the ensemble for an input-dependent job and names it', () => {
    const c = build(inputDependent(), { elapsedSec: 520, lines: milestoneLines(800, 9).slice(0, 2) });
    const lines = [];
    const out = estimateProgress({
      configDir: c.configDir, jobs: [c.job], history: { [c.job.id]: c.history }, now: () => new Date(c.now), log: l => lines.push(l),
    });
    const e = out[c.job.id];
    assert.equal(e.strategyId, 'ensemble');
    assert.match(e.reason, /^auto: ensemble \(ensemble: log-learned/);
    assert.deepEqual(lines, []);
  });

  test('estimateProgress falls to history for a steady job and says the ensemble stepped aside', () => {
    const c = build(steady(8, 600), { elapsedSec: 200, lines: [] });
    const out = estimateProgress({
      configDir: c.configDir, jobs: [c.job], history: { [c.job.id]: c.history }, now: () => new Date(c.now),
    });
    const e = out[c.job.id];
    assert.equal(e.strategyId, 'history');
    assert.match(e.reason, /^auto: history \(.+\); skipped declared: .+, ensemble: .*history has the lowest replay error/);
  });
});
