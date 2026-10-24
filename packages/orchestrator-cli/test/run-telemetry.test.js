'use strict';

// A UI draws ONE run of a job from the telemetry file. These tests hold the reader to what that needs:
// the right run, a bounded number of points that never average a spike away, the thresholds and the
// two moments (kill, end), and an honest "not available" instead of an empty success.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { telemetryPath } = require('../src/job-telemetry');
const { readRunTelemetry, MAX_TELEMETRY_POINTS } = require('../src/run-telemetry');
const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

const tmpDirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-runtel-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const RUN_A = '2026-10-18T09:00:00.000Z';
const RUN_B = '2026-10-18T10:00:00.000Z';

const at = (run, offsetS) => new Date(Date.parse(run) + offsetS * 1000).toISOString();

function write(dir, jobId, lines, { older = false, raw = '' } = {}) {
  fs.mkdirSync(path.join(dir, 'telemetry'), { recursive: true });
  const file = older ? path.join(dir, 'telemetry', `${jobId}.1.ndjson`) : telemetryPath(dir, jobId);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join('') + raw);
}

const start = (run, extra = {}) => ({ t: at(run, 0), kind: 'start', run, pid: 1, soft: null, hard: null, ...extra });
const sample = (run, offsetS, cpuPct, ramMb) => ({ t: at(run, offsetS), kind: 'sample', run, pid: 1, cpuPct, ramMb });

