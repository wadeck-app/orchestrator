'use strict';

// The events of a run of a job, each driven through the REAL Scheduler (fake children, a fake clock) and checked against
// the catalog: published, exactly once, at the right moment, with a payload that validates against the declared schema
// and carries its correlation key. The harness collects every invalid payload and the afterEach below fails on any.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { assertNoProblems } = require('./helpers/event-harness');
const { S, MINUTE } = require('./helpers/event-scenarios');

afterEach(assertNoProblems);

describe('job.started', () => {
  test('is published once per run, with the pid and what triggered it, before anything else', async () => {
    const h = await S.success();
    const started = h.of('job.started');
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].payload, { jobId: 'job', label: 'Job', trigger: 'manual', pid: null });
    assert.equal(h.names()[0], 'job.started');
  });

  test('carries the real pid of the process', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob()], { exits: [0], pid: 4242 });
    await h.sched.trigger('job');
    await settle();
    assert.equal(h.of('job.started')[0].payload.pid, 4242);
  });

  test('is published once per run, so twice for two runs', async () => {
    const h = await S.recovered();
    assert.equal(h.of('job.started').length, 2);
  });

  test('says which kind of firing it was: retry for an automatic retry', async () => {
    const h = await S.retryExhausted();
    assert.deepEqual(h.of('job.started').map((e) => e.payload.trigger), ['manual', 'retry', 'retry']);
  });

  test('is NOT published for a firing that was refused, nor for a run that could not be started', async () => {
    for (const scenario of [S.livenessSkip, S.adoptedRefusal, S.startFailure, S.supervisorStartFailure]) {
      const h = await scenario();
      assert.deepEqual(h.of('job.started'), [], h.names().join(', '));
    }
  });
});

describe('job.completed', () => {
  test('ends a run that exited 0: after job.started, once, with the exit code and a duration', async () => {
    const h = await S.success();
    assert.deepEqual(h.names(), ['job.started', 'job.completed']);
    const { payload } = h.of('job.completed')[0];
    assert.equal(payload.exitCode, 0);
    assert.ok(Number.isInteger(payload.durationMs) && payload.durationMs >= 0, JSON.stringify(payload));
  });

  test('is not published for a failure, a skip code or a kill', async () => {
    for (const scenario of [S.failure, S.skipExitCode, S.manualKill]) {
      const h = await scenario();
      assert.deepEqual(h.of('job.completed'), [], h.names().join(', '));
    }
  });
});

describe('job.failed', () => {
  test('ends a run that exited non-zero: once, with that exit code', async () => {
    const h = await S.failure();
    assert.deepEqual(h.names(), ['job.started', 'job.failed']);
    assert.equal(h.of('job.failed')[0].payload.exitCode, 3);
  });

  test('a run that could not be started is one job.failed with exitCode 1 and durationMs 0, and no job.started', async () => {
    for (const scenario of [S.startFailure, S.supervisorStartFailure]) {
      const h = await scenario();
      assert.deepEqual(h.names(), ['job.failed']);
      assert.deepEqual(h.of('job.failed')[0].payload, { jobId: 'job', label: 'Job', exitCode: 1, durationMs: 0 });
    }
  });

  test('the cause of a start failure is in the run log, not only in the event', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const h = await S.startFailure();
    const folder = path.join(h.dir, 'logs', 'jobs', 'job');
    const log = fs.readFileSync(path.join(folder, fs.readdirSync(folder)[0]), 'utf8');
    assert.match(log, /could not start the job: spawn ENOENT/);
  });
});

