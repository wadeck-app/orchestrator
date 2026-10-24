'use strict';

// `declared`: the job says how far it is, with "##orch-progress <0..100>[ <message>]" log lines or a JSON file.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { declaredStrategy } = require('../../src/progress/declared-strategy');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const SEC = 1000;
const startOf = (c) => Date.parse(c.currentStartedAt);

function run({ elapsedSec, lines, runs, options, jobExtra, raw }) {
  const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec, lines, raw }, runs, job: jobExtra });
  const ctx = fx.contextOf(c, { options });
  return { c, ctx, estimate: declaredStrategy.estimate(ctx) };
}

const THREE_RUNS = [1, 2, 3].map(i => ({ agoMin: 60 * i, durationSec: 600 }));

describe('declared: reports in the log', () => {
  test('no report yet: no estimate, and the reason shows what the job must print', () => {
    const { estimate } = run({ elapsedSec: 30, lines: [[5, 'starting']] });
    assert.equal(estimate.strategyId, 'declared');
    assert.equal(estimate.progress, null);
    assert.equal(estimate.confidence, 'none');
    assert.match(estimate.reason, /no "##orch-progress <0-100>" line in the log of this run yet/);
    assert.match(estimate.reason, /##orch-progress 25 reading input/);
  });

  test('one report: progress is the value, the end is extrapolated from the start', () => {
    const { c, estimate } = run({ elapsedSec: 70, lines: [[60, '##orch-progress 40 copying files']] });
    assert.equal(estimate.progress, 0.4);
    assert.equal(estimate.etaAt, new Date(startOf(c) + 150 * SEC).toISOString());
    assert.equal(estimate.detail.method, 'since-start');
    assert.equal(estimate.detail.message, 'copying files');
    assert.notEqual(estimate.confidence, 'none');
    assert.match(estimate.reason, /40 ?%/);
    assert.match(estimate.reason, /copying files/);
  });

  test('several steady reports: the end follows their rate', () => {
    const { c, estimate } = run({
      elapsedSec: 35,
      lines: [[10, '##orch-progress 10'], [20, '##orch-progress 20'], [30, '##orch-progress 30']],
    });
    assert.equal(estimate.progress, 0.3);
    assert.equal(estimate.detail.method, 'rate');
    assert.equal(estimate.etaAt, new Date(startOf(c) + 100 * SEC).toISOString());
    assert.ok(['high', 'medium'].includes(estimate.confidence), estimate.confidence);
  });

  test('the prefix of a stderr line and a decimal value are accepted', () => {
    const { estimate } = run({ elapsedSec: 20, lines: [[10, '[stderr] ##orch-progress 12.5 warming up']] });
    assert.equal(estimate.progress, 0.125);
  });

  test('a value below the last one is ignored and counted; a reset marker starts over', () => {
    const dropped = run({ elapsedSec: 40, lines: [[10, '##orch-progress 50'], [20, '##orch-progress 20']] }).estimate;
    assert.equal(dropped.progress, 0.5);
    assert.equal(dropped.detail.ignoredDrops, 1);
    assert.match(dropped.reason, /1 report\(s\) below the last value ignored/);

    const reset = run({ elapsedSec: 40, lines: [[10, '##orch-progress 50'], [20, '##orch-progress reset'], [30, '##orch-progress 10']] }).estimate;
    assert.equal(reset.progress, 0.1);
    assert.equal(reset.detail.resets, 1);
    assert.match(reset.reason, /restarted 1 time/);
  });

  test('malformed reports are counted, never silently dropped', () => {
    const { estimate } = run({
      elapsedSec: 40,
      lines: [[10, '##orch-progress abc'], [15, '##orch-progress 150'], [20, '##orch-progress 30']],
    });
    assert.equal(estimate.progress, 0.3);
    assert.equal(estimate.detail.malformed, 2);
    assert.match(estimate.reason, /2 malformed ##orch-progress line\(s\) ignored/);
  });

  test('unsteady reports fall back to the usual duration of the job', () => {
    const { c, estimate } = run({
      elapsedSec: 100,
      runs: THREE_RUNS,
      lines: [[10, '##orch-progress 10'], [11, '##orch-progress 50'], [60, '##orch-progress 51']],
    });
    assert.equal(estimate.detail.method, 'history');
    assert.equal(estimate.etaAt, new Date(startOf(c) + 600 * SEC).toISOString());
  });

  test('a rate that says the end already passed is "later than the reports predicted", not a past ETA', () => {
    const { estimate } = run({
      elapsedSec: 300,
      lines: [[10, '##orch-progress 50'], [20, '##orch-progress 60']],
    });
    assert.equal(estimate.progress, 0.6);
    assert.equal(estimate.etaAt, null);
    assert.equal(estimate.detail.overdue, true);
    assert.match(estimate.reason, /later than the reports predicted/);
  });

  test('stale reports lower the confidence', () => {
    const fresh = run({ elapsedSec: 35, lines: [[10, '##orch-progress 10'], [20, '##orch-progress 20'], [30, '##orch-progress 30']] }).estimate;
    const stale = run({ elapsedSec: 900, lines: [[10, '##orch-progress 10'], [20, '##orch-progress 20'], [30, '##orch-progress 30']] }).estimate;
    assert.ok(stale.confidenceScore < fresh.confidenceScore);
    assert.equal(stale.confidence, 'low');
    assert.match(stale.reason, /last report \d+ min ago/);
  });

  test('progress 100 while the run is still open is reported as is', () => {
    const { estimate } = run({ elapsedSec: 50, lines: [[40, '##orch-progress 100 finishing']] });
    assert.equal(estimate.progress, 1);
  });

  test('a run with no log file yet says so', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 3 } });
    fs.rmSync(path.join(c.logDir, fs.readdirSync(c.logDir)[0]));
    const estimate = declaredStrategy.estimate(fx.contextOf(c));
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /no log file for this run yet/);
  });
});

