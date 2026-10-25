'use strict';

// `orch job <jobId> logs` on a run whose log was rotated into segments (<id>-<stamp>.log, .log.2, .log.3...): the segments
// are read in order as one log, -n counts across them, -f keeps following when the writer moves to the next segment, and
// --list says how many there are. Same harness as cli-job-logs.test.js; the follow loop is paced by a FakeTime.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');
const { followClock } = require('./helpers/follow-clock');

const JOB = 'web';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-job-logs-seg-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const A = '2026-10-20T03:00:00.000Z';
const B = '2026-10-21T03:00:00.000Z';
const C = '2026-10-22T03:00:00.000Z';
const stampOf = (startedAt) => startedAt.replace(/:/g, '-').slice(0, 19);
const segFile = (startedAt, n) => path.join(dir, 'logs', 'jobs', JOB, `${JOB}-${stampOf(startedAt)}.log${n > 1 ? `.${n}` : ''}`);
const ts = (n, text) => `[2026-10-22 03:00:${String(n).padStart(2, '0')}] ${text}`;

function writeSeg(startedAt, n, lines, { trailingNewline = true } = {}) {
  const f = segFile(startedAt, n);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + (trailingNewline ? '\n' : ''));
  return f;
}

function entry(startedAt, exitCode, extra = {}) {
  const finishedAt = exitCode === null ? undefined : new Date(Date.parse(startedAt) + 12_000).toISOString();
  return { startedAt, finishedAt, exitCode, pid: 1, triggeredBy: { kind: 'cron' }, ...extra };
}

async function run(argv, { history = [], time } = {}) {
  const out = [];
  const err = [];
  const origExit = process.exit;
  const origLog = console.log;
  const origCErr = console.error;
  let exitCode = 0;
  console.log = (m) => { out.push(`${m}\n`); };
  console.error = (m) => { err.push(`${m}\n`); };
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  try {
    await runCli(argv, {
      send: async (command) => {
        if (command === 'get-job') {
          return { id: JOB };
        }
        if (command === 'list-state') {
          return { [JOB]: history };
        }
        throw new Error(`unexpected command ${command}`);
      },
      startDaemon: () => {},
      configDir: dir,
      jobLogs: { pollMs: 10, time, stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); } },
    });
  } catch (e) {
    if (e.message !== 'exit') {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origCErr;
  }
  return { out: out.join(''), err: err.join(''), exitCode };
}

const nl = (lines) => lines.join('\n') + '\n';

