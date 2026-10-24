'use strict';

// The plan's edge matrix (section 7) for every strategy, and the shape tests on typical durations (q9).
// A strategy added to the registry without an entry in OPTIONS fails the first test: say how it is configured.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { STRATEGIES } = require('../../src/progress/registry');
const { replayJob } = require('../../src/progress/replay');
const { createLogCorpus } = require('../../src/progress/log-corpus');
const fx = require('./helpers/fixture-builder');
const { pipelineLines, countedLines, runsOf, MINUTES_STABLE } = require('./helpers/make-fixtures');

after(fx.cleanupTemp);

const byId = Object.fromEntries(STRATEGIES.map(s => [s.id, s]));

/** The options each strategy needs to run at all. */
const OPTIONS = {
  history: undefined,
  declared: undefined,
  'log-learned': undefined,
  ensemble: undefined,
  ratio: { pattern: '(\\d+)/(\\d+)' },
  'log-declared': { milestones: [{ pattern: '^Parsed', at: 0.35 }, { pattern: '^Computed', at: 0.65 }] },
};

const SEC = 1000;

function estimateOf(id, spec) {
  const c = fx.buildCase(fx.tempDir(), spec);
  const strategy = byId[id];
  const checked = strategy.validateOptions(OPTIONS[id]);
  assert.equal(checked.ok, true, `${id}: ${JSON.stringify(checked)}`);
  const e = strategy.estimate(fx.contextOf(c, { options: checked.value }));
  return { c, e };
}

function assertContract(id, e, c) {
  assert.equal(e.strategyId, id);
  if (e.progress === null) {
    assert.ok(typeof e.reason === 'string' && e.reason.trim().length > 0, `${id}: a null progress carries a reason`);
    assert.equal(e.etaAt, null);
  } else {
    assert.ok(e.progress >= 0 && e.progress <= 1, `${id}: progress ${e.progress}`);
    assert.ok(e.etaAt === null || Date.parse(e.etaAt) >= c.now, `${id}: etaAt ${e.etaAt} is in the past`);
    assert.ok(e.etaAt !== null || e.detail?.overdue === true || e.detail?.etaUnknown === true, `${id}: no etaAt without overdue or etaUnknown`);
  }
  assert.ok(e.confidenceScore >= 0 && e.confidenceScore <= 1);
}

const CURRENT = { elapsedSec: 280, lines: [...countedLines(600, 9).filter(([s]) => s <= 280)] };

function steady(n, durationSec = 600, extra = {}) {
  return runsOf(Array(n).fill(durationSec), { lines: countedLines }).map(r => ({ ...r, ...extra }));
}

/** Cases of the matrix: name -> spec. */
const CASES = {
  'no run': { runs: [], current: CURRENT },
  'one run': { runs: steady(1), current: CURRENT },
  'two runs': { runs: steady(2), current: CURRENT },
  'exactly three runs (the minimum)': { runs: steady(3), current: CURRENT },
  'identical durations': { runs: steady(8), current: CURRENT },
  'one huge outlier': { runs: runsOf([600, 36_000, 600, 600, 600, 600, 600, 600], { lines: countedLines }), current: CURRENT },
  'failed, killed, orphaned and skipped runs mixed in': {
    runs: [
      ...steady(3),
      { agoMin: 1000, durationSec: 20, exitCode: 1, lines: [[10, 'Error: boom']] },
      { agoMin: 1100, durationSec: 100, exitCode: null, extra: { cancelledByUser: true }, lines: [[50, 'Reading input batch1']] },
      { agoMin: 1200, durationSec: 100, exitCode: null, extra: { orphaned: true }, lines: [] },
      { agoMin: 1300, durationSec: 0, exitCode: null, extra: { skipped: true }, lines: [], markers: false },
    ],
    current: CURRENT,
  },
  'a log format change': {
    runs: [
      ...[0, 1].map(i => ({ agoMin: 120 * (i + 1), durationSec: 600, lines: [[120, `phase=extract n=${i}`], [300, `phase=load n=${i}`], [480, `phase=index n=${i}`]] })),
      ...steady(5).map((r, i) => ({ ...r, agoMin: 120 * (i + 3) })),
    ],
    current: { elapsedSec: 150, lines: [[120, 'phase=extract n=9']] },
  },
  'empty logs': { runs: steady(6).map(r => ({ ...r, lines: [] })), current: { elapsedSec: 200, lines: [] } },
  'clock skew (log lines stamped before the run)': {
    runs: steady(6).map(r => ({ ...r, lines: r.lines.map(([s, t]) => [s - 40, t]) })),
    current: { elapsedSec: 280, lines: CURRENT.lines.map(([s, t]) => [s - 40, t]) },
  },
  'two runs in the same second': {
    runs: [
      ...steady(5),
      { agoMs: 1_000 * 60 * 600 + 100, durationSec: 600, lines: pipelineLines(600, 7) },
      { agoMs: 1_000 * 60 * 600 + 600, durationSec: 600, lines: pipelineLines(600, 8) },
    ],
    current: CURRENT,
  },
  'a legacy daily log file in the directory': { runs: steady(6), current: CURRENT, legacyDaily: true },
};