describe('declared: the JSON file', () => {
  function withFile(content, mtimeOffsetSec, elapsedSec = 100) {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec, lines: [] } });
    const file = path.join(c.configDir, 'progress.json');
    fs.writeFileSync(file, content);
    const when = new Date(startOf(c) + mtimeOffsetSec * SEC);
    fs.utimesSync(file, when, when);
    const ctx = fx.contextOf(c, { options: { file } });
    return { c, file, estimate: declaredStrategy.estimate(ctx) };
  }

  test('reads {progress, message} and stamps it with the file time', () => {
    const { c, estimate } = withFile(JSON.stringify({ progress: 60, message: 'half way' }), 50, 60);
    assert.equal(estimate.progress, 0.6);
    assert.equal(estimate.detail.message, 'half way');
    assert.equal(estimate.etaAt, new Date(startOf(c) + Math.round(50 * SEC / 0.6)).toISOString());
  });

  test('a file older than the run is the previous run\'s: ignored, and the reason says so', () => {
    const { estimate } = withFile(JSON.stringify({ progress: 90 }), -3600);
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /older than this run/);
  });

  test('a file that is not valid JSON is named in the reason', () => {
    const { file, estimate } = withFile('{ nope', 10);
    assert.equal(estimate.progress, null);
    assert.ok(estimate.reason.includes(file), estimate.reason);
    assert.match(estimate.reason, /not valid JSON/);
  });

  test('a missing file and no log line: the reason names both sources', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 10 } });
    const file = path.join(c.configDir, 'missing.json');
    const estimate = declaredStrategy.estimate(fx.contextOf(c, { options: { file } }));
    assert.equal(estimate.progress, null);
    assert.ok(estimate.reason.includes(file));
    assert.match(estimate.reason, /##orch-progress/);
  });

  test('a value outside 0..100 is refused with the file named', () => {
    const { estimate } = withFile(JSON.stringify({ progress: 140 }), 10);
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /progress must be a number from 0 to 100/);
  });
});

describe('declared: options', () => {
  test('none, or { file }', () => {
    assert.deepEqual(declaredStrategy.validateOptions(undefined), { ok: true, value: undefined });
    assert.deepEqual(declaredStrategy.validateOptions({ file: 'out/p.json' }), { ok: true, value: { file: 'out/p.json' } });
  });

  for (const [name, raw, pattern] of [
    ['an unknown key', { path: 'x' }, /unknown option "path".*accepted: file/],
    ['an empty file', { file: '' }, /"file" must be a non-empty string/],
    ['a number', 5, /options must be an object/],
    ['an array', [], /options must be an object/],
  ]) {
    test(`refuses ${name} with the fix`, () => {
      const r = declaredStrategy.validateOptions(raw);
      assert.equal(r.ok, false);
      assert.match(r.error, pattern);
    });
  }
});
