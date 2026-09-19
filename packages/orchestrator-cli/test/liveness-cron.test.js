'use strict';

// The liveness check -- "if the target is already alive, do not fire" -- existed but was reachable
// only from _maybeSpawn, which only startup jobs went through. Cron jobs went straight to _fire
// (both the recurring task and the catch-up path), and so did once jobs, so `--liveness-strategy` on
// a cron job was accepted by the CLI and then quietly ignored. That is the mechanism meant to handle
// "this scraper is already running", so its absence is the reason the failure showed up as an exit
// code at all.
//
// And where it did work, it was a bare `return`: no log line, no event, no run history. "Nothing
// happened and nobody can tell why" is the opposite failure, so a skip has to announce itself.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { FakeTime }  = require('../src/time-service');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-livecron-'));
}

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.pid = 4242;
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

/** `alive` is what the liveness check reports for every job. */
function makeSched(jobs, alive, extraOptions = {}) {
  const dir = tmpDir();
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  for (const job of jobs) registry.add(job);
  const events  = [];
  const spawned = [];
  const sched = new Scheduler(registry, state, {
    spawn: (cmd) => { spawned.push(cmd); return fakeChild(0); },
    liveness: async () => alive,
    eventPublisher: { publish: (event, payload) => events.push({ event, payload }) },
    ...extraOptions,
  });
  return { sched, state, registry, events, spawned };
}

const names = (events) => events.map((e) => e.event);

const LIVE = { strategy: 'command', command: 'tasklist' };

/*
 * The recurring path, driven by a clock the test owns.
 *
 * These two used to arm a SIX-field schedule - "every second", which node-cron accepted - and then
 * sleep 1500ms in real time. Two problems with that, both of which the single-timer refactor exposed:
 * the registry refuses six fields (CRON_RE is anchored on five), so the tests exercised a schedule no
 * user can configure; and they spent 3 seconds of wall clock proving something about a decision.
 *
 * A five-field schedule advanced on a FakeTime is the same assertion about the shape users actually
 * have, and it is instant.
 */
describe('a cron job honours its liveness check', () => {
  const HOURLY = { schedule: '0 * * * *', command: 'npm run scrape' };

  function armHourly(alive) {
    const time = new FakeTime();
    const env = makeSched([], alive, { time });
    env.sched._scheduleCron({
      id: 'wa', type: 'cron', ...HOURLY,
      enabled: true, triggerMode: 'fire-and-forget', liveness: LIVE, label: 'wa',
    });
    return { ...env, time };
  }

  test('the recurring task does not fire while the target is alive', async () => {
    const { sched, spawned, time } = armHourly(true);

    // Two occurrences' worth, so this cannot pass by never reaching one.
    await time.advanceAsync(2 * 60 * 60_000, 10 * 60_000);
    await sched.stop();

    assert.deepEqual(spawned, [], 'the cron fired on top of a run that was already going');
  });

  test('the recurring task does fire when the target is not alive', async () => {
    const { sched, spawned, time } = armHourly(false);

    await time.advanceAsync(2 * 60 * 60_000, 10 * 60_000);
    await sched.stop();

    assert.ok(spawned.length > 0, 'the liveness check now blocks a cron that should have run');
  });

  // The guard that makes the rewrite above safe rather than merely different: our matcher reads five
  // fields positionally, so a six-field expression would be read as minute-hour-dom-mon-dow and mean
  // something else. Refused out loud instead.
  test('a six-field schedule is refused rather than misread', async () => {
    const { sched, spawned, time } = (() => {
      const t = new FakeTime();
      const env = makeSched([], false, { time: t });
      env.sched._scheduleCron({
        id: 'wa', type: 'cron', schedule: '* * * * * *', command: 'npm run scrape',
        enabled: true, triggerMode: 'fire-and-forget', liveness: LIVE, label: 'wa',
      });
      return { ...env, time: t };
    })();

    await time.advanceAsync(2 * 60 * 60_000, 10 * 60_000);
    await sched.stop();

    assert.deepEqual(spawned, [], 'a six-field schedule was read as something it is not');
    assert.equal(sched.armedTimers, 0, 'a timer was armed for a schedule that cannot be honoured');
  });

  // The catch-up path: a missed firing replayed at daemon start.
  test('a caught-up firing is skipped while the target is alive', async () => {
    const job = {
      id: 'wa', type: 'cron', schedule: '0 8 * * *', command: 'npm run scrape',
      enabled: true, triggerMode: 'fire-and-forget', missedFiring: 'catch-up', liveness: LIVE,
    };
    const { sched, spawned } = makeSched([job], true, {
      now: () => new Date('2026-09-18T09:00:00.000Z'),
      catchUpInitialDelayMs: 0,
    });

    await sched.start();
    await sched.stop();

    assert.deepEqual(spawned, [], 'catch-up ignored the liveness check');
  });

  test('a caught-up firing still happens when the target is not alive', async () => {
    const job = {
      id: 'wa', type: 'cron', schedule: '0 8 * * *', command: 'npm run scrape',
      enabled: true, triggerMode: 'fire-and-forget', missedFiring: 'catch-up', liveness: LIVE,
    };
    const { sched, spawned } = makeSched([job], false, {
      now: () => new Date('2026-09-18T09:00:00.000Z'),
      catchUpInitialDelayMs: 0,
    });

    await sched.start();
    await sched.stop();

    assert.deepEqual(spawned, ['npm run scrape']);
  });
});

