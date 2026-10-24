'use strict';

// The real LogCorpus/LogReader: per-run log files read by byte offset, bounded, tolerant of odd lines; and the
// past runs the engine may learn from, history first, then runs only the log files remember (question q4).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createLogCorpus, createFileLogReader, mask, MAX_LOG_LINE } = require('../../src/progress/log-corpus');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

function reader(content, options = {}) {
  const dir = fx.tempDir();
  const file = path.join(dir, 'a.log');
  fs.writeFileSync(file, content);
  return { file, r: createFileLogReader(file, { runStartedAt: '2026-10-20T10:00:00.000Z', ...options }) };
}

describe('LogReader.readFrom', () => {
  test('parses "[YYYY-MM-DD HH:MM:SS] text" as UTC', () => {
    const { r } = reader('[2026-10-20 10:00:05] hello world\n[2026-10-20 10:00:07] [stderr] oops\n');
    const { lines, nextOffset } = r.readFrom(0);
    assert.deepEqual(lines.map(l => l.text), ['hello world', '[stderr] oops']);
    assert.equal(lines[0].ts.toISOString(), '2026-10-20T10:00:05.000Z');
    assert.equal(lines[1].ts.toISOString(), '2026-10-20T10:00:07.000Z');
    assert.equal(nextOffset, Buffer.byteLength('[2026-10-20 10:00:05] hello world\n[2026-10-20 10:00:07] [stderr] oops\n'));
  });

  test('an offset read returns only what was appended', () => {
    const { file, r } = reader('[2026-10-20 10:00:05] one\n');
    const first = r.readFrom(0);
    fs.appendFileSync(file, '[2026-10-20 10:00:09] two\n');
    const second = r.readFrom(first.nextOffset);
    assert.deepEqual(second.lines.map(l => l.text), ['two']);
    assert.deepEqual(r.readFrom(second.nextOffset).lines, []);
  });

  test('a line still being written (no newline) is left for the next read in a live log, kept in a finished one', () => {
    const live = reader('[2026-10-20 10:00:05] done line\n[2026-10-20 10:00:06] half wri');
    const got = live.r.readFrom(0);
    assert.deepEqual(got.lines.map(l => l.text), ['done line']);
    assert.equal(got.nextOffset, Buffer.byteLength('[2026-10-20 10:00:05] done line\n'));

    const done = reader('[2026-10-20 10:00:05] done line\n[2026-10-20 10:00:06] last', { finished: true });
    assert.deepEqual(done.r.readFrom(0).lines.map(l => l.text), ['done line', 'last']);
  });

  test('a line without a timestamp keeps the previous one; the first falls back to the run start', () => {
    const { r } = reader('no prefix at all\n[2026-10-20 10:00:05] ok\ncontinuation\r\n');
    const { lines } = r.readFrom(0);
    assert.deepEqual(lines.map(l => l.text), ['no prefix at all', 'ok', 'continuation']);
    assert.equal(lines[0].ts.toISOString(), '2026-10-20T10:00:00.000Z');
    assert.equal(lines[2].ts.toISOString(), '2026-10-20T10:00:05.000Z');
  });

  test('a line is cut to the bound', () => {
    const { r } = reader(`[2026-10-20 10:00:05] ${'x'.repeat(MAX_LOG_LINE * 3)}\n`);
    assert.equal(r.readFrom(0).lines[0].text.length, MAX_LOG_LINE);
  });

  test('a file larger than the byte cap is read up to the cap and says so', () => {
    const line = '[2026-10-20 10:00:05] 0123456789\n';
    const { r } = reader(line.repeat(100), { byteCap: line.length * 10 + 5 });
    const got = r.readFrom(0);
    assert.equal(got.lines.length, 10);
    assert.equal(got.truncated, true);
    assert.equal(got.nextOffset, line.length * 10);
  });

  test('a missing file is an empty log, not an error', () => {
    const r = createFileLogReader(path.join(fx.tempDir(), 'nope.log'), { runStartedAt: '2026-10-20T10:00:00.000Z' });
    assert.equal(r.exists(), false);
    assert.deepEqual(r.readFrom(0), { lines: [], nextOffset: 0, truncated: false });
    assert.deepEqual(r.tail(1000), []);
  });

  test('an empty file', () => {
    const { r } = reader('');
    assert.equal(r.exists(), true);
    assert.deepEqual(r.readFrom(0).lines, []);
  });
});

