'use strict';

// restartOnExit, driven through the REAL Scheduler: a child the test controls, a clock the test moves (FakeTime), and a
// publisher that checks every event against the catalog. Nothing sleeps: the delays are crossed by advancing the clock.
//
// What a user relies on, and what each group pins down:
//   - ANY exit brings the job back (code 0, a failure, a signal, the job's own timeout), after a growing pause;
//   - a MANUAL kill never does, and also cancels a restart that was waiting;
//   - a job that cannot stay up is given up on, visibly, and stays stopped;
//   - a run that stayed up long enough clears the memory of its past failures;
//   - nothing restarts a job that was disabled, removed, edited out of the policy, or that is already running again.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeHarness, cronJob, settle, assertNoProblems } = require('./helpers/event-harness');

afterEach(assertNoProblems);

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** A long-running server: no timeout, restarted after every exit. alertAfterFailures high so the events read cleanly. */
function server(restartOnExit = true, extra = {}) {
  return cronJob({ timeoutSeconds: 0, alertAfterFailures: 99, restartOnExit, ...extra });
}

/** The text of every run log of the job, oldest first. */
function runLogs(h, jobId = 'job') {
  const dir = path.join(h.dir, 'logs', 'jobs', jobId);
  return fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
}

/** Lets `ms` of fake time pass, in steps of one second so each restart that falls due can start and end before the next. */
async function pass(h, ms) {
  await h.time.advanceAsync(ms, SECOND);
  await settle();
}

describe('any exit brings the job back', () => {
  const cases = [
    ['exit code 0', 0, 'job.completed'],
    ['a failure', 1, 'job.failed'],
    ['another failure', 137, 'job.failed'],
    // A child killed by a signal closes with a null code, which the scheduler records as exit 1.
    ['a signal (no exit code)', null, 'job.failed'],
  ];
  for (const [what, code, terminal] of cases) {
    test(`${what}: restarted after the first delay, as a "restart" run`, async () => {
      const h = makeHarness([server()], { exits: [code, undefined] });
      await h.sched.trigger('job');
      await settle();
      assert.deepEqual(h.names(), ['job.started', terminal, 'job.restart_scheduled']);
      assert.equal(h.spawned.length, 1);

      await pass(h, 999);
      assert.equal(h.spawned.length, 1, 'not before the delay');
      await pass(h, 1);
      assert.equal(h.spawned.length, 2);
      assert.deepEqual(h.of('job.started').map((e) => e.payload.trigger), ['manual', 'restart']);
      assert.equal(h.sched.runningCount('job'), 1);
    });
  }

  test('the restart is announced with what the user needs to follow it', async () => {
    const h = makeHarness([server()], { exits: [3, undefined] });
    await h.sched.trigger('job');
    await settle();
    assert.deepEqual(h.of('job.restart_scheduled')[0].payload, {
      jobId: 'job', label: 'Job', exitCode: 3, attempt: 1, delaySeconds: 1, restartsInWindow: 1, maxRestarts: 10, windowSeconds: 300,
    });
  });

  test('the ended run says in its own log when it comes back', async () => {
    const h = makeHarness([server()], { exits: [3, undefined] });
    await h.sched.trigger('job');
    await settle();
    assert.match(runLogs(h)[0], /\[restart\] attempt 1 in 1s \(exitCode=3; 1 of 10 restarts allowed in 300s\)/);
  });

  test('the restarted run is in the history as triggered by a restart, with its attempt number', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, SECOND);
    assert.deepEqual(h.state.get('job').triggeredBy, { kind: 'restart', attempt: 1 });
  });

  test('a run ended by the job\'s own timeout is restarted too, and the event says it was the timeout', async () => {
    const h = makeHarness([server(true, { timeoutSeconds: 5 })], { exits: [undefined] });
    await h.sched.trigger('job');
    await pass(h, 5 * SECOND);
    assert.deepEqual(h.names(), ['job.started', 'job.timed_out', 'job.failed', 'job.restart_scheduled']);
    assert.equal(h.of('job.restart_scheduled')[0].payload.endReason, 'timeout');
    await pass(h, SECOND);
    assert.equal(h.spawned.length, 2);
  });

  test('a job that cannot be started at all is restarted too (the supervisor may be back in a moment)', async () => {
    let attempts = 0;
    const spawn = () => { attempts++; throw new Error('spawn EAGAIN'); };
    const h = makeHarness([server()], { scheduler: { spawn } });
    await h.sched.trigger('job');
    await settle();
    assert.deepEqual(h.names(), ['job.failed', 'job.restart_scheduled']);
    await pass(h, SECOND);
    assert.equal(attempts, 2);
  });

  test('a run the job declares skipped (skipExitCodes) is restarted like any other exit', async () => {
    const h = makeHarness([server(true, { skipExitCodes: [2] })], { exits: [2, undefined] });
    await h.sched.trigger('job');
    await settle();
    assert.deepEqual(h.names(), ['job.started', 'job.skipped', 'job.restart_scheduled']);
  });

  test('works for every job type', async () => {
    for (const type of ['startup', 'manual', 'once']) {
      const base = { id: 'job', type, command: 'run it', label: 'Job', enabled: true, triggerMode: 'fire-and-forget', timeoutSeconds: 0, restartOnExit: true };
      const extra = type === 'once' ? { delayMs: 1000, scheduledAt: new Date().toISOString() } : {};
      const h = makeHarness([{ ...base, ...extra }], { exits: [1, undefined] });
      await h.sched.trigger('job');
      await settle();
      await pass(h, SECOND);
      assert.equal(h.spawned.length, 2, type);
      await h.sched.stop();
    }
  });

  test('a job without the setting is not restarted', async () => {
    const h = makeHarness([cronJob({ timeoutSeconds: 0 })], { exits: [1] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, 10 * MINUTE);
    assert.equal(h.spawned.length, 1);
    assert.deepEqual(h.names(), ['job.started', 'job.failed']);
  });

  test('restartOnExit: false is the same as no setting', async () => {
    const h = makeHarness([cronJob({ timeoutSeconds: 0, restartOnExit: false })], { exits: [1] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, 10 * MINUTE);
    assert.equal(h.spawned.length, 1);
  });
});

