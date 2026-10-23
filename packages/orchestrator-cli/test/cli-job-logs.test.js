'use strict';

// `orch job-logs <id>`: a job's run log as plain text (snapshot or -f), the runs of the job, and the help entry.
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

describe('orch job-logs: snapshot', () => {
  test('prints the whole newest run exactly as written, no JSON wrapper', async () => {
    writeRun(A, stamped(['old run']));
    const newest = stamped(['[job:started] pid=7 triggeredBy=cron', 'hello', '[job:finished] exitCode=0 duration=12s']);
    writeRun(B, newest);

    const { out, exitCode } = await run(['job-logs', JOB], { history: [entry(A, 0), entry(B, 0)] });

    assert.equal(out, newest.join('\n') + '\n');
    assert.equal(exitCode, 0);
  });

  test('-n keeps the last N lines and says on stderr how many were cut', async () => {
    writeRun(B, stamped(['one', 'two', 'three', 'four']));

    const { out, err, exitCode } = await run(['job-logs', JOB, '-n', '2'], { history: [entry(B, 0)] });

    assert.equal(out, stamped(['one', 'two', 'three', 'four']).slice(2).join('\n') + '\n');
    assert.match(err, /2 earlier lines not shown/);
    assert.equal(exitCode, 0);
  });

  test('--tail N is the long form and a run shorter than N says nothing', async () => {
    writeRun(B, stamped(['one', 'two']));

    const { out, err } = await run(['job-logs', JOB, '--tail', '5'], { history: [entry(B, 0)] });

    assert.equal(out, stamped(['one', 'two']).join('\n') + '\n');
    assert.equal(err, '');
  });

  test('--run previous and --run 2 read the run before the latest; --run 1 and latest the newest', async () => {
    writeRun(A, ['[2026-10-20 03:00:00] run A']);
    writeRun(B, ['[2026-10-21 03:00:00] run B']);
    writeRun(C, ['[2026-10-22 03:00:00] run C']);
    const history = [entry(A, 0), entry(B, 0), entry(C, 0)];

    assert.match((await run(['job-logs', JOB, '--run', 'previous'], { history })).out, /run B/);
    assert.match((await run(['job-logs', JOB, '--run', '2'], { history })).out, /run B/);
    assert.match((await run(['job-logs', JOB, '--run', '3'], { history })).out, /run A/);
    assert.match((await run(['job-logs', JOB, '--run', '1'], { history })).out, /run C/);
    assert.match((await run(['job-logs', JOB, '--run', 'latest'], { history })).out, /run C/);
  });

  test('--run takes a start time as printed by --list-runs', async () => {
    writeRun(A, ['[2026-10-20 03:00:00] run A']);
    writeRun(B, ['[2026-10-21 03:00:00] run B']);

    const { out, exitCode } = await run(['job-logs', JOB, '--run', '2026-10-20 03:00:00'], { history: [entry(A, 0), entry(B, 0)] });

    assert.match(out, /run A/);
    assert.equal(exitCode, 0);
  });

  test('a run that does not exist exits 1 and points to --list-runs', async () => {
    writeRun(B, ['x']);

    const { err, exitCode } = await run(['job-logs', JOB, '--run', '7'], { history: [entry(B, 0)] });

    assert.equal(exitCode, 1);
    assert.match(err, /No such run/);
    assert.match(err, /orch job-logs nightly-backup --list-runs/);
  });

  test('--json prints an array of {t,text}; a line without a stamp has t null', async () => {
    writeRun(B, ['[2026-10-21 03:00:01] hello [x]', 'bare line']);

    const { out } = await run(['job-logs', JOB, '--json'], { history: [entry(B, 0)] });

    assert.deepEqual(JSON.parse(out), [
      { t: '2026-10-21 03:00:01', text: 'hello [x]' },
      { t: null, text: 'bare line' },
    ]);
  });
});

describe('orch job-logs: --list-runs', () => {
  const history = () => [entry(A, 3, { triggeredBy: { kind: 'manual' } }), entry(B, 0), entry(C, null)];

  beforeEach(() => {
    writeRun(A, ['a']);
    writeRun(B, ['b']);
    writeRun(C, ['c']);
  });

  test('lists runs newest first with exit code or running, duration, trigger and the flag to read each', async () => {
    const { out, exitCode } = await run(['job-logs', JOB, '--list-runs'], { history: history() });
    const lines = out.trimEnd().split('\n');

    assert.equal(exitCode, 0);
    assert.match(lines[0], /^START \(UTC\)\s+EXIT\s+DURATION\s+TRIGGER\s+READ WITH$/);
    assert.match(lines[1], /^2026-10-22 03:00:00\s+running\s+\S+\s+cron\s+--run 1$/);
    assert.match(lines[2], /^2026-10-21 03:00:00\s+0\s+12s\s+cron\s+--run 2$/);
    assert.match(lines[3], /^2026-10-20 03:00:00\s+3\s+12s\s+manual\s+--run 3$/);
  });

  test('--json is an array of runs', async () => {
    const { out } = await run(['job-logs', JOB, '--list-runs', '--json'], { history: history() });
    const runs = JSON.parse(out);

    assert.equal(runs.length, 3);
    assert.deepEqual(runs[0], { run: 1, startedAt: '2026-10-22 03:00:00', status: 'running', exitCode: null, durationMs: runs[0].durationMs, trigger: 'cron' });
    assert.deepEqual(runs[2], { run: 3, startedAt: '2026-10-20 03:00:00', status: 'finished', exitCode: 3, durationMs: 12000, trigger: 'manual' });
  });

  test('a run missing from the history takes its exit code and trigger from the file markers', async () => {
    writeRun(B, ['[2026-10-21 03:00:00] [job:started] pid=1 triggeredBy=dependency', '[2026-10-21 03:00:05] [job:finished] exitCode=2 duration=5.2s']);

    const { out } = await run(['job-logs', JOB, '--list-runs', '--json'], { history: [] });
    const mid = JSON.parse(out)[1];

    assert.equal(mid.exitCode, 2);
    assert.equal(mid.trigger, 'dependency');
    assert.equal(mid.durationMs, 5200);
  });

  test('cannot be combined with -f, -n or --run (exit 4)', async () => {
    for (const extra of [['-f'], ['-n', '3'], ['--run', '2']]) {
      const { err, exitCode } = await run(['job-logs', JOB, '--list-runs', ...extra], { history: history() });
      assert.equal(exitCode, 4, extra.join(' '));
      assert.match(err, /--list-runs/);
    }
  });
});