describe('job.skipped', () => {
  test('exit code listed in skipExitCodes: reason "exitCode", with the real code, once, and neither completed nor failed', async () => {
    const h = await S.skipExitCode();
    assert.deepEqual(h.names(), ['job.started', 'job.skipped']);
    const { payload } = h.of('job.skipped')[0];
    assert.equal(payload.reason, 'exitCode');
    assert.equal(payload.exitCode, 3);
    assert.ok(Number.isInteger(payload.durationMs));
  });

  test('concurrency: the refused firing says how full the job is, and starts nothing', async () => {
    const h = await S.concurrencyRefusal();
    assert.equal(h.refusal.status, 'already-running');
    assert.deepEqual(h.names(), ['job.started', 'job.skipped']);
    assert.deepEqual(h.of('job.skipped')[0].payload, {
      jobId: 'job', label: 'Job', exitCode: null, durationMs: 0, reason: 'concurrency', running: 1, maxConcurrency: 1,
    });
    assert.equal(h.spawned.length, 1, 'the refused firing must not spawn');
  });

  test('concurrency also refuses a dependent that is at its limit', async () => {
    const { S: scenarios } = require('./helpers/event-scenarios');
    const h = await scenarios.dependencyRefusal();
    const skipped = h.of('job.skipped');
    assert.equal(skipped.length, 1, h.names().join(', '));
    assert.equal(skipped[0].payload.jobId, 'child');
    assert.equal(skipped[0].payload.reason, 'concurrency');
    assert.equal(h.of('job.started', 'child').length, 1, 'only the first run of the dependent started');
  });

  test('adopted: a startup firing is refused while the run from before the restart is followed; nothing starts', async () => {
    const h = await S.adoptedRefusal();
    assert.deepEqual(h.names(), ['job.skipped']);
    assert.deepEqual(h.of('job.skipped')[0].payload, { jobId: 'job', label: 'Job', exitCode: null, durationMs: 0, reason: 'adopted' });
    assert.equal(h.spawned.length, 0);
  });

  test('liveness: a cron firing finds the target already up; nothing starts, one skip', async () => {
    const h = await S.livenessSkip();
    assert.deepEqual(h.names(), ['job.skipped']);
    assert.equal(h.of('job.skipped')[0].payload.reason, 'liveness');
    assert.equal(h.spawned.length, 0);
  });
});

describe('job.recovered', () => {
  test('is published right after the job.completed of the run that succeeded after a failure', async () => {
    const h = await S.recovered();
    assert.deepEqual(h.names(), ['job.started', 'job.failed', 'job.started', 'job.completed', 'job.recovered']);
  });

  test('is not published for a success after a success, nor for a success after nothing', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob()], { exits: [0] });
    await h.sched.trigger('job');
    await settle();
    await h.sched.trigger('job');
    await settle();
    assert.deepEqual(h.of('job.recovered'), []);
  });

  test('is published once per recovery, not once per later success', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob()], { exits: [1, 0, 0] });
    for (let i = 0; i < 3; i++) {
      await h.sched.trigger('job');
      await settle();
    }
    assert.equal(h.of('job.recovered').length, 1);
  });
});

describe('job.anomaly', () => {
  test('a success that took more than 3 times the average is announced after its job.completed, once', async () => {
    const h = await S.anomaly();
    assert.deepEqual(h.names(), ['job.started', 'job.completed', 'job.anomaly']);
    const { payload } = h.of('job.anomaly')[0];
    assert.equal(payload.multiplier, 3);
    assert.ok(payload.durationMs > 3 * payload.avgMs, JSON.stringify(payload));
  });

  test('is not published when there is no history yet', async () => {
    const h = await S.success();
    assert.deepEqual(h.of('job.anomaly'), []);
  });

  test('is not published for a slow run that failed', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob()], { exits: [1], startedAgoMs: 30_000 });
    const hourAgo = Date.now() - 60 * MINUTE;
    for (let i = 0; i < 3; i++) {
      const start = new Date(hourAgo + i * MINUTE);
      h.state.record('job', { startedAt: start.toISOString(), finishedAt: new Date(start.getTime() + 1000).toISOString(), exitCode: 0, pid: 1 });
    }
    await h.sched.trigger('job');
    await settle();
    assert.deepEqual(h.of('job.anomaly'), []);
    assert.deepEqual(h.names(), ['job.started', 'job.failed']);
  });
});

