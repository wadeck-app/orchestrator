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
  return { registry, state, sched, time, dir };
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

/*
 * orch exists to be the one thing on a machine that owns timers for other applications. It used to
 * own a pile of its own: a node-cron task per cron job, plus a timer each for a once job, a window
 * start, a window end, a retry. These hold it to one.
 */
describe('the whole daemon arms one timer', () => {
  test('a registry full of mixed jobs arms exactly one', async () => {
    const env = makeEnv();
    const now = env.time.now();
    for (let i = 0; i < 4; i++) {
      env.registry.add(cronJob({ id: `cron${i}`, schedule: `${i} * * * *` }));
    }
    env.registry.add(cronJob({ id: 'pending', activeFrom: iso(now + 7 * DAY) }));
    env.registry.add(cronJob({ id: 'closing', activeUntil: iso(now + 7 * DAY) }));
    for (let i = 0; i < 3; i++) {
      env.registry.add({
        id: `once${i}`, type: 'once', command: 'echo once', label: 'O', enabled: true,
        triggerMode: 'fire-and-forget', liveness: null, missedFiring: 'skip',
        delayMs: (i + 1) * HOUR, scheduledAt: iso(now),
      });
    }
    env.registry.add({
      id: 'startup', type: 'startup', delaySeconds: 300, command: 'echo up', label: 'S',
      enabled: true, triggerMode: 'fire-and-forget', liveness: null,
    });

    await env.sched.start();
    try {
      // Ten jobs, eleven deadlines (the closing one holds a cron occurrence AND its window end).
      assert.ok(env.sched.inspectTimers().length === 10, 'not every job was reported');
      assert.equal(env.sched.armedTimers, 1, 'one timer per job is exactly what this replaces');
    } finally {
      await env.sched.stop();
    }
  });

  test('stopping disarms it', async () => {
    const env = makeEnv();
    env.registry.add(cronJob());
    await env.sched.start();
    assert.equal(env.sched.armedTimers, 1);

    await env.sched.stop();

    assert.equal(env.sched.armedTimers, 0, 'a stopped scheduler is still armed');
  });

  // A firing re-arms for the next occurrence, so the count must not grow with each one.
  test('firings do not accumulate timers', async () => {
    const env = makeEnv();
    env.registry.add(cronJob({ schedule: '0 * * * *' }));
    await env.sched.start();
    try {
      await env.time.advanceAsync(5 * HOUR, 10 * MINUTE);

      assert.equal(env.sched.armedTimers, 1, 'each firing left a timer behind');
    } finally {
      await env.sched.stop();
    }
  });

  /*
   * The cron occurrence is on the injected clock now, not node-cron's own. Two hours of an hourly
   * schedule must be two firings - not none, which is what a schedule still driven by the real clock
   * would give here, and not three, which is what re-arming from the wrong instant would give.
   */
  test('an hourly job fires once per hour of the test clock', async () => {
    const env = makeEnv();
    const spawned = [];
    const sched = new Scheduler(env.registry, env.state, {
      configDir: env.dir,
      time: env.time,
      liveness: async () => false,
      spawn: (cmd) => {
        spawned.push(cmd);
        const c = new EventEmitter();
        c.pid = 1;
        process.nextTick(() => c.emit('close', 0));
        return c;
      },
      eventPublisher: { publish: () => {} },
    });
    env.registry.add(cronJob({ schedule: '0 * * * *' }));
    await sched.start();
    try {
      await env.time.advanceAsync(2 * HOUR + MINUTE, 5 * MINUTE);

      assert.equal(spawned.length, 2, `fired ${spawned.length} times in two hours`);
    } finally {
      await sched.stop();
    }
  });
});

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
