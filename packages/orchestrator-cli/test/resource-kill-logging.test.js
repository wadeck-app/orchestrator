'use strict';

// A job killed by the resource monitor used to leave this in its own log: "Over hard budget 1/3",
// "2/3", then "[job:finished] exitCode=1". The kill itself went to the daemon's stderr, which ends up
// in no file, so an exit code 1 caused by the monitor read exactly like the job failing on its own.
// These tests hold the job log to saying what happened, and what the monitor saw when it decided.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PEAK_MEASURE_VERSION } = require('../src/types');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler, sampleProcessTree } = require('../src/scheduler');

const MB = 1024 * 1024;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resource-kill-log-'));
}

function makeDeps(dir) {
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  return { registry, state };
}

function seedTinyBaseline(state, id) {
  for (let i = 0; i < 3; i++) {
    state.record(id, {
      startedAt:  `2026-08-22T08:0${i}:00Z`,
      finishedAt: `2026-08-22T08:0${i}:05Z`,
      exitCode: 0, pid: 100 + i, peakCpuPct: 0.001, peakRamMb: 0.001, peakMeasure: PEAK_MEASURE_VERSION,
    });
  }
}

function busyJob(dir, id, ms) {
  const scriptPath = path.join(dir, `${id}.js`);
  fs.writeFileSync(scriptPath, `const t = Date.now(); while (Date.now() - t < ${ms});`);
  return {
    id, type: 'startup', delaySeconds: 0,
    command: `"${process.execPath}" "${scriptPath}"`,
    enabled: true, triggerMode: 'wait', liveness: null,
  };
}

function readJobLog(dir, jobId) {
  const logDir = path.join(dir, 'logs', 'jobs', jobId);
  const files  = fs.readdirSync(logDir);
  assert.equal(files.length, 1, `expected one log file, got: ${files.join(', ')}`);
  return fs.readFileSync(path.join(logDir, files[0]), 'utf8').split('\n');
}

/** What the monitor measured when it decided: the biggest process is a scraper, its child is small. */
const OVER_BUDGET = {
  cpuPct: 5000,
  ramMb: 147,
  walked: 4,
  counted: 3,
  processes: [
    { pid: 4242, ppid: 1000, ramMb: 120, cpuPct: 4000 },
    { pid: 4243, ppid: 4242, ramMb: 20, cpuPct: 900 },
    { pid: 1000, ppid: 1, ramMb: 7, cpuPct: 100 },
  ],
};

async function runKilledJob(dir, id, extra = {}) {
  const { registry, state } = makeDeps(dir);
  seedTinyBaseline(state, id);
  registry.add(busyJob(dir, id, 20000));
  const sched = new Scheduler(registry, state, {
    configDir: dir, liveness: async () => false, sampleIntervalMs: 25, sustainSamples: 3,
    sampleUsage: async () => OVER_BUDGET,
    processName: async (pid) => ({ 4242: 'chatgpt-scraper.exe', 4243: 'node.exe' })[pid],
    ...extra,
  });
  await sched.trigger(id);
  await sched.stop();
  return readJobLog(dir, id);
}

describe('a job killed by the resource monitor', () => {
  test('says so in its own log, before the kill, with the numbers that justified it', async () => {
    const lines = await runKilledJob(tmpDir(), 'killed-a');

    const kill = lines.findIndex(l => l.includes('[resource-monitor] Hard limit exceeded'));
    assert.ok(kill >= 0, `no kill line in the job log:\n${lines.join('\n')}`);
    assert.match(lines[kill], /3\/3/);
    assert.match(lines[kill], /RAM: 147MB/);
    assert.match(lines[kill], /killing/);

    const finished = lines.findIndex(l => l.includes('[job:finished]'));
    assert.ok(kill < finished, 'the kill is announced before the job is reported finished');
  });

  test('marks the finished line, so exit 1 from the monitor is not mistaken for a failure of the job', async () => {
    const lines = await runKilledJob(tmpDir(), 'killed-b');
    const finished = lines.find(l => l.includes('[job:finished]'));
    assert.match(finished, /reason=resource-limit/);
  });

  test('names the biggest processes at kill time, with their executable, so the culprit is known', async () => {
    const lines = await runKilledJob(tmpDir(), 'killed-c');
    const tree = lines.find(l => l.includes('Process tree at kill'));
    assert.ok(tree, `no process-tree line:\n${lines.join('\n')}`);
    assert.match(tree, /3 of 4 processes counted/);
    assert.match(tree, /pid 4242 chatgpt-scraper\.exe \(parent 1000\) 120MB/);
    assert.match(tree, /pid 4243 node\.exe \(parent 4242\) 20MB/);
    // Biggest first.
    assert.ok(tree.indexOf('pid 4242') < tree.indexOf('pid 4243'));
  });

  test('still kills, and still says it, when a process name cannot be found', async () => {
    const lines = await runKilledJob(tmpDir(), 'killed-d', { processName: async () => { throw new Error('tasklist failed'); } });
    const tree = lines.find(l => l.includes('Process tree at kill'));
    assert.match(tree, /pid 4242 \(parent 1000\) 120MB/);
    assert.ok(lines.some(l => l.includes('[job:finished]') && l.includes('reason=resource-limit')));
  });

  test('is not hurt by a sampler that reports no breakdown', async () => {
    const lines = await runKilledJob(tmpDir(), 'killed-e', { sampleUsage: async () => ({ cpuPct: 5000, ramMb: 5000 }) });
    assert.ok(lines.some(l => l.includes('[resource-monitor] Hard limit exceeded')));
    assert.ok(lines.some(l => l.includes('[job:finished]') && l.includes('reason=resource-limit')));
  });
});