describe('job.timed_out', () => {
  test('fires once when the timeout is reached, while the run is still going, then the run ends with job.failed', async () => {
    const h = await S.timeout(143);
    assert.deepEqual(h.names(), ['job.started', 'job.timed_out', 'job.failed']);
    assert.deepEqual(h.of('job.timed_out')[0].payload, { jobId: 'job', label: 'Job', timeoutSeconds: 5 });
    assert.equal(h.of('job.failed')[0].payload.exitCode, 143);
  });

  test('is not published before the timeout', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ timeoutSeconds: 5 })], { exits: [undefined] });
    await h.sched.trigger('job');
    await h.time.advanceAsync(4000, 1000);
    await settle();
    assert.deepEqual(h.names(), ['job.started']);
    assert.equal(h.sched.runningCount('job'), 1);
  });

  test('a process that exits 0 after the kill ends with job.completed, after job.timed_out', async () => {
    const h = await S.timeoutThenZero();
    assert.deepEqual(h.names(), ['job.started', 'job.timed_out', 'job.completed']);
  });

  test('a killed process whose exit code is a skip code ends with job.skipped, after job.timed_out', async () => {
    const h = await S.timeoutThenSkipCode();
    assert.deepEqual(h.names(), ['job.started', 'job.timed_out', 'job.skipped']);
  });

  test('a job without a timeout (timeoutSeconds 0) never times out', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ timeoutSeconds: 0 })], { exits: [undefined] });
    await h.sched.trigger('job');
    await h.time.advanceAsync(2 * 60 * MINUTE, 30 * MINUTE);
    await settle();
    assert.deepEqual(h.names(), ['job.started']);
    assert.equal(h.sched.runningCount('job'), 1, 'the run is left alone');
  });

  test('a run that ends before the timeout never publishes it, even when the clock then passes it', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ timeoutSeconds: 5 })], { exits: [0] });
    await h.sched.trigger('job');
    await settle();
    await h.time.advanceAsync(60_000, 5000);
    assert.deepEqual(h.names(), ['job.started', 'job.completed']);
  });
});

describe('job.killed_manual', () => {
  test('ends a run stopped by the user, instead of job.failed: once, without an exit code, no retry', async () => {
    const h = await S.manualKill();
    assert.deepEqual(h.names(), ['job.started', 'job.killed_manual']);
    const { payload } = h.of('job.killed_manual')[0];
    assert.deepEqual(Object.keys(payload).sort(), ['durationMs', 'jobId', 'label']);
    assert.ok(Number.isInteger(payload.durationMs));
    assert.equal(h.sched.runCounts().running, 0);
  });

  test('with several instances, one job.killed_manual per stopped run', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ maxConcurrency: 3 })], { exits: [undefined] });
    for (let i = 0; i < 3; i++) {
      await h.sched.trigger('job');
    }
    const stopped = await h.sched.killJob('job');
    await settle();
    assert.deepEqual(stopped, { killed: true, count: 3 });
    assert.equal(h.of('job.killed_manual').length, 3);
    assert.equal(h.terminals().length, 3);
  });

  test('a run that was not stopped by a user is never announced as killed: a timeout kill is a failure', async () => {
    const h = await S.timeout(143);
    assert.deepEqual(h.of('job.killed_manual'), []);
  });
});

describe('alert.consecutive_failures', () => {
  test('starts at the third failure in a row (the default) and repeats for each further failure, after its job.failed', async () => {
    const h = await S.consecutiveFailures(4);
    const alerts = h.of('alert.consecutive_failures');
    assert.deepEqual(alerts.map((a) => a.payload.consecutiveFailures), [3, 4]);
    assert.ok(alerts.every((a) => a.payload.threshold === 3));
    assert.deepEqual(h.names().slice(-6), ['job.started', 'job.failed', 'alert.consecutive_failures', 'job.started', 'job.failed', 'alert.consecutive_failures']);
    assert.equal(h.of('job.failed').length, 4);
  });

  test('honours the threshold of the job', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ alertAfterFailures: 1 })], { exits: [1] });
    await h.sched.trigger('job');
    await settle();
    assert.deepEqual(h.names(), ['job.started', 'job.failed', 'alert.consecutive_failures']);
    assert.equal(h.of('alert.consecutive_failures')[0].payload.threshold, 1);
  });

  test('is not published by a success, which also ends the streak', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob()], { exits: [1, 1, 0, 1, 1] });
    for (let i = 0; i < 5; i++) {
      await h.sched.trigger('job');
      await settle();
    }
    assert.deepEqual(h.of('alert.consecutive_failures'), []);
  });

  test('a skip neither adds to the streak nor ends it', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ skipExitCodes: [9] })], { exits: [1, 9, 1, 1] });
    for (let i = 0; i < 4; i++) {
      await h.sched.trigger('job');
      await settle();
    }
    assert.deepEqual(h.of('alert.consecutive_failures').map((a) => a.payload.consecutiveFailures), [3]);
  });
});