describe('the pause grows with the strategy', () => {
  async function delaysOf(restartOnExit, restarts) {
    const h = makeHarness([server(restartOnExit)], { exits: [1] });
    await h.sched.trigger('job');
    await settle();
    for (let i = 1; i < restarts; i++) {
      await pass(h, h.of('job.restart_scheduled').at(-1).payload.delaySeconds * SECOND);
    }
    return h.of('job.restart_scheduled').map((e) => e.payload.delaySeconds);
  }

  test('exponential (the default): 1, 2, 4, 8, 16, then the 30 s ceiling', async () => {
    assert.deepEqual(await delaysOf({ maxRestarts: 100 }, 8), [1, 2, 4, 8, 16, 30, 30, 30]);
  });

  test('fixed', async () => {
    assert.deepEqual(await delaysOf({ strategy: 'fixed', initialDelaySeconds: 3, maxRestarts: 100 }, 4), [3, 3, 3, 3]);
  });

  test('linear', async () => {
    assert.deepEqual(await delaysOf({ strategy: 'linear', initialDelaySeconds: 2, stepSeconds: 3, maxDelaySeconds: 10, maxRestarts: 100 }, 5), [2, 5, 8, 10, 10]);
  });
});

describe('a manual kill never restarts the job', () => {
  test('orch kill: the run is cancelled, nothing is scheduled, nothing starts later', async () => {
    const h = makeHarness([server()], { exits: [undefined] });
    await h.sched.trigger('job');
    await h.sched.killJob('job');
    await settle();
    assert.deepEqual(h.names(), ['job.started', 'job.killed_manual']);
    await pass(h, 10 * MINUTE);
    assert.equal(h.spawned.length, 1);
    assert.equal(h.sched._deadlines.list().filter((d) => d.kind === 'restart').length, 0);
  });

  test('orch kill during the wait before a restart cancels that restart, and says so', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    await h.sched.trigger('job');
    await settle();
    assert.equal(h.sched._deadlines.list().filter((d) => d.kind === 'restart').length, 1);

    const killed = await h.sched.killJob('job');

    assert.deepEqual(killed, { killed: false, count: 0, cancelledRestart: true });
    await pass(h, 10 * MINUTE);
    assert.equal(h.spawned.length, 1, 'the cancelled restart happened anyway');
  });

  test('a kill that has nothing to cancel does not claim it did', async () => {
    const h = makeHarness([server()], { exits: [0] });
    assert.deepEqual(await h.sched.killJob('job'), { killed: false, count: 0 });
  });

  test('restart-job (the kill half) does not leave a second copy behind: one running run after it', async () => {
    const h = makeHarness([server()], { exits: [undefined] });
    await h.sched.trigger('job');
    const result = await h.sched.restartJob('job');
    await settle();
    assert.equal(result.started, true);
    await pass(h, 10 * MINUTE);
    assert.equal(h.sched.runningCount('job'), 1);
    assert.equal(h.spawned.length, 2);
    assert.deepEqual(h.of('job.restart_scheduled'), []);
  });

  test('after a manual stop and start, the backoff starts over from the first delay', async () => {
    const h = makeHarness([server()], { exits: [1, 1, undefined, 1, undefined] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, SECOND);
    assert.deepEqual(h.of('job.restart_scheduled').map((e) => e.payload.delaySeconds), [1, 2]);
    await h.sched.killJob('job');
    await settle();
    await h.sched.trigger('job');
    await settle();
    await h.sched.killJob('job');
    await settle();
    await h.sched.trigger('job');
    await settle();
    const delays = h.of('job.restart_scheduled').map((e) => e.payload.delaySeconds);
    assert.equal(delays.at(-1), 1, `the backoff survived a manual stop: ${delays.join(', ')}`);
  });
});