describe('orch job-logs: errors', () => {
  test('unknown job: says so, points to orch list, exit 1', async () => {
    const { err, exitCode } = await run(['job-logs', 'nope'], { job: null });

    assert.equal(exitCode, 1);
    assert.match(err, /Job not found: "nope"\. Run `orch list`/);
  });

  test('a job with no log yet: says so with the orch trigger hint, exit 1', async () => {
    const { err, exitCode } = await run(['job-logs', JOB]);

    assert.equal(exitCode, 1);
    assert.match(err, /has no log yet/);
    assert.match(err, /orch trigger nightly-backup/);
  });

  test('bad -n values name the flag and what is accepted (exit 4)', async () => {
    for (const bad of ['0', '-3', 'abc', '1.5']) {
      const { err, exitCode } = await run(['job-logs', JOB, '-n', bad]);
      assert.equal(exitCode, 4, bad);
      assert.match(err, /-n|--tail/);
      assert.match(err, /whole number of 1 or more/);
    }
    const long = await run(['job-logs', JOB, '--tail', 'abc']);
    assert.match(long.err, /--tail must be a whole number/);
  });

  test('a bad --run value names the flag and the accepted values (exit 4)', async () => {
    const { err, exitCode } = await run(['job-logs', JOB, '--run', 'yesterday']);

    assert.equal(exitCode, 4);
    assert.match(err, /--run must be one of: latest, previous/);
    assert.match(err, /--list-runs/);
  });

  test('--run 0 is refused (runs count from 1)', async () => {
    const { exitCode } = await run(['job-logs', JOB, '--run', '0']);
    assert.equal(exitCode, 4);
  });

  test('a valued flag without a value is an error (exit 4)', async () => {
    for (const argv of [['job-logs', JOB, '-n'], ['job-logs', JOB, '--tail'], ['job-logs', JOB, '--run']]) {
      const { err, exitCode } = await run(argv);
      assert.equal(exitCode, 4, argv.join(' '));
      assert.match(err, /needs a value/);
    }
  });

  test('missing id, extra id and unknown flag are refused with the usage line (exit 4)', async () => {
    for (const [argv, re] of [
      [['job-logs'], /Missing job id/],
      [['job-logs', 'a', 'b'], /Unexpected argument "b"/],
      [['job-logs', JOB, '--bogus'], /Unknown flag "--bogus"/],
    ]) {
      const { err, exitCode } = await run(argv);
      assert.equal(exitCode, 4, argv.join(' '));
      assert.match(err, re);
      assert.match(err, /Usage: orch job-logs/);
    }
  });
});

describe('orch job-logs: --follow', () => {
  test('on a finished job: prints the last run, says it is not running on stderr, exits 0', async () => {
    writeRun(B, stamped(['hello']));

    const { out, err, exitCode } = await run(['job-logs', JOB, '-f'], { history: [entry(B, 0)] });

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

    const { out, err, exitCode } = await run(['job-logs', JOB, '--follow'], { history: base });

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

    const { out, exitCode } = await run(['job-logs', JOB, '-f'], {
      historyFn: () => [finished ? entry(C, 137) : entry(C, null)],
    });

    assert.match(out, /\[orch\] run ended with exit code 137\n$/);
    assert.equal(exitCode, 0);
  });

  test('-f with -n prints only the tail first', async () => {
    const f = writeRun(C, stamped(['one', 'two', 'three']));
    setTimeout(() => fs.appendFileSync(f, '[2026-10-22 03:00:09] [job:finished] exitCode=0 duration=1s\n'), 50);

    const { out, err } = await run(['job-logs', JOB, '-f', '-n', '1'], { history: [entry(C, null)] });

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

    const { out } = await run(['job-logs', JOB, '-f', '--json'], { history: [entry(C, null)] });
    const objs = out.trimEnd().split('\n').map(l => JSON.parse(l));

    assert.deepEqual(objs, [
      { t: '2026-10-22 03:00:00', text: 'started' },
      { t: '2026-10-22 03:00:09', text: '[job:finished] exitCode=0 duration=1s' },
      { event: 'run-ended', exitCode: 0 },
    ]);
  });
});

describe('orch job-logs: help', () => {
  test('orch --help lists the command, every flag and both examples; orch logs points to it', async () => {
    const { out } = await run(['--help']);

    assert.match(out, /orch job-logs <id>/);
    for (const flag of ['-f, --follow', '-n, --tail <N>', '--run <which>', '--list-runs', '--json']) {
      assert.ok(out.includes(flag), `help must explain ${flag}`);
    }
    assert.ok(out.includes('orch job-logs nightly-backup\n') || /orch job-logs nightly-backup\s*(#|$|\n)/m.test(out));
    assert.ok(out.includes('orch job-logs nightly-backup -f'));
    assert.ok(out.includes('for a job, prefer: orch job-logs <id> [-f]'));
  });
});
