'use strict';

// The log-format check of `log-learned`: a job whose early log lines vary from run to run (names, ids that digits
// masking cannot normalise) must not look like a format change; a log that really changed must.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { logLearnedStrategy } = require('../../src/progress/log-learned-strategy');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

/** A word made only of letters, different for every (run, slot): letters survive the digit masking. */
function word(run, slot) {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let n = run * 97 + slot * 13 + 5;
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += letters[n % 26];
    n = Math.floor(n / 3) + 7 * (i + 1) + slot;
  }
  return `${out}${run}x${slot}`.replace(/[0-9]/g, 'q');
}

/**
 * 20 early lines, 8 of them the same in every run, 12 naming something that differs in every run (letters only, so
 * masking does not equalise them); then three stable milestones later in the run.
 */
function earlyVaryingLines(durationSec, run) {
  const lines = [];
  for (let slot = 0; slot < 20; slot++) {
    lines.push([slot + 1, slot % 5 < 2 ? `Stable step ${String.fromCharCode(97 + slot)} done` : `Loaded plugin ${word(run, slot)}`]);
  }
  lines.push([Math.round(durationSec * 0.3), 'Fetched records from the source']);
  lines.push([Math.round(durationSec * 0.6), 'Transformed records']);
  lines.push([Math.round(durationSec * 0.9), 'Uploading files']);
  return lines;
}

function run({ elapsedSec, lines, runs }) {
  const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec, lines }, runs });
  const ctx = fx.contextOf(c, { options: undefined });
  return { c, estimate: logLearnedStrategy.estimate(ctx) };
}

describe('log-learned: the format check', () => {
  test('the fixture really varies: only 8 of the 20 early lines are shared between two runs', () => {
    const a = new Set(earlyVaryingLines(600, 1).slice(0, 20).map(l => l[1]));
    const b = earlyVaryingLines(600, 2).slice(0, 20).map(l => l[1]);
    assert.equal(b.filter(t => a.has(t)).length, 8);
  });

  test('early lines that vary from run to run are not a format change', () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({ agoMin: 60 * (i + 2), durationSec: 600, lines: earlyVaryingLines(600, i) }));
    const { estimate } = run({ elapsedSec: 200, lines: earlyVaryingLines(600, 99).slice(0, 21), runs });

    assert.notEqual(estimate.progress, null, estimate.reason);
    assert.doesNotMatch(estimate.reason, /log format changed/);
    assert.equal(estimate.detail.usableRuns, 5);
  });

  test('a log that really changed format is one, however many lines it shares nothing on', () => {
    const newFormat = (i) => Array.from({ length: 8 }, (_, k) => [10 + k * 20, `phase=${String.fromCharCode(97 + k)} rows=${i}`]);
    const older = Array.from({ length: 5 }, (_, i) => ({ agoMin: 60 * (i + 2), durationSec: 600, lines: earlyVaryingLines(600, i) }));
    const { estimate } = run({ elapsedSec: 200, lines: newFormat(9), runs: older });

    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /log format changed, relearning \(needs 3 more runs with the new log format; 0 of 5 usable runs match\)/);
    assert.equal(estimate.detail.formatChanged, true);
  });

  test('one line is not enough to call a format change', () => {
    const runs = Array.from({ length: 5 }, (_, i) => ({ agoMin: 60 * (i + 2), durationSec: 600, lines: earlyVaryingLines(600, i) }));
    const { estimate } = run({ elapsedSec: 5, lines: [[1, `Loaded plugin ${word(77, 3)}`]], runs });

    assert.doesNotMatch(estimate.reason, /log format changed/);
    assert.equal(estimate.detail.usableRuns, 5);
  });

  test('a changed format is judged per past run: the runs that still match are kept', () => {
    const newFormat = (i) => Array.from({ length: 8 }, (_, k) => [10 + k * 20, `phase=${String.fromCharCode(97 + k)} rows=${i}`]);
    const newer = [0, 1, 2].map(i => ({ agoMin: 60 * (i + 2), durationSec: 600, lines: newFormat(i) }));
    const older = Array.from({ length: 5 }, (_, i) => ({ agoMin: 60 * (i + 6), durationSec: 600, lines: earlyVaryingLines(600, i) }));
    const { estimate } = run({ elapsedSec: 200, lines: newFormat(9), runs: [...newer, ...older] });

    assert.equal(estimate.detail.usableRuns, 3, estimate.reason);
  });
});
