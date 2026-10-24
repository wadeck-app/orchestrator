'use strict';

// `orch job <jobId> logs [execId]`: an execution's log as plain text (snapshot or -f), the executions of the job,
// the `orch job` namespace and the help of both.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');

const JOB = 'nightly-backup';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-job-logs-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function runFile(startedAt) {
  return path.join(dir, 'logs', 'jobs', JOB, `${JOB}-${startedAt.replace(/:/g, '-').slice(0, 19)}.log`);
}

function writeRun(startedAt, lines, { trailingNewline = true } = {}) {
  const f = runFile(startedAt);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + (trailingNewline ? '\n' : ''));
  return f;
}

function stamped(lines) {
  return lines.map((l, i) => `[2026-10-20 03:00:${String(i).padStart(2, '0')}] ${l}`);
}

const A = '2026-10-20T03:00:00.000Z';
const B = '2026-10-21T03:00:00.000Z';
const C = '2026-10-22T03:00:00.000Z';

function entry(startedAt, exitCode, extra = {}) {
  const finishedAt = exitCode === null ? undefined : new Date(Date.parse(startedAt) + 12_000).toISOString();
  return { startedAt, finishedAt, exitCode, pid: 1, triggeredBy: { kind: 'cron' }, ...extra };
}

async function run(argv, { history = [], job = { id: JOB }, historyFn } = {}) {
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
          if (job instanceof Error) {
            throw job;
          }
          return job;
        }
        if (command === 'list-state') {
          return { [JOB]: historyFn ? historyFn() : history };
        }
        throw new Error(`unexpected command ${command}`);
      },
      startDaemon: () => {},
      configDir: dir,
      jobLogs: { pollMs: 10, stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); } },
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

describe('orch job <jobId> logs: snapshot', () => {
  test('prints the whole newest run exactly as written, no JSON wrapper', async () => {
    writeRun(A, stamped(['old run']));
    const newest = stamped(['[job:started] pid=7 triggeredBy=cron', 'hello', '[job:finished] exitCode=0 duration=12s']);
    writeRun(B, newest);

    const { out, exitCode } = await run(['job', JOB, 'logs'], { history: [entry(A, 0), entry(B, 0)] });

    assert.equal(out, newest.join('\n') + '\n');
    assert.equal(exitCode, 0);
  });

  test('-n keeps the last N lines and says on stderr how many were cut', async () => {
    writeRun(B, stamped(['one', 'two', 'three', 'four']));

    const { out, err, exitCode } = await run(['job', JOB, 'logs', '-n', '2'], { history: [entry(B, 0)] });

    assert.equal(out, stamped(['one', 'two', 'three', 'four']).slice(2).join('\n') + '\n');
    assert.match(err, /2 earlier lines not shown/);
    assert.equal(exitCode, 0);
  });

  test('--tail N is the long form and a run shorter than N says nothing', async () => {
    writeRun(B, stamped(['one', 'two']));

    const { out, err } = await run(['job', JOB, 'logs', '--tail', '5'], { history: [entry(B, 0)] });

    assert.equal(out, stamped(['one', 'two']).join('\n') + '\n');
    assert.equal(err, '');
  });

  test('previous and 2 read the execution before the latest; 1 and latest the newest', async () => {
    writeRun(A, ['[2026-10-20 03:00:00] run A']);
    writeRun(B, ['[2026-10-21 03:00:00] run B']);
    writeRun(C, ['[2026-10-22 03:00:00] run C']);
    const history = [entry(A, 0), entry(B, 0), entry(C, 0)];

    assert.match((await run(['job', JOB, 'logs', 'previous'], { history })).out, /run B/);
    assert.match((await run(['job', JOB, 'logs', '2'], { history })).out, /run B/);
    assert.match((await run(['job', JOB, 'logs', '3'], { history })).out, /run A/);
    assert.match((await run(['job', JOB, 'logs', '1'], { history })).out, /run C/);
    assert.match((await run(['job', JOB, 'logs', 'latest'], { history })).out, /run C/);
  });

  test('the exec id itself selects the execution: the file-name stamp and the spaced spelling', async () => {
    writeRun(A, ['[2026-10-20 03:00:00] run A']);
    writeRun(B, ['[2026-10-21 03:00:00] run B']);
    const history = [entry(A, 0), entry(B, 0)];

    const stamp = await run(['job', JOB, 'logs', '2026-10-20T03-00-00'], { history });
    const spaced = await run(['job', JOB, 'logs', '2026-10-20 03:00:00'], { history });

    assert.match(stamp.out, /run A/);
    assert.match(spaced.out, /run A/);
    assert.equal(stamp.exitCode, 0);
    assert.equal(spaced.exitCode, 0);
  });

  test('an execId that matches no run names the job and the value, points to --list, exit 1', async () => {
    writeRun(B, ['x']);

    for (const id of ['7', '2020-01-01T00-00-00']) {
      const { err, exitCode } = await run(['job', JOB, 'logs', id], { history: [entry(B, 0)] });

      assert.equal(exitCode, 1, id);
      assert.match(err, new RegExp(`No execution "${id}" for job "nightly-backup"`));
      assert.match(err, /orch job nightly-backup logs --list/);
    }
  });

  test('--json prints an array of {t,text}; a line without a stamp has t null', async () => {
    writeRun(B, ['[2026-10-21 03:00:01] hello [x]', 'bare line']);

    const { out } = await run(['job', JOB, 'logs', '--json'], { history: [entry(B, 0)] });

    assert.deepEqual(JSON.parse(out), [
      { t: '2026-10-21 03:00:01', text: 'hello [x]' },
      { t: null, text: 'bare line' },
    ]);
  });
});

