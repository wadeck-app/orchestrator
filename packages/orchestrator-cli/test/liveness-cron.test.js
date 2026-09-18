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

describe('a cron job honours its liveness check', () => {
  // The recurring path. A 6-field schedule fires every second, which node-cron accepts, so this
  // exercises the real cron task rather than a stand-in for it.
  test('the recurring task does not fire while the target is alive', async () => {
    const { sched, spawned } = makeSched([], true);

    sched._scheduleCron({
      id: 'wa', type: 'cron', schedule: '* * * * * *', command: 'npm run scrape',
      enabled: true, triggerMode: 'fire-and-forget', liveness: LIVE, label: 'wa',
    });
    await new Promise((r) => setTimeout(r, 1500));
    await sched.stop();

    assert.deepEqual(spawned, [], 'the cron fired on top of a run that was already going');
  });

  test('the recurring task does fire when the target is not alive', async () => {
    const { sched, spawned } = makeSched([], false);

    sched._scheduleCron({
      id: 'wa', type: 'cron', schedule: '* * * * * *', command: 'npm run scrape',
      enabled: true, triggerMode: 'fire-and-forget', liveness: LIVE, label: 'wa',
    });
    await new Promise((r) => setTimeout(r, 1500));
    await sched.stop();

    assert.ok(spawned.length > 0, 'the liveness check now blocks a cron that should have run');
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
