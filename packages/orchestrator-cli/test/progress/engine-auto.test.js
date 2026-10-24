'use strict';

// The engine over real log files and the learned-data file: the auto order, what is explicit-only, the choice
// kept for a run, and the store being invalidated or broken without taking get-progress down.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { estimateProgress } = require('../../src/progress/engine');
const { AUTO_STRATEGIES, STRATEGIES } = require('../../src/progress/registry');
const { progressFilePath } = require('../../src/progress/store');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const now = () => new Date(fx.T0);
const THREE = [1, 2, 3].map(i => ({ agoMin: 60 * i, durationSec: 600 }));

function estimate(c, over = {}) {
  const logs = [];
  const job = { ...c.job, ...over.jobExtra };
  const result = estimateProgress({
    configDir: c.configDir, jobs: [job], history: { [job.id]: c.history }, now, log: l => logs.push(l), ...over.input,
  });
  return { e: result[job.id], logs };
}

describe('auto', () => {
  test('tries declared, ensemble and history: ratio and log-declared need a pattern the user wrote', () => {
    assert.deepEqual(AUTO_STRATEGIES.map(s => s.id), ['declared', 'ensemble', 'history']);
    assert.deepEqual(STRATEGIES.map(s => s.id), ['declared', 'ratio', 'log-declared', 'log-learned', 'ensemble', 'history']);
  });

  test('a job that prints the convention is estimated by declared', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: THREE, current: { elapsedSec: 60, lines: [[50, '##orch-progress 40 copying']] } });
    const { e } = estimate(c);
    assert.equal(e.strategyId, 'declared');
    assert.match(e.reason, /^auto: declared \(job reports 40 %/);
    assert.ok(!/skipped/.test(e.reason));
  });

  test('without the convention, history answers and the skip reason says why declared did not', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: THREE, current: { elapsedSec: 300, lines: [[5, 'working']] } });
    const { e } = estimate(c);
    assert.equal(e.strategyId, 'history');
    assert.match(e.reason, /^auto: history \(/);
    assert.match(e.reason, /skipped declared: no "##orch-progress <0-100>" line in the log of this run yet/);
  });

  test('with nothing to go on, the reason lists every skip and what to do', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: [], current: { elapsedSec: 30, lines: [] } });
    const { e } = estimate(c);
    assert.equal(e.progress, null);
    assert.match(e.reason, /declared: no "##orch-progress/);
    assert.match(e.reason, /history: needs 3 usable runs, has 0/);
  });
});

describe('the choice kept for a run', () => {
  test('is written to the progress file once and read back', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: THREE, current: { elapsedSec: 300 } });
    const first = estimate(c).e;
    const file = JSON.parse(fs.readFileSync(progressFilePath(c.configDir, 'j'), 'utf8'));
    assert.equal(file.chosen.strategyId, 'history');
    assert.equal(file.chosen.runStartedAt, c.currentStartedAt);
    const second = estimate(c).e;
    assert.equal(second.detail.chosenAt, first.detail.chosenAt);
    assert.equal(first.detail.chosenAt, new Date(fx.T0).toISOString());
  });

  test('a higher-priority strategy that becomes available takes over, and the reason says the run had another one', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: THREE, current: { elapsedSec: 300 } });
    assert.equal(estimate(c).e.strategyId, 'history');
    fs.appendFileSync(path.join(c.logDir, fs.readdirSync(c.logDir).find(n => n.includes(c.currentStartedAt.slice(0, 19).replace(/:/g, '-')))),
      `[${fx.stamp(fx.T0 - 5000)}] ##orch-progress 50 half\n`);
    const e = estimate(c).e;
    assert.equal(e.strategyId, 'declared');
    assert.match(e.reason, /this run was estimated by history earlier/);
    assert.equal(e.detail.previouslyChosen, 'history');
  });

  test('when the strategy chosen earlier stops answering, the fallback is named, not silent', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: THREE, current: { elapsedSec: 300 } });
    let aAnswers = true;
    const mk = (id, answers) => ({
      id, version: 1, validateOptions: () => ({ ok: true, value: undefined }),
      estimate: (ctx) => (answers()
        ? { strategyId: id, progress: 0.5, etaAt: null, confidence: 'low', confidenceScore: 0.3, reason: `${id} ok`, serverNow: ctx.now().toISOString(), detail: { overdue: true } }
        : { strategyId: id, progress: null, etaAt: null, confidence: 'none', confidenceScore: 0, reason: `${id} lost its data`, serverNow: ctx.now().toISOString() }),
    });
    const strategies = () => [mk('a', () => aAnswers), mk('b', () => true)];
    assert.equal(estimate(c, { input: { strategies } }).e.strategyId, 'a');
    aAnswers = false;
    const e = estimate(c, { input: { strategies } }).e;
    assert.equal(e.strategyId, 'b');
    assert.match(e.reason, /skipped a: a lost its data/);
    assert.match(e.reason, /this run was estimated by a earlier/);
  });
});