describe('snapshot', () => {
  test('the segments are one log: read in order, whatever order the file names sort in', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => ts(i, `line ${i}`));
    writeSeg(C, 1, lines.slice(0, 3));
    writeSeg(C, 2, lines.slice(3, 6));
    writeSeg(C, 10, lines.slice(9, 12));
    writeSeg(C, 3, lines.slice(6, 9));
    const { out, err, exitCode } = await run(['job', JOB, 'logs'], { history: [entry(C, 0)] });
    assert.equal(out, nl(lines));
    assert.equal(err, '');
    assert.equal(exitCode, 0);
  });

  test('-n counts across segments and says how many lines were cut', async () => {
    writeSeg(C, 1, [ts(0, 'a'), ts(1, 'b'), ts(2, 'c')]);
    writeSeg(C, 2, [ts(3, 'd'), ts(4, 'e')]);
    writeSeg(C, 3, [ts(5, 'f')]);
    const { out, err } = await run(['job', JOB, 'logs', '-n', '4'], { history: [entry(C, 0)] });
    assert.equal(out, nl([ts(2, 'c'), ts(3, 'd'), ts(4, 'e'), ts(5, 'f')]));
    assert.match(err, /2 earlier lines not shown \(-n 4\)/);
  });

  test('-n smaller than the last segment reads that segment only', async () => {
    writeSeg(C, 1, [ts(0, 'a'), ts(1, 'b')]);
    writeSeg(C, 2, [ts(2, 'c'), ts(3, 'd'), ts(4, 'e')]);
    const { out, err } = await run(['job', JOB, 'logs', '-n', '2'], { history: [entry(C, 0)] });
    assert.equal(out, nl([ts(3, 'd'), ts(4, 'e')]));
    assert.match(err, /3 earlier lines not shown/);
  });

  test('dropped segments are said on stderr, and the log starts at the first one kept', async () => {
    writeSeg(C, 4, [ts(0, 'x')]);
    writeSeg(C, 5, [ts(1, 'y')]);
    const { out, err, exitCode } = await run(['job', JOB, 'logs'], { history: [entry(C, 0)] });
    assert.equal(out, nl([ts(0, 'x'), ts(1, 'y')]));
    assert.match(err, /\[orch\] 3 earlier segments of this execution were dropped by log rotation; the log starts at segment 4 \(keepSegments, see docs\/daemon-config\.md\)/);
    assert.equal(exitCode, 0);
  });

  test('one dropped segment is singular', async () => {
    writeSeg(C, 2, [ts(0, 'x')]);
    const { err } = await run(['job', JOB, 'logs'], { history: [entry(C, 0)] });
    assert.match(err, /\[orch\] 1 earlier segment of this execution was dropped/);
  });

  test('the drop notice is not printed with --json on stdout, only on stderr', async () => {
    writeSeg(C, 3, [ts(0, 'x')]);
    const { out, err } = await run(['job', JOB, 'logs', '--json'], { history: [entry(C, 0)] });
    assert.deepEqual(JSON.parse(out), [{ t: '2026-10-22 03:00:00', text: 'x' }]);
    assert.match(err, /2 earlier segments of this execution were dropped/);
  });

  test('--json is one array over all the segments', async () => {
    writeSeg(C, 1, [ts(0, 'a')]);
    writeSeg(C, 2, [ts(1, 'b')]);
    const { out } = await run(['job', JOB, 'logs', '--json'], { history: [entry(C, 0)] });
    assert.deepEqual(JSON.parse(out).map((l) => l.text), ['a', 'b']);
  });

  test('escape sequences are stripped in every segment unless --raw', async () => {
    writeSeg(C, 1, [ts(0, '\x1b[31mred\x1b[0m')]);
    writeSeg(C, 2, [ts(1, '\x1b[32mgreen\x1b[0m')]);
    assert.equal((await run(['job', JOB, 'logs'], { history: [entry(C, 0)] })).out, nl([ts(0, 'red'), ts(1, 'green')]));
    assert.equal((await run(['job', JOB, 'logs', '--raw'], { history: [entry(C, 0)] })).out, nl([ts(0, '\x1b[31mred\x1b[0m'), ts(1, '\x1b[32mgreen\x1b[0m')]));
  });

  test('a segment that ends without a newline does not glue its last line to the next segment', async () => {
    writeSeg(C, 1, [ts(0, 'a'), ts(1, 'cut')], { trailingNewline: false });
    writeSeg(C, 2, [ts(2, 'b')]);
    const { out } = await run(['job', JOB, 'logs'], { history: [entry(C, 0)] });
    assert.equal(out, nl([ts(0, 'a'), ts(1, 'cut'), ts(2, 'b')]));
  });

  test('a multibyte character is whole across a read of a big segment', async () => {
    writeSeg(C, 1, [ts(0, 'café ☃')]);
    writeSeg(C, 2, [ts(1, 'été')]);
    const { out } = await run(['job', JOB, 'logs'], { history: [entry(C, 0)] });
    assert.equal(out, nl([ts(0, 'café ☃'), ts(1, 'été')]));
  });
});

