'use strict';

// A job that ended while the daemon was down. The supervisor recorded how it ended in the run folder; when the
// daemon comes back it must give that run the same history, log, events and consequences as if it had seen the
// end itself (policy C, .claude/plans/2026-10-18_update-with-jobs-running.md): everything is recorded and
// announced, flagged late, and what ACTS (retry, dependents, their hooks) only happens if the end is recent.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { runDirFor } = require('../src/supervised-run');

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const MINUTE = 60_000;
const WINDOW_MS = 30 * MINUTE;

const schedulers = [];
afterEach(async () => {
  while (schedulers.length > 0) {
    await schedulers.pop().stop();
  }
});

function cronJob(extra = {}) {
  return { id: 'job', type: 'cron', schedule: '0 8 * * *', command: 'run it', label: 'Job', enabled: true, triggerMode: 'fire-and-forget', ...extra };
}

function makeEnv(jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-recovery-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  for (const job of jobs) {
    registry.add(job);
  }
  const events = [];
  const hooks = [];
  const spawned = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    now: () => new Date(NOW),
    lateActionWindowMs: WINDOW_MS,
    spawn: (cmd) => { spawned.push(cmd); throw new Error('recovery must not start anything itself'); },
    liveness: async () => false,
    sampleUsage: async () => null,
    eventPublisher: { publish: (event, payload) => events.push({ event, payload }) },
    hookDispatcher: { dispatch: async (name, payload) => { hooks.push({ name, payload }); } },
  });
  schedulers.push(sched);
  return { sched, state, registry, events, hooks, spawned, dir };
}

const at = (minutesAgo) => new Date(NOW - minutesAgo * MINUTE).toISOString();
const names = (events) => events.map((e) => e.event);

/**
 * Leaves what a daemon and a supervisor leave behind when the daemon dies mid-run and the job then ends: an open
 * entry in the state, a run folder with the spec and the supervisor's final status, and the job's output in the log.
 */
function leaveRun(env, { jobId = 'job', startedMinutesAgo = 90, endedMinutesAgo = 60, status = {}, done = false, effects = null, trigger = { kind: 'cron' } } = {}) {
  const startedAt = at(startedMinutesAgo);
  env.state.record(jobId, { startedAt, exitCode: null, pid: 4242, triggeredBy: trigger, peakRamMb: 123, peakCpuPct: 4, peakMeasure: 2 });
  env.state.flushNow();
  const runDir = runDirFor(env.dir, jobId, startedAt);
  fs.mkdirSync(runDir, { recursive: true });
  const logDir = path.join(env.dir, 'logs', 'jobs', jobId);
  fs.mkdirSync(logDir, { recursive: true });
  const compact = startedAt.replace(/:/g, '-').slice(0, 19);
  const logPath = path.join(logDir, `${jobId}-${compact}.log`);
  fs.writeFileSync(logPath, '[2026-10-18 10:31:00] [job:started] pid=4242 triggeredBy=cron\n[2026-10-18 10:45:00] the job said something\n');
  fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify({
    command: 'run it', cwd: env.dir, logPath, timeoutSeconds: 315, heartbeatMs: 2000,
    context: { jobId, label: 'Job', trigger, startedAt },
  }));
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    state: 'exited', supervisorPid: 1, childPid: 4242, startedAt, finishedAt: at(endedMinutesAgo), exitCode: 0, ...status,
  }));
  if (effects !== null) {
    fs.writeFileSync(path.join(runDir, 'effects.json'), JSON.stringify(effects));
  }
  if (done) {
    fs.writeFileSync(path.join(runDir, 'done'), '');
  }
  return { runDir, logPath, startedAt };
}

