'use strict';

// What the resource monitor sees of a job is kept next to the job, one file per job, so a UI can draw it and
// an incident ("why was this job killed at 09:34?") can be read after the fact instead of
// guessed. These tests hold the file to being readable, bounded and never in the job's way.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { JobTelemetry, readJobTelemetry, telemetryPath } = require('../src/job-telemetry');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-telemetry-'));
}

const RUN = '2026-10-18T09:30:00.000Z';

describe('JobTelemetry', () => {
  test('writes one JSON line per sample, in a file named after the job', () => {
    const dir = tmpDir();
    const t = new JobTelemetry(dir, 'post-process-10h', RUN, 4242);

    t.sample({ cpuPct: 12.34, ramMb: 147.26, walked: 4, counted: 3, processes: [{ pid: 4242, ppid: 1, ramMb: 120.04, cpuPct: 10 }] });
    t.sample({ cpuPct: 1, ramMb: 20 });

    assert.equal(telemetryPath(dir, 'post-process-10h'), path.join(dir, 'telemetry', 'post-process-10h.ndjson'));
    const lines = fs.readFileSync(telemetryPath(dir, 'post-process-10h'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].kind, 'sample');
    assert.equal(lines[0].run, RUN);
    assert.equal(lines[0].pid, 4242);
    assert.equal(lines[0].cpuPct, 12.3);
    assert.equal(lines[0].ramMb, 147.3);
    assert.deepEqual(lines[0].processes, [{ pid: 4242, ppid: 1, ramMb: 120, cpuPct: 10 }]);
    assert.equal(lines[0].walked, 4);
    assert.equal(lines[0].counted, 3);
    assert.ok(Number.isFinite(Date.parse(lines[0].t)), 'every line says when it was taken');
    assert.equal(lines[1].processes, undefined, 'a sampler with no breakdown writes none, rather than an empty list');
  });

  test('keeps only the biggest few processes of a sample, so a wide tree cannot bloat the file', () => {
    const dir = tmpDir();
    const t = new JobTelemetry(dir, 'wide', RUN, 1);
    const processes = Array.from({ length: 40 }, (_, i) => ({ pid: i + 10, ppid: 1, ramMb: 40 - i, cpuPct: 0 }));

    t.sample({ cpuPct: 1, ramMb: 800, processes });

    const [line] = readJobTelemetry(dir, 'wide');
    assert.equal(line.processes.length, 5);
    assert.deepEqual(line.processes.map(p => p.pid), [10, 11, 12, 13, 14]);
  });

  test('records the thresholds the run is held to, and the kill, as events', () => {
    const dir = tmpDir();
    const t = new JobTelemetry(dir, 'killed', RUN, 7);

    t.event('start', { soft: { cpuPct: 60, ramMb: 78 }, hard: { cpuPct: 100, ramMb: 130 } });
    t.sample({ cpuPct: 50, ramMb: 147 });
    t.event('resource-kill', { consecutiveSamples: 3 });

    const lines = readJobTelemetry(dir, 'killed');
    assert.deepEqual(lines.map(l => l.kind), ['start', 'sample', 'resource-kill']);
    assert.deepEqual(lines[0].hard, { cpuPct: 100, ramMb: 130 });
    assert.equal(lines[2].consecutiveSamples, 3);
  });

  test('is bounded: past the size cap the file is rotated and only one older file is kept', () => {
    const dir = tmpDir();
    const t = new JobTelemetry(dir, 'long', RUN, 1, { maxBytes: 600 });

    for (let i = 0; i < 60; i++) {
      t.sample({ cpuPct: i, ramMb: i });
    }

    const live = telemetryPath(dir, 'long');
    const older = path.join(dir, 'telemetry', 'long.1.ndjson');
    assert.ok(fs.statSync(live).size <= 600 + 200, 'the live file stays near the cap');
    assert.ok(fs.existsSync(older), 'the previous file is kept');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'telemetry')).sort(), ['long.1.ndjson', 'long.ndjson'],
      'never more than the live file and one older one');
  });

  test('reads rotated and live files back oldest first', () => {
    const dir = tmpDir();
    const t = new JobTelemetry(dir, 'order', RUN, 1, { maxBytes: 500 });

    for (let i = 0; i < 30; i++) {
      t.sample({ cpuPct: i, ramMb: i });
    }

    const cpu = readJobTelemetry(dir, 'order').map(l => l.cpuPct);
    assert.deepEqual(cpu, [...cpu].sort((a, b) => a - b), 'chronological');
    assert.equal(cpu[cpu.length - 1], 29);
  });

  test('a torn last line, from a crash mid-write, is skipped instead of losing the file', () => {
    const dir = tmpDir();
    const t = new JobTelemetry(dir, 'torn', RUN, 1);
    t.sample({ cpuPct: 1, ramMb: 1 });
    fs.appendFileSync(telemetryPath(dir, 'torn'), '{"kind":"sample","cpuPct":');

    assert.equal(readJobTelemetry(dir, 'torn').length, 1);
  });

  test('reads nothing, without failing, for a job that never had any', () => {
    assert.deepEqual(readJobTelemetry(tmpDir(), 'never'), []);
  });

  test('never throws into the job: a folder it cannot create is reported once, and the job runs on', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'telemetry'), 'a file where the folder should be');
    const warnings = [];
    const t = new JobTelemetry(dir, 'blocked', RUN, 1, { onWarn: (m) => warnings.push(m) });

    assert.doesNotThrow(() => { t.sample({ cpuPct: 1, ramMb: 1 }); t.sample({ cpuPct: 2, ramMb: 2 }); });
    assert.equal(warnings.length, 1, 'said once, not on every sample');
    assert.match(warnings[0], /telemetry/i);
  });

  test('refuses a job id that would escape the telemetry folder', () => {
    assert.throws(() => telemetryPath(tmpDir(), '../../etc/passwd'), /job id/i);
  });
});
