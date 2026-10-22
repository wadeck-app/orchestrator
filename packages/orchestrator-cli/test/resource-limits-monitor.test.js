'use strict';

// The resource monitor reads a job's `resourceLimits`: how long a breach must last (sustainSeconds, as
// a number of samples), what it does about it (enforce kill | warn | off), absolute ceilings that need
// no baseline, and the defaults (hard 3x, soft 1.5x, 30 s) when nothing is set.
//
// Timing: the smallest sustainSeconds is 2, so these tests use a 1 s sample interval, which makes the
// sustained breach 2 samples (the first sample is taken at once).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry } = require('../src/registry');
const { State }    = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { PEAK_MEASURE_VERSION } = require('../src/types');
const { readTelemetryLines } = require('./helpers/read-telemetry');
const { readResourceHistory } = require('../src/resource-history');

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reslim-mon-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function seedBaseline(state, id, cpuPct = 10, ramMb = 100) {
  for (let i = 0; i < 3; i++) {
    state.record(id, {
      startedAt: `2026-08-22T08:0${i}:00Z`, finishedAt: `2026-08-22T08:0${i}:05Z`,
      exitCode: 0, pid: 100 + i, peakCpuPct: cpuPct, peakRamMb: ramMb, peakMeasure: PEAK_MEASURE_VERSION,
    });
  }
}

function sleepJob(dir, id, ms, resourceLimits) {
  const scriptPath = path.join(dir, `${id}.js`);
  fs.writeFileSync(scriptPath, `setTimeout(() => {}, ${ms});`);
  return {
    id, type: 'startup', delaySeconds: 0,
    command: `"${process.execPath}" "${scriptPath}"`,
    enabled: true, triggerMode: 'wait', liveness: null,
    ...(resourceLimits ? { resourceLimits } : {}),
  };
}

async function run({ id, ms, limits, baseline = true, sampleUsage, sampleIntervalMs = 1000, dir = tmpDir(), prepare }) {
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  if (baseline) {
    seedBaseline(state, id);
  }
  registry.add(sleepJob(dir, id, ms, limits));
  prepare?.(dir);
  const events = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir, liveness: async () => false, sampleIntervalMs, sampleUsage,
    eventPublisher: { publish: (topic, payload) => events.push({ topic, payload }) },
  });
  await sched.trigger(id);
  await sched.stop();
  const logDir = path.join(dir, 'logs', 'jobs', id);
  const log = fs.readdirSync(logDir).flatMap(f => fs.readFileSync(path.join(logDir, f), 'utf8').split('\n'));
  return { dir, state, events, log, hardEvents: events.filter(e => e.topic === 'job.resource_hard_limit') };
}

const OVER = async () => ({ cpuPct: 5000, ramMb: 5000 });

describe('the defaults, recorded in the telemetry start line', () => {
  test('hard 3x, soft 1.5x of the baseline, 15 samples (30 s of 2 s samples), enforce kill', async () => {
    const r = await run({
      id: 'dflt', ms: 400, sampleIntervalMs: 2000,
      sampleUsage: async () => ({ cpuPct: 1, ramMb: 1 }),
    });
    const start = readTelemetryLines(r.dir, 'dflt').find(l => l.kind === 'start');
    assert.deepEqual(start.soft, { cpuPct: 15, ramMb: 150 });
    assert.deepEqual(start.hard, { cpuPct: 30, ramMb: 300 });
    assert.equal(start.enforce, 'kill');
    assert.equal(start.sustainSamples, 15);
  });

  test('a job at 2.5x its baseline is warned about but not killed, whatever the time', async () => {
    const r = await run({
      id: 'tolerant', ms: 2600, limits: { sustainSeconds: 2 },
      sampleUsage: async () => ({ cpuPct: 25, ramMb: 250 }),
    });
    assert.equal(r.hardEvents.length, 0, '2.5x is under the new 3x hard budget');
    assert.equal(r.events.filter(e => e.topic === 'job.resource_soft_limit').length, 1, '2.5x is over the 1.5x soft budget');
    assert.equal(r.state.get('tolerant').exitCode, 0);
  });
});

describe('enforce: kill, the sustain is per job', () => {
  test('kills after sustainSeconds worth of samples, and the log counts to that number', async () => {
    const r = await run({ id: 'kill2', ms: 20000, limits: { sustainSeconds: 2 }, sampleUsage: OVER });
    assert.equal(r.hardEvents.length, 1);
    assert.equal(r.hardEvents[0].payload.enforced, true);
    assert.equal(r.hardEvents[0].payload.consecutiveSamples, 2);
    assert.ok(r.log.some(l => /Over hard budget 1\/2/.test(l)), r.log.join('\n'));
    assert.ok(r.log.some(l => /Hard limit exceeded for 2\/2 consecutive samples/.test(l)), r.log.join('\n'));
    assert.ok(r.log.some(l => l.includes('[job:finished]') && l.includes('reason=resource-limit')));
    assert.equal(r.state.get('kill2').endReason, 'resource-limit');
  });
});