describe('orch job <jobId> logs: --list', () => {
  const history = () => [entry(A, 3, { triggeredBy: { kind: 'manual' } }), entry(B, 0), entry(C, null)];

  beforeEach(() => {
    writeRun(A, ['a']);
    writeRun(B, ['b']);
    writeRun(C, ['c']);
  });

  test('lists executions newest first: exec id first, start, exit code or running, duration, trigger', async () => {
    const { out, exitCode } = await run(['job', JOB, 'logs', '--list'], { history: history() });
    const lines = out.trimEnd().split('\n');

    assert.equal(exitCode, 0);
    assert.match(lines[0], /^EXEC ID\s+START \(UTC\)\s+EXIT\s+DURATION\s+TRIGGER$/);
    assert.match(lines[1], /^2026-10-22T03-00-00\s+2026-10-22 03:00:00\s+running\s+\S+\s+cron$/);
    assert.match(lines[2], /^2026-10-21T03-00-00\s+2026-10-21 03:00:00\s+0\s+12s\s+cron$/);
    assert.match(lines[3], /^2026-10-20T03-00-00\s+2026-10-20 03:00:00\s+3\s+12s\s+manual$/);
    assert.equal(lines.length, 4);
  });

  test('a finished execution whose exit code was never recorded reads "unknown", not "null"', async () => {
    const lost = { ...entry(B, 0), exitCode: null };
    const { out } = await run(['job', JOB, 'logs', '--list'], { history: [entry(A, 3), lost, entry(C, null)] });
    const row = out.split('\n').find((l) => l.startsWith('2026-10-21T03-00-00'));

    assert.match(row, /\sunknown\s/);
    assert.equal(out.includes('null'), false);
  });

  test('--json is an array of executions', async () => {
    const { out } = await run(['job', JOB, 'logs', '--list', '--json'], { history: history() });
    const runs = JSON.parse(out);

    assert.equal(runs.length, 3);
    assert.deepEqual(runs[0], { execId: '2026-10-22T03-00-00', startedAt: '2026-10-22 03:00:00', status: 'running', exitCode: null, durationMs: runs[0].durationMs, trigger: 'cron' });
    assert.deepEqual(runs[2], { execId: '2026-10-20T03-00-00', startedAt: '2026-10-20 03:00:00', status: 'finished', exitCode: 3, durationMs: 12000, trigger: 'manual' });
  });

  test('a run missing from the history takes its exit code and trigger from the file markers', async () => {
    writeRun(B, ['[2026-10-21 03:00:00] [job:started] pid=1 triggeredBy=dependency', '[2026-10-21 03:00:05] [job:finished] exitCode=2 duration=5.2s']);

    const { out } = await run(['job', JOB, 'logs', '--list', '--json'], { history: [] });
    const mid = JSON.parse(out)[1];

    assert.equal(mid.exitCode, 2);
    assert.equal(mid.trigger, 'dependency');
    assert.equal(mid.durationMs, 5200);
  });

  test('cannot be combined with an execId, -f or -n (exit 4)', async () => {
    for (const extra of [['-f'], ['-n', '3'], ['2']]) {
      const { err, exitCode } = await run(['job', JOB, 'logs', '--list', ...extra], { history: history() });
      assert.equal(exitCode, 4, extra.join(' '));
      assert.match(err, /--list lists the executions/);
    }
  });
});

