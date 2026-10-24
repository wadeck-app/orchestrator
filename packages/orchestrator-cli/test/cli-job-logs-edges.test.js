'use strict';

// `orch job <jobId> logs`: the edges of -f (multibyte text, partial lines, the end of a run, a daemon that fails),
// of the argument grammar and of which files count as runs. The follow loop is paced by a FakeTime
// (test/helpers/follow-clock.js): a test waits for the loop to be asleep, changes the world, advances one poll.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');
const { followClock } = require('./helpers/follow-clock');

const JOB = 'nightly-backup';
const USAGE = 'Usage: orch job <jobId> logs [execId] [-f|--follow] [-n|--tail <N>] [--list] [--json] [--raw]';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-job-logs-edges-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function runFile(startedAt, job = JOB) {
  return path.join(dir, 'logs', 'jobs', job, `${job}-${startedAt.replace(/:/g, '-').slice(0, 19)}.log`);
}

function writeRun(startedAt, lines, { trailingNewline = true } = {}) {
  const f = runFile(startedAt);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + (trailingNewline ? '\n' : ''));
  return f;
}

const A = '2026-10-20T03:00:00.000Z';
const B = '2026-10-21T03:00:00.000Z';
const C = '2026-10-22T03:00:00.000Z';

const ts = (n, text) => `[2026-10-22 03:00:${String(n).padStart(2, '0')}] ${text}`;
const FIN = (n) => ts(n, '[job:finished] exitCode=0 duration=1s');
const stamped = (lines) => lines.map((l, i) => ts(i, l));

function entry(startedAt, exitCode, extra = {}) {
  const finishedAt = exitCode === null ? undefined : new Date(Date.parse(startedAt) + 12_000).toISOString();
  return { startedAt, finishedAt, exitCode, pid: 1, triggeredBy: { kind: 'cron' }, ...extra };
}