describe('LogReader.tail', () => {
  test('returns the last complete lines within the window, dropping the cut first one', () => {
    const body = Array.from({ length: 50 }, (_, i) => `[2026-10-20 10:00:${String(i).padStart(2, '0')}] line ${i}\n`).join('');
    const { r } = reader(body);
    const lines = r.tail(200);
    assert.ok(lines.length >= 5 && lines.length < 12, `got ${lines.length}`);
    assert.equal(lines[lines.length - 1].text, 'line 49');
    assert.match(lines[0].text, /^line \d+$/, 'the first line is whole');
  });

  test('a window larger than the file returns everything', () => {
    const { r } = reader('[2026-10-20 10:00:05] a\n[2026-10-20 10:00:06] b\n');
    assert.deepEqual(r.tail(10_000).map(l => l.text), ['a', 'b']);
  });
});

describe('mask and fingerprint', () => {
  test('digits, hex ids and paths are masked', () => {
    assert.equal(mask('Processed 1234 files in 5.2s'), 'Processed # files in #.#s');
    assert.equal(mask('commit 9f8a7b6c5d4e done'), 'commit <hex> done');
    assert.equal(mask('writing C:\\Users\\bob\\out\\a.txt now'), 'writing <path> now');
    assert.equal(mask('reading /var/data/in/file.csv now'), 'reading <path> now');
  });

  test('the fingerprint ignores values and markers but not the format', () => {
    const a = reader('[2026-10-20 10:00:00] [job:started] pid=1\n[2026-10-20 10:00:05] Step 1 of 3 took 4s\n[2026-10-20 10:00:09] Step 2 of 3 took 9s\n');
    const b = reader('[2026-10-21 11:11:11] [job:started] pid=99\n[2026-10-21 11:11:12] Step 2 of 3 took 77s\n[2026-10-21 11:11:20] Step 3 of 3 took 1s\n');
    const c = reader('[2026-10-21 11:11:12] phase alpha begins\n[2026-10-21 11:11:20] phase beta begins\n');
    assert.equal(a.r.fingerprint(), b.r.fingerprint());
    assert.notEqual(a.r.fingerprint(), c.r.fingerprint());
    assert.equal(reader('').r.fingerprint(), '', 'no lines, no fingerprint');
  });
});

function corpusOf(c, extra = {}) {
  return createLogCorpus({
    configDir: c.configDir, jobId: c.job.id, history: c.history, currentStartedAt: c.currentStartedAt, ...extra,
  });
}

describe('LogCorpus.currentRun', () => {
  test('reads the log of the open run', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 30, lines: [[5, 'Step 1']] } });
    const lines = corpusOf(c).currentRun().readFrom(0).lines.map(l => l.text);
    assert.deepEqual(lines, ['[job:started] pid=2 triggeredBy=cron', 'Step 1']);
  });

  test('the legacy daily file of the same job is never read as a run', () => {
    const c = fx.buildCase(fx.tempDir(), {
      legacyDaily: true, current: { elapsedSec: 30 }, runs: [{ agoMin: 60, durationSec: 100 }],
    });
    const past = corpusOf(c).pastRuns(20);
    assert.equal(past.length, 1);
  });
});