describe('orch job <jobId> logs: errors', () => {
  test('unknown job: says so, points to orch list, exit 1', async () => {
    const { err, exitCode } = await run(['job', 'nope', 'logs'], { job: null });

    assert.equal(exitCode, 1);
    assert.match(err, /Job not found: "nope"\. Run `orch list`/);
  });

  test('a job with no log yet: says so with the orch trigger hint, exit 1', async () => {
    const { err, exitCode } = await run(['job', JOB, 'logs']);

    assert.equal(exitCode, 1);
    assert.match(err, /has no log yet/);
    assert.match(err, /orch trigger nightly-backup/);
  });

  test('bad -n values name the flag and what is accepted (exit 4)', async () => {
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      const { err, exitCode } = await run(['job', JOB, 'logs', '-n', bad]);
      assert.equal(exitCode, 4, bad);
      assert.match(err, /-n|--tail/);
      assert.match(err, /whole number of 1 or more/);
    }
    const long = await run(['job', JOB, 'logs', '--tail', 'abc']);
    assert.match(long.err, /--tail must be a whole number/);
  });

  test('a bad execId names the accepted forms (exit 4)', async () => {
    const { err, exitCode } = await run(['job', JOB, 'logs', 'yesterday']);

    assert.equal(exitCode, 4);
    assert.match(err, /execId must be one of: latest, previous/);
    assert.match(err, /--list/);
  });

  test('execId 0 is refused (executions count from 1)', async () => {
    const { exitCode } = await run(['job', JOB, 'logs', '0']);
    assert.equal(exitCode, 4);
  });

  test('a valued flag without a value is an error (exit 4)', async () => {
    for (const argv of [['job', JOB, 'logs', '-n'], ['job', JOB, 'logs', '--tail'], ['job', JOB, 'logs', '-n', '--json']]) {
      const { err, exitCode } = await run(argv);
      assert.equal(exitCode, 4, argv.join(' '));
      assert.match(err, /needs a value/);
    }
  });

  test('a second execId and an unknown flag are refused with the usage line (exit 4)', async () => {
    for (const [argv, re] of [
      [['job', JOB, 'logs', 'latest', 'previous'], /Unexpected argument "previous"/],
      [['job', JOB, 'logs', '--bogus'], /Unknown flag "--bogus"/],
      [['job', JOB, 'logs', '--run', '2'], /Unknown flag "--run"/],
      [['job', JOB, 'logs', '--list-runs'], /Unknown flag "--list-runs"/],
    ]) {
      const { err, exitCode } = await run(argv);
      assert.equal(exitCode, 4, argv.join(' '));
      assert.match(err, re);
      assert.match(err, /Usage: orch job <jobId> logs/);
    }
  });
});

describe('orch job: the namespace', () => {
  test('no id, an id without sub-command and an unknown sub-command print the usage of orch job, exit 4', async () => {
    for (const [argv, re] of [
      [['job'], /Missing job id/],
      [['job', JOB], /Missing sub-command/],
      [['job', JOB, 'frobnicate'], /Unknown sub-command "frobnicate"/],
    ]) {
      const { err, out, exitCode } = await run(argv);
      assert.equal(exitCode, 4, argv.join(' '));
      assert.equal(out, '');
      assert.match(err, re);
      assert.match(err, /Usage: orch job <jobId> <sub-command>/);
      assert.match(err, /^  logs /m);
    }
  });

  test('lists only logs as sub-command', async () => {
    const { err } = await run(['job', JOB]);
    const subs = err.split('Sub-commands:')[1].split('Examples:')[0].split('\n').filter((l) => /^  \S/.test(l));

    assert.equal(subs.length, 1, subs.join('\n'));
  });

  test('the old name orch job-logs says it was renamed and exits 4', async () => {
    const { err, out, exitCode } = await run(['job-logs', JOB, '-f']);

    assert.equal(exitCode, 4);
    assert.equal(out, '');
    assert.equal(err.trim(), 'orch job-logs was renamed: use orch job <jobId> logs [execId] [-f]');
  });
});