describe('executions', () => {
  test('previous and numbers count runs, not files', async () => {
    writeSeg(A, 1, [ts(0, 'run A')]);
    writeSeg(B, 1, [ts(0, 'run B 1')]);
    writeSeg(B, 2, [ts(1, 'run B 2')]);
    writeSeg(C, 1, [ts(0, 'run C 1')]);
    writeSeg(C, 2, [ts(1, 'run C 2')]);
    writeSeg(C, 3, [ts(2, 'run C 3')]);
    const history = [entry(A, 0), entry(B, 0), entry(C, 0)];
    assert.equal((await run(['job', JOB, 'logs', 'previous'], { history })).out, nl([ts(0, 'run B 1'), ts(1, 'run B 2')]));
    assert.equal((await run(['job', JOB, 'logs', '3'], { history })).out, nl([ts(0, 'run A')]));
    assert.equal((await run(['job', JOB, 'logs', stampOf(B)], { history })).out, nl([ts(0, 'run B 1'), ts(1, 'run B 2')]));
  });

  test('a run whose first segment was dropped is still a run: listed, selectable by its exec id', async () => {
    writeSeg(B, 3, [ts(0, 'kept 3')]);
    writeSeg(B, 4, [ts(1, 'kept 4')]);
    const history = [entry(B, 0)];
    const listed = JSON.parse((await run(['job', JOB, 'logs', '--list', '--json'], { history })).out);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].execId, stampOf(B));
    assert.equal((await run(['job', JOB, 'logs', stampOf(B)], { history })).out, nl([ts(0, 'kept 3'), ts(1, 'kept 4')]));
  });

  test('--list says how many segments a run has, how many were dropped and its total size', async () => {
    writeSeg(B, 1, [ts(0, 'only')]);
    writeSeg(C, 4, ['x'.repeat(1500)]);
    writeSeg(C, 5, ['y'.repeat(1500)]);
    const history = [entry(B, 0), entry(C, 0)];
    const { out } = await run(['job', JOB, 'logs', '--list'], { history });
    const lines = out.trimEnd().split('\n');
    assert.match(lines[0], /^EXEC ID\s+START \(UTC\)\s+EXIT\s+DURATION\s+TRIGGER\s+SEGMENTS\s+SIZE$/);
    assert.match(lines[1], /^2026-10-22T03-00-00\s+2026-10-22 03:00:00\s+0\s+12s\s+cron\s+2 \(\+3 dropped\)\s+2\.9 KB$/);
    assert.match(lines[2], /^2026-10-21T03-00-00\s+2026-10-21 03:00:00\s+0\s+12s\s+cron\s+1\s+\d+ B$/);
    const json = JSON.parse((await run(['job', JOB, 'logs', '--list', '--json'], { history })).out);
    assert.deepEqual([json[0].segments, json[0].droppedSegments, json[0].sizeBytes], [2, 3, 3002]);
    assert.deepEqual([json[1].segments, json[1].droppedSegments], [1, 0]);
  });

  test('the exit code comes from the finished marker in the LAST segment when the history has no entry', async () => {
    writeSeg(B, 1, [ts(0, '[job:started] pid=1 triggeredBy=dependency')]);
    writeSeg(B, 2, [ts(5, '[job:finished] exitCode=2 duration=5.2s')]);
    const json = JSON.parse((await run(['job', JOB, 'logs', '--list', '--json'], { history: [] })).out);
    assert.equal(json[0].exitCode, 2);
    assert.equal(json[0].trigger, 'dependency');
    assert.equal(json[0].durationMs, 5200);
  });
});