describe('readRunTelemetry', () => {
  test('answers the newest run by default and leaves the other runs out', async () => {
    const dir = tmpDir();
    write(dir, 'j', [
      start(RUN_A), sample(RUN_A, 2, 10, 100), sample(RUN_A, 4, 11, 101),
      start(RUN_B), sample(RUN_B, 2, 50, 500),
    ]);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.available, true);
    assert.equal(result.run, RUN_B);
    assert.deepEqual(result.samples.map(s => [s.cpuPct, s.ramMb]), [[50, 500]]);
  });

  test('a threshold side nothing defines (an absolute RAM ceiling and no baseline) is null, the other side stays', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_A, { hard: { cpuPct: null, ramMb: 512 } }), sample(RUN_A, 2, 10, 100)]);

    const result = await readRunTelemetry(dir, 'j');

    assert.deepEqual(result.hard, { cpuPct: null, ramMb: 512 });
    assert.equal(result.soft, null);
  });

  test('answers the run asked for, by its startedAt', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_A), sample(RUN_A, 2, 10, 100), start(RUN_B), sample(RUN_B, 2, 50, 500)]);

    const result = await readRunTelemetry(dir, 'j', RUN_A);

    assert.equal(result.run, RUN_A);
    assert.deepEqual(result.samples.map(s => s.cpuPct), [10]);
  });

  test('carries the thresholds, the kill and the end of the run', async () => {
    const dir = tmpDir();
    const soft = { cpuPct: 20, ramMb: 200 };
    const hard = { cpuPct: 40, ramMb: 400 };
    write(dir, 'j', [
      start(RUN_A, { soft, hard }),
      sample(RUN_A, 2, 45, 450),
      { t: at(RUN_A, 4), kind: 'resource-kill', run: RUN_A, consecutiveSamples: 3, cpuPct: 45, ramMb: 450 },
      { t: at(RUN_A, 5), kind: 'end', run: RUN_A, exitCode: null, durationMs: 5000, reason: 'resource-limit' },
    ]);

    const result = await readRunTelemetry(dir, 'j');

    assert.deepEqual(result.soft, soft);
    assert.deepEqual(result.hard, hard);
    assert.deepEqual(result.kill, { t: at(RUN_A, 4), cpuPct: 45, ramMb: 450, consecutiveSamples: 3 });
    assert.deepEqual(result.end, { t: at(RUN_A, 5), exitCode: null, durationMs: 5000, reason: 'resource-limit' });
    assert.equal(result.truncated, false);
  });

  test('an ordinary finish has a null reason, a run in progress has no end at all', async () => {
    const dir = tmpDir();
    write(dir, 'done', [start(RUN_A), sample(RUN_A, 2, 1, 1), { t: at(RUN_A, 3), kind: 'end', run: RUN_A, exitCode: 0, durationMs: 3000 }]);
    write(dir, 'going', [start(RUN_A), sample(RUN_A, 2, 1, 1)]);

    assert.equal((await readRunTelemetry(dir, 'done')).end.reason, null);
    assert.equal((await readRunTelemetry(dir, 'going')).end, undefined);
  });

  test('has null thresholds when the run started before there was a baseline', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_A), sample(RUN_A, 2, 1, 1)]);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.soft, null);
    assert.equal(result.hard, null);
  });

  test('keeps the maximum of each bucket when a long run is downsampled, so a spike survives', async () => {
    const dir = tmpDir();
    const lines = [start(RUN_A)];
    // 3000 samples, 2 s apart = 100 minutes; one lone spike in the middle.
    for (let i = 1; i <= 3000; i++) {
      lines.push(sample(RUN_A, i * 2, i === 1501 ? 99.9 : 1, i === 777 ? 9999 : 10));
    }
    write(dir, 'j', lines);

    const result = await readRunTelemetry(dir, 'j');

    assert.ok(result.samples.length <= MAX_TELEMETRY_POINTS, `got ${result.samples.length} points`);
    assert.ok(result.samples.length > MAX_TELEMETRY_POINTS / 2, 'downsampled, not collapsed');
    assert.equal(Math.max(...result.samples.map(s => s.cpuPct)), 99.9);
    assert.equal(Math.max(...result.samples.map(s => s.ramMb)), 9999);
    assert.ok(result.bucketSeconds >= 10, `3000 samples into 600 points is at least 10 s a bucket, got ${result.bucketSeconds}`);
    assert.equal(result.rawSamples, 3000);
    const times = result.samples.map(s => Date.parse(s.t));
    assert.deepEqual([...times].sort((a, b) => a - b), times, 'points stay in time order');
  });

  test('does not touch a short run: every sample is a point and bucketSeconds is null', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_A), sample(RUN_A, 2, 1, 1), sample(RUN_A, 4, 2, 2)]);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.samples.length, 2);
    assert.equal(result.bucketSeconds, null);
    assert.equal(result.rawSamples, 2);
  });

  test('ignores a torn last line, which is the daemon in the middle of appending', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_A), sample(RUN_A, 2, 7, 70)], { raw: '{"t":"2026-10-18T09:00:04.000Z","kind":"sample","run":"2026-10-18T09:00:00.000Z","cpu' });

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.available, true);
    assert.deepEqual(result.samples.map(s => s.cpuPct), [7]);
  });

  test('joins a run that rotation cut in two, and says its beginning is gone', async () => {
    const dir = tmpDir();
    // The start event stayed in the first half; here the older file holds samples only.
    write(dir, 'j', [sample(RUN_A, 2, 1, 1), sample(RUN_A, 4, 2, 2)], { older: true });
    write(dir, 'j', [sample(RUN_A, 6, 3, 3), { t: at(RUN_A, 7), kind: 'end', run: RUN_A, exitCode: 0, durationMs: 7000 }]);

    const result = await readRunTelemetry(dir, 'j');

    assert.deepEqual(result.samples.map(s => s.cpuPct), [1, 2, 3]);
    assert.equal(result.truncated, true, 'no start event: the beginning was rotated away');
    assert.equal(result.end.exitCode, 0);
  });

  test('says why when the job has no telemetry file at all', async () => {
    const result = await readRunTelemetry(tmpDir(), 'never-sampled');

    assert.equal(result.available, false);
    assert.deepEqual(result.samples, []);
    assert.match(result.reason, /no telemetry/i);
  });

  test('says why when the run asked for is not in the file any more', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_B), sample(RUN_B, 2, 1, 1)]);

    const result = await readRunTelemetry(dir, 'j', RUN_A);

    assert.equal(result.available, false);
    assert.equal(result.run, RUN_A);
    assert.match(result.reason, /rotated|no longer/i);
    assert.match(result.reason, new RegExp(RUN_A));
  });

  test('is not available, and says so, for a run that ended before its first sample', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_A), { t: at(RUN_A, 1), kind: 'end', run: RUN_A, exitCode: 0, durationMs: 1000 }]);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.available, false);
    assert.match(result.reason, /No sample was taken/);
    assert.equal(result.end.durationMs, 1000, 'the end is still reported, it is true');
  });

  test('refuses a job id that could name another file', async () => {
    await assert.rejects(() => readRunTelemetry(tmpDir(), '../secrets'), /not a valid job id/);
  });
});

