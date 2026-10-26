'use strict';

// restartOnExit, what the daemon says and remembers about a restart that has not happened yet:
//   - pendingRestarts(): which jobs wait for a restart, when, and which attempt it is (orch status);
//   - the restart counters survive a daemon restart (<configDir>/restart-state.json), so a crash-looping job does not get a
//     fresh budget each time the daemon restarts. A second Scheduler over the same config dir stands for the new daemon.
// FakeTime everywhere: the delays are crossed by advancing the clock, nothing sleeps.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeHarness, cronJob, settle, assertNoProblems, leaveRun } = require('./helpers/event-harness');
const { FakeTime } = require('../src/time-service');

afterEach(assertNoProblems);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const POLICY = { strategy: 'fixed', initialDelaySeconds: 10, maxRestarts: 3, windowSeconds: 300 };

function server(restartOnExit = POLICY, extra = {}) {
  return cronJob({ timeoutSeconds: 0, alertAfterFailures: 99, restartOnExit, ...extra });
}

async function pass(h, ms) {
  await h.time.advanceAsync(ms, SECOND);
  await settle();
}

function capture() {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

const fileOf = (h) => path.join(h.dir, 'restart-state.json');
const readFile = (h) => JSON.parse(fs.readFileSync(fileOf(h), 'utf8'));

/**
 * The daemon after a restart: a new Scheduler over the same config dir, `gapMs` later on the clock of `h`. The jobs are given
 * again because the harness keeps its registry in its own folder; the file is what must carry over. Its clock is h.time.
 */
function restarted(h, jobs, gapMs, options = {}) {
  const time = new FakeTime(h.time.now() + gapMs);
  const next = makeHarness(jobs, { ...options, scheduler: { configDir: h.dir, time, now: () => new Date(time.now()), ...(options.scheduler ?? {}) } });
  // The scheduler works in the config dir of the first daemon: that is where its files (and the runs of leaveRun) are.
  next.time = time;
  next.dir = h.dir;
  return next;
}

/** Starts `h.sched` and returns what it wrote with console.error meanwhile. */
async function startLogged(h) {
  const log = capture();
  try {
    await h.sched.start();
  } finally {
    log.restore();
  }
  return log.lines;
}

/** A server job that failed `n` times in a row, the last restart waiting: n restarts counted, attempt n. */
async function crashLoopedTo(n, job = server()) {
  const h = makeHarness([job], { exits: [7] });
  await h.sched.trigger('job');
  await settle();
  for (let i = 1; i < n; i++) {
    await pass(h, 10 * SECOND);
  }
  return h;
}

describe('pendingRestarts: what orch status shows', () => {
  test('is empty while nothing waits', async () => {
    const h = makeHarness([server()], { exits: [undefined] });
    await h.sched.trigger('job');
    await settle();
    assert.deepEqual(h.sched.pendingRestarts(), []);
  });

  test('names the job, the moment it restarts and the attempt', async () => {
    const h = makeHarness([server()], { exits: [7] });
    const before = h.time.now();
    await h.sched.trigger('job');
    await settle();

    assert.deepEqual(h.sched.pendingRestarts(), [{ jobId: 'job', dueAt: new Date(before + 10 * SECOND).toISOString(), attempt: 1 }]);
  });

  test('follows the attempt number, and is empty again once the restart has started', async () => {
    const h = makeHarness([server()], { exits: [7, 7, undefined] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, 10 * SECOND);
    assert.equal(h.sched.pendingRestarts()[0].attempt, 2);

    await pass(h, 10 * SECOND);
    assert.deepEqual(h.sched.pendingRestarts(), []);
  });

  test('forgets a restart that orch kill cancelled', async () => {
    const h = makeHarness([server()], { exits: [7] });
    await h.sched.trigger('job');
    await settle();
    await h.sched.killJob('job');
    assert.deepEqual(h.sched.pendingRestarts(), []);
  });
});

describe('the restart counters are kept in <configDir>/restart-state.json', () => {
  test('written when a restart is scheduled, with the attempt and the moments inside the window', async () => {
    const h = makeHarness([server()], { exits: [7] });
    const before = h.time.now();
    await h.sched.trigger('job');
    await settle();

    assert.deepEqual(readFile(h), { version: 1, jobs: { job: { attempt: 1, restarts: [before] } } });
    assert.equal(fs.existsSync(fileOf(h) + '.tmp'), false, 'the atomic write left its temporary file');
  });

  test('updated by each restart and emptied by a manual stop (orch kill)', async () => {
    const h = await crashLoopedTo(2);
    assert.equal(readFile(h).jobs.job.attempt, 2);
    assert.equal(readFile(h).jobs.job.restarts.length, 2);

    await h.sched.killJob('job');
    assert.deepEqual(readFile(h), { version: 1, jobs: {} });
  });

  test('not created for a job that never restarts', async () => {
    const h = makeHarness([server()], { exits: [undefined] });
    await h.sched.trigger('job');
    await h.sched.killJob('job');
    assert.equal(fs.existsSync(fileOf(h)), false);
  });

  test('stopping the daemon keeps the file as it is: it never counts as a restart nor clears the budget', async () => {
    const h = await crashLoopedTo(2);
    const before = fs.readFileSync(fileOf(h), 'utf8');

    await h.sched.stop();

    assert.equal(fs.readFileSync(fileOf(h), 'utf8'), before);
  });

  test('a write that fails is reported with the path and the cause, and the run is unaffected', async () => {
    const h = makeHarness([server()], { exits: [7] });
    // A folder where the file belongs: the rename fails on every platform.
    fs.mkdirSync(fileOf(h));
    const log = capture();
    try {
      await h.sched.trigger('job');
      await settle();
    } finally {
      log.restore();
    }
    assert.ok(log.lines.some((l) => l.includes(fileOf(h)) && /restart counters could not be saved/.test(l)), log.lines.join('\n'));
    assert.equal(h.of('job.restart_scheduled').length, 1);
  });
});

describe('after a daemon restart', () => {
  test('a run that ended while the daemon was down is counted on top of the restored counters', async () => {
    const h1 = await crashLoopedTo(2);
    await h1.sched.stop();

    const h2 = restarted(h1, [server()], 5 * SECOND);
    const lines = await startLogged(h2);
    assert.ok(lines.some((l) => /restart counters restored for job "job".*attempt 2.*2 restarts/.test(l)), lines.join('\n'));

    // The daemon (index.ts) recovers the runs first, then starts the scheduler: the counters must be there for the recovery.
    const h3 = restarted(h1, [server()], 5 * SECOND);
    leaveRun(h3, h3.time.now(), { trigger: { kind: 'restart', attempt: 2 }, startedMinutesAgo: 0.5, endedMinutesAgo: 0.1, status: { exitCode: 7 } });
    await h3.sched.recoverRuns();

    const scheduled = h3.of('job.restart_scheduled');
    assert.equal(scheduled.length, 1, h3.names().join(','));
    assert.equal(scheduled[0].payload.attempt, 3);
    assert.equal(scheduled[0].payload.restartsInWindow, 3, 'the restarts before the daemon restart were forgotten');
  });

  test('a startup job started by the new daemon keeps the restored counters: the crash loop is not given a fresh budget', async () => {
    const startup = { ...server(), type: 'startup', schedule: undefined };
    const h1 = await crashLoopedTo(3, startup);
    await h1.sched.stop();

    const h2 = restarted(h1, [startup], 5 * SECOND, { exits: [7] });
    await h2.sched.start();
    await settle();

    // 3 restarts already counted inside the window = maxRestarts: this failure is the one the job is given up on.
    assert.equal(h2.of('job.restart_abandoned').length, 1, h2.names().join(','));
    assert.equal(h2.of('job.restart_scheduled').length, 0);
  });

  test('a manual trigger after the daemon restart starts over with a full budget', async () => {
    const h1 = await crashLoopedTo(3);
    await h1.sched.stop();

    const h2 = restarted(h1, [server()], 5 * SECOND, { exits: [7] });
    await h2.sched.start();
    await h2.sched.trigger('job');
    await settle();

    assert.equal(h2.of('job.restart_abandoned').length, 0);
    assert.equal(h2.of('job.restart_scheduled')[0].payload.attempt, 1);
    assert.equal(readFile(h2).jobs.job.attempt, 1);
  });

  test('restarts older than the window are dropped, with their attempt', async () => {
    const h1 = await crashLoopedTo(2);
    await h1.sched.stop();

    const h2 = restarted(h1, [server()], 10 * MINUTE);
    const lines = await startLogged(h2);

    assert.deepEqual(readFile(h2), { version: 1, jobs: {} });
    assert.deepEqual(lines, [], 'an entry that simply aged out is normal, not a problem to report');
  });

  test('a job without restartOnExit any more is dropped, and said', async () => {
    const h1 = await crashLoopedTo(2);
    await h1.sched.stop();

    const h2 = restarted(h1, [server(false)], SECOND);
    const lines = await startLogged(h2);

    assert.ok(lines.some((l) => /job "job".*has no restartOnExit any more.*counters dropped/.test(l)), lines.join('\n'));
    assert.deepEqual(readFile(h2), { version: 1, jobs: {} });
  });

  test('a job that was removed is dropped, and said', async () => {
    const h1 = makeHarness([server()], { exits: [7] });
    fs.writeFileSync(fileOf(h1), JSON.stringify({ version: 1, jobs: { gone: { attempt: 1, restarts: [h1.time.now()] } } }));

    const lines = await startLogged(h1);

    assert.ok(lines.some((l) => /job "gone" no longer exists.*counters dropped/.test(l)), lines.join('\n'));
    assert.deepEqual(readFile(h1), { version: 1, jobs: {} });
  });

  test('a corrupt file is REPORTED with its path and what to do, and the daemon starts with empty counters', async () => {
    const h = makeHarness([server()], { exits: [7] });
    fs.writeFileSync(fileOf(h), '{ "version": 1, "jobs": {');

    const lines = await startLogged(h);

    assert.ok(lines.some((l) => l.includes(fileOf(h)) && /corrupt/i.test(l) && /empty counters/.test(l) && /delete/i.test(l)), lines.join('\n'));
    await h.sched.trigger('job');
    await settle();
    assert.equal(h.of('job.restart_scheduled')[0].payload.attempt, 1);
    assert.equal(readFile(h).version, 1, 'the next change replaces the corrupt file');
  });

  for (const [what, content] of [
    ['an unknown version', { version: 2, jobs: {} }],
    ['no jobs object', { version: 1 }],
    ['a JSON value that is not an object', [1, 2]],
  ]) {
    test(`${what} is reported the same way`, async () => {
      const h = makeHarness([server()], { exits: [7] });
      fs.writeFileSync(fileOf(h), JSON.stringify(content));

      const lines = await startLogged(h);

      assert.ok(lines.some((l) => l.includes(fileOf(h)) && /empty counters/.test(l)), lines.join('\n'));
    });
  }

  test('one bad entry is reported and dropped, the others are kept', async () => {
    const h = makeHarness([server(), server(POLICY, { id: 'other' })], { exits: [7] });
    const now = h.time.now();
    fs.writeFileSync(fileOf(h), JSON.stringify({ version: 1, jobs: {
      job: { attempt: 'many', restarts: [now] },
      other: { attempt: 1, restarts: [now - SECOND, now + 5 * MINUTE] },
    } }));

    const lines = await startLogged(h);

    assert.ok(lines.some((l) => /job "job".*invalid.*counters dropped/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /job "other".*in the future/.test(l)), lines.join('\n'));
    assert.deepEqual(readFile(h), { version: 1, jobs: { other: { attempt: 1, restarts: [now - SECOND] } } });
  });

  test('a missing file is the normal first start: nothing is reported, nothing is written', async () => {
    const h = makeHarness([server()], { exits: [7] });

    const lines = await startLogged(h);

    assert.deepEqual(lines, []);
    assert.equal(fs.existsSync(fileOf(h)), false);
  });
});