describe('alert.retry_exhausted', () => {
  test('is published once, after the job.failed of the last attempt, not while attempts remain', async () => {
    const h = await S.retryExhausted();
    assert.deepEqual(h.names(), [
      'job.started', 'job.failed',
      'job.started', 'job.failed',
      'job.started', 'job.failed', 'alert.retry_exhausted',
    ]);
    assert.deepEqual(h.of('alert.retry_exhausted')[0].payload, { jobId: 'job', label: 'Job', exitCode: 75, attempts: 2 });
  });

  test('is not published for an exit code that is not retried', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ retryOnExitCodes: [75], retryDelays: [10] })], { exits: [1] });
    await h.sched.trigger('job');
    await settle();
    await h.time.advanceAsync(60_000, 10_000);
    assert.deepEqual(h.names(), ['job.started', 'job.failed']);
  });

  test('a retry that succeeds ends the series quietly: no alert', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ retryOnExitCodes: [75], retryDelays: [10], alertAfterFailures: 99 })], { exits: [75, 0] });
    await h.sched.trigger('job');
    await settle();
    await h.time.advanceAsync(10_000, 1000);
    await settle();
    assert.deepEqual(h.names(), ['job.started', 'job.failed', 'job.started', 'job.completed', 'job.recovered']);
  });
});

describe('alert.sla_breach', () => {
  test('a scheduled firing that did not succeed within the window is announced once, with the firing time and the window', async () => {
    const h = await S.sla(1, 3, 1);
    const breaches = h.of('alert.sla_breach');
    assert.equal(breaches.length, 1, h.names().join(', '));
    const { payload } = breaches[0];
    assert.equal(payload.windowMinutes, 3);
    assert.ok(Math.abs(Date.parse(payload.scheduledAt) - h.firedAt[0].getTime()) < 1000, `${payload.scheduledAt} vs ${h.firedAt[0].toISOString()}`);
  });

  test('is published once per missed firing, each with its own scheduledAt', async () => {
    const h = await S.sla(1, 3, 2);
    const breaches = h.of('alert.sla_breach');
    assert.equal(breaches.length, 2, h.names().join(', '));
    assert.notEqual(breaches[0].payload.scheduledAt, breaches[1].payload.scheduledAt);
  });

  test('is not published when the run after the firing succeeded in time', async () => {
    const h = await S.sla(0, 3, 1);
    assert.deepEqual(h.of('alert.sla_breach'), []);
    assert.ok(h.of('job.completed').length >= 1);
  });

  test('is not published for a job without slaWindowMinutes', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const { fireNextCron } = require('./helpers/event-scenarios');
    const h = makeHarness([cronJob({ schedule: '*/5 * * * *' })], { exits: [1] });
    await h.sched.start();
    await fireNextCron(h);
    await h.time.advanceAsync(10 * MINUTE, MINUTE);
    await settle();
    assert.deepEqual(h.of('alert.sla_breach'), []);
  });

  test('a manual trigger is not a scheduled firing: no window is watched', async () => {
    const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
    const h = makeHarness([cronJob({ slaWindowMinutes: 3 })], { exits: [1] });
    await h.sched.trigger('job');
    await settle();
    await h.time.advanceAsync(10 * MINUTE, MINUTE);
    assert.deepEqual(h.of('alert.sla_breach'), []);
  });
});