describe('a once job honours its liveness check', () => {
  test('it does not fire while the target is alive', async () => {
    const job = {
      id: 'one', type: 'once', command: 'npm run scrape', enabled: true,
      triggerMode: 'fire-and-forget', liveness: LIVE,
      delayMs: 1000, scheduledAt: new Date('2026-09-18T08:00:00.000Z').toISOString(),
    };
    const { sched, spawned } = makeSched([job], true, {
      now: () => new Date('2026-09-18T09:00:00.000Z'),
    });

    await sched.start();
    await sched.stop();

    assert.deepEqual(spawned, []);
  });
});

describe('a skipped firing says so', () => {
  test('job.skipped is published, with liveness as the reason', async () => {
    const job = {
      id: 'svc', type: 'startup', delaySeconds: 0, command: 'npm run scrape',
      enabled: true, triggerMode: 'fire-and-forget', liveness: LIVE,
    };
    const { sched, events } = makeSched([job], true);

    await sched.start();
    await sched.stop();

    const skipped = events.find((e) => e.event === 'job.skipped');
    assert.ok(skipped, `the skip left no trace at all: ${names(events).join(', ')}`);
    assert.equal(skipped.payload.jobId, 'svc');
    assert.equal(skipped.payload.reason, 'liveness');
  });

  test('the skip is recorded in the run history, with no exit code to show', async () => {
    const job = {
      id: 'svc', type: 'startup', delaySeconds: 0, command: 'npm run scrape',
      enabled: true, triggerMode: 'fire-and-forget', liveness: LIVE,
    };
    const { sched, state } = makeSched([job], true);

    await sched.start();
    await sched.stop();

    const entry = state.get('svc');
    assert.ok(entry, 'nothing in the history: the dashboard cannot show why the run is missing');
    assert.equal(entry.skipped, true);
    assert.equal(entry.exitCode, null, 'no process ran, so there is no exit code to report');
    assert.ok(entry.finishedAt, 'without finishedAt the entry reads as a run still in flight');
  });

  test('no job.started or job.failed is published for a skip', async () => {
    const job = {
      id: 'svc', type: 'startup', delaySeconds: 0, command: 'npm run scrape',
      enabled: true, triggerMode: 'fire-and-forget', liveness: LIVE,
    };
    const { sched, events } = makeSched([job], true);

    await sched.start();
    await sched.stop();

    assert.ok(!names(events).includes('job.started'));
    assert.ok(!names(events).includes('job.failed'));
  });
});

describe('an explicit manual trigger overrides liveness', () => {
  test('orch trigger fires even when the target is alive', async () => {
    const job = {
      id: 'wa', type: 'cron', schedule: '0 8 * * *', command: 'npm run scrape',
      enabled: true, triggerMode: 'fire-and-forget', liveness: LIVE,
    };
    const { sched, spawned } = makeSched([job], true);

    await sched.trigger('wa');

    assert.deepEqual(spawned, ['npm run scrape'],
      'a human asking for a run explicitly should not be second-guessed');
  });
});
