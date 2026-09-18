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
 * A cron job with an active window: "active for three weeks", or a period that starts later.
 *
 * At the end the job is DISABLED, not deleted. Its definition, history and logs stay, and turning it
 * back on is a decision the user makes.
 *
 * Every one of these spans days or weeks and takes no real time: on the real timers they could not
 * have been written at all.
 */

const dirs = [];
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.pid = 12345;
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-window-'));
  dirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  const time = new FakeTime();
  const spawned = [];
  const events = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    time,
    liveness: async () => false,
    spawn: (cmd) => { spawned.push(cmd); return fakeChild(0); },
    eventPublisher: { publish: (topic, payload) => events.push({ topic, payload }) },
  });
  return { registry, sched, time, spawned, events };
}

// Every minute, so a day of simulated time produces plenty of firings to count.
function cronJob(window = {}) {
  return {
    id: 'c', type: 'cron', schedule: '* * * * *', command: 'echo tick', label: 'C',
    enabled: true, triggerMode: 'fire-and-forget', liveness: null, missedFiring: 'skip',
    ...window,
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/*
 * node-cron drives itself on the real clock, so these do not assert firings - they assert the
 * scheduling DECISIONS the window governs, which is where the logic lives.
 */
describe('a window that has not opened yet', () => {
  test('the job is enabled but not on the clock', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(cronJob({ activeFrom: iso(time.now() + 7 * DAY) }));

    await sched.start();

    assert.equal(registry.get('c').enabled, true, 'pending is not disabled');
    assert.equal(sched.windowStateOf('c'), 'pending');
    await sched.stop();
  });

  test('it goes on the clock when the window opens', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(cronJob({ activeFrom: iso(time.now() + 7 * DAY) }));
    await sched.start();

    await time.advanceAsync(7 * DAY, HOUR);

    assert.equal(sched.windowStateOf('c'), 'active');
    await sched.stop();
  });

  test('it is still not active a minute before opening', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(cronJob({ activeFrom: iso(time.now() + 7 * DAY) }));
    await sched.start();

    await time.advanceAsync(7 * DAY - MINUTE, HOUR);

    assert.equal(sched.windowStateOf('c'), 'pending');
    await sched.stop();
  });
});

describe('a window that closes', () => {
  test('the job is disabled, not deleted', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(cronJob({ activeUntil: iso(time.now() + 2 * DAY) }));
    await sched.start();

    await time.advanceAsync(2 * DAY, HOUR);

    const job = registry.get('c');
    assert.ok(job, 'the job must still exist');
    assert.equal(job.enabled, false, 'and be disabled');
    await sched.stop();
  });

  /*
   * Expiry is armed as its own timer rather than checked at the next firing. For a weekly job that
   * would be up to six days late, and for a job that never fires again it would be never.
   */
  test('expires on time rather than at its next firing', async () => {
    const { registry, sched, time } = makeEnv();
    // Fires once a year, so the next firing is nowhere near the end of the window.
    registry.add(cronJob({ schedule: '0 0 1 1 *', activeUntil: iso(time.now() + 2 * DAY) }));
    await sched.start();

    await time.advanceAsync(2 * DAY, HOUR);

    assert.equal(registry.get('c').enabled, false);
    await sched.stop();
  });

  // A job going quiet on its own is otherwise indistinguishable from a job that is broken.
  test('says so, rather than going quiet', async () => {
    const { registry, sched, time, events } = makeEnv();
    registry.add(cronJob({ activeUntil: iso(time.now() + DAY) }));
    await sched.start();

    await time.advanceAsync(DAY, HOUR);

    const expired = events.filter(e => e.topic === 'job.window_expired');
    assert.equal(expired.length, 1, 'expiry must be announced exactly once');
    assert.equal(expired[0].payload.jobId, 'c');
    await sched.stop();
  });

  test('announces it once, not once per check', async () => {
    const { registry, sched, time, events } = makeEnv();
    registry.add(cronJob({ activeUntil: iso(time.now() + DAY) }));
    await sched.start();

    await time.advanceAsync(30 * DAY, HOUR);

    assert.equal(events.filter(e => e.topic === 'job.window_expired').length, 1);
    await sched.stop();
  });

  test('is still enabled just before the end', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(cronJob({ activeUntil: iso(time.now() + 2 * DAY) }));
    await sched.start();

    await time.advanceAsync(2 * DAY - MINUTE, HOUR);

    assert.equal(registry.get('c').enabled, true);
    await sched.stop();
  });
});

describe('three weeks, start to finish', () => {
  test('pending, then active, then disabled', async () => {
    const { registry, sched, time } = makeEnv();
    const start = time.now() + 7 * DAY;
    registry.add(cronJob({ activeFrom: iso(start), activeUntil: iso(start + 21 * DAY) }));
    await sched.start();

    assert.equal(sched.windowStateOf('c'), 'pending');

    await time.advanceAsync(7 * DAY, HOUR);
    assert.equal(sched.windowStateOf('c'), 'active');
    assert.equal(registry.get('c').enabled, true);

    await time.advanceAsync(21 * DAY, HOUR);
    assert.equal(registry.get('c').enabled, false, 'disabled at the end of the three weeks');
    assert.ok(registry.get('c'), 'and still present');
    await sched.stop();
  });
});

describe('a window that closed while the daemon was down', () => {
  // The registry is read at startup, so the check has to happen there too rather than only on a timer
  // that was never armed.
  test('the job is disabled at startup, not resumed', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(cronJob({ activeUntil: iso(time.now() - DAY) }));

    await sched.start();

    assert.equal(registry.get('c').enabled, false);
    await sched.stop();
  });

  test('a catch-up firing is not replayed for an expired job', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add(cronJob({ missedFiring: 'catch-up', activeUntil: iso(time.now() - DAY) }));

    await sched.start();
    await time.advanceAsync(HOUR, MINUTE);

    assert.deepEqual(spawned, [], 'the window exists to prevent exactly this work');
    await sched.stop();
  });

  test('a catch-up firing is not replayed before the window opens', async () => {
    const { registry, sched, time, spawned } = makeEnv();
    registry.add(cronJob({ missedFiring: 'catch-up', activeFrom: iso(time.now() + 7 * DAY) }));

    await sched.start();
    await time.advanceAsync(HOUR, MINUTE);

    assert.deepEqual(spawned, []);
    await sched.stop();
  });
});

describe('a job with no window is unaffected', () => {
  test('stays active and enabled indefinitely', async () => {
    const { registry, sched, time } = makeEnv();
    registry.add(cronJob());

    await sched.start();
    await time.advanceAsync(365 * DAY, DAY);

    assert.equal(registry.get('c').enabled, true);
    assert.equal(sched.windowStateOf('c'), 'active');
    await sched.stop();
  });
});

describe('the window is refused when it can never fire', () => {
  test('rejects an end before the start', () => {
    const { registry, time } = makeEnv();

    assert.throws(
      () => registry.add(cronJob({ activeFrom: iso(time.now() + DAY), activeUntil: iso(time.now()) })),
      /activeUntil must be after activeFrom/,
    );
  });

  test('rejects an unparseable bound', () => {
    const { registry } = makeEnv();

    assert.throws(() => registry.add(cronJob({ activeUntil: 'next tuesday' })), /ISO timestamp/);
  });
});
