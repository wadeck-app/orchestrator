'use strict';

// The progress strategies read run logs through createFileLogReader / createLogCorpus. A run rotated into segments
// (<id>-<stamp>.log, .log.2...) reads as ONE log for exists/size/tail (the end of the run, across segments) and the head
// (readFrom(0), fingerprint) is the first segment still kept. Documented limit: a byte offset above 0 addresses that first segment.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFileLogReader, createLogCorpus } = require('../src/progress/log-corpus');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-prog-seg-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const STARTED = '2026-10-22T03:00:00.000Z';
const line = (n, text) => `[2026-10-22 03:00:${String(n).padStart(2, '0')}] ${text}\n`;

function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('createFileLogReader over segments', () => {
  const file = () => path.join(dir, 'job-2026-10-22T03-00-00.log');
  const reader = () => createFileLogReader(file(), { runStartedAt: STARTED });

  test('exists and size cover every segment, also when the first one was dropped', () => {
    put(`${file()}.3`, line(1, 'abc'));
    put(`${file()}.4`, line(2, 'de'));
    assert.equal(reader().exists(), true);
    assert.equal(reader().size(), line(1, 'abc').length + line(2, 'de').length);
  });

  test('a run with no segment at all does not exist and is an empty log', () => {
    assert.equal(reader().exists(), false);
    assert.deepEqual(reader().tail(1000), []);
    assert.deepEqual(reader().readFrom(0).lines, []);
  });

  test('tail is the end of the run: the last segment, and the one before when the last is shorter than asked', () => {
    put(file(), line(1, 'one') + line(2, 'two'));
    put(`${file()}.2`, line(3, 'three'));
    assert.deepEqual(reader().tail(10_000).map((l) => l.text), ['one', 'two', 'three']);
    assert.deepEqual(reader().tail(line(3, 'three').length + 2).map((l) => l.text), ['three']);
  });

  test('tail with only the last segment big enough never opens the older ones', () => {
    put(file(), 'garbage that would not parse as anything useful\n');
    put(`${file()}.2`, line(3, 'three') + line(4, 'four'));
    assert.deepEqual(reader().tail(line(3, 'three').length + line(4, 'four').length).map((l) => l.text), ['three', 'four']);
  });

  test('readFrom(0) and the fingerprint are the head of the first segment kept', () => {
    put(`${file()}.5`, line(1, 'first kept') + line(2, 'second'));
    put(`${file()}.6`, line(3, 'later'));
    assert.deepEqual(reader().readFrom(0).lines.map((l) => l.text), ['first kept', 'second']);
    assert.notEqual(reader().fingerprint(), '');
  });

  test('an unrotated run behaves exactly as before', () => {
    put(file(), line(1, 'only'));
    assert.deepEqual(reader().readFrom(0).lines.map((l) => l.text), ['only']);
    assert.deepEqual(reader().tail(1000).map((l) => l.text), ['only']);
    assert.equal(reader().size(), line(1, 'only').length);
  });
});

describe('createLogCorpus over segments', () => {
  const FIN = (n, code) => line(n, `[job:finished] exitCode=${code} duration=${n}s`);

  test('a past run known only by its log is found once, whatever its number of segments', () => {
    const logDir = path.join(dir, 'logs', 'jobs', 'job');
    put(path.join(logDir, 'job-2026-10-20T03-00-00.log'), line(0, '[job:started] pid=1 triggeredBy=cron') + line(1, 'work'));
    put(path.join(logDir, 'job-2026-10-20T03-00-00.log.2'), line(2, 'more work') + FIN(10, 0));
    const corpus = createLogCorpus({ configDir: dir, jobId: 'job', history: [], currentStartedAt: '2026-10-22T03:00:00.000Z' });
    const past = corpus.pastRuns(10);
    assert.equal(past.length, 1);
    assert.equal(past[0].entry.exitCode, 0, 'the end marker is in the last segment');
    assert.deepEqual(past[0].reader.tail(10_000).map((l) => l.text).slice(-2), ['more work', '[job:finished] exitCode=0 duration=10s']);
  });

  test('a past run whose first segment was dropped is still found', () => {
    const logDir = path.join(dir, 'logs', 'jobs', 'job');
    put(path.join(logDir, 'job-2026-10-20T03-00-00.log.4'), line(0, 'late') + FIN(10, 0));
    const past = createLogCorpus({ configDir: dir, jobId: 'job', history: [], currentStartedAt: '2026-10-22T03:00:00.000Z' }).pastRuns(10);
    assert.equal(past.length, 1);
    assert.equal(past[0].entry.exitCode, 0);
  });

  test('the current run reads across its segments for the tail', () => {
    const logDir = path.join(dir, 'logs', 'jobs', 'job');
    put(path.join(logDir, 'job-2026-10-22T03-00-00.log'), line(0, 'head'));
    put(path.join(logDir, 'job-2026-10-22T03-00-00.log.2'), line(1, 'progress 40%'));
    const current = createLogCorpus({ configDir: dir, jobId: 'job', history: [], currentStartedAt: STARTED }).currentRun();
    assert.equal(current.exists(), true);
    assert.equal(current.tail(10_000).pop().text, 'progress 40%');
  });
});
