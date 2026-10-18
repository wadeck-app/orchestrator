'use strict';

// Everything the scheduler does when a run ends, pinned down before that code moves.
//
// The end of a run used to live in one 100-line close handler. It is being split so the same effects can run
// for a job that ended while the daemon was down (see .claude/plans/2026-10-18_update-with-jobs-running.md),
// and a split of code this old is only safe against tests that say what it does today.
//
// Two tests below describe behaviour the handler was MEANT to have and never had; they are marked.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');

const schedulers = [];
afterEach(async () => {
  while (schedulers.length > 0) {
    await schedulers.pop().stop();
  }
});

function cronJob(extra = {}) {
  return { id: 'job', type: 'cron', schedule: '0 8 * * *', command: 'run it', label: 'Job', enabled: true, triggerMode: 'wait', ...extra };
}

/** A scheduler whose children exit with the next code of `codes`, recording events, hooks and spawns. */
function makeEnv(jobs, codes, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-end-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  for (const job of jobs) {
    registry.add(job);
  }
  const events = [];
  const hooks = [];
  const spawned = [];
  let next = 0;
  // Two runs of a job in the same millisecond share a start time, which is the key of their history entry: the
  // second would replace the first. A fast machine does that, so the clock never gives the same instant twice.
  let ticks = 0;
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    now: () => new Date(Date.now() + ticks++),
    spawn: (cmd) => {
      spawned.push(cmd);
      const child = new EventEmitter();
      child.pid = 4242;
      const code = codes[Math.min(next++, codes.length - 1)];
      process.nextTick(() => child.emit('close', code));
      return child;
    },
    liveness: async () => false,
    sampleUsage: async () => null,
    eventPublisher: { publish: (event, payload) => events.push({ event, payload }) },
    hookDispatcher: { dispatch: async (name, payload) => { hooks.push({ name, payload }); } },
    ...extra,
  });
  schedulers.push(sched);
  return { sched, state, registry, events, hooks, spawned, dir };
}

const names = (events) => events.map((e) => e.event);

/** The text of the newest run log of a job. */
function runLog(dir, jobId) {
  const folder = path.join(dir, 'logs', 'jobs', jobId);
  const files = fs.readdirSync(folder).filter((f) => f.endsWith('.log')).sort();
  return fs.readFileSync(path.join(folder, files[files.length - 1]), 'utf8');
}

describe('a run that succeeds', () => {
  test('publishes started then completed, records the exit code and writes the finish marker', async () => {
    const env = makeEnv([cronJob()], [0]);

    await env.sched._fire(cronJob());

    assert.deepEqual(names(env.events), ['job.started', 'job.completed']);
    assert.equal(env.state.get('job').exitCode, 0);
    assert.match(runLog(env.dir, 'job'), /\[job:finished\] exitCode=0 /);
  });

  test('fires the jobs that depend on it, and only the enabled ones', async () => {
    const dependents = [
      cronJob({ id: 'after', dependsOn: 'job' }),
      cronJob({ id: 'off', dependsOn: 'job', enabled: false }),
    ];
    const env = makeEnv([cronJob(), ...dependents], [0]);

    await env.sched._fire(cronJob());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(env.spawned.length, 2, `the parent and one dependent should have run, got ${env.spawned.length}`);
  });

  test('clears the retry counter', async () => {
    const env = makeEnv([cronJob({ retryOnExitCodes: [7], retryDelays: [60] })], [7, 0]);

    await env.sched._fire(cronJob({ retryOnExitCodes: [7], retryDelays: [60] }));
    assert.equal(env.sched._retryCounters.get('job'), 1);
    await env.sched._fire(cronJob({ retryOnExitCodes: [7], retryDelays: [60] }));

    assert.equal(env.sched._retryCounters.has('job'), false);
  });
});

