'use strict';

// `log-learned`: the strategy mines log "shapes" (digits, hex ids and paths masked) that appear in most usable
// runs at a stable relative time, then interpolates between the last one seen and the next expected one.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { logLearnedStrategy, createLogLearnedStrategy } = require('../../src/progress/log-learned-strategy');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const SEC = 1000;
const startOf = (c) => Date.parse(c.currentStartedAt);

/** The lines of a run of `durationSec`, each at its fraction; numbers and paths vary on purpose (they are masked). */
function pipelineLines(durationSec, salt = 0) {
  const at = (f) => Math.round(f * durationSec);
  return [
    [at(0.10), `Loading config from C:\\data\\run${salt}\\app.yml`],
    [at(0.30), `Fetched ${1000 + salt * 7} records from the source`],
    [at(0.60), `Transformed ${1000 + salt * 7} records in ${20 + salt} ms`],
    [at(0.90), `Uploading ${70 + salt} files to /srv/out/batch${salt}`],
  ];
}

function pastRuns(n, durationSec, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    agoMin: 60 * (i + 2), durationSec, lines: pipelineLines(durationSec, i), ...extra,
  }));
}

function run({ elapsedSec, lines, runs, options, strategy = logLearnedStrategy, store, jobExtra }) {
  const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec, lines }, runs, job: jobExtra });
  const checked = strategy.validateOptions(options);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const ctx = fx.contextOf(c, { options: checked.value, store });
  return { c, ctx, estimate: strategy.estimate(ctx) };
}

describe('log-learned: options', () => {
  test('takes no options, or minSupportPercent', () => {
    assert.equal(logLearnedStrategy.validateOptions(undefined).ok, true);
    assert.equal(logLearnedStrategy.validateOptions({ minSupportPercent: 80 }).ok, true);
  });

  const bad = [
    ['a string', 'x', /options must be an object/],
    ['an unknown key', { threshold: 1 }, /unknown option "threshold" \(accepted: minSupportPercent\)/],
    ['a support of 5', { minSupportPercent: 5 }, /"minSupportPercent" must be a whole number from 10 to 100/],
    ['a support of 101', { minSupportPercent: 101 }, /from 10 to 100/],
    ['a support as text', { minSupportPercent: '60' }, /from 10 to 100/],
  ];
  for (const [name, raw, pattern] of bad) {
    test(`refuses ${name} with the fix`, () => {
      const r = logLearnedStrategy.validateOptions(raw);
      assert.equal(r.ok, false);
      assert.match(r.error, pattern);
    });
  }
});

describe('log-learned: not enough to learn from', () => {
  test('no usable run: says there is no run log yet and what to do', () => {
    const { estimate } = run({ elapsedSec: 30, lines: [], runs: [] });
    assert.equal(estimate.strategyId, 'log-learned');
    assert.equal(estimate.progress, null);
    assert.equal(estimate.confidence, 'none');
    assert.match(estimate.reason, /no usable run log yet/);
    assert.match(estimate.reason, /--progress history/);
  });

  test('two usable runs: says how many are missing', () => {
    const { estimate } = run({ elapsedSec: 30, lines: [], runs: pastRuns(2, 600) });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /needs 3 usable runs with a log, has 2/);
  });

  test('failed, killed, orphaned and skipped runs are not learned from', () => {
    const bad = [
      { exitCode: 1 },
      { exitCode: null, extra: { orphaned: true } },
      { exitCode: null, extra: { cancelledByUser: true } },
      { exitCode: null, extra: { skipped: true } },
    ].map((b, i) => ({ agoMin: 600 + i * 60, durationSec: 100, lines: [[50, 'Something else entirely']], ...b }));
    const { estimate } = run({ elapsedSec: 30, lines: [], runs: [...pastRuns(2, 600), ...bad] });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /has 2/);
  });

  test('a usual duration under 10 s: the 1 s log resolution is named, with the fix', () => {
    const { estimate } = run({ elapsedSec: 3, lines: [], runs: pastRuns(5, 8) });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /1 s resolution/);
    assert.match(estimate.reason, /--progress history/);
  });

  test('no stable milestone in the logs: says so', () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({ agoMin: 60 * (i + 2), durationSec: 600, lines: [[100 + i, `Unique line number ${'abcde'[i]} here`]] }));
    const { estimate } = run({ elapsedSec: 30, lines: [], runs });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /no stable milestone/);
  });
});