describe('a run that ended normally while the daemon was down (case 1)', () => {
  test('gets its real exit code and end time in the history', async () => {
    const env = makeEnv([cronJob()]);
    const run = leaveRun(env, { status: { exitCode: 0 } });

    await env.sched.recoverRuns();

    const entry = env.state.get('job');
    assert.equal(entry.exitCode, 0);
    assert.equal(entry.finishedAt, at(60));
    assert.equal(entry.startedAt, run.startedAt);
    assert.equal(entry.peakRamMb, 123, 'the peaks measured before the restart must survive');
  });

  test('is announced as completed, late, with the time it really ended, and not as started again', async () => {
    const env = makeEnv([cronJob()]);
    leaveRun(env, { status: { exitCode: 0 } });

    await env.sched.recoverRuns();

    assert.deepEqual(names(env.events), ['job.completed']);
    assert.equal(env.events[0].payload.late, true);
    assert.equal(env.events[0].payload.finishedAt, at(60));
  });

  test('writes the finish marker into the same run log, after what the job wrote', async () => {
    const env = makeEnv([cronJob()]);
    const run = leaveRun(env, { status: { exitCode: 0 } });

    await env.sched.recoverRuns();

    const log = fs.readFileSync(run.logPath, 'utf8');
    assert.match(log, /the job said something\n[^]*\[job:finished\] exitCode=0 duration=1800s/);
  });

  test('stamps the finish marker with the time the job really ended, not the time the daemon came back', async () => {
    const env = makeEnv([cronJob()]);
    const run = leaveRun(env, { endedMinutesAgo: 60, status: { exitCode: 0 } });

    await env.sched.recoverRuns();

    assert.match(fs.readFileSync(run.logPath, 'utf8'), /\[2026-10-18 11:00:00\] \[job:finished\]/);
  });

  test('puts the end on disk before declaring the run handled, and removes the run folder', async () => {
    const env = makeEnv([cronJob()]);
    const run = leaveRun(env, { status: { exitCode: 5 } });

    await env.sched.recoverRuns();

    const onDisk = JSON.parse(fs.readFileSync(path.join(env.dir, 'state.json'), 'utf8'));
    assert.equal(onDisk.jobs.job[0].exitCode, 5, 'the exit code was only in memory');
    assert.equal(fs.existsSync(run.runDir), false);
  });

  test('is no longer an open run, so the update check stops waiting for it', async () => {
    const env = makeEnv([cronJob()]);
    leaveRun(env, { status: { exitCode: 0 } });

    await env.sched.recoverRuns();

    assert.deepEqual(env.state.getOpenRuns('job'), []);
  });
});

describe('a run that died while the daemon was down (case 2)', () => {
  test('a job killed by a signal is a failure, like a live one', async () => {
    const env = makeEnv([cronJob()]);
    leaveRun(env, { status: { exitCode: undefined, signal: 'killed' } });

    await env.sched.recoverRuns();

    assert.equal(env.state.get('job').exitCode, 1);
    assert.deepEqual(names(env.events), ['job.failed']);
  });

  test('a failure counts for the consecutive-failure alert', async () => {
    const env = makeEnv([cronJob({ alertAfterFailures: 1 })]);
    leaveRun(env, { status: { exitCode: 2 } });

    await env.sched.recoverRuns();

    assert.ok(names(env.events).includes('alert.consecutive_failures'), names(env.events).join(', '));
  });

  test('a job a user killed is cancelled, announced as such, and never retried', async () => {
    const env = makeEnv([cronJob({ retryOnExitCodes: [1], retryDelays: [60] })]);
    leaveRun(env, { status: { exitCode: 1, killed: true, killReason: 'manual' } });

    await env.sched.recoverRuns();

    const entry = env.state.get('job');
    assert.equal(entry.exitCode, null);
    assert.equal(entry.cancelledByUser, true);
    assert.deepEqual(names(env.events), ['job.killed_manual']);
    assert.equal(env.hooks.length, 0);
  });
});

describe('a run that timed out or hit its limit while the daemon was down (case 4)', () => {
  test('a timeout is announced and marked, which the daemon would have done at the time', async () => {
    const env = makeEnv([cronJob()]);
    const run = leaveRun(env, { status: { exitCode: 1, killed: true, killReason: 'timeout', timedOut: true } });

    await env.sched.recoverRuns();

    assert.ok(names(env.events).includes('job.timed_out'), names(env.events).join(', '));
    const log = fs.readFileSync(run.logPath, 'utf8');
    assert.match(log, /\[job:timeout\]/);
    assert.match(log, /\[job:finished\] .*reason=timeout/);
  });

  test('a run ended by the resource limit says so in its finish marker', async () => {
    const env = makeEnv([cronJob()]);
    const run = leaveRun(env, { status: { exitCode: 1, killed: true, killReason: 'resource-limit' } });

    await env.sched.recoverRuns();

    assert.match(fs.readFileSync(run.logPath, 'utf8'), /\[job:finished\] .*reason=resource-limit/);
  });
});

