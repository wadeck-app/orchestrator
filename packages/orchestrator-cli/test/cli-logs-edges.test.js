'use strict';

// `orch logs` (the daemon log, or one job's runs of today): argument validation, the JSON view and --follow.
// Follow waits on the output itself (a promise resolved when the text shows up), never on a timer. The date is
// frozen so "today" cannot change under a test.
const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');

const TODAY = '2026-10-24';

let dir;
beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: Date.parse(`${TODAY}T12:00:00.000Z`) });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logs-edges-'));
});
afterEach(() => {
  mock.timers.reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

function daemonLog(content) {
  const f = path.join(dir, 'logs', 'daemon', `daemon-${TODAY}.log`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

function jobRun(jobId, time, content) {
  const f = path.join(dir, 'logs', 'jobs', jobId, `${jobId}-${TODAY}T${time}.log`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

/** Starts `orch logs ...` with stdout/stderr/exit captured; `waitFor(text)` resolves when stdout holds it. */
function start(argv) {
  const stdout = [];
  const stderr = [];
  const waiters = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const origExit = process.exit;
  let exitCode = 0;
  const text = () => stdout.join('');
  // The test runner reports through these streams with binary chunks while the capture is on: let them through.
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') {
      return origOut.call(process.stdout, chunk, ...rest);
    }
    stdout.push(chunk);
    for (const w of waiters.splice(0)) {
      if (text().includes(w.needle)) {
        w.resolve();
      } else {
        waiters.push(w);
      }
    }
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    if (typeof chunk !== 'string') {
      return origErr.call(process.stderr, chunk, ...rest);
    }
    stderr.push(chunk);
    return true;
  };
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  const restore = () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exit = origExit;
  };
  const done = runCli(argv, { send: async () => ({}), startDaemon: () => {}, configDir: dir })
    .catch((e) => {
      if (e.message !== 'exit') {
        throw e;
      }
    })
    .finally(restore)
    .then(() => ({ out: text(), err: stderr.join(''), exitCode }));
  return {
    done,
    text,
    waitFor: (needle) => (text().includes(needle) ? Promise.resolve() : new Promise((resolve) => { waiters.push({ needle, resolve }); })),
    interrupt: () => process.emit('SIGINT'),
  };
}

const run = (argv) => start(argv).done;

describe('orch logs: --tail', () => {
  beforeEach(() => { daemonLog('[2026-10-24 10:00:00] one\n[2026-10-24 10:00:01] two\n[2026-10-24 10:00:02] three\n'); });

  test('a --tail that is not a whole number is a usage error (exit 4) naming the value, and prints nothing', async () => {
    for (const bad of ['abc', '-2', '1.5', '', '2x', '1e3']) {
      const { out: o, err, exitCode } = await run(['logs', '--tail', bad]);

      assert.equal(exitCode, 4, `"${bad}"`);
      assert.equal(o, '', `"${bad}"`);
      assert.match(err, /--tail must be a whole number of 0 or more/, `"${bad}"`);
      assert.ok(err.includes(`got "${bad}"`), err);
    }
  });

  test('--tail without a value, or followed by another flag, says it needs a value (exit 4)', async () => {
    for (const argv of [['logs', '--tail'], ['logs', '--tail', '--json'], ['logs', '--follow', '--tail']]) {
      const { out: o, err, exitCode } = await run(argv);

      assert.equal(exitCode, 4, argv.join(' '));
      assert.equal(o, '', argv.join(' '));
      assert.match(err, /--tail needs a value/, argv.join(' '));
    }
  });

  test('--tail 2 keeps the last two lines; a number above the line count keeps all of them', async () => {
    const two = await run(['logs', '--tail', '2']);
    assert.deepEqual(two.out.trimEnd().split('\n').map((l) => JSON.parse(l).message), ['two', 'three']);

    const many = await run(['logs', '--tail', '50']);
    assert.equal(many.out.trimEnd().split('\n').length, 3);
  });

  test('--tail 0 shows no history (it is how to ask for only the new lines with --follow) and exits 0', async () => {
    const { out: o, err, exitCode } = await run(['logs', '--tail', '0']);

    assert.equal(o, '');
    assert.equal(err, '');
    assert.equal(exitCode, 0);
  });
});

describe('orch logs: --since', () => {
  test('--since is refused instead of silently ignored: exit 4, says it is not supported and what to use instead', async () => {
    daemonLog('[2026-10-24 10:00:00] one\n');

    const { out: o, err, exitCode } = await run(['logs', '--since', '1h']);

    assert.equal(exitCode, 4);
    assert.equal(o, '');
    assert.match(err, /--since is not supported/);
    assert.match(err, /--tail/);
  });
});

describe('orch logs --job: the job id', () => {
  test('an id that would leave logs/jobs is refused (exit 4), whether or not the target exists', async () => {
    fs.mkdirSync(path.join(dir, 'logs', 'secret'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs', 'secret', `secret-${TODAY}T10-00-00.log`), 'TOP SECRET\n');
    for (const id of ['../x', '..', '.', '../secret', '..\\secret', 'a/b', 'a\\b', '/etc', 'C:\\Windows', 'job id', 'jöb']) {
      const { out: o, err, exitCode } = await run(['logs', '--job', id]);

      assert.equal(exitCode, 4, id);
      assert.equal(o, '', id);
      assert.ok(err.includes(`Invalid job id "${id}"`), err);
      assert.match(err, /letters, digits and "-"/);
      assert.match(err, /orch list/);
    }
  });

  test('--job without a value, or followed by a flag, says it needs a value (exit 4)', async () => {
    for (const argv of [['logs', '--job'], ['logs', '--job', '--json'], ['logs', '--follow', '--job']]) {
      const { out: o, err, exitCode } = await run(argv);

      assert.equal(exitCode, 4, argv.join(' '));
      assert.equal(o, '', argv.join(' '));
      assert.match(err, /--job needs a job id/, argv.join(' '));
    }
  });

  test('a valid id keeps working, and a job id that starts with a prefix of another does not mix their runs', async () => {
    jobRun('nightly', '10-00-00', '[2026-10-24 10:00:00] mine\n');
    jobRun('nightly-backup', '10-00-00', '[2026-10-24 10:00:00] not mine\n');

    const { out: o, exitCode } = await run(['logs', '--job', 'nightly']);

    assert.equal(exitCode, 0);
    assert.equal(o.includes('mine'), true);
    assert.equal(o.includes('not mine'), false);
  });
});

describe('orch logs: the JSON view', () => {
  test('a line is split into timestamp and message only when it STARTS with a stamp', async () => {
    daemonLog([
      '[2026-10-24 10:00:00] starts with a stamp',
      'foo [2026-01-01 10:00:00] bar',
      '[1] items done',
      'no stamp at all',
      '[2026-10-24 10:00:01] says [2026-10-24 10:00:02] twice',
    ].join('\n') + '\n');

    const { out: o } = await run(['logs']);

    assert.deepEqual(o.trimEnd().split('\n').map((l) => JSON.parse(l)), [
      { timestamp: '2026-10-24 10:00:00', message: 'starts with a stamp' },
      { message: 'foo [2026-01-01 10:00:00] bar' },
      { message: '[1] items done' },
      { message: 'no stamp at all' },
      { timestamp: '2026-10-24 10:00:01', message: 'says [2026-10-24 10:00:02] twice' },
    ]);
  });
});

describe('orch logs --follow', () => {
  test('--job whose log folder does not exist: a clear message and exit 1, not an unhandled ENOENT', async () => {
    const { err, exitCode } = await run(['logs', '--follow', '--job', 'never-ran']);

    assert.equal(exitCode, 1);
    assert.match(err, /Cannot follow job "never-ran": it has no log folder/);
    assert.match(err, /orch list/);
  });

  test('--job: a run that starts after the follow began is read from its first line, the previous one is not repeated', async () => {
    const first = jobRun('tick', '10-00-00', '[2026-10-24 10:00:00] one\n');
    const cli = start(['logs', '--follow', '--job', 'tick']);

    await cli.waitFor('one');
    fs.appendFileSync(first, '[2026-10-24 10:00:01] two\n');
    await cli.waitFor('two');
    jobRun('tick', '11-00-00', '[2026-10-24 11:00:00] fresh run\n');
    await cli.waitFor('fresh run');
    fs.appendFileSync(path.join(dir, 'logs', 'jobs', 'tick', `tick-${TODAY}T11-00-00.log`), '[2026-10-24 11:00:01] more\n');
    await cli.waitFor('more');
    cli.interrupt();
    const { out: o, exitCode } = await cli.done;

    assert.deepEqual(o.trimEnd().split('\n').map((l) => JSON.parse(l).message), ['one', 'two', 'fresh run', 'more']);
    assert.equal(exitCode, 0);
  });

  test('the daemon log missing at the start: says so, then prints the lines once the file appears', async () => {
    const cli = start(['logs', '--follow']);

    await cli.waitFor('No daemon logs for today');
    daemonLog('[2026-10-24 10:00:00] daemon up\n');
    await cli.waitFor('daemon up');
    cli.interrupt();
    const { out: o, exitCode } = await cli.done;

    assert.equal(o.includes('daemon up'), true);
    assert.equal(o.split('daemon up').length, 2, 'printed once');
    assert.equal(exitCode, 0);
  });

  test('the daemon log: lines appended after the snapshot are printed once, in order', async () => {
    const f = daemonLog('[2026-10-24 10:00:00] first\n');
    const cli = start(['logs', '--follow']);

    await cli.waitFor('first');
    fs.appendFileSync(f, '[2026-10-24 10:00:01] second\n');
    await cli.waitFor('second');
    cli.interrupt();
    const { out: o } = await cli.done;

    assert.deepEqual(o.trimEnd().split('\n').map((l) => JSON.parse(l).message), ['first', 'second']);
  });
});