describe('log-learned: interpolation', () => {
  test('after the third milestone: progress follows the pace to the next one, the end is the usual duration', () => {
    const { c, estimate } = run({ elapsedSec: 400, runs: pastRuns(5, 600), lines: pipelineLines(600, 9).slice(0, 3) });
    assert.equal(estimate.strategyId, 'log-learned');
    assert.notEqual(estimate.confidence, 'none');
    // The last milestone was seen at 60 % (360 s); 40 s later at a pace of 600 s per run.
    assert.ok(Math.abs(estimate.progress - (0.6 + 40 / 600)) < 0.02, `progress ${estimate.progress}`);
    assert.ok(Math.abs(Date.parse(estimate.etaAt) - (startOf(c) + 600 * SEC)) <= 15 * SEC, estimate.etaAt);
    assert.match(estimate.reason, /Transformed # records in # ms/);
    assert.match(estimate.reason, /learned from 5 usable runs/);
  });

  test('a slower run: the pace of the last two milestones rescales the end', () => {
    // Milestones seen at twice their usual time: 30 % at 360 s, 60 % at 720 s => the run takes 1200 s.
    const slow = [[360, 'Fetched 5 records from the source'], [720, 'Transformed 5 records in 9 ms']];
    const { c, estimate } = run({ elapsedSec: 800, runs: pastRuns(5, 600), lines: slow });
    assert.ok(Math.abs(Date.parse(estimate.etaAt) - (startOf(c) + 1200 * SEC)) <= 20 * SEC, estimate.etaAt);
    assert.match(estimate.reason, /pace x2\.0/);
  });

  test('progress waits below the next milestone while it has not appeared', () => {
    // 'Transformed' is expected at 60 % (360 s) and has not shown at 500 s.
    const { estimate } = run({ elapsedSec: 500, runs: pastRuns(5, 600), lines: pipelineLines(600, 9).slice(0, 2) });
    assert.ok(estimate.progress < 0.6, `progress ${estimate.progress}`);
    assert.ok(estimate.progress > 0.45, `progress ${estimate.progress}`);
    assert.ok(Date.parse(estimate.etaAt) >= fx.T0, 'the end is not in the past');
    assert.equal(estimate.detail.behind, true);
  });

  test('nothing seen yet: the usual duration paces it, at lower confidence', () => {
    const { c, estimate } = run({ elapsedSec: 30, runs: pastRuns(5, 600), lines: [] });
    assert.ok(Math.abs(estimate.progress - 0.05) < 0.02, `progress ${estimate.progress}`);
    assert.equal(estimate.etaAt, new Date(startOf(c) + 600 * SEC).toISOString());
    assert.notEqual(estimate.confidence, 'high');
  });

  test('past the last milestone and the usual duration: overdue, no end, never above 99 %', () => {
    const { estimate } = run({ elapsedSec: 1500, runs: pastRuns(5, 600), lines: pipelineLines(600, 9) });
    assert.equal(estimate.etaAt, null);
    assert.equal(estimate.detail.overdue, true);
    assert.ok(estimate.progress <= 0.99);
    assert.match(estimate.reason, /longer than usual/);
  });

  test('a log line stamped before the run started counts as time zero (clock skew)', () => {
    const early = [[-30, 'Fetched 5 records from the source']];
    const { estimate } = run({ elapsedSec: 40, runs: pastRuns(5, 600), lines: early });
    assert.ok(estimate.progress >= 0 && estimate.progress <= 1);
    assert.ok(Date.parse(estimate.etaAt) >= fx.T0);
  });
});

describe('log-learned: which shapes become milestones', () => {
  function runsWith(extraLine) {
    return pastRuns(6, 600).map((r, i) => ({ ...r, lines: [...r.lines, ...extraLine(i)] }));
  }

  test('a line at a random time in every run is not a milestone', () => {
    const wander = [0.12, 0.85, 0.3, 0.7, 0.5, 0.2];
    const { estimate } = run({ elapsedSec: 400, lines: pipelineLines(600, 9).slice(0, 3), runs: runsWith(i => [[Math.round(wander[i] * 600), 'Heartbeat from the worker']]) });
    assert.equal(estimate.detail.milestones, 4);
  });

  test('a line present in 2 of 6 runs is not a milestone at the default support, and is with 30 %', () => {
    const rare = (i) => (i < 2 ? [[300, 'Rare optional step']] : []);
    const a = run({ elapsedSec: 400, lines: pipelineLines(600, 9).slice(0, 3), runs: runsWith(rare) });
    assert.equal(a.estimate.detail.milestones, 4);
    const b = run({ elapsedSec: 400, lines: pipelineLines(600, 9).slice(0, 3), runs: runsWith(rare), options: { minSupportPercent: 30 } });
    assert.equal(b.estimate.detail.milestones, 5);
  });

  test('numbers, hex ids and paths do not make a line a different shape', () => {
    const lines = (i) => [[Math.round(0.45 * 600), `Commit deadbeef${i}00 pushed to /home/u${i}/repo${i}`]];
    const { estimate } = run({ elapsedSec: 400, lines: pipelineLines(600, 9).slice(0, 3), runs: runsWith(lines) });
    assert.equal(estimate.detail.milestones, 5);
  });

  test('the job marker lines are not milestones', () => {
    const { estimate } = run({ elapsedSec: 400, lines: pipelineLines(600, 9).slice(0, 3), runs: pastRuns(5, 600) });
    assert.equal(estimate.detail.milestones, 4);
  });
});

describe('log-learned: learned data', () => {
  test('is written to the store once per run and a second estimate is identical', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 400, lines: pipelineLines(600, 9).slice(0, 3) }, runs: pastRuns(5, 600) });
    const store = fx.memoryStore();
    const first = logLearnedStrategy.estimate(fx.contextOf(c, { store }));
    const data = JSON.parse(JSON.stringify(store.read()));
    assert.equal(Object.keys(data.runs).length, 5);
    assert.equal(store.meta().learnedFromRuns.length, 5);
    assert.ok(store.meta().logFingerprint.length > 0);
    const second = logLearnedStrategy.estimate(fx.contextOf(c, { store }));
    assert.deepEqual(second, first);
    assert.deepEqual(JSON.parse(JSON.stringify(store.read())), data);
  });

  test('a byte budget spreads the learning over several estimates and the reason says so', () => {
    const strategy = createLogLearnedStrategy({ learnByteBudget: 1 });
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 400, lines: pipelineLines(600, 9).slice(0, 3) }, runs: pastRuns(5, 600) });
    const store = fx.memoryStore();
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const e = strategy.estimate(fx.contextOf(c, { store }));
      seen.push(e);
    }
    assert.equal(seen[0].progress, null);
    assert.match(seen[0].reason, /learning: 1 of 5 past runs read/);
    assert.equal(Object.keys(store.read().runs).length, 5);
    assert.notEqual(seen[5].progress, null);
  });

  test('a run known only from its log (not in the history any more) is learned from', () => {
    const runs = pastRuns(5, 600).map((r, i) => (i >= 2 ? { ...r, inHistory: false } : r));
    const { estimate } = run({ elapsedSec: 400, lines: pipelineLines(600, 9).slice(0, 3), runs });
    assert.equal(estimate.detail.usableRuns, 5);
  });

  // Two lines of the new format: one line alone is not judged (see log-learned-format.test.js).
  test('a changed log format: the old runs are ignored and the reason counts the runs still needed', () => {
    const newFormat = (durationSec, i) => [
      [Math.round(0.2 * durationSec), `phase=extract rows=${i}`],
      [Math.round(0.5 * durationSec), `phase=load rows=${i}`],
      [Math.round(0.8 * durationSec), `phase=index rows=${i}`],
    ];
    const newer = [0, 1].map(i => ({ agoMin: 60 * (i + 2), durationSec: 600, lines: newFormat(600, i) }));
    const older = pastRuns(5, 600).map((r, i) => ({ ...r, agoMin: 60 * (i + 4) }));
    const { estimate } = run({ elapsedSec: 100, lines: newFormat(600, 9).slice(0, 2), runs: [...newer, ...older] });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /log format changed, relearning \(needs 1 more run/);
  });

  test('after the format change enough new runs make an estimate again', () => {
    const newFormat = (durationSec, i) => [
      [Math.round(0.2 * durationSec), `phase=extract rows=${i}`],
      [Math.round(0.5 * durationSec), `phase=load rows=${i}`],
      [Math.round(0.8 * durationSec), `phase=index rows=${i}`],
    ];
    const newer = [0, 1, 2].map(i => ({ agoMin: 60 * (i + 2), durationSec: 600, lines: newFormat(600, i) }));
    const older = pastRuns(5, 600).map((r, i) => ({ ...r, agoMin: 60 * (i + 6) }));
    const { estimate } = run({ elapsedSec: 400, lines: newFormat(600, 9).slice(0, 2), runs: [...newer, ...older] });
    assert.notEqual(estimate.progress, null);
    assert.equal(estimate.detail.usableRuns, 3);
  });

  test('an empty past log learns nothing and does not throw', () => {
    const runs = pastRuns(5, 600).map(r => ({ ...r, lines: [] }));
    const { estimate } = run({ elapsedSec: 400, lines: [], runs });
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /no stable milestone/);
  });
});