describe('a job that ends without the monitor', () => {
  test('never carries the resource-limit reason', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(busyJob(dir, 'calm', 200));
    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleIntervalMs: 25,
      sampleUsage: async () => ({ cpuPct: 1, ramMb: 1 }),
    });
    await sched.trigger('calm');
    await sched.stop();
    const finished = readJobLog(dir, 'calm').find(l => l.includes('[job:finished]'));
    assert.ok(finished);
    assert.doesNotMatch(finished, /reason=resource-limit/);
  });
});

describe('sampleProcessTree breakdown', () => {
  const ROOT = 1000;
  const sample = ({ cpu = 1, mb, elapsed, ppid = ROOT }) => ({ cpu, memory: mb * MB, elapsed, ppid });

  test('lists every process it counted, biggest first, with its parent', async () => {
    const usage = await sampleProcessTree(ROOT, {
      tree: async () => [ROOT, 2000, 3000],
      usage: async (pid) => ({
        [ROOT]: sample({ mb: 7, elapsed: 5000, ppid: 1 }),
        2000: sample({ mb: 120, elapsed: 4000 }),
        3000: sample({ mb: 20, elapsed: 3000, ppid: 2000 }),
      })[pid],
    });
    assert.deepEqual(usage.processes.map(p => [p.pid, p.ppid, Math.round(p.ramMb)]), [
      [2000, ROOT, 120], [3000, 2000, 20], [ROOT, 1, 7],
    ]);
    assert.equal(usage.walked, 3);
    assert.equal(usage.counted, 3);
  });

  test('says how many it walked against how many it counted, so a dropped process is visible', async () => {
    const usage = await sampleProcessTree(ROOT, {
      tree: async () => [ROOT, 2000, 9999],
      usage: async (pid) => ({
        [ROOT]: sample({ mb: 7, elapsed: 5000, ppid: 1 }),
        2000: sample({ mb: 20, elapsed: 4000 }),
        // Older than the root: cannot be its descendant, so it is not counted.
        9999: sample({ mb: 500, elapsed: 900_000 }),
      })[pid],
    });
    assert.equal(usage.walked, 3);
    assert.equal(usage.counted, 2);
    assert.ok(!usage.processes.some(p => p.pid === 9999));
    assert.equal(Math.round(usage.ramMb), 27, 'the dropped process stays out of the total, as before');
  });
});

describe('the telemetry file of a killed job', () => {
  const { readTelemetryLines } = require('./helpers/read-telemetry');

  test('keeps what the monitor saw: the thresholds at the start, every sample, the kill and the end', async () => {
    const dir = tmpDir();
    await runKilledJob(dir, 'telemetry-a');

    const lines = readTelemetryLines(dir, 'telemetry-a');
    const kinds = lines.map(l => l.kind);
    assert.equal(kinds[0], 'start', `kinds: ${kinds.join(',')}`);
    assert.ok(kinds.filter(k => k === 'sample').length >= 3, 'the three samples that led to the kill');
    assert.ok(kinds.includes('resource-kill'));
    assert.equal(kinds[kinds.length - 1], 'end');

    assert.ok(lines[0].hard && lines[0].hard.ramMb > 0, 'the hard threshold the run was held to');
    const sample = lines.find(l => l.kind === 'sample');
    assert.equal(sample.ramMb, 147);
    assert.equal(sample.counted, 3);
    assert.equal(sample.processes[0].pid, 4242);

    const kill = lines.find(l => l.kind === 'resource-kill');
    assert.equal(kill.consecutiveSamples, 3);
    const end = lines[lines.length - 1];
    assert.equal(end.reason, 'resource-limit');
    assert.ok('exitCode' in end);
    assert.equal(new Set(lines.map(l => l.run)).size, 1, 'every line names the same run');
  });

  test('is written for a run that was not killed too: the history a UI would draw', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(busyJob(dir, 'telemetry-b', 300));
    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleIntervalMs: 25,
      sampleUsage: async () => ({ cpuPct: 2, ramMb: 30, walked: 1, counted: 1 }),
    });
    await sched.trigger('telemetry-b');
    await sched.stop();

    const lines = readTelemetryLines(dir, 'telemetry-b');
    assert.ok(lines.some(l => l.kind === 'sample'));
    const end = lines[lines.length - 1];
    assert.equal(end.kind, 'end');
    assert.equal(end.reason, undefined, 'an ordinary finish carries no reason');
  });
});