describe('explicit strategies through the engine', () => {
  test('ratio reads its counter from the log and never falls back to history', () => {
    const jobExtra = { progress: { strategy: 'ratio', options: { pattern: '(\\d+)/(\\d+)' } } };
    const withCounter = fx.buildCase(fx.tempDir(), { runs: THREE, job: jobExtra, current: { elapsedSec: 35, lines: [[10, 'f 1/10'], [20, 'f 2/10'], [30, 'f 3/10']] } });
    const ok = estimate(withCounter).e;
    assert.equal(ok.strategyId, 'ratio');
    assert.equal(ok.progress, 0.3);
    assert.ok(!ok.reason.startsWith('auto'));

    const without = fx.buildCase(fx.tempDir(), { runs: THREE, job: jobExtra, current: { elapsedSec: 300, lines: [[5, 'nothing']] } });
    const none = estimate(without).e;
    assert.equal(none.strategyId, 'ratio');
    assert.equal(none.progress, null);
    assert.match(none.reason, /no log line matched/);
  });

  test('log-declared learns from the past logs and keeps what it learned in the progress file', () => {
    const lines = [[20, 'Step A'], [50, 'Step B'], [80, 'Step C']];
    const jobExtra = { progress: { strategy: 'log-declared', options: { milestones: [{ pattern: 'Step A' }, { pattern: 'Step B' }, { pattern: 'Step C' }] } } };
    const c = fx.buildCase(fx.tempDir(), {
      job: jobExtra, current: { elapsedSec: 55, lines: [[20, 'Step A'], [50, 'Step B']] },
      runs: [1, 2, 3, 4].map(i => ({ agoMin: 60 * i, durationSec: 100, lines })),
    });
    const e = estimate(c).e;
    assert.equal(e.strategyId, 'log-declared');
    assert.equal(e.etaAt, new Date(Date.parse(c.currentStartedAt) + 100_000).toISOString());
    const file = JSON.parse(fs.readFileSync(progressFilePath(c.configDir, 'j'), 'utf8'));
    assert.equal(file.strategies['log-declared'].strategyVersion, 1);
    assert.equal(file.strategies['log-declared'].learnedFromRuns.length, 4);
  });

  test('editing the job drops what was learned, with a log line', () => {
    const options = { milestones: [{ pattern: 'Step A' }, { pattern: 'Step B' }] };
    const lines = [[20, 'Step A'], [50, 'Step B']];
    const c = fx.buildCase(fx.tempDir(), {
      job: { progress: { strategy: 'log-declared', options } }, current: { elapsedSec: 55, lines },
      runs: [1, 2, 3, 4].map(i => ({ agoMin: 60 * i, durationSec: 100, lines })),
    });
    estimate(c);
    const { logs } = estimate(c, { jobExtra: { command: 'a different command' } });
    assert.ok(logs.includes('[progress] job j: dropped learned data: the command, cwd or progress setting of the job changed'), logs.join('\n'));
  });
});

describe('robustness', () => {
  test('a corrupt progress file is replaced and reported; the estimate still answers', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: THREE, current: { elapsedSec: 300 } });
    fs.mkdirSync(path.join(c.configDir, 'progress'), { recursive: true });
    fs.writeFileSync(progressFilePath(c.configDir, 'j'), 'garbage{');
    const { e, logs } = estimate(c);
    assert.equal(e.strategyId, 'history');
    assert.ok(logs.some(l => /learned data file unreadable/.test(l)), logs.join('\n'));
  });

  test('a job with no log directory at all is estimated from its history', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: THREE.map(r => ({ ...r, log: false })), current: { elapsedSec: 300 } });
    fs.rmSync(c.logDir, { recursive: true, force: true });
    assert.equal(estimate(c).e.strategyId, 'history');
  });

  test('estimateProgress without a configDir fails loudly', () => {
    assert.throws(() => estimateProgress({ jobs: [], history: {}, now }), /needs configDir/);
  });
});