describe('orch job <jobId> logs: --follow', () => {
  test('on a finished job: prints the last run, says it is not running on stderr, exits 0', async () => {
    writeRun(B, stamped(['hello']));

    const { out, err, exitCode } = await run(['job', JOB, 'logs', '-f'], { history: [entry(B, 0)] });

    assert.equal(out, stamped(['hello']).join('\n') + '\n');
    assert.match(err, /the job is not running; showing the last run/);
    assert.equal(exitCode, 0);
  });

  test('on a running job: prints the tail, streams new lines, and ends with the exit code from the finished marker', async () => {
    const f = writeRun(C, stamped(['started', 'working']));
    const base = [entry(C, null)];

    setTimeout(() => fs.appendFileSync(f, '[2026-10-22 03:00:10] more output\n'), 60);
    // A line written in two pieces must not be printed half.
    setTimeout(() => fs.appendFileSync(f, '[2026-10-22 03:00:11] [job:fini'), 120);
    setTimeout(() => fs.appendFileSync(f, 'shed] exitCode=3 duration=11s\n'), 180);

    const { out, err, exitCode } = await run(['job', JOB, 'logs', '--follow'], { history: base });

    assert.equal(out, [
      ...stamped(['started', 'working']),
      '[2026-10-22 03:00:10] more output',
      '[2026-10-22 03:00:11] [job:finished] exitCode=3 duration=11s',
      '[orch] run ended with exit code 3',
    ].join('\n') + '\n');
    assert.equal(err, '');
    assert.equal(exitCode, 0);
  });

  test('a run that ends without a marker is closed from the history', async () => {
    writeRun(C, stamped(['started']));
    let finished = false;
    setTimeout(() => { finished = true; }, 60);

    const { out, exitCode } = await run(['job', JOB, 'logs', '-f'], {
      historyFn: () => [finished ? entry(C, 137) : entry(C, null)],
    });

    assert.match(out, /\[orch\] run ended with exit code 137\n$/);
    assert.equal(exitCode, 0);
  });

  test('-f with -n prints only the tail first', async () => {
    const f = writeRun(C, stamped(['one', 'two', 'three']));
    setTimeout(() => fs.appendFileSync(f, '[2026-10-22 03:00:09] [job:finished] exitCode=0 duration=1s\n'), 50);

    const { out, err } = await run(['job', JOB, 'logs', '-f', '-n', '1'], { history: [entry(C, null)] });

    assert.equal(out, [
      '[2026-10-20 03:00:02] three',
      '[2026-10-22 03:00:09] [job:finished] exitCode=0 duration=1s',
      '[orch] run ended with exit code 0',
    ].join('\n') + '\n');
    assert.match(err, /2 earlier lines not shown/);
  });

  test('--json streams one {t,text} object per line and a run-ended event', async () => {
    const f = writeRun(C, ['[2026-10-22 03:00:00] started']);
    setTimeout(() => fs.appendFileSync(f, '[2026-10-22 03:00:09] [job:finished] exitCode=0 duration=1s\n'), 50);

    const { out } = await run(['job', JOB, 'logs', '-f', '--json'], { history: [entry(C, null)] });
    const objs = out.trimEnd().split('\n').map(l => JSON.parse(l));

    assert.deepEqual(objs, [
      { t: '2026-10-22 03:00:00', text: 'started' },
      { t: '2026-10-22 03:00:09', text: '[job:finished] exitCode=0 duration=1s' },
      { event: 'run-ended', exitCode: 0 },
    ]);
  });
});