describe('readRunTelemetry: files that hold nothing usable', () => {
  const NOTHING_READABLE = 'The telemetry file of job "j" holds no readable run.';

  test('an empty file is "not available" with a reason, not an empty success', async () => {
    const dir = tmpDir();
    write(dir, 'j', []);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.available, false);
    assert.equal(result.run, null);
    assert.deepEqual(result.samples, []);
    assert.equal(result.reason, NOTHING_READABLE);
  });

  test('a file of only garbage lines says nothing in it is readable', async () => {
    const dir = tmpDir();
    write(dir, 'j', [], { raw: 'not json at all\n{"a":1}\n[1,2]\n\u0000\u0000\n' });

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.available, false);
    assert.equal(result.reason, NOTHING_READABLE);
  });

  test('lines that name a run but cannot be parsed do not make the run available', async () => {
    const dir = tmpDir();
    write(dir, 'j', [], { raw: `{"t":"x","kind":"sample","run":"${RUN_A}","cpu\n` });

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.available, false);
    assert.equal(result.reason, NOTHING_READABLE);
  });

  test('a folder where the telemetry file should be is "no telemetry" (only a file counts), not a crash', async () => {
    const dir = tmpDir();
    fs.mkdirSync(telemetryPath(dir, 'j'), { recursive: true });

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.available, false);
    assert.match(result.reason, /^No telemetry has been recorded for job "j" yet/);
  });

  // Windows answers ENOENT (not ENOTDIR) for a path below a plain file, so there is no stat error to provoke there.
  test('a path that cannot be read for a reason other than "missing" is an error that names the file and what to check', { skip: process.platform === 'win32' ? 'stat answers ENOENT below a plain file on Windows' : false }, async () => {
    const dir = tmpDir();
    // The telemetry folder is a plain file: stat on a path below it is ENOTDIR, not ENOENT.
    fs.writeFileSync(path.join(dir, 'telemetry'), 'in the way');

    await assert.rejects(
      () => readRunTelemetry(dir, 'j'),
      (err) => err.message.startsWith('telemetry: cannot read ') && err.message.endsWith('Check that the file is readable by the user running the daemon.'),
    );
  });
});