describe('a job that cannot stay up is given up on', () => {
  const POLICY = { strategy: 'fixed', initialDelaySeconds: 1, maxRestarts: 2, windowSeconds: 60 };

  async function crashLoop() {
    const h = makeHarness([server(POLICY)], { exits: [7] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, 10 * SECOND);
    return h;
  }

  test('after maxRestarts restarts within the window: restart_abandoned, and the job stays stopped', async () => {
    const h = await crashLoop();
    assert.deepEqual(h.names(), [
      'job.started', 'job.failed', 'job.restart_scheduled',
      'job.started', 'job.failed', 'job.restart_scheduled',
      'job.started', 'job.failed', 'job.restart_abandoned',
    ]);
    assert.equal(h.spawned.length, 3);
    assert.deepEqual(h.of('job.restart_abandoned')[0].payload, {
      jobId: 'job', label: 'Job', cause: 'limit', exitCode: 7, attempts: 2, restartsInWindow: 2, maxRestarts: 2, windowSeconds: 60,
    });
  });

  test('nothing starts later: no timer is left armed', async () => {
    const h = await crashLoop();
    await pass(h, 60 * MINUTE);
    assert.equal(h.spawned.length, 3);
    assert.equal(h.sched._deadlines.list().filter((d) => d.kind === 'restart').length, 0);
  });

  test('the last run\'s log says why, with the cause, the numbers and how to start the job again', async () => {
    const h = await crashLoop();
    const last = runLogs(h).at(-1);
    assert.match(last, /\[restart\] giving up: 2 restarts in the last 60s is the limit \(maxRestarts=2, windowSeconds=60\)/);
    assert.match(last, /the job stays stopped.*orch trigger job/s);
  });

  test('the daemon log gets a line too: this is not something to find by opening run logs', async () => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.join(' ')); };
    try {
      await crashLoop();
    } finally {
      console.error = original;
    }
    assert.ok(lines.some((l) => /\[scheduler\] job "job" is no longer restarted.*2 restarts in the last 60s/s.test(l)), lines.join('\n'));
  });

  test('a manual trigger afterwards starts from a clean slate: a full budget again', async () => {
    const h = await crashLoop();
    await h.sched.trigger('job');
    await settle();
    await pass(h, 10 * SECOND);
    assert.equal(h.of('job.restart_abandoned').length, 2);
    assert.equal(h.spawned.length, 6);
    assert.deepEqual(h.of('job.restart_scheduled').map((e) => e.payload.attempt), [1, 2, 1, 2]);
  });

  test('the window slides: restarts spread out over more than the window are never too many', async () => {
    const h = makeHarness([server({ strategy: 'fixed', initialDelaySeconds: 40, maxRestarts: 2, windowSeconds: 60 })], { exits: [7] });
    await h.sched.trigger('job');
    await settle();
    // One restart every 40 s: never more than one is still inside the 60 s window when the next exit comes.
    await pass(h, 40 * SECOND);
    await pass(h, 40 * SECOND);
    await pass(h, 40 * SECOND);
    await pass(h, 40 * SECOND);
    assert.deepEqual(h.of('job.restart_abandoned'), [], 'two restarts per 80 s is within 2 per 60 s');
    assert.ok(h.spawned.length >= 5);
  });
});

