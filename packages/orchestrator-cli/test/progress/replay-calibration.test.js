'use strict';

// Calibration: does the real end of a run fall inside the interval the estimate states? An estimate states an end
// time (etaAt) and a confidence score s; the interval is etaAt +- (1 - s) x the predicted duration (history's score
// is 1 - MAD/median, so for it that is +- the MAD). The share of samples whose real end is inside is the strategy's
// calibration. Samples without an etaAt (overdue) state no interval and are not counted.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { replayJob } = require('../../src/progress/replay');
const { createLogCorpus } = require('../../src/progress/log-corpus');
const { buildReplayReport, formatReplayReport } = require('../../src/progress/replay-report');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

function corpusOf(c) {
  return createLogCorpus({ configDir: c.configDir, jobId: c.job.id, history: c.history, currentStartedAt: FAR_FUTURE });
}

const runsOf = (n, durationSec = 600, extra = {}) => Array.from({ length: n }, (_, i) => ({ agoMin: 60 * (i + 1), durationSec, ...extra }));

/** A strategy that knows the real end (from the fixture) and misses it by `missMs(runIndex)`, stating `score`. */
function missing(c, { score, missMs, withEta = true }) {
  const endOf = (startedAt) => Date.parse(c.history.find(e => e.startedAt === startedAt).finishedAt);
  const order = c.history.map(e => e.startedAt);
  return {
    id: 'miss', version: 1,
    validateOptions: (raw) => ({ ok: true, value: raw }),
    estimate: (ctx) => ({
      strategyId: 'miss', progress: 0.5, confidence: 'high', confidenceScore: score, reason: 'r', serverNow: ctx.now().toISOString(),
      etaAt: withEta ? new Date(endOf(ctx.run.startedAt) + missMs(order.indexOf(ctx.run.startedAt))).toISOString() : null,
    }),
  };
}

function replay(c, strategy) {
  return replayJob({ job: c.job, configDir: c.configDir, corpus: corpusOf(c), strategies: [strategy], sampleEveryPercent: 25 });
}

describe('calibration of the stated interval', () => {
  test('a miss inside (1 - score) x duration counts, one outside does not: half the runs inside gives 0.5', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf(4) });
    // score 0.9 on a 600 s run: the interval is +-60 s.
    const r = replay(c, missing(c, { score: 0.9, missMs: (i) => (i % 2 === 0 ? 30_000 : 120_000) }));

    const m = r.strategies.miss.metrics;
    assert.equal(m.calibrated, 12, '4 runs x 3 samples');
    assert.equal(m.calibration, 0.5);
    const samples = r.strategies.miss.samples;
    const widthOk = (s) => Math.abs(s.intervalMs - 0.1 * (Date.parse(s.etaAt) - Date.parse(s.runStartedAt))) < 1;
    assert.equal(samples.every(widthOk), true, 'the interval is (1 - 0.9) x the predicted duration');
    assert.equal(samples.filter(s => s.inside).length, 6);
  });

  test('the boundary is inside, and a score of 1 states an interval of zero', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf(3) });
    const exact = replay(c, missing(c, { score: 1, missMs: () => 0 })).strategies.miss.metrics;
    assert.equal(exact.calibration, 1);
    const off = replay(c, missing(c, { score: 1, missMs: () => 1000 })).strategies.miss.metrics;
    assert.equal(off.calibration, 0);
  });

  test('a sample with no etaAt (overdue) states no interval: it is not counted, and no calibration is reported', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf(3) });
    const m = replay(c, missing(c, { score: 0.9, missMs: () => 0, withEta: false })).strategies.miss.metrics;
    assert.equal(m.calibrated, 0);
    assert.equal(m.calibration, null);
  });

  test('the history strategy on steady runs is a number between 0 and 1', () => {
    const { historyStrategy } = require('../../src/progress/history-strategy');
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf(8) });
    const m = replay(c, historyStrategy).strategies.history.metrics;
    assert.ok(m.calibrated > 0);
    assert.ok(m.calibration >= 0 && m.calibration <= 1);
  });
});

describe('the report: calibration column and the default strategy set', () => {
  const report = (c, extra = {}) => buildReplayReport({ job: c.job, history: c.history, configDir: c.configDir, ...extra });

  test('the table has a calibration column and the JSON carries the metric per strategy', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf(6) });
    const r = report(c);
    const history = r.strategies.find(s => s.id === 'history');
    assert.equal(typeof history.metrics.calibration, 'number');
    assert.equal(typeof history.metrics.calibrated, 'number');
    assert.match(formatReplayReport(r), /calib/);
  });

  test('the default set lists ratio and log-declared as not configured when the job lacks their options, with the way out', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf(6) });
    const r = report(c);
    assert.deepEqual(r.strategies.map(s => s.id), ['declared', 'ratio', 'log-declared', 'log-learned', 'ensemble', 'history']);

    for (const id of ['ratio', 'log-declared']) {
      const s = r.strategies.find(x => x.id === id);
      assert.equal(s.notConfigured, true, id);
      assert.match(s.unavailable, new RegExp(`orch edit j --progress ${id} --progress-options`), id);
    }
    const text = formatReplayReport(r);
    assert.match(text, /^ratio\s+not configured/m);
    assert.match(text, /^log-declared\s+not configured/m);
    assert.match(text, /ratio: not configured, needs options/);
  });

  test('a strategy the job configures is replayed, not listed as missing', () => {
    const job = { progress: { strategy: 'ratio', options: { pattern: '(\\d+)/(\\d+)' } } };
    const lines = Array.from({ length: 9 }, (_, k) => [30 + k * 60, `done ${k + 1}/10`]);
    const c = fx.buildCase(fx.tempDir(), { job, runs: runsOf(6, 600, { lines }) });
    const ratio = report(c).strategies.find(s => s.id === 'ratio');
    assert.equal(ratio.notConfigured, undefined);
    assert.ok(ratio.metrics.estimated > 0);
  });

  test('ensemble is replayed when the job has enough runs to compare strategies, and says why not otherwise', () => {
    const few = fx.buildCase(fx.tempDir(), { runs: runsOf(4) });
    const small = report(few).strategies.find(s => s.id === 'ensemble');
    assert.match(small.unavailable, /ensemble compares strategies on the job's past runs: needs 5 usable runs, has 4/);
    assert.equal(small.notConfigured, undefined, 'not a configuration problem: more runs fix it');

    const enough = fx.buildCase(fx.tempDir(), { runs: runsOf(8) });
    const full = report(enough).strategies.find(s => s.id === 'ensemble');
    assert.equal(full.unavailable, undefined);
    assert.ok(full.metrics.estimated > 0);
  });

  test('--strategy ratio on a job without options still explains instead of omitting', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf(6) });
    const r = report(c, { strategyId: 'ratio' });
    assert.equal(r.strategies[0].notConfigured, true);
  });
});
