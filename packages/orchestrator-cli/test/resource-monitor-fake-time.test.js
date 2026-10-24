'use strict';

// The resource monitor's counting rules, driven sample by sample on the fake clock (no real wait): a transient spike
// must never kill, the soft alert is said once per run, and an absolute ceiling holds without a baseline while leaving the
// soft budget (always a factor of the baseline) alone. The process is a real short one, so the kill is a real kill; the
// sampler is a script of readings the test controls.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { assertNoProblems, makeHarness, settle } = require('./helpers/event-harness');
const { untilTrue } = require('./helpers/event-scenarios');
const { readTelemetryLines } = require('./helpers/read-telemetry');
const { PEAK_MEASURE_VERSION } = require('../src/types');

afterEach(assertNoProblems);

const STEP_MS = 50;

// Baseline 10 % / 100 MB: soft 15 % / 150 MB, hard 30 % / 300 MB.
const OVER = { cpuPct: 5000, ramMb: 5000 };
const CALM = { cpuPct: 1, ramMb: 1 };
// Over the soft budget, under the hard one.
const SOFT = { cpuPct: 20, ramMb: 200 };

/**
 * @param {object} o
 * @param {Array<{cpuPct: number, ramMb: number}>} o.readings what the sampler returns, in order; the last one repeats
 * @param {boolean} [o.baseline] seed three earlier runs (default true)
 * @param {object} [o.limits] the job's resourceLimits
 * @param {number} [o.sustainSamples] the Scheduler option (wins over the job's sustainSeconds)
 */
