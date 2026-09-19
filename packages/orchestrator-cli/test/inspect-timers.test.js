'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { Scheduler } = require('../src/scheduler');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { FakeTime } = require('../src/time-service');

/*
 * inspectTimers exists to answer one question: does what the scheduler has ARMED agree with what the
 * registry ASKS FOR?
 *
 * Every "it was configured and never fired" bug in this daemon has been a disagreement between those
 * two, and each one took a code reading to find - a job added at runtime that was never scheduled, a
 * once job past a timer's ceiling that fired at once, a window beyond 24 days that opened
 * immediately. So the case that matters most here is the ghost test below: a job the scheduler has
 * never been told about must be reported, not hidden.
 */

const dirs = [];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-inspect-'));
  dirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  const time = new FakeTime();
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    time,
    liveness: async () => false,
    spawn: () => {
      const c = new EventEmitter();
      c.pid = 1;
      process.nextTick(() => c.emit('close', 0));
      return c;
    },
    eventPublisher: { publish: () => {} },
  });
  return { registry, sched, time };
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Runs a test body against a started scheduler, and stops it whatever happens.
 *
 * The try/finally is the point. A cron task is a real node-cron timer, so a body that throws before
 * its own `stop()` leaves one armed and the whole FILE then hangs at exit instead of reporting the
 * failure - which is how one wrong assertion here turned into an 88-second run with no visible cause.
 * A failing test must fail, not hang.
 */
async function withScheduler(body) {
  const env = makeEnv();
  await env.sched.start();
  try {
    await body(env);
  } finally {
    await env.sched.stop();
  }
}

function cronJob(extra = {}) {
  return {
    id: 'c1', type: 'cron', schedule: '*/5 * * * *', command: 'echo tick', label: 'C',
    enabled: true, triggerMode: 'fire-and-forget', liveness: null, missedFiring: 'skip', ...extra,
  };
}

function report(rows, id) {
  const row = rows.find(r => r.jobId === id);
  assert.notEqual(row, undefined, `no report for "${id}"`);
  return row;
}

describe('inspectTimers reports what is armed against what is configured', () => {
  test('an enabled cron job is armed as cron, with its next firing', async () => {
    const env = makeEnv();
    env.registry.add(cronJob());
    await env.sched.start();
    try {
      const r = report(env.sched.inspectTimers(), 'c1');
      assert.equal(r.armed, 'cron');
      assert.equal(r.problem, null);
      assert.notEqual(r.nextFiring, null, 'no next firing computed for a valid schedule');
    } finally {
      await env.sched.stop();
    }
  });

  test('a once job is armed as once, and says when', async () => {
    const env = makeEnv();
    const due = env.time.now() + 3 * HOUR;
    env.registry.add({
      id: 'o1', type: 'once', command: 'echo once', label: 'O', enabled: true,
      triggerMode: 'fire-and-forget', liveness: null, missedFiring: 'skip',
      delayMs: 3 * HOUR, scheduledAt: iso(env.time.now()),
    });
    await env.sched.start();
    try {
      const r = report(env.sched.inspectTimers(), 'o1');
      assert.equal(r.armed, 'once');
      assert.equal(r.dueAt, iso(due), 'the armed moment is not the configured one');
      assert.equal(r.problem, null);
    } finally {
      await env.sched.stop();
    }
  });

  test('a window that has not opened is armed as window-start', async () => {
    const env = makeEnv();
    env.registry.add(cronJob({ activeFrom: iso(env.time.now() + 7 * DAY) }));
    await env.sched.start();
    try {
      const r = report(env.sched.inspectTimers(), 'c1');
      assert.equal(r.armed, 'window-start');
      assert.equal(r.windowState, 'pending');
      // Pending is a correct state, not a problem: saying something here would bury the real ones.
      assert.equal(r.problem, null);
    } finally {
      await env.sched.stop();
    }
  });

  /*
   * A cron job inside a closing window has BOTH timers: the cron task that fires it, and the window
   * timer that will disable it. `armed` names the firing mechanism and `windowEndsAt` carries the
   * other, because collapsing them into one field hid the window completely - and "why did my job
   * disable itself" is the question that needs it.
   */
  test('a window that will close reports its end alongside the cron task', async () => {
    const env = makeEnv();
    const ends = env.time.now() + 7 * DAY;
    env.registry.add(cronJob({ activeUntil: iso(ends) }));
    await env.sched.start();
    try {
      const r = report(env.sched.inspectTimers(), 'c1');
      assert.equal(r.armed, 'cron', 'the firing mechanism is still the cron task');
      assert.equal(r.windowEndsAt, iso(ends), 'the window end is invisible in the report');
      assert.equal(r.windowState, 'active');
      assert.equal(r.problem, null);
    } finally {
      await env.sched.stop();
    }
  });

  test('a job with no window reports no window end', async () => {
    const env = makeEnv();
    env.registry.add(cronJob());
    await env.sched.start();
    try {
      assert.equal(report(env.sched.inspectTimers(), 'c1').windowEndsAt, null);
    } finally {
      await env.sched.stop();
    }
  });

  test('a disabled job has nothing armed, and that is not a problem', async () => {
    const env = makeEnv();
    env.registry.add(cronJob({ enabled: false }));
    await env.sched.start();
    try {
      const r = report(env.sched.inspectTimers(), 'c1');
      assert.equal(r.armed, null);
      assert.equal(r.problem, null, 'a disabled job was reported as broken');
    } finally {
      await env.sched.stop();
    }
  });

  /*
   * The case this whole thing exists for.
   *
   * A job written straight into the registry while the daemon runs, without the scheduler being told
   * - which is exactly the bug fixed in eafcdf7, where `add-job` wrote the registry and nothing armed
   * a timer. `orch list` showed it, the dashboard showed it, and it never fired.
   */
  test('a job the scheduler was never told about is reported, not hidden', async () => {
    await withScheduler(async ({ registry, sched }) => {
      registry.add(cronJob({ id: 'ghost' }));

      const r = report(sched.inspectTimers(), 'ghost');
      assert.equal(r.armed, null);
      assert.notEqual(r.problem, null, 'a job that will never fire reported no problem');
      assert.match(r.problem, /NOTHING is armed/, `the problem does not say what is wrong: ${r.problem}`);
      // The message has to tell the user what to do about it, not just that something is wrong.
      assert.match(r.problem, /orch edit ghost/, `no way out offered: ${r.problem}`);
    });
  });

  // Scheduling it clears the report, which is what makes the report trustworthy.
  test('and scheduling it clears the problem', async () => {
    await withScheduler(async ({ registry, sched }) => {
      registry.add(cronJob({ id: 'ghost' }));

      sched.scheduleJob(registry.get('ghost'));

      const r = report(sched.inspectTimers(), 'ghost');
      assert.equal(r.armed, 'cron');
      assert.equal(r.problem, null);
    });
  });
});