describe('job.window_expired', () => {
  test('is published once, when the active window closes, and the job is disabled', async () => {
    const h = await S.windowExpired();
    const expired = h.of('job.window_expired');
    assert.equal(expired.length, 1);
    assert.deepEqual(expired[0].payload, { jobId: 'job', label: 'Job', activeUntil: h.activeUntil });
    assert.equal(h.registry.get('job').enabled, false);
  });

  test('is not published before the window closes', async () => {
    const { makeHarness, cronJob } = require('./helpers/event-harness');
    const h = makeHarness([]);
    h.registry.add(cronJob({ activeUntil: new Date(h.time.now() + 24 * 60 * MINUTE).toISOString() }));
    await h.sched.start();
    await h.time.advanceAsync(23 * 60 * MINUTE, 60 * MINUTE);
    assert.deepEqual(h.of('job.window_expired'), []);
    assert.equal(h.registry.get('job').enabled, true);
  });

  test('is not published when the job is disabled by hand', async () => {
    const { makeHarness, cronJob } = require('./helpers/event-harness');
    const { commandsOf } = require('./helpers/event-scenarios');
    const h = makeHarness([cronJob({ activeUntil: new Date(Date.now() + 10 * 24 * 60 * MINUTE).toISOString() })]);
    await h.sched.start();
    commandsOf(h)['disable-job']({ id: 'job' });
    await h.time.advanceAsync(20 * 24 * 60 * MINUTE, 24 * 60 * MINUTE);
    assert.deepEqual(h.of('job.window_expired'), []);
  });
});

describe('a run that could not be started follows the same rules as any failed run', () => {
  const { makeHarness, cronJob, settle } = require('./helpers/event-harness');
  const refusing = () => {
    const attempts = [];
    return { attempts, spawn: () => { attempts.push(1); throw new Error('spawn ENOENT'); } };
  };

  test('it feeds the consecutive-failure alert: the third start failure in a row alerts, after its job.failed', async () => {
    const { spawn } = refusing();
    const h = makeHarness([cronJob()], { scheduler: { spawn } });
    for (let i = 0; i < 3; i++) {
      await h.sched.trigger('job');
      await settle();
    }
    assert.deepEqual(h.names(), ['job.failed', 'job.failed', 'job.failed', 'alert.consecutive_failures']);
    assert.deepEqual(h.of('alert.consecutive_failures')[0].payload.consecutiveFailures, 3);
  });

  test('a start failure after real failures continues their streak', async () => {
    const h = makeHarness([cronJob()], { exits: [1, 1] });
    await h.sched.trigger('job');
    await settle();
    await h.sched.trigger('job');
    await settle();
    h.sched._spawn = () => { throw new Error('spawn ENOENT'); };
    await h.sched.trigger('job');
    await settle();
    assert.equal(h.of('alert.consecutive_failures').length, 1);
  });

  test('retryOnExitCodes applies (the failure counts as exit code 1): it is tried again after the delay, then the series is exhausted', async () => {
    const { spawn, attempts } = refusing();
    const h = makeHarness([cronJob({ retryOnExitCodes: [1], retryDelays: [10], alertAfterFailures: 99 })], { scheduler: { spawn } });
    await h.sched.trigger('job');
    await settle();
    assert.equal(attempts.length, 1);
    await h.time.advanceAsync(9999, 1000);
    assert.equal(attempts.length, 1, 'not before the delay');
    await h.time.advanceAsync(1, 1);
    await settle();
    assert.equal(attempts.length, 2);
    assert.deepEqual(h.names(), ['job.failed', 'job.failed', 'alert.retry_exhausted']);
    assert.equal(h.of('alert.retry_exhausted')[0].payload.attempts, 1);
  });

  test('it is announced to the rest of the daemon like any end of a run (job-finished, once), and fires no dependent', async () => {
    const { spawn } = refusing();
    const h = makeHarness([cronJob(), cronJob({ id: 'after', dependsOn: 'job' })], { scheduler: { spawn } });
    await h.sched.trigger('job');
    await settle();
    assert.equal(h.signals.finished.length, 1);
    assert.equal(h.signals.finished[0].exitCode, 1);
    assert.deepEqual(h.spawned, []);
    const entry = h.state.get('job');
    assert.equal(entry.exitCode, 1);
    assert.ok(entry.finishedAt);
  });

  test('it leaves no record in the resource history: no process ever ran', async () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawn } = refusing();
    const h = makeHarness([cronJob()], { scheduler: { spawn } });
    await h.sched.trigger('job');
    await settle();
    assert.equal(fs.existsSync(path.join(h.dir, 'resource-history', 'job.ndjson')), false);
  });
});
