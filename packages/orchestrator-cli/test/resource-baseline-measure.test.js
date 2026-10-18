'use strict';

// The hard resource budget is twice the average of the peaks of a job's past successful runs. Those
// peaks were measured by a sampler that, under load, counted a job as its idle shell wrapper (see
// process-tree-skew.test.js): a job that really weighs 130 MB was recorded at 17 MB on quiet runs.
//
// Correcting the sampler alone would kill those jobs. Measured correctly they sit far above a budget
// built from the old figures, so every run would be killed, and since only SUCCESSFUL runs feed the
// baseline it would never be corrected: a loop with no way out. So a peak records which method measured
// it, and the baseline only trusts peaks from the current one. After the fix a job runs without a hard
// budget until it has three successful runs measured properly, then has a budget that means something.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { State } = require('../src/state');
const { PEAK_MEASURE_VERSION } = require('../src/types');

function tmpState() {
  return new State(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-baseline-measure-')), 'state.json'));
}

const run = (hour, ram, extra = {}) => ({
  startedAt: `2026-10-18T${String(hour).padStart(2, '0')}:00:00Z`, finishedAt: `2026-10-18T${String(hour).padStart(2, '0')}:01:00Z`,
  exitCode: 0, pid: hour, peakCpuPct: 10, peakRamMb: ram, ...extra,
});

describe('which peaks make a baseline', () => {
  test('peaks recorded before the measurement was corrected are not a baseline', () => {
    const state = tmpState();
    for (const [h, ram] of [[1, 17], [2, 17], [3, 17], [4, 140]]) {
      state.record('legacy', run(h, ram));
    }
    assert.equal(state.getResourceBaseline('legacy'), null,
      'figures that may have counted only the shell wrapper must not set a budget');
  });

  test('peaks measured with the current method are', () => {
    const state = tmpState();
    for (const [h, ram] of [[1, 100], [2, 120], [3, 140]]) {
      state.record('current', run(h, ram, { peakMeasure: PEAK_MEASURE_VERSION }));
    }
    const baseline = state.getResourceBaseline('current');
    assert.ok(baseline !== null);
    assert.equal(baseline.ramMb, 120);
  });

  test('old and new peaks are not mixed: two current runs are not enough, however many old ones there are', () => {
    const state = tmpState();
    state.record('mixed', run(1, 17));
    state.record('mixed', run(2, 17));
    state.record('mixed', run(3, 17));
    state.record('mixed', run(4, 130, { peakMeasure: PEAK_MEASURE_VERSION }));
    state.record('mixed', run(5, 140, { peakMeasure: PEAK_MEASURE_VERSION }));
    assert.equal(state.getResourceBaseline('mixed'), null);

    state.record('mixed', run(6, 120, { peakMeasure: PEAK_MEASURE_VERSION }));
    assert.equal(state.getResourceBaseline('mixed').ramMb, 130, 'only the three current runs, 17 MB ones left out');
  });

  test('the version survives a round trip through the state file', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-baseline-measure-')), 'state.json');
    const first = new State(file);
    first.record('persisted', run(1, 100, { peakMeasure: PEAK_MEASURE_VERSION }));
    first.record('persisted', run(2, 100, { peakMeasure: PEAK_MEASURE_VERSION }));
    first.record('persisted', run(3, 100, { peakMeasure: PEAK_MEASURE_VERSION }));
    first.shutdown();

    assert.ok(new State(file).getResourceBaseline('persisted') !== null);
  });
});