describe('a run that fails', () => {
  test('publishes failed, records the code, and fires no dependent', async () => {
    const env = makeEnv([cronJob(), cronJob({ id: 'after', dependsOn: 'job' })], [3]);

    await env.sched._fire(cronJob());
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(names(env.events), ['job.started', 'job.failed']);
    assert.equal(env.state.get('job').exitCode, 3);
    assert.equal(env.spawned.length, 1, 'a failed run must not start its dependents');
  });

  test('raises the consecutive-failure alert once the job threshold is reached', async () => {
    const job = cronJob({ alertAfterFailures: 2 });
    const env = makeEnv([job], [1, 1]);

    await env.sched._fire(job);
    assert.ok(!names(env.events).includes('alert.consecutive_failures'));
    await env.sched._fire(job);

    const alert = env.events.find((e) => e.event === 'alert.consecutive_failures');
    assert.ok(alert, `no alert after two failures: ${names(env.events).join(', ')}`);
    assert.equal(alert.payload.consecutiveFailures, 2);
    assert.equal(alert.payload.threshold, 2);
  });

  test('schedules a retry on a listed exit code, tells the hook, and writes the marker in the run log', async () => {
    const job = cronJob({ retryOnExitCodes: [7], retryDelays: [60, 120] });
    const env = makeEnv([job], [7]);

    await env.sched._fire(job);

    assert.equal(env.hooks.filter((h) => h.name === 'onJobRetry').length, 1);
    assert.equal(env.hooks[0].payload.attempt, 1);
    assert.equal(env.hooks[0].payload.totalAttempts, 2);
    assert.equal(env.sched._retryCounters.get('job'), 1);
    // INTENDED, NEVER TRUE: the logger was closed before this line ran, so the marker went nowhere.
    assert.match(runLog(env.dir, 'job'), /\[retry\] attempt 1\/2 in 60s \(exitCode=7\)/);
  });

  test('gives up after the last delay: hook, event and the permanent-failure marker', async () => {
    const job = cronJob({ retryOnExitCodes: [7], retryDelays: [60] });
    const env = makeEnv([job], [7, 7]);

    await env.sched._fire(job);
    await env.sched._fire(job);

    assert.equal(env.hooks.filter((h) => h.name === 'onJobExhausted').length, 1);
    const exhausted = env.events.find((e) => e.event === 'alert.retry_exhausted');
    assert.ok(exhausted, `no exhaustion alert: ${names(env.events).join(', ')}`);
    assert.equal(exhausted.payload.attempts, 1);
    assert.equal(env.sched._retryCounters.has('job'), false);
    assert.match(runLog(env.dir, 'job'), /\[retry\] exhausted after 1 attempts/);
  });

  test('does not retry an exit code that is not listed', async () => {
    const job = cronJob({ retryOnExitCodes: [7], retryDelays: [60] });
    const env = makeEnv([job], [8]);

    await env.sched._fire(job);

    assert.equal(env.hooks.length, 0);
    assert.equal(env.sched._retryCounters.has('job'), false);
  });
});

describe('recovery and anomaly', () => {
  test('a success after a failure publishes job.recovered', async () => {
    // INTENDED, NEVER TRUE: "was the previous run a failure" was read after this run's own open entry had
    // been recorded, so it always looked at a run that had not failed yet.
    const job = cronJob();
    const env = makeEnv([job], [1, 0]);

    await env.sched._fire(job);
    await env.sched._fire(job);

    assert.ok(names(env.events).includes('job.recovered'), `no recovery: ${names(env.events).join(', ')}`);
  });

  test('a success after a success does not publish job.recovered', async () => {
    const job = cronJob();
    const env = makeEnv([job], [0, 0]);

    await env.sched._fire(job);
    await env.sched._fire(job);

    assert.ok(!names(env.events).includes('job.recovered'));
  });

  test('a run three times longer than the recent average is an anomaly, announced and written in the log', async () => {
    const job = cronJob();
    // Three earlier runs of exactly one second, then a run that took ten.
    let clock = Date.parse('2026-10-18T10:00:00Z');
    const env = makeEnv([job], [0], { now: () => new Date(clock) });
    for (let i = 0; i < 3; i++) {
      const start = new Date(Date.parse('2026-10-18T09:00:00Z') + i * 60_000);
      env.state.record('job', { startedAt: start.toISOString(), finishedAt: new Date(start.getTime() + 1000).toISOString(), exitCode: 0, pid: 1 });
    }
    // _fire measures the duration against the real clock, so start the run ten seconds in the past.
    clock = Date.now() - 10_000;

    await env.sched._fire(job);

    const anomaly = env.events.find((e) => e.event === 'job.anomaly');
    assert.ok(anomaly, `no anomaly: ${names(env.events).join(', ')}`);
    assert.equal(anomaly.payload.multiplier, 3);
    assert.match(runLog(env.dir, 'job'), /anomaly detected/);
  });
});

describe('a run ended by the user, a timeout or a declared skip', () => {
  test('a user kill is announced as such and neither fails nor retries', async () => {
    const job = cronJob({ retryOnExitCodes: [1], retryDelays: [60] });
    const env = makeEnv([job], [1]);
    const original = env.sched._spawn;
    env.sched._spawn = (...args) => {
      const child = original(...args);
      env.sched._killedByUser.add(child);
      return child;
    };

    await env.sched._fire(job);

    assert.deepEqual(names(env.events), ['job.started', 'job.killed_manual']);
    assert.equal(env.state.get('job').exitCode, null);
    assert.equal(env.state.get('job').cancelledByUser, true);
    assert.equal(env.hooks.length, 0);
  });

  test('job-finished is emitted once, with the exit code and the duration', async () => {
    const env = makeEnv([cronJob()], [5]);
    const seen = [];
    env.sched.on('job-finished', (ev) => seen.push(ev));

    await env.sched._fire(cronJob());

    assert.equal(seen.length, 1);
    assert.equal(seen[0].exitCode, 5);
    assert.equal(seen[0].id, 'job');
    assert.equal(typeof seen[0].durationMs, 'number');
  });
});
