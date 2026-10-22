'use strict';

// The long consumption history: one compact JSON line per closed run in
// <configDir>/resource-history/<jobId>.ndjson, newest 500 kept, read through `get-resource-history`.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  appendResourceHistory, readResourceHistory, resourceHistoryPath, RESOURCE_HISTORY_RETENTION,
} = require('../src/resource-history');
const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

const tmpDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reshist-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function record(i, extra = {}) {
  const startedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  return {
    startedAt, finishedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i, 500)).toISOString(), durationMs: 500,
    exitCode: 0, peakCpuPct: 10 + i, peakRamMb: 100 + i, avgCpuPct: 5, avgRamMb: 90, samples: 4,
    soft: { cpuPct: 15, ramMb: 150 }, hard: { cpuPct: 30, ramMb: 300 }, enforce: 'kill', ...extra,
  };
}

describe('appendResourceHistory', () => {
  test('writes one JSON line per run under resource-history/<jobId>.ndjson', () => {
    const dir = tmp();
    appendResourceHistory(dir, 'job-a', record(1));
    appendResourceHistory(dir, 'job-a', record(2, { endReason: 'resource-limit', exitCode: 1 }));
    const file = path.join(dir, 'resource-history', 'job-a.ndjson');
    assert.equal(resourceHistoryPath(dir, 'job-a'), file);
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), record(1));
    assert.equal(JSON.parse(lines[1]).endReason, 'resource-limit');
  });

  test('refuses a job id that cannot be a file name', () => {
    assert.throws(() => appendResourceHistory(tmp(), '../evil', record(1)), /job id/);
  });

  test('keeps the newest 500 lines when the file grows past it', () => {
    const dir = tmp();
    assert.equal(RESOURCE_HISTORY_RETENTION, 500);
    for (let i = 0; i < 503; i++) {
      appendResourceHistory(dir, 'job-a', record(i));
    }
    const lines = fs.readFileSync(resourceHistoryPath(dir, 'job-a'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 500);
    assert.equal(JSON.parse(lines[0]).peakCpuPct, 13, 'the oldest three were dropped');
    assert.equal(JSON.parse(lines[499]).peakCpuPct, 512);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'resource-history')), ['job-a.ndjson'], 'no temp file left behind');
  });
});

describe('readResourceHistory', () => {
  test('no file: empty answer, not an error', () => {
    assert.deepEqual(readResourceHistory(tmp(), 'nope'), { runs: [], total: 0, retention: 500 });
  });

  test('newest first, total counts every stored run, default limit 100', () => {
    const dir = tmp();
    for (let i = 0; i < 150; i++) {
      appendResourceHistory(dir, 'job-a', record(i));
    }
    const r = readResourceHistory(dir, 'job-a');
    assert.equal(r.total, 150);
    assert.equal(r.retention, 500);
    assert.equal(r.runs.length, 100);
    assert.equal(r.runs[0].peakCpuPct, 159);
    assert.equal(r.runs[99].peakCpuPct, 60);
  });

  test('an explicit limit', () => {
    const dir = tmp();
    for (let i = 0; i < 5; i++) {
      appendResourceHistory(dir, 'job-a', record(i));
    }
    assert.equal(readResourceHistory(dir, 'job-a', 2).runs.length, 2);
  });

  test('a torn or foreign line is skipped, the rest is served', () => {
    const dir = tmp();
    appendResourceHistory(dir, 'job-a', record(1));
    fs.appendFileSync(resourceHistoryPath(dir, 'job-a'), '{"startedAt":"2026-01\n');
    appendResourceHistory(dir, 'job-a', record(2));
    const r = readResourceHistory(dir, 'job-a');
    assert.equal(r.total, 2);
    assert.equal(r.runs.length, 2);
  });
});

describe('get-resource-history', () => {
  function env() {
    const dir = tmp();
    const registry = new Registry(path.join(dir, 'registry.json'));
    registry.add({ id: 'j1', type: 'cron', schedule: '0 9 * * *', command: 'node -v' });
    const scheduler = { killJob: async () => ({ killed: false }), skipNextFiring: () => {}, scheduleJob: () => {}, unscheduleJob: () => {} };
    const commands = makeCommands(registry, new State(path.join(dir, 'state.json')), scheduler, dir);
    return { dir, commands };
  }

  test('answers { runs, total, retention }, newest first', () => {
    const { dir, commands } = env();
    for (let i = 0; i < 3; i++) {
      appendResourceHistory(dir, 'j1', record(i));
    }
    const r = commands['get-resource-history']({ jobId: 'j1' });
    assert.equal(r.total, 3);
    assert.equal(r.retention, 500);
    assert.deepEqual(r.runs.map(x => x.peakCpuPct), [12, 11, 10]);
  });

  test('a job without history answers empty', () => {
    const { commands } = env();
    assert.deepEqual(commands['get-resource-history']({ jobId: 'j1' }), { runs: [], total: 0, retention: 500 });
  });

  test('an unknown job is refused like get-run-telemetry does', () => {
    const { commands } = env();
    assert.throws(() => commands['get-resource-history']({ jobId: 'ghost' }), /Job not found: "ghost".*orch list/s);
  });

  test('a bad job id is refused with the rule', () => {
    const { commands } = env();
    assert.throws(() => commands['get-resource-history']({ jobId: '../x' }), /get-resource-history needs a job id/);
    assert.throws(() => commands['get-resource-history']({}), /get-resource-history needs a job id/);
  });

  for (const limit of [0, -1, 501, 1.5, 'ten', null]) {
    test(`limit ${JSON.stringify(limit)} is refused with the range`, () => {
      const { commands } = env();
      assert.throws(() => commands['get-resource-history']({ jobId: 'j1', limit }), /limit.*whole number.*1.*500/s);
    });
  }

  test('limit 500 is accepted', () => {
    const { commands } = env();
    assert.equal(commands['get-resource-history']({ jobId: 'j1', limit: 500 }).total, 0);
  });
});