describe('a run that stayed up long enough clears the memory of the past', () => {
  test('after the stable duration the backoff starts again from the first delay', async () => {
    const h = makeHarness([server({ maxRestarts: 100 })], { exits: [1, 1, 1, undefined] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, 7 * SECOND);
    assert.deepEqual(h.of('job.restart_scheduled').map((e) => e.payload.delaySeconds), [1, 2, 4]);
    // The fourth run stays up for exactly the stable duration (15 minutes), then dies.
    await h.time.advanceAsync(15 * MINUTE, MINUTE);
    h.children.at(-1).exit(1);
    await settle();
    const last = h.of('job.restart_scheduled').at(-1).payload;
    assert.equal(last.attempt, 1);
    assert.equal(last.delaySeconds, 1);
    assert.match(runLogs(h).at(-1), /\[restart\] this run stayed up for .*\(stable after 900s\): the backoff and the restart count start over/);
  });

  test('a run one second short of it does not', async () => {
    const h = makeHarness([server({ maxRestarts: 100 })], { exits: [1, 1, 1, undefined] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, 7 * SECOND);
    await h.time.advanceAsync(15 * MINUTE - SECOND, MINUTE);
    h.children.at(-1).exit(1);
    await settle();
    assert.equal(h.of('job.restart_scheduled').at(-1).payload.attempt, 4);
  });

  test('a stable run also clears the restarts counted in the window, so a long window does not give up on a healthy job', async () => {
    const h = makeHarness([server({ strategy: 'fixed', initialDelaySeconds: 1, maxRestarts: 2, windowSeconds: 3600, stableAfterSeconds: 60 })], { exits: [1, 1, undefined] });
    await h.sched.trigger('job');
    await settle();
    await pass(h, 5 * SECOND);
    // Two restarts are in the window; the third run lives two minutes, dies, and must still be restarted.
    await h.time.advanceAsync(2 * MINUTE, 10 * SECOND);
    h.children.at(-1).exit(1);
    await settle();
    assert.deepEqual(h.of('job.restart_abandoned'), []);
    assert.equal(h.of('job.restart_scheduled').at(-1).payload.restartsInWindow, 1);
  });
});

describe('nothing restarts a job that should not come back', () => {
  test('a job disabled during the wait is not started (the command also unschedules it)', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    await h.sched.trigger('job');
    await settle();
    h.registry.disable('job');
    h.sched.unscheduleJob('job');
    await pass(h, 10 * MINUTE);
    assert.equal(h.spawned.length, 1);
  });

  test('a job disabled by something that did not unschedule it is still not started, and the daemon log says why', async () => {
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.join(' ')); };
    try {
      const h = makeHarness([server()], { exits: [1, undefined] });
      await h.sched.trigger('job');
      await settle();
      h.registry.disable('job');
      await pass(h, 10 * SECOND);
      assert.equal(h.spawned.length, 1);
    } finally {
      console.error = original;
    }
    assert.ok(lines.some((l) => /job "job".*restart.*cancelled.*disabled/s.test(l)), lines.join('\n'));
  });

  test('a job removed during the wait is not started', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    await h.sched.trigger('job');
    await settle();
    h.registry.remove('job');
    await pass(h, 10 * SECOND);
    assert.equal(h.spawned.length, 1);
  });

  test('a job edited out of the policy during the wait is not started', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    await h.sched.trigger('job');
    await settle();
    h.registry.edit('job', {}, ['restartOnExit']);
    h.sched.scheduleJob(h.registry.get('job'));
    await pass(h, 10 * SECOND);
    assert.equal(h.spawned.length, 1);
  });

  test('an unrelated edit during the wait (the daemon re-plans the job) keeps the restart', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    await h.sched.trigger('job');
    await settle();
    h.registry.edit('job', { label: 'Renamed' });
    h.sched.scheduleJob(h.registry.get('job'));
    await pass(h, SECOND);
    assert.equal(h.spawned.length, 2);
  });

  test('a manual trigger during the wait takes its place: no second copy a moment later', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    await h.sched.trigger('job');
    await settle();
    await h.sched.trigger('job');
    await settle();
    assert.equal(h.spawned.length, 2);
    await pass(h, 10 * MINUTE);
    assert.equal(h.spawned.length, 2);
    assert.equal(h.sched.runningCount('job'), 1);
  });

  test('a restart whose job is already running again (another instance started it) is skipped, not doubled', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    await h.sched.trigger('job');
    await settle();
    // Started behind the scheduler's back, so nothing cancelled the pending restart.
    h.sched._running.set('job', 1);
    const log = [];
    const original = console.error;
    console.error = (...args) => { log.push(args.join(' ')); };
    try {
      await pass(h, 10 * SECOND);
    } finally {
      console.error = original;
    }
    assert.equal(h.spawned.length, 1);
    assert.ok(log.some((l) => /job "job".*restart.*skipped.*already running/s.test(l)), log.join('\n'));
  });

  test('a stopped scheduler restarts nothing, even for a run that ends afterwards', async () => {
    const h = makeHarness([server()], { exits: [undefined] });
    await h.sched.trigger('job');
    await h.sched.stop();
    h.children[0].exit(1);
    await settle();
    await pass(h, 10 * MINUTE);
    assert.deepEqual(h.of('job.restart_scheduled'), []);
    assert.equal(h.spawned.length, 1);
  });
});