describe('what a recovered end sets in motion (policy C)', () => {
  test('a recent failure is retried and its hook told: the end is within the window', async () => {
    const env = makeEnv([cronJob({ retryOnExitCodes: [7], retryDelays: [60] })]);
    leaveRun(env, { endedMinutesAgo: 10, status: { exitCode: 7 } });

    await env.sched.recoverRuns();

    assert.equal(env.hooks.filter((h) => h.name === 'onJobRetry').length, 1);
    assert.equal(env.sched._retryCounters.get('job'), 1);
  });

  test('an old failure is announced but not retried, and the log says why', async () => {
    const env = makeEnv([cronJob({ retryOnExitCodes: [7], retryDelays: [60] })]);
    const run = leaveRun(env, { endedMinutesAgo: 120, startedMinutesAgo: 150, status: { exitCode: 7 } });

    await env.sched.recoverRuns();

    assert.ok(names(env.events).includes('job.failed'));
    assert.equal(env.hooks.length, 0);
    assert.equal(env.sched._retryCounters.has('job'), false);
    assert.match(fs.readFileSync(run.logPath, 'utf8'), /retry\/dependents skipped: the run ended 120 min before the daemon came back \(window 30 min\)/);
  });

  test('a recent success fires its dependents, an old one does not', async () => {
    const recent = makeEnv([cronJob(), cronJob({ id: 'after', dependsOn: 'job' })]);
    leaveRun(recent, { endedMinutesAgo: 5, status: { exitCode: 0 } });
    const old = makeEnv([cronJob(), cronJob({ id: 'after', dependsOn: 'job' })]);
    leaveRun(old, { endedMinutesAgo: 200, startedMinutesAgo: 230, status: { exitCode: 0 } });
    const fired = [];
    recent.sched._fireUnlessFull = (job) => { fired.push(['recent', job.id]); };
    old.sched._fireUnlessFull = (job) => { fired.push(['old', job.id]); };

    await recent.sched.recoverRuns();
    await old.sched.recoverRuns();

    assert.deepEqual(fired, [['recent', 'after']]);
  });

  test('a success after a failure is announced as recovered, since the run before it had failed', async () => {
    const env = makeEnv([cronJob()]);
    env.state.record('job', { startedAt: at(300), finishedAt: at(299), exitCode: 1, pid: 1 });
    leaveRun(env, { status: { exitCode: 0 } });

    await env.sched.recoverRuns();

    assert.ok(names(env.events).includes('job.recovered'), names(env.events).join(', '));
  });
});

describe('a daemon that died in the middle of handling the end (case 9)', () => {
  test('events already published are not published again, the actions still happen', async () => {
    const env = makeEnv([cronJob({ retryOnExitCodes: [7], retryDelays: [60] })]);
    leaveRun(env, { endedMinutesAgo: 5, status: { exitCode: 7 }, effects: { state: true, events: true } });

    await env.sched.recoverRuns();

    assert.deepEqual(names(env.events), []);
    assert.equal(env.hooks.filter((h) => h.name === 'onJobRetry').length, 1);
  });

  test('actions already started are never started twice, even if the events were not done', async () => {
    const env = makeEnv([cronJob({ retryOnExitCodes: [7], retryDelays: [60] })]);
    leaveRun(env, { endedMinutesAgo: 5, status: { exitCode: 7 }, effects: { state: true, actions: true } });

    await env.sched.recoverRuns();

    assert.ok(names(env.events).includes('job.failed'));
    assert.equal(env.hooks.length, 0, 'a retry hook ran a second time');
  });

  test('a run already marked done is only cleaned up', async () => {
    const env = makeEnv([cronJob()]);
    const run = leaveRun(env, { status: { exitCode: 0 }, done: true });

    await env.sched.recoverRuns();

    assert.deepEqual(env.events, []);
    assert.equal(fs.existsSync(run.runDir), false);
  });
});

describe('edge cases of the folder and the job', () => {
  test('a job deleted while the daemon was down is still finalized, from what the spec recorded', async () => {
    const env = makeEnv([]);
    leaveRun(env, { status: { exitCode: 3 } });

    await env.sched.recoverRuns();

    assert.equal(env.state.get('job').exitCode, 3);
    assert.deepEqual(names(env.events), ['job.failed']);
    assert.equal(env.events[0].payload.label, 'Job');
  });

  test('recovery never starts a process', async () => {
    const env = makeEnv([cronJob(), cronJob({ id: 'after', dependsOn: 'job' })]);
    leaveRun(env, { endedMinutesAgo: 2, status: { exitCode: 0 } });
    env.sched._fireUnlessFull = () => {};

    await env.sched.recoverRuns();

    assert.deepEqual(env.spawned, []);
  });

  test('an unreadable status is reported and left alone, not guessed at', async () => {
    const env = makeEnv([cronJob()]);
    const run = leaveRun(env, {});
    fs.writeFileSync(path.join(run.runDir, 'status.json'), '{ not json');

    const report = await env.sched.recoverRuns();

    assert.equal(report.unreadable.length, 1);
    assert.match(report.unreadable[0], /status\.json/);
    assert.equal(fs.existsSync(run.runDir), true, 'evidence must be kept');
  });

  test('reports what it did, so the daemon log can say it', async () => {
    const env = makeEnv([cronJob()]);
    leaveRun(env, { status: { exitCode: 0 } });

    const report = await env.sched.recoverRuns();

    assert.equal(report.finalized, 1);
  });
});