describe('readRunTelemetry: which run is the newest, and what is a point', () => {
  test('a line of an older run that arrives after a newer run began does not displace the newer one', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_A), start(RUN_B), sample(RUN_B, 2, 50, 500), sample(RUN_A, 4, 10, 100)]);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.run, RUN_B);
    assert.deepEqual(result.samples.map(s => s.cpuPct), [50]);
    assert.equal(result.rawSamples, 1);
  });

  test('the newest run is found when the older file holds a newer one than the live file starts with', async () => {
    const dir = tmpDir();
    write(dir, 'j', [start(RUN_B), sample(RUN_B, 2, 50, 500)], { older: true });
    write(dir, 'j', [start(RUN_A), sample(RUN_A, 2, 10, 100)]);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.run, RUN_B, 'the newest run wins whatever the file order');
  });

  test('600 samples are all kept raw; 601 are bucketed into at most 600 points and the raw count says 601', async () => {
    const dir = tmpDir();
    const lines = (n) => [start(RUN_A), ...Array.from({ length: n }, (_, i) => sample(RUN_A, (i + 1) * 2, i, i))];
    write(dir, 'exact', lines(600));
    write(dir, 'over', lines(601));

    const exact = await readRunTelemetry(dir, 'exact');
    const over = await readRunTelemetry(dir, 'over');

    assert.equal(exact.samples.length, 600);
    assert.equal(exact.bucketSeconds, null);
    assert.equal(exact.rawSamples, 600);
    assert.ok(over.samples.length <= 600, `${over.samples.length} points`);
    assert.notEqual(over.bucketSeconds, null);
    assert.equal(over.rawSamples, 601);
    assert.equal(Math.max(...over.samples.map(s => s.cpuPct)), 600, 'the last sample is not lost to a bucket past the end');
  });

  test('a sample with an unreadable time is dropped, a sample with no number reads as 0', async () => {
    const dir = tmpDir();
    write(dir, 'j', [
      start(RUN_A),
      { ...sample(RUN_A, 2, 5, 50), t: 'not a date' },
      { ...sample(RUN_A, 4, null, null) },
      { ...sample(RUN_A, 6, '7', undefined) },
      sample(RUN_A, 8, 9, 90),
    ]);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.rawSamples, 3, 'the sample with the bad time is not a point');
    assert.deepEqual(result.samples.map(s => [s.cpuPct, s.ramMb]), [[0, 0], [0, 0], [9, 90]]);
  });

  test('a "run" key written inside the text of another field does not move the line to that run', async () => {
    const dir = tmpDir();
    const decoy = '2026-10-18T23:00:00.000Z';
    // The reason is written before the run field and carries what looks like one.
    write(dir, 'j', [
      start(RUN_A),
      sample(RUN_A, 2, 5, 50),
      { t: at(RUN_A, 4), kind: 'end', reason: `said "run":"${decoy}" in passing`, run: RUN_A, exitCode: 0, durationMs: 4000 },
    ]);

    const result = await readRunTelemetry(dir, 'j');

    assert.equal(result.run, RUN_A);
    assert.equal(result.available, true);
    assert.equal(result.end.reason, `said "run":"${decoy}" in passing`);
  });
});

describe('the get-run-telemetry command', () => {
  function env() {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state = new State(path.join(dir, 'state.json'));
    const commands = makeCommands(registry, state, {}, dir);
    return { dir, registry, commands };
  }

  test('answers the telemetry of a known job', async () => {
    const { dir, registry, commands } = env();
    registry.add({ id: 'known', type: 'startup', command: 'node -v', label: 'K' });
    write(dir, 'known', [start(RUN_A), sample(RUN_A, 2, 5, 50)]);

    const result = await commands['get-run-telemetry']({ jobId: 'known' });

    assert.equal(result.available, true);
    assert.equal(result.samples.length, 1);
  });

  test('passes the run through', async () => {
    const { dir, registry, commands } = env();
    registry.add({ id: 'known', type: 'startup', command: 'node -v', label: 'K' });
    write(dir, 'known', [start(RUN_A), sample(RUN_A, 2, 5, 50), start(RUN_B), sample(RUN_B, 2, 6, 60)]);

    const result = await commands['get-run-telemetry']({ jobId: 'known', run: RUN_A });

    assert.equal(result.run, RUN_A);
  });

  test('rejects a malformed job id with the rule and what to do', async () => {
    const { commands } = env();
    await assert.rejects(
      async () => commands['get-run-telemetry']({ jobId: '../x' }),
      /letters, digits and "-".*orch list/s,
    );
    await assert.rejects(async () => commands['get-run-telemetry']({}), /job id/);
  });

  test('rejects an unknown job id', async () => {
    const { commands } = env();
    await assert.rejects(async () => commands['get-run-telemetry']({ jobId: 'ghost' }), /Job not found: "ghost"/);
  });

  test('rejects a run that is not a string', async () => {
    const { registry, commands } = env();
    registry.add({ id: 'known', type: 'startup', command: 'node -v', label: 'K' });
    await assert.rejects(async () => commands['get-run-telemetry']({ jobId: 'known', run: 5 }), /run must be/);
  });
});
