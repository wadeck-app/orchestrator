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
  test('creates a new entry', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1234 });
    const e = s.get('job-a');
    assert.equal(e.startedAt, '2026-08-22T08:00:00Z');
    assert.equal(e.exitCode, 0);
    assert.equal(e.pid, 1234);
  });

  test('updates existing entry', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: null, pid: 1234 });
    s.record('job-a', { startedAt: '2026-08-22T08:00:05Z', exitCode: 1, pid: 1234 });
    assert.equal(s.get('job-a').exitCode, 1);
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
    assert.ok(raw.jobs['job-a']);
  });
});

describe('get()', () => {
  test('returns null for unknown id', () => {
    const s = new State(tmpFile());
    assert.equal(s.get('ghost'), null);
  });

  test('returns entry for known id', () => {
    const s = new State(tmpFile());
    s.record('job-x', { startedAt: '2026-08-22T10:00:00Z', exitCode: 0, pid: 42 });
    assert.equal(s.get('job-x').pid, 42);
  });
});

describe('getAll()', () => {
  test('returns all entries as plain object', () => {
    const s = new State(tmpFile());
    s.record('a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    s.record('b', { startedAt: '2026-08-22T09:00:00Z', exitCode: 1, pid: 2 });
    const all = s.getAll();
    assert.ok(all['a']);
    assert.ok(all['b']);
    assert.equal(Object.keys(all).length, 2);
  });

  test('returns a copy (mutations do not affect internal state)', () => {
    const s = new State(tmpFile());
    s.record('a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    const all = s.getAll();
    all['a'].exitCode = 99;
    assert.equal(s.get('a').exitCode, 0);
  });
});

describe('clear()', () => {
  test('removes an existing entry', () => {
    const s = new State(tmpFile());
    s.record('job-a', { startedAt: '2026-08-22T08:00:00Z', exitCode: 0, pid: 1 });
    s.clear('job-a');
    assert.equal(s.get('job-a'), null);
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
});