describe('when the configuration is wrong, it is said and nothing guesses', () => {
  function capture() {
    const lines = [];
    const original = console.error;
    console.error = (...args) => { lines.push(args.join(' ')); };
    return { lines, restore: () => { console.error = original; } };
  }

  test('both restartOnExit and a retry list on one job (a hand-edited registry): restartOnExit wins, loudly at start', async () => {
    const h = makeHarness([server()], { exits: [1, undefined] });
    // The registry refuses this combination; a registry.json edited by hand can still hold it.
    Object.assign(h.registry.get('job'), { retryOnExitCodes: [1], retryDelays: [5] });
    const log = capture();
    try {
      await h.sched.start();
    } finally {
      log.restore();
    }
    assert.ok(log.lines.some((l) => /job "job".*restartOnExit.*retryOnExitCodes.*ignored/s.test(l)), log.lines.join('\n'));

    await h.sched.trigger('job');
    await settle();
    assert.deepEqual(h.names(), ['job.started', 'job.failed', 'job.restart_scheduled']);
    assert.equal(h.of('alert.retry_exhausted').length, 0);
    await pass(h, SECOND);
    assert.deepEqual(h.of('job.started').map((e) => e.payload.trigger), ['manual', 'restart']);
  });

  test('an invalid restartOnExit in the registry is reported at start, and the job is not restarted', async () => {
    const h = makeHarness([server()], { exits: [1] });
    h.registry.get('job').restartOnExit = { strategy: 'quadratic' };
    const log = capture();
    try {
      await h.sched.start();
    } finally {
      log.restore();
    }
    assert.ok(log.lines.some((l) => /job "job" has an invalid restartOnExit.*strategy must be one of fixed, linear, exponential.*NOT be restarted/s.test(l)), log.lines.join('\n'));

    await h.sched.trigger('job');
    await settle();
    await pass(h, 10 * MINUTE);
    assert.deepEqual(h.names(), ['job.started', 'job.failed']);
    assert.match(runLogs(h)[0], /\[restart\] not restarting: restartOnExit is invalid -- restartOnExit\.strategy must be one of/);
  });
});