describe('edge matrix: setup', () => {
  test('every registered strategy has options in this test', () => {
    for (const s of STRATEGIES) {
      assert.ok(Object.prototype.hasOwnProperty.call(OPTIONS, s.id), `add the options that make "${s.id}" run to OPTIONS in edge-matrix.test.js`);
    }
  });
});

for (const [caseName, spec] of Object.entries(CASES)) {
  describe(`edge matrix: ${caseName}`, () => {
    for (const s of STRATEGIES) {
      test(`${s.id} keeps the contract`, () => {
        const { c, e } = estimateOf(s.id, spec);
        assertContract(s.id, e, c);
      });
    }
  });
}

describe('edge matrix: what is said', () => {
  const needing = ['history', 'log-learned', 'ensemble'];

  test('0, 1 and 2 runs: no estimate, and the reason counts the runs', () => {
    for (const [name, has] of [['no run', 0], ['one run', 1], ['two runs', 2]]) {
      for (const id of needing) {
        const { e } = estimateOf(id, CASES[name]);
        assert.equal(e.progress, null, `${id} with ${has} runs`);
        assert.match(e.reason, has === 0 && id === 'log-learned' ? /no usable run log yet/ : new RegExp(`has ${has}`), `${id}: ${e.reason}`);
      }
    }
  });

  test('exactly the minimum of runs: history and log-learned and ensemble answer', () => {
    for (const id of needing) {
      const { e } = estimateOf(id, CASES['exactly three runs (the minimum)']);
      assert.notEqual(e.progress, null, `${id}: ${e.reason}`);
    }
  });

  test('identical durations: the end is exactly the usual duration', () => {
    const { c, e } = estimateOf('history', CASES['identical durations']);
    assert.equal(Date.parse(e.etaAt), Date.parse(c.currentStartedAt) + 600 * SEC);
    assert.equal(e.confidence, 'high');
  });

  test('one huge outlier does not move the estimate (history: median; log-learned: relative times)', () => {
    for (const id of ['history', 'log-learned']) {
      const { c, e } = estimateOf(id, CASES['one huge outlier']);
      assert.ok(Math.abs(Date.parse(e.etaAt) - (Date.parse(c.currentStartedAt) + 600 * SEC)) <= 30 * SEC, `${id}: ${e.etaAt}`);
    }
  });

  test('failed, killed, orphaned and skipped runs do not count', () => {
    const { e } = estimateOf('history', {
      ...CASES['failed, killed, orphaned and skipped runs mixed in'],
      runs: [...CASES['failed, killed, orphaned and skipped runs mixed in'].runs.slice(0, 2), ...CASES['failed, killed, orphaned and skipped runs mixed in'].runs.slice(3)],
    });
    assert.equal(e.progress, null);
    assert.match(e.reason, /has 2/);
    const three = estimateOf('log-learned', CASES['failed, killed, orphaned and skipped runs mixed in']);
    assert.equal(three.e.detail.usableRuns, 3);
  });

  test('a log format change: log-learned says it relearns and how many runs it needs', () => {
    const { e } = estimateOf('log-learned', CASES['a log format change']);
    assert.equal(e.progress, null);
    assert.match(e.reason, /log format changed, relearning \(needs 1 more run/);
  });

  test('empty logs: history still answers, log-learned says there is no stable milestone', () => {
    assert.notEqual(estimateOf('history', CASES['empty logs']).e.progress, null);
    const { e } = estimateOf('log-learned', CASES['empty logs']);
    assert.equal(e.progress, null);
    assert.match(e.reason, /no stable milestone/);
  });

  test('a legacy daily log file changes nothing', () => {
    for (const id of ['history', 'log-learned', 'ensemble']) {
      const withDaily = estimateOf(id, CASES['a legacy daily log file in the directory']).e;
      const without = estimateOf(id, { ...CASES['a legacy daily log file in the directory'], legacyDaily: false }).e;
      assert.deepEqual(withDaily, without, id);
    }
  });

  test('two runs in the same second: both are kept as history, nothing throws', () => {
    const { e } = estimateOf('history', CASES['two runs in the same second']);
    assert.notEqual(e.progress, null);
  });
});

describe('shapes of typical jobs', () => {
  const fixtures = path.join(__dirname, 'fixtures');
  const replayOf = (name, strategies, extra = {}) => {
    const { job, history } = fx.loadFixture(path.join(fixtures, name));
    const dir = path.join(fixtures, name);
    return replayJob({
      job, configDir: dir, strategies,
      corpus: createLogCorpus({ configDir: dir, jobId: job.id, history, currentStartedAt: '9999-12-31T00:00:00.000Z' }),
      ...extra,
    });
  };

  test('short job (under 10 s): history answers; log-learned says the 1 s resolution is too coarse', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf([8, 7, 9, 8, 8, 7], { spacingMin: 5 }), current: { elapsedSec: 4, lines: [] } });
    const history = byId.history.estimate(fx.contextOf(c));
    assert.notEqual(history.progress, null);
    const learned = byId['log-learned'].estimate(fx.contextOf(c));
    assert.equal(learned.progress, null);
    assert.match(learned.reason, /1 s resolution/);
    const ensemble = byId.ensemble.estimate(fx.contextOf(c));
    assert.equal(ensemble.detail.chosen, 'history');
  });

  test('minutes-long job: both answer and agree on the end within 20 s', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: runsOf(MINUTES_STABLE, { lines: countedLines }), current: CURRENT });
    const start = Date.parse(c.currentStartedAt);
    for (const id of ['history', 'log-learned']) {
      const e = byId[id].estimate(fx.contextOf(c));
      assert.ok(Math.abs(Date.parse(e.etaAt) - (start + 602 * SEC)) <= 20 * SEC, `${id}: ${e.etaAt}`);
    }
  });

  test('hours-long job: the estimate scales (halfway at half the usual duration)', () => {
    const c = fx.buildCase(fx.tempDir(), {
      runs: runsOf([10800, 10900, 10700, 10850, 10750], { spacingMin: 400, lines: pipelineLines }),
      current: { elapsedSec: 5400, lines: pipelineLines(10800, 9).filter(([s]) => s <= 5400) },
    });
    const h = byId.history.estimate(fx.contextOf(c));
    assert.ok(Math.abs(h.progress - 0.5) < 0.02, `history ${h.progress}`);
    const l = byId['log-learned'].estimate(fx.contextOf(c));
    assert.ok(l.progress > 0.35 && l.progress < 0.65, `log-learned ${l.progress}`);
    assert.match(h.reason, /3 h/);
  });

  test('input-dependent job: log-learned is far closer to the real end than history, and the ensemble picks it', () => {
    const r = replayOf('input-dependent', [byId.history, byId['log-learned']], { sampleEveryPercent: 25, stores: { 'log-learned': fx.memoryStore() } });
    const h = r.strategies.history.metrics;
    const l = r.strategies['log-learned'].metrics;
    assert.ok(l.maePct < h.maePct / 3, `log-learned ${l.maePct} vs history ${h.maePct}`);
    assert.deepEqual(r.strategies['log-learned'].errors, []);
  });

  test('stable minutes job: history is exact enough that nothing beats it by much', () => {
    const r = replayOf('minutes-stable', [byId.history, byId['log-learned']], { sampleEveryPercent: 25, stores: { 'log-learned': fx.memoryStore() } });
    assert.ok(r.strategies.history.metrics.maePct < 0.02, `history ${r.strategies.history.metrics.maePct}`);
  });
});