describe('orch job: help', () => {
  test('orch --help has a Job category for the sub-commands of orch job, with every logs flag and the examples', async () => {
    const { out } = await run(['--help']);

    assert.match(out, /^Job \(sub-commands of one job: orch job <jobId> <sub-command>; all of them: orch job --help\):$/m);
    assert.match(out, /^ {2}orch job <jobId> logs \[execId\] \[-f\] \[-n <N>\] \[--list\] \[--json\] \[--raw\]$/m);
    for (const flag of ['execId ', '-f, --follow', '-n, --tail <N>', '--list ', '--json ', '--raw ', 'orch job <jobId> logs --help']) {
      assert.ok(out.includes(flag), `help must explain ${flag}`);
    }
    for (const example of [
      'orch job nightly-backup logs',
      'orch job nightly-backup logs 2026-10-24T08-35-01',
      'orch job nightly-backup logs previous',
      'orch job nightly-backup logs -f',
      'orch job nightly-backup logs --list',
    ]) {
      assert.match(out, new RegExp(`^ +${example}$`, 'm'), example);
    }
    assert.ok(out.includes('for a job, prefer: orch job <jobId> logs [execId] [-f]'));
    assert.equal(out.includes('job-logs'), false);
    assert.equal(out.includes('--list-runs'), false);
  });

  test('orch job --help and -h show the usage, the sub-commands, the meaning of <jobId> and examples (exit 0, stdout)', async () => {
    for (const argv of [['job', '--help'], ['job', '-h'], ['job', JOB, '--help']]) {
      const { out, err, exitCode } = await run(argv);
      assert.equal(exitCode, 0, argv.join(' '));
      assert.equal(err, '');
      assert.match(out, /^Usage: orch job <jobId> <sub-command> \[options\]$/m);
      assert.match(out, /<jobId> {6}The id of an existing job/);
      assert.match(out, /^Sub-commands:$/m);
      assert.match(out, /^ {2}logs {9}Read the log of one execution/m);
      assert.match(out, /^Examples:$/m);
    }
  });

  test('orch job <jobId> logs --help and -h show the reference in sub-categories', async () => {
    for (const argv of [['job', JOB, 'logs', '--help'], ['job', JOB, 'logs', '-h'], ['job', JOB, 'logs', '-f', '--help']]) {
      const { out, err, exitCode } = await run(argv);
      assert.equal(exitCode, 0, argv.join(' '));
      assert.equal(err, '');
      for (const heading of ['Choosing the execution', 'Following', 'Output', 'Errors and exit codes', 'Examples']) {
        assert.match(out, new RegExp(`^${heading}$`, 'm'), heading);
      }
      for (const word of ['latest', 'previous', '1, 2, 3...', '<exec id>', '--list', '-f, --follow', '-n, --tail <N>', '--json', '--raw', 'NO_COLOR']) {
        assert.ok(out.includes(word), `logs help must explain ${word}`);
      }
      assert.match(out, /^ +orch job nightly-backup logs 2026-10-24T08-35-01 /m);
      assert.match(out, /^ {2}1 {3}Unknown job/m);
      assert.match(out, /^ {2}4 {3}Usage error/m);
    }
  });
});

describe('orch job logs: the sub-command in the job id position', () => {
  const HINT = /Did you mean: orch job <jobId> logs \.\.\.\? The job id comes first\./;

  for (const argv of [['job', 'logs'], ['job', 'logs', '-f'], ['job', 'logs', 'nightly-backup']]) {
    test(`orch ${argv.join(' ')} hints at the order and exits 4`, async () => {
      const { err, exitCode } = await run(argv, { job: null });

      assert.match(err, HINT);
      assert.doesNotMatch(err, /Missing sub-command/);
      assert.equal(exitCode, 4);
    });
  }

  test('a daemon that answers "not found" with an error gives the same hint', async () => {
    const { err, exitCode } = await run(['job', 'logs', '-f'], { job: new Error('Job not found: "logs"') });

    assert.match(err, HINT);
    assert.equal(exitCode, 4);
  });

  test('a job really called "logs" keeps working: its id comes first', async () => {
    const { err } = await run(['job', 'logs'], { job: { id: 'logs' } });

    assert.match(err, /Missing sub-command for job "logs"/);
    assert.doesNotMatch(err, /Did you mean/);
  });
});