describe('--follow across a rotation', () => {
  test('the writer moves to the next segment: nothing is skipped or printed twice, and the end is reported', async () => {
    const first = writeSeg(C, 1, [ts(0, 'started'), ts(1, 'working')]);
    const clock = followClock();
    const p = run(['job', JOB, 'logs', '--follow'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.appendFileSync(first, ts(2, 'last of segment 1') + '\n'));
    await clock.tick(10, p, () => {
      // A late line still lands in segment 1 after segment 2 exists: it is read before leaving.
      writeSeg(C, 2, [ts(3, 'first of segment 2')]);
      fs.appendFileSync(first, ts(2, 'late line of segment 1') + '\n');
    });
    await clock.tick(10, p, () => fs.appendFileSync(segFile(C, 2), ts(4, '[job:finished] exitCode=0 duration=4s') + '\n'));
    const { out, exitCode } = await p;
    assert.equal(out, nl([
      ts(0, 'started'), ts(1, 'working'), ts(2, 'last of segment 1'),
      ts(2, 'late line of segment 1'), ts(3, 'first of segment 2'),
      ts(4, '[job:finished] exitCode=0 duration=4s'),
      '[orch] run ended with exit code 0',
    ]));
    assert.equal(exitCode, 0);
  });

  test('several segments appear within one poll: all are read, in order', async () => {
    const first = writeSeg(C, 1, [ts(0, 'a')]);
    const clock = followClock();
    const p = run(['job', JOB, 'logs', '--follow'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => {
      fs.appendFileSync(first, ts(1, 'b') + '\n');
      writeSeg(C, 2, [ts(2, 'c')]);
      writeSeg(C, 3, [ts(3, 'd')]);
      writeSeg(C, 4, [ts(4, '[job:finished] exitCode=1 duration=4s')]);
    });
    const { out } = await p;
    assert.equal(out, nl([ts(0, 'a'), ts(1, 'b'), ts(2, 'c'), ts(3, 'd'), ts(4, '[job:finished] exitCode=1 duration=4s'), '[orch] run ended with exit code 1']));
  });

  test('a half-written line at the end of a segment is held, then completed in the same segment', async () => {
    const first = writeSeg(C, 1, [ts(0, 'a')]);
    const clock = followClock();
    const p = run(['job', JOB, 'logs', '--follow'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.appendFileSync(first, '[2026-10-22 03:00:01] half'));
    await clock.tick(10, p, () => fs.appendFileSync(first, ' done\n'));
    await clock.tick(10, p, () => writeSeg(C, 2, [ts(2, '[job:finished] exitCode=0 duration=2s')]));
    const { out } = await p;
    assert.equal(out, nl([ts(0, 'a'), ts(1, 'half done'), ts(2, '[job:finished] exitCode=0 duration=2s'), '[orch] run ended with exit code 0']));
  });

  test('a segment left without its newline when the writer moved on is printed as a line, not glued to the next', async () => {
    const first = writeSeg(C, 1, [ts(0, 'a')]);
    const clock = followClock();
    const p = run(['job', JOB, 'logs', '--follow'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => {
      fs.appendFileSync(first, '[2026-10-22 03:00:01] cut short');
      writeSeg(C, 2, [ts(2, '[job:finished] exitCode=0 duration=2s')]);
    });
    const { out } = await p;
    assert.equal(out, nl([ts(0, 'a'), ts(1, 'cut short'), ts(2, '[job:finished] exitCode=0 duration=2s'), '[orch] run ended with exit code 0']));
  });

  test('the follower started on a run with several segments prints the tail across them, then follows the last', async () => {
    writeSeg(C, 1, [ts(0, 'a'), ts(1, 'b')]);
    const second = writeSeg(C, 2, [ts(2, 'c'), ts(3, 'd')]);
    const clock = followClock();
    const p = run(['job', JOB, 'logs', '-f', '-n', '3'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.appendFileSync(second, ts(4, '[job:finished] exitCode=0 duration=4s') + '\n'));
    const { out, err } = await p;
    assert.equal(out, nl([ts(1, 'b'), ts(2, 'c'), ts(3, 'd'), ts(4, '[job:finished] exitCode=0 duration=4s'), '[orch] run ended with exit code 0']));
    assert.match(err, /1 earlier line not shown/);
  });

  test('segments dropped while following (the reader was too slow): it jumps to the oldest kept one and says so', async () => {
    const first = writeSeg(C, 1, [ts(0, 'a')]);
    const clock = followClock();
    const p = run(['job', JOB, 'logs', '--follow'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => {
      fs.appendFileSync(first, ts(1, 'b') + '\n');
      writeSeg(C, 2, [ts(2, 'lost 2')]);
      writeSeg(C, 3, [ts(3, 'lost 3')]);
      writeSeg(C, 4, [ts(4, 'kept 4')]);
      writeSeg(C, 5, [ts(5, '[job:finished] exitCode=0 duration=5s')]);
      fs.rmSync(first);
      fs.rmSync(segFile(C, 2));
      fs.rmSync(segFile(C, 3));
    });
    const { out, err, exitCode } = await p;
    assert.equal(out, nl([ts(0, 'a'), ts(4, 'kept 4'), ts(5, '[job:finished] exitCode=0 duration=5s'), '[orch] run ended with exit code 0']));
    assert.match(err, /\[orch\] 3 segments of this execution were dropped by log rotation while following; the output of segments 1-3 is lost/);
    assert.equal(exitCode, 0);
  });
});
