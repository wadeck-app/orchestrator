'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { State } = require('../src/state');

function tmpFile() {
  return path.join(os.tmpdir(), `orch-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe('first-run', () => {
  test('creates file with empty jobs on first access', () => {
    const f = tmpFile();
    const s = new State(f);
    s.getAll();
    assert.ok(fs.existsSync(f));
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(raw, { jobs: {} });
  });
});

describe('record()', () => {
  test('creates a new entry as array with one item', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1234 });
    const e = s.get('job-a');
    assert.equal(e.startedAt, '2026-08-22T08:00:00Z');
    assert.equal(e.exitCode, 0);
    assert.equal(e.pid, 1234);
  });

  test('second record prepends - most recent is index 0', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: null, pid: 1234 });
    s.record('job-a', { startedAt: '2026-08-22T08:00:05Z', exitCode: 1, pid: 1234 });
    // get() returns most recent (index 0)
    assert.equal(s.get('job-a').exitCode, 1);
    assert.equal(s.get('job-a').startedAt, '2026-08-22T08:00:05Z');
    // getAll() exposes array of length 2
    const all = s.getAll();
    assert.equal(all['job-a'].length, 2);
    assert.equal(all['job-a'][0].startedAt, '2026-08-22T08:00:05Z');
    assert.equal(all['job-a'][1].startedAt, '2026-08-22T08:00:00Z');
  });

  test('accepts null exitCode (still running)', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: null, pid: 999 });
    assert.equal(s.get('job-a').exitCode, null);
  });

  test('accepts null pid', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: null });
    assert.equal(s.get('job-a').pid, null);
  });

  test('persists to disk after record', () => {
    const f = tmpFile();
    const s = new State(f);
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.ok(Array.isArray(raw.jobs['job-a']));
    assert.equal(raw.jobs['job-a'].length, 1);
  });

  test('caps history at 20 entries', () => {
    const s = new State(tmpFile());
    for (let i = 0; i < 25; i++) {
      s.record('job-a', { startedAt: `2026-08-22T${String(i).padStart(2, '0')}:00:00Z`, exitCode: i, pid: i });
    }
    const all = s.getAll();
    assert.equal(all['job-a'].length, 20);
    // Most recent should be entry 24
    assert.equal(all['job-a'][0].exitCode, 24);
    // Oldest retained should be entry 5
    assert.equal(all['job-a'][19].exitCode, 5);
  });
});

describe('get()', () => {
  test('returns null for unknown id', () => {
    const s = new State(tmpFile());
    assert.equal(s.get('ghost'), null);
  });

  test('returns most recent entry for known id', () => {
    const s = new State(tmpFile());
    s.record('job-x', { startedAt: '2026-08-22T10:00:00Z', exitCode: 0, pid: 42 });
    assert.equal(s.get('job-x').pid, 42);
  });

  test('returns null for id with empty array (after migration edge case)', () => {
    const f = tmpFile();
    // Simulate an empty array written directly
    fs.writeFileSync(f, JSON.stringify({ jobs: { 'job-a': [] } }));
    const s = new State(f);
    assert.equal(s.get('job-a'), null);
  });
});

describe('getAll()', () => {
  test('returns all entries as plain object with arrays', () => {
    const s = new State(tmpFile());
    s.record('a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    s.record('b', { startedAt: '2026-08-22T09:00:00Z', exitCode: 1, pid: 2 });
    const all = s.getAll();
    assert.ok(Array.isArray(all['a']));
    assert.ok(Array.isArray(all['b']));
    assert.equal(Object.keys(all).length, 2);
  });

  test('returns a copy (mutations do not affect internal state)', () => {
    const s = new State(tmpFile());
    s.record('a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    const all = s.getAll();
    all['a'][0].exitCode = 99;
    assert.equal(s.get('a').exitCode, 0);
  });
});

describe('clear()', () => {
  test('removes an existing entry array', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    s.clear('job-a');
    assert.equal(s.get('job-a'), null);
    const all = s.getAll();
    assert.equal(all['job-a'], undefined);
  });

  test('no-op for unknown id', () => {
    const s = new State(tmpFile());
    assert.doesNotThrow(() => s.clear('ghost'));
  });
});

describe('atomic write', () => {
  test('no .tmp file left after record', () => {
    const f = tmpFile();
    const s = new State(f);
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    assert.ok(!fs.existsSync(f + '.tmp'));
  });
});

describe('persistence across instances', () => {
  test('data survives creating a new State instance on the same file', () => {
    const f = tmpFile();
    const s1 = new State(f);
    s1.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 7 });
    const s2 = new State(f);
    assert.equal(s2.get('job-a').pid, 7);
  });

  test('multiple entries survive round-trip', () => {
    const f = tmpFile();
    const s1 = new State(f);
    s1.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    s1.record('job-a', { startedAt: '2026-08-22T09:00:00Z', exitCode: 1, pid: 2 });
    const s2 = new State(f);
    const all = s2.getAll();
    assert.equal(all['job-a'].length, 2);
    assert.equal(all['job-a'][0].exitCode, 1);
  });
});

describe('backward-compat: legacy single-entry format', () => {
  test('reads old single-entry format and migrates to array', () => {
    const f = tmpFile();
    // Write old-style state (single RuntimeEntry per job)
    fs.writeFileSync(f, JSON.stringify({
      jobs: {
        'job-a': { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 7 }
      }
    }));
    const s = new State(f);
    assert.equal(s.get('job-a').pid, 7);
    const all = s.getAll();
    assert.ok(Array.isArray(all['job-a']), 'should migrate legacy entry to array');
    assert.equal(all['job-a'].length, 1);
  });
});

describe('record() - in-flight update (same startedAt)', () => {
  test('updates existing in-progress entry instead of creating duplicate when startedAt matches', () => {
    const s = new State(tmpFile());
    const startedAt = '2026-09-02T10:00:00Z';

    // Simulates scheduler: record start (in-progress)
    s.record('job-a', { startedAt, exitCode: null, pid: 999 });
    assert.equal(s.getAll()['job-a'].length, 1, 'one entry after start');
    assert.equal(s.get('job-a').exitCode, null);

    // Simulates scheduler: record completion (same startedAt)
    s.record('job-a', { startedAt, exitCode: 0, pid: 999 });
    assert.equal(s.getAll()['job-a'].length, 1, 'still ONE entry after completion - must not duplicate');
    assert.equal(s.get('job-a').exitCode, 0, 'exitCode updated to final value');
  });

  test('appends new entry when startedAt differs (real second run)', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-09-02T10:00:00Z', exitCode: 0, pid: 1 });
    s.record('job-a', { startedAt: '2026-09-02T11:00:00Z', exitCode: 1, pid: 2 });
    assert.equal(s.getAll()['job-a'].length, 2, 'two entries for two distinct runs');
  });
});

describe('getResourceBaseline', () => {
  test('returns null when fewer than 3 runs have resource data', () => {
    const s = new State(tmpFile());
    s.record('job-r', { startedAt: '2026-09-05T10:00:00Z', exitCode: 0, pid: 1, peakCpuPct: 10, peakRamMb: 50 });
    s.record('job-r', { startedAt: '2026-09-05T11:00:00Z', exitCode: 0, pid: 2, peakCpuPct: 12, peakRamMb: 55 });
    assert.equal(s.getResourceBaseline('job-r'), null, 'null when < 3 data points');
  });

  test('returns correct average for 3+ runs', () => {
    const s = new State(tmpFile());
    s.record('job-r', { startedAt: '2026-09-05T08:00:00Z', exitCode: 0, pid: 1, peakCpuPct: 10, peakRamMb: 100 });
    s.record('job-r', { startedAt: '2026-09-05T09:00:00Z', exitCode: 0, pid: 2, peakCpuPct: 20, peakRamMb: 200 });
    s.record('job-r', { startedAt: '2026-09-05T10:00:00Z', exitCode: 0, pid: 3, peakCpuPct: 30, peakRamMb: 300 });
    const b = s.getResourceBaseline('job-r');
    assert.ok(b !== null, 'baseline should exist with 3 runs');
    assert.equal(b.cpuPct, 20, 'avg CPU = 20');
    assert.equal(b.ramMb, 200, 'avg RAM = 200');
  });

  test('ignores runs without resource data', () => {
    const s = new State(tmpFile());
    s.record('job-r', { startedAt: '2026-09-05T07:00:00Z', exitCode: 0, pid: 1 });  // no resource data
    s.record('job-r', { startedAt: '2026-09-05T08:00:00Z', exitCode: 0, pid: 2, peakCpuPct: 10, peakRamMb: 100 });
    s.record('job-r', { startedAt: '2026-09-05T09:00:00Z', exitCode: 0, pid: 3, peakCpuPct: 20, peakRamMb: 200 });
    assert.equal(s.getResourceBaseline('job-r'), null, 'only 2 runs have resource data - should be null');
  });
});