describe('enforce: warn', () => {
  test('logs the sustained breach and publishes enforced:false once, and kills nothing', async () => {
    const r = await run({ id: 'warn1', ms: 4500, limits: { enforce: 'warn', sustainSeconds: 2 }, sampleUsage: OVER });
    assert.equal(r.hardEvents.length, 1, 'once per continuous breach, not every sample');
    assert.equal(r.hardEvents[0].payload.enforced, false);
    const warned = r.log.filter(l => l.includes('[resource-monitor]') && l.includes('would be killed (enforce: warn)'));
    assert.equal(warned.length, 1, r.log.join('\n'));
    assert.match(warned[0], /2\/2 consecutive samples/);
    assert.ok(!r.log.some(l => l.includes('reason=resource-limit')));
    const entry = r.state.get('warn1');
    assert.equal(entry.exitCode, 0, 'the job ran to its own end');
    assert.equal(entry.endReason, undefined);
  });

  test('a breach that ends and starts again is announced again', async () => {
    let calls = 0;
    // over, over, calm, over, over, calm...
    const sampleUsage = async () => {
      calls++;
      return [1, 2, 4, 5].includes(calls) ? { cpuPct: 5000, ramMb: 5000 } : { cpuPct: 1, ramMb: 1 };
    };
    const r = await run({ id: 'warn2', ms: 5600, limits: { enforce: 'warn', sustainSeconds: 2 }, sampleUsage });
    assert.ok(calls >= 5, `the pattern needs 5 samples, got ${calls}`);
    assert.equal(r.hardEvents.length, 2);
  });
});

describe('enforce: off', () => {
  test('checks no threshold at all, but peaks and telemetry are still recorded', async () => {
    const r = await run({ id: 'off1', ms: 2600, limits: { enforce: 'off', sustainSeconds: 2 }, sampleUsage: OVER });
    assert.equal(r.hardEvents.length, 0);
    assert.equal(r.events.filter(e => e.topic === 'job.resource_soft_limit').length, 0);
    assert.ok(!r.log.some(l => /Over hard budget/.test(l)));
    const entry = r.state.get('off1');
    assert.equal(entry.exitCode, 0);
    assert.equal(entry.peakRamMb, 5000);
    const lines = readTelemetryLines(r.dir, 'off1');
    assert.ok(lines.some(l => l.kind === 'sample'));
    assert.equal(lines.find(l => l.kind === 'start').enforce, 'off');
  });
});

describe('absolute ceilings', () => {
  test('maxRamMb kills on a job that has no baseline yet', async () => {
    const r = await run({
      id: 'abs1', ms: 20000, baseline: false, limits: { maxRamMb: 100, sustainSeconds: 2 },
      sampleUsage: async () => ({ cpuPct: 1, ramMb: 500 }),
    });
    assert.equal(r.hardEvents.length, 1);
    assert.deepEqual(r.hardEvents[0].payload.hardThreshold, { cpuPct: null, ramMb: 100 });
    const start = readTelemetryLines(r.dir, 'abs1').find(l => l.kind === 'start');
    assert.deepEqual(start.hard, { cpuPct: null, ramMb: 100 });
    assert.equal(start.soft, null);
  });

  test('a job under its ceiling and without a baseline is left alone', async () => {
    const r = await run({
      id: 'abs2', ms: 2600, baseline: false, limits: { maxRamMb: 1000, maxCpuPct: 100, sustainSeconds: 2 },
      sampleUsage: async () => ({ cpuPct: 1, ramMb: 500 }),
    });
    assert.equal(r.hardEvents.length, 0);
    assert.equal(r.state.get('abs2').exitCode, 0);
  });

  test('with no baseline and no ceiling nothing is checked', async () => {
    const r = await run({ id: 'abs3', ms: 2600, baseline: false, limits: { sustainSeconds: 2 }, sampleUsage: OVER });
    assert.equal(r.hardEvents.length, 0);
  });
});

describe('the long history', () => {
  test('a closed run leaves one compact record', async () => {
    const r = await run({
      id: 'hist1', ms: 2600, limits: { sustainSeconds: 2 },
      sampleUsage: async () => ({ cpuPct: 20, ramMb: 200 }),
    });
    const { runs, total } = readResourceHistory(r.dir, 'hist1');
    assert.equal(total, 1);
    const h = runs[0];
    assert.equal(h.exitCode, 0);
    assert.equal(h.endReason, undefined);
    assert.equal(h.peakCpuPct, 20);
    assert.equal(h.peakRamMb, 200);
    assert.equal(h.avgCpuPct, 20);
    assert.equal(h.avgRamMb, 200);
    assert.ok(h.samples >= 2, `samples: ${h.samples}`);
    assert.deepEqual(h.soft, { cpuPct: 15, ramMb: 150 });
    assert.deepEqual(h.hard, { cpuPct: 30, ramMb: 300 });
    assert.equal(h.enforce, 'kill');
    assert.equal(h.startedAt, r.state.get('hist1').startedAt);
    assert.equal(h.finishedAt, r.state.get('hist1').finishedAt);
    assert.ok(h.durationMs >= 2000);
  });

  test('a run killed by the monitor is recorded with its reason', async () => {
    const r = await run({ id: 'hist2', ms: 20000, limits: { sustainSeconds: 2 }, sampleUsage: OVER });
    const h = readResourceHistory(r.dir, 'hist2').runs[0];
    assert.equal(h.endReason, 'resource-limit');
    assert.equal(h.peakRamMb, 5000);
  });

  test('a run that took no sample has null averages', async () => {
    const r = await run({ id: 'hist3', ms: 150, sampleUsage: async () => null });
    const h = readResourceHistory(r.dir, 'hist3').runs[0];
    assert.equal(h.samples, 0);
    assert.equal(h.avgCpuPct, null);
    assert.equal(h.avgRamMb, null);
  });

  test('a history that cannot be written is reported once in the job log and the run is unaffected', async () => {
    const r = await run({
      id: 'hist4', ms: 150, sampleUsage: async () => ({ cpuPct: 1, ramMb: 1 }),
      // A file where the directory should be.
      prepare: (dir) => fs.writeFileSync(path.join(dir, 'resource-history'), 'in the way'),
    });
    const warnings = r.log.filter(l => l.includes('[resource-monitor]') && l.includes('resource history'));
    assert.equal(warnings.length, 1, r.log.join('\n'));
    assert.match(warnings[0], /could not be written/);
    assert.equal(r.state.get('hist4').exitCode, 0);
  });
});