describe('LogCorpus.pastRuns', () => {
  test('usable runs of the history, newest first, with their log; the open run and the others are left out', () => {
    const c = fx.buildCase(fx.tempDir(), {
      current: { elapsedSec: 30 },
      runs: [
        { agoMin: 60, durationSec: 100 },
        { agoMin: 120, durationSec: 100, exitCode: 2 },
        { agoMin: 180, durationSec: 100, extra: { skipped: true } },
        { agoMin: 240, durationSec: 100, exitCode: null, extra: { cancelledByUser: true } },
        { agoMin: 300, durationSec: 100, exitCode: null, extra: { orphaned: true } },
        { agoMin: 360, durationSec: 100 },
      ],
    });
    const past = corpusOf(c).pastRuns(20);
    assert.deepEqual(past.map(p => p.entry.startedAt), [c.history[1].startedAt, c.history[6].startedAt]);
    assert.equal(past[0].reader.exists(), true);
  });

  test('a history entry whose log is gone is still returned, with a reader that says it does not exist', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 5 }, runs: [{ agoMin: 60, durationSec: 100, log: false }] });
    const [only] = corpusOf(c).pastRuns(20);
    assert.equal(only.reader.exists(), false);
  });

  test('runs only the log files remember are learned from, bounded by the limit, newest first', () => {
    const runs = Array.from({ length: 30 }, (_, i) => ({ agoMin: 60 * (i + 1), durationSec: 100 + i, inHistory: i < 5 }));
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 5 }, runs });
    const past = corpusOf(c).pastRuns(20);
    assert.equal(past.length, 20);
    const starts = past.map(p => p.entry.startedAt);
    assert.deepEqual([...starts].sort().reverse(), starts, 'newest first');
    const fromLog = past[10].entry;
    assert.equal(fromLog.exitCode, 0);
    assert.equal(Date.parse(fromLog.finishedAt) - Date.parse(fromLog.startedAt), (100 + 10) * 1000, 'duration from the [job:finished] marker');
  });

  test('a log-only run that failed, was skipped, was killed or never finished is not usable', () => {
    const runs = [
      { agoMin: 60, durationSec: 100, inHistory: false },
      { agoMin: 120, durationSec: 100, inHistory: false, exitCode: 3 },
      { agoMin: 180, durationSec: 100, inHistory: false, raw: '[2026-10-20 07:00:00] [job:started] pid=1 triggeredBy=cron\n[2026-10-20 07:00:09] [job:skipped] reason=concurrency -- x\n' },
      { agoMin: 240, durationSec: 100, inHistory: false, raw: '[2026-10-20 06:00:00] [job:started] pid=1 triggeredBy=cron\n[2026-10-20 06:01:40] [job:finished] exitCode=0 duration=100s reason=timeout\n' },
      { agoMin: 300, durationSec: 100, inHistory: false, raw: '[2026-10-20 05:00:00] [job:started] pid=1 triggeredBy=cron\n[2026-10-20 05:00:09] still going\n' },
    ];
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 5 }, runs });
    const past = corpusOf(c).pastRuns(20);
    assert.equal(past.length, 1);
    assert.equal(Date.parse(past[0].entry.startedAt), fx.T0 - 60 * fx.MIN);
  });

  test('olderThan keeps only runs that started before it (leave-one-out replay)', () => {
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 5 }, runs: [60, 120, 180].map(agoMin => ({ agoMin, durationSec: 50 })) });
    const cut = new Date(fx.T0 - 100 * fx.MIN).toISOString();
    const past = corpusOf(c, { olderThan: cut }).pastRuns(20);
    assert.equal(past.length, 2);
  });

  test('a log read past the byte cap for a past run does not load the whole file', () => {
    const big = `[2026-10-20 09:00:00] [job:started] pid=1 triggeredBy=cron\n${'[2026-10-20 09:00:01] filler line here\n'.repeat(5000)}[2026-10-20 09:01:40] [job:finished] exitCode=0 duration=100s\n`;
    const c = fx.buildCase(fx.tempDir(), { current: { elapsedSec: 5 }, runs: [{ agoMin: 60, durationSec: 100, raw: big, inHistory: false }] });
    const [only] = corpusOf(c, { pastByteCap: 10_000 }).pastRuns(20);
    assert.equal(only.entry.exitCode, 0, 'the markers are found at the end without reading the middle');
    const got = only.reader.readFrom(0);
    assert.equal(got.truncated, true);
    assert.ok(got.nextOffset <= 10_000);
  });
});