function monitorHarness({ readings, baseline = true, limits, sustainSamples = 3 }) {
  const id = 'res';
  const calls = [];
  const sampleUsage = async () => {
    const reading = readings[Math.min(calls.length, readings.length - 1)];
    calls.push(reading);
    return reading;
  };
  const h = makeHarness([], { startedAgoMs: 1000, scheduler: { spawn: undefined, sampleUsage, sampleIntervalMs: STEP_MS, sustainSamples: sustainSamples === null ? undefined : sustainSamples } });
  h.calls = calls;
  h.release = path.join(h.dir, `${id}.release`);
  h.running = path.join(h.dir, `${id}.running`);
  const script = path.join(h.dir, `${id}.js`);
  fs.writeFileSync(script, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(h.running)}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(h.release)})) { process.exit(0); } }, 10);`);
  if (baseline) {
    for (let i = 0; i < 3; i++) {
      h.state.record(id, {
        startedAt: `2026-08-22T08:0${i}:00Z`, finishedAt: `2026-08-22T08:0${i}:05Z`,
        exitCode: 0, pid: 100 + i, peakCpuPct: 10, peakRamMb: 100, peakMeasure: PEAK_MEASURE_VERSION,
      });
    }
  }
  h.registry.add({
    id, type: 'cron', schedule: '0 8 * * *', label: 'Res', enabled: true, triggerMode: 'fire-and-forget',
    command: `"${process.execPath}" "${script}"`,
    ...(limits === undefined ? {} : { resourceLimits: limits }),
  });
  return h;
}

/** Takes exactly `readings.length` samples (the first at once, the others one step of the fake clock apart), then ends the run. */
async function runAllSamples(h, { release }) {
  await h.sched.trigger('res');
  await untilTrue(() => fs.existsSync(h.running));
  await settle();
  const total = h.readingsTotal;
  for (let i = 1; i < total; i++) {
    await h.time.advanceAsync(STEP_MS, STEP_MS);
    await settle();
  }
  if (release) {
    fs.writeFileSync(h.release, '');
  }
  await h.untilFinished(1);
  await settle();
  return h;
}

async function scenario(options, { release = true } = {}) {
  const h = monitorHarness(options);
  h.readingsTotal = options.readings.length;
  await runAllSamples(h, { release });
  assert.ok(h.calls.length >= options.readings.length, `the script needs ${options.readings.length} samples, the monitor took ${h.calls.length}`);
  return h;
}

describe('enforce: kill, a transient spike', () => {
  test('over, over, calm, over, over with a sustain of 3 samples kills nothing: the calm sample restarts the count', async () => {
    const h = await scenario({ readings: [OVER, OVER, CALM, OVER, OVER] });
    assert.deepEqual(h.of('job.resource_hard_limit'), []);
    assert.deepEqual(h.names(), ['job.started', 'job.resource_soft_limit', 'job.completed']);
    assert.equal(h.state.get('res').endReason, undefined, 'the run ended by itself');
    assert.equal(h.state.get('res').exitCode, 0);
  });

  test('the count restarts at 1 after the calm sample: a breach of 3 samples after it kills, and says 3 (not 5)', async () => {
    const h = await scenario({ readings: [OVER, OVER, CALM, OVER, OVER, OVER] }, { release: false });
    const hard = h.of('job.resource_hard_limit');
    assert.equal(hard.length, 1);
    assert.equal(hard[0].payload.consecutiveSamples, 3);
    assert.equal(hard[0].payload.enforced, true);
    assert.equal(h.state.get('res').endReason, 'resource-limit');
  });

  test('a breach one sample short of the sustain does not kill', async () => {
    const h = await scenario({ readings: [OVER, OVER] });
    assert.deepEqual(h.of('job.resource_hard_limit'), []);
    assert.equal(h.state.get('res').exitCode, 0);
  });
});

describe('the soft alert', () => {
  test('enforce: warn: said once per run, even when the load goes calm and over the soft budget again', async () => {
    const h = await scenario({ readings: [SOFT, SOFT, CALM, SOFT, SOFT], limits: { enforce: 'warn' } });
    const soft = h.of('job.resource_soft_limit');
    assert.equal(soft.length, 1);
    assert.deepEqual(soft[0].payload.softThreshold, { cpuPct: 15, ramMb: 150 });
    assert.deepEqual(h.of('job.resource_hard_limit'), [], 'under the hard budget the whole time');
  });

  test('a ceiling does not change the soft budget: soft stays 1.5x the baseline while the hard side takes the ceiling', async () => {
    const h = await scenario({ readings: [SOFT], limits: { maxCpuPct: 100 } });
    const soft = h.of('job.resource_soft_limit');
    assert.equal(soft.length, 1);
    assert.deepEqual(soft[0].payload.softThreshold, { cpuPct: 15, ramMb: 150 });
    const start = readTelemetryLines(h.dir, 'res').find((l) => l.kind === 'start');
    assert.deepEqual(start.soft, { cpuPct: 15, ramMb: 150 });
    assert.deepEqual(start.hard, { cpuPct: 100, ramMb: 300 }, 'the ceiling replaces the cpu side only; ram stays 3x the baseline');
  });
});

describe('the sustain', () => {
  const startLine = (h) => readTelemetryLines(h.dir, 'res').find((l) => l.kind === 'start');

  test('the Scheduler option sustainSamples wins over the job\'s sustainSeconds', async () => {
    const h = await scenario({ readings: [CALM], limits: { sustainSeconds: 30 }, sustainSamples: 4 });
    assert.equal(startLine(h).sustainSamples, 4);
  });

  test('without the option, the job\'s sustainSeconds is converted with the sample interval (2 s at 50 ms = 40 samples)', async () => {
    const h = await scenario({ readings: [CALM], limits: { sustainSeconds: 2 }, sustainSamples: null });
    assert.equal(startLine(h).sustainSamples, 40);
  });
});

describe('maxCpuPct as an absolute ceiling', () => {
  test('kills a job with NO baseline (no soft budget exists, so no soft alert either)', async () => {
    // Two samples are needed for the sustain: the first one at once, the second one a step later.
    const over = { cpuPct: 80, ramMb: 10 };
    const h = await scenario({ readings: [over, over], baseline: false, limits: { maxCpuPct: 50 }, sustainSamples: 2 }, { release: false });
    assert.equal(h.of('job.resource_hard_limit').length, 1);
    assert.deepEqual(h.of('job.resource_hard_limit')[0].payload.hardThreshold, { cpuPct: 50, ramMb: null });
    assert.deepEqual(h.of('job.resource_soft_limit'), []);
    assert.equal(h.state.get('res').endReason, 'resource-limit');
  });

  test('a job with no baseline under its ceiling is left alone', async () => {
    const h = await scenario({ readings: [{ cpuPct: 40, ramMb: 99999 }, { cpuPct: 40, ramMb: 99999 }], baseline: false, limits: { maxCpuPct: 50 } });
    assert.deepEqual(h.of('job.resource_hard_limit'), [], 'the ram side has no limit at all without a baseline');
    assert.equal(h.state.get('res').exitCode, 0);
  });
});