async function run(argv, { history = [], job = { id: JOB }, time, listState } = {}) {
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
          return job;
        }
        if (command === 'list-state') {
          return listState ? listState() : { [JOB]: history };
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

describe('orch job <jobId> logs --follow: the edges', () => {
  test('multibyte text (accents, CJK, emoji) in the snapshot: the lines appended after it are neither duplicated nor lost', async () => {
    const snapshot = [ts(0, 'café déjà vu'), ts(1, '日本語のログ'), ts(2, 'party 🎉🎉')];
    const f = writeRun(C, snapshot);
    const clock = followClock();

    const p = run(['job', JOB, 'logs', '-f'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.appendFileSync(f, `${ts(3, 'ñandú 🚀')}\n`));
    await clock.tick(10, p, () => fs.appendFileSync(f, `${ts(4, '漢字')}\n${FIN(5)}\n`));
    const { out, exitCode } = await p;

    assert.equal(out, [...snapshot, ts(3, 'ñandú 🚀'), ts(4, '漢字'), FIN(5), '[orch] run ended with exit code 0'].join('\n') + '\n');
    assert.equal(exitCode, 0);
  });

  test('multibyte text before a held partial last line of the snapshot keeps the offset right', async () => {
    const f = writeRun(C, [ts(0, 'héllo'), ts(1, 'wörld 🎉 par')], { trailingNewline: false });
    const clock = followClock();

    const p = run(['job', JOB, 'logs', '-f'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.appendFileSync(f, `tial\n${FIN(2)}\n`));
    const { out } = await p;

    assert.equal(out, [ts(0, 'héllo'), ts(1, 'wörld 🎉 partial'), FIN(2), '[orch] run ended with exit code 0'].join('\n') + '\n');
  });

  test('a character written in two pieces (a poll lands between its bytes) is printed whole, never as U+FFFD', async () => {
    const f = writeRun(C, [ts(0, 'start')]);
    const bytes = Buffer.from(`${ts(1, 'party 🎉 done')}\n`, 'utf8');
    // Cut in the middle of the 4 bytes of the emoji.
    const cut = bytes.indexOf(Buffer.from('🎉')) + 2;
    const clock = followClock();

    const p = run(['job', JOB, 'logs', '-f'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.appendFileSync(f, bytes.subarray(0, cut)));
    await clock.tick(10, p, () => fs.appendFileSync(f, Buffer.concat([bytes.subarray(cut), Buffer.from(`${FIN(2)}\n`)])));
    const { out } = await p;

    assert.equal(out.includes('�'), false, out);
    assert.equal(out, [ts(0, 'start'), ts(1, 'party 🎉 done'), FIN(2), '[orch] run ended with exit code 0'].join('\n') + '\n');
  });

  test('a partial last line of the initial snapshot is held until it is completed, then printed once', async () => {
    const f = writeRun(C, [ts(0, 'complete'), ts(1, 'half a li')], { trailingNewline: false });
    const clock = followClock();

    const p = run(['job', JOB, 'logs', '-f'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.appendFileSync(f, `ne\n${FIN(2)}\n`));
    const { out } = await p;

    assert.equal(out, [ts(0, 'complete'), ts(1, 'half a line'), FIN(2), '[orch] run ended with exit code 0'].join('\n') + '\n');
  });

  test('[job:skipped] ends the follow like [job:finished]', async () => {
    const f = writeRun(C, [ts(0, 'waiting')]);
    const clock = followClock();

    const p = run(['job', JOB, 'logs', '-f'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.appendFileSync(f, `${ts(1, '[job:skipped] exitCode=0')}\n`));
    const { out, exitCode } = await p;

    assert.match(out, /\[job:skipped\] exitCode=0\n\[orch\] run ended with exit code 0\n$/);
    assert.equal(exitCode, 0);
  });

  test('-f on an older execution prints it, says it has ended on stderr and does not follow (exit 0)', async () => {
    writeRun(B, [ts(0, 'old run')]);
    writeRun(C, [ts(0, 'new run')]);

    const { out, err, exitCode } = await run(['job', JOB, 'logs', 'previous', '-f'], { history: [entry(B, 0), entry(C, null)] });

    assert.equal(out, ts(0, 'old run') + '\n');
    assert.equal(err, 'execution 2026-10-21T03-00-00 has ended; showing it (not following)\n');
    assert.equal(exitCode, 0);
  });

  test('-f on a run of unknown status (no history, no marker) shows it once instead of waiting for nothing', async () => {
    writeRun(C, [ts(0, 'who knows')]);

    const { out, err, exitCode } = await run(['job', JOB, 'logs', '-f'], { history: [] });

    assert.equal(out, ts(0, 'who knows') + '\n');
    assert.equal(err, 'the job is not running; showing the last run\n');
    assert.equal(exitCode, 0);
  });

  test('the daemon failing while following: exit 1, "Lost track of the run" with the cause and the command to read it again', async () => {
    const f = writeRun(C, [ts(0, 'started')]);
    let down = false;
    const clock = followClock();

    const p = run(['job', JOB, 'logs', '-f'], {
      listState: () => {
        if (down) {
          throw new Error('daemon went away');
        }
        return { [JOB]: [entry(C, null)] };
      },
      time: clock.time,
    });
    await clock.tick(10, p, () => { down = true; fs.appendFileSync(f, `${ts(1, 'still running')}\n`); });
    // The history is consulted every 8 polls.
    await clock.tick(80, p);
    const { out, err, exitCode } = await p;

    assert.equal(exitCode, 1);
    assert.equal(err, 'Lost track of the run while following (daemon went away). The run may still be going: read it again with: orch job nightly-backup logs -f\n');
    assert.equal(out.includes('run ended'), false);
  });

  test('the run file deleted while following: exit 1 with the same "Lost track" message, not a hang or a stack trace', async () => {
    const f = writeRun(C, [ts(0, 'started')]);
    const clock = followClock();

    const p = run(['job', JOB, 'logs', '-f'], { history: [entry(C, null)], time: clock.time });
    await clock.tick(10, p, () => fs.rmSync(f));
    const { err, exitCode } = await p;

    assert.equal(exitCode, 1);
    assert.match(err, /^Lost track of the run while following \(.*ENOENT.*\)\. The run may still be going: read it again with: orch job nightly-backup logs -f\n$/);
  });
});

describe('orch job <jobId> logs: arguments, the edges', () => {
  beforeEach(() => { writeRun(A, stamped(['a1', 'a2', 'a3'])); writeRun(B, stamped(['b1', 'b2', 'b3'])); });
  const history = () => [entry(A, 0), entry(B, 0)];

  test('the exec id accepts a Z suffix, fractional seconds, mixed separators and surrounding spaces', async () => {
    for (const id of ['2026-10-20T03-00-00Z', '2026-10-20T03:00:00.123Z', '2026-10-20T03:00-00', '2026-10-20 03-00:00', '  2026-10-20T03-00-00  ']) {
      const { out, exitCode } = await run(['job', JOB, 'logs', id], { history: history() });

      assert.equal(exitCode, 0, id);
      assert.match(out, /a1/, id);
    }
  });

  test('the exec id is not the file name, a date alone, a bare time or a zoned time: exit 4 naming the accepted forms', async () => {
    for (const id of ['nightly-backup-2026-10-20T03-00-00.log', '2026-10-20', '03:00:00', '2026-10-20T03-00', '2026-10-20T03-00-00+02:00']) {
      const { err, out, exitCode } = await run(['job', JOB, 'logs', id], { history: history() });

      assert.equal(exitCode, 4, id);
      assert.equal(out, '', id);
      assert.equal(err, `execId must be one of: latest, previous, a number from 1 (1 = latest, 2 = the one before), or an exec id as printed by --list (e.g. 2026-10-24T08-35-01); got "${id}".\n${USAGE}\n`);
    }
  });

  test('a repeated flag is harmless: -f -f follows once, the last -n wins', async () => {
    const dup = await run(['job', JOB, 'logs', '-f', '-f'], { history: history() });
    assert.equal(dup.exitCode, 0);
    assert.equal(dup.err, 'the job is not running; showing the last run\n');

    const { out, err } = await run(['job', JOB, 'logs', '-n', '2', '-n', '1'], { history: history() });
    assert.equal(out, stamped(['b1', 'b2', 'b3'])[2] + '\n');
    assert.match(err, /2 earlier lines not shown \(-n 1\)/);
  });

  test('-n followed by a flag does not swallow it as the value; -n 007 is 7', async () => {
    const swallowed = await run(['job', JOB, 'logs', '-n', '-f'], { history: history() });
    assert.equal(swallowed.exitCode, 4);
    assert.equal(swallowed.err, `-n needs a value.\n${USAGE}\n`);

    const padded = await run(['job', JOB, 'logs', '-n', '007'], { history: history() });
    assert.equal(padded.exitCode, 0);
    assert.equal(padded.err, '');
    assert.equal(padded.out, stamped(['b1', 'b2', 'b3']).join('\n') + '\n');
  });

  test('a -n that is not a safe integer is refused with the value and the real reason, not "whole number" again', async () => {
    const { err, exitCode } = await run(['job', JOB, 'logs', '-n', '99999999999999999999'], { history: history() });

    assert.equal(exitCode, 4);
    assert.match(err, /-n/);
    assert.match(err, /99999999999999999999/);
    assert.match(err, /too large/);
    assert.match(err, /9007199254740991/);
  });

  test('--list clashes: one message per cause, the first cause wins, full text', async () => {
    const cases = [
      [['--list', '-f'], '-f/--follow'],
      [['--list', '--follow'], '-f/--follow'],
      [['--list', '-n', '3'], '-n/--tail'],
      [['--tail', '3', '--list'], '-n/--tail'],
      [['--list', 'previous'], 'the execId "previous"'],
      [['2', '--list'], 'the execId "2"'],
      [['--list', '-n', '3', '-f', '2'], '-f/--follow'],
    ];
    for (const [flags, clash] of cases) {
      const { err, out, exitCode } = await run(['job', JOB, 'logs', ...flags], { history: history() });

      assert.equal(exitCode, 4, flags.join(' '));
      assert.equal(out, '', flags.join(' '));
      assert.equal(err, `--list lists the executions; it cannot be combined with ${clash}. Run them separately.\n${USAGE}\n`, flags.join(' '));
    }
  });

  test('--list with --json and --raw together is fine (they only shape the output)', async () => {
    const { out, exitCode } = await run(['job', JOB, 'logs', '--list', '--json', '--raw'], { history: history() });

    assert.equal(exitCode, 0);
    assert.equal(JSON.parse(out).length, 2);
  });

  test('a single hidden line says "1 earlier line", singular', async () => {
    const { err } = await run(['job', JOB, 'logs', '-n', '2'], { history: history() });

    assert.equal(err, '[orch] 1 earlier line not shown (-n 2). Drop -n for the whole run.\n');
  });

  test('a job id that starts with "-" is not a job id (exit 4, the usage of orch job)', async () => {
    for (const argv of [['job', '-x', 'logs'], ['job', '--json'], ['job', '-f', 'logs']]) {
      const { err, out, exitCode } = await run(argv);

      assert.equal(exitCode, 4, argv.join(' '));
      assert.equal(out, '', argv.join(' '));
      assert.match(err, /^Missing job id\. See the ids with: orch list\n/, argv.join(' '));
    }
  });
});

describe('orch job <jobId> logs: which files are runs', () => {
  test('a job never lists the runs of a job whose id extends its own (nightly vs nightly-backup)', async () => {
    const dirNightly = path.join(dir, 'logs', 'jobs', 'nightly');
    fs.mkdirSync(dirNightly, { recursive: true });
    fs.writeFileSync(path.join(dirNightly, 'nightly-2026-10-20T03-00-00.log'), 'mine\n');
    // Misplaced in the shorter id's folder: not a run of "nightly".
    fs.writeFileSync(path.join(dirNightly, 'nightly-backup-2026-10-21T03-00-00.log'), 'not mine\n');
    writeRun(B, ['backup run']);

    const { out } = await run(['job', 'nightly', 'logs', '--list', '--json'], { job: { id: 'nightly' }, listState: () => ({}) });

    assert.deepEqual(JSON.parse(out).map((r) => r.execId), ['2026-10-20T03-00-00']);
  });

  test('legacy one-file-per-day logs and files that only look like runs are not listed', async () => {
    writeRun(B, ['the run']);
    const d = path.dirname(runFile(B));
    for (const junk of [`${JOB}-2026-10-20.log`, `${JOB}-2026-10-20T03-00-00.log.1`, `${JOB}-2026-10-20T03-00-00.txt`, `x${JOB}-2026-10-20T03-00-00.log`, 'notes.log', `${JOB}-2026-10-20T03-00-00-extra.log`]) {
      fs.writeFileSync(path.join(d, junk), 'junk\n');
    }

    const { out } = await run(['job', JOB, 'logs', '--list', '--json'], { history: [entry(B, 0)] });

    assert.deepEqual(JSON.parse(out).map((r) => r.execId), ['2026-10-21T03-00-00']);
  });

  test('a job with only legacy day files has no log yet', async () => {
    const d = path.dirname(runFile(B));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${JOB}-2026-10-20.log`), 'legacy\n');

    const { err, exitCode } = await run(['job', JOB, 'logs']);

    assert.equal(exitCode, 1);
    assert.match(err, /has no log yet/);
  });

  test('a run file that cannot be read: "Cannot read <file>", the reason, a hint, exit 1', async () => {
    // A directory with a run file's name: listed, then refused by the read, on every platform.
    const f = runFile(B);
    fs.mkdirSync(f, { recursive: true });

    const { err, out, exitCode } = await run(['job', JOB, 'logs'], { history: [entry(B, 0)] });

    assert.equal(exitCode, 1);
    assert.equal(out, '');
    assert.ok(err.startsWith(`Cannot read ${f}: `), err);
    assert.ok(err.endsWith('. Check that the file exists and is readable.\n'), err);
  });

  test('a run pruned between the listing and the read: exit 1 with the same "Cannot read" message', async () => {
    const f = writeRun(B, ['soon gone']);

    const { err, exitCode } = await run(['job', JOB, 'logs'], {
      listState: () => { fs.rmSync(f); return {}; },
    });

    assert.equal(exitCode, 1);
    assert.ok(err.startsWith(`Cannot read ${f}: `), err);
    assert.match(err, /ENOENT/);
  });

  test('--list survives a run pruned after the listing: the row stays, status unknown', async () => {
    const f = writeRun(B, ['soon gone']);

    const { out, exitCode } = await run(['job', JOB, 'logs', '--list', '--json'], {
      listState: () => { fs.rmSync(f); return {}; },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(out).map((r) => [r.execId, r.status]), [['2026-10-21T03-00-00', 'unknown']]);
  });

  test('durations read 42s, 1m05s and 1h02m in the table', async () => {
    writeRun(A, ['a']);
    writeRun(B, ['b']);
    writeRun(C, ['c']);
    const span = (start, ms) => ({ startedAt: start, finishedAt: new Date(Date.parse(start) + ms).toISOString(), exitCode: 0, pid: 1, triggeredBy: { kind: 'cron' } });

    const { out } = await run(['job', JOB, 'logs', '--list'], { history: [span(A, 42_000), span(B, 65_000), span(C, 3_720_000)] });
    const rows = out.trimEnd().split('\n').slice(1);

    assert.match(rows[0], /\s1h02m\s/);
    assert.match(rows[1], /\s1m05s\s/);
    assert.match(rows[2], /\s42s\s/);
  });
});
