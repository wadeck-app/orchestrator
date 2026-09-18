'use strict';

// A job that declines to do its work is not a job that broke.
//
// The case that prompted this: a scraper holds a single-instance lock and exits 2 when another copy
// is already running. orch counted every non-zero exit as a failure, so a perfectly healthy "nothing
// to do here" produced job.failed, fed the consecutive-failure alert, lit up the systray and sat in
// the dashboard's failure list. `skipExitCodes` is per job on purpose: 2 is a convention in that
// scraper's repo, not in every binary orch can launch.
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-skip-test-'));
}

function fakeChild(exitCode) {
  const child = new EventEmitter();
  child.pid = 12345;
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

/** Scheduler wired to a captured event log and a child that exits with `exitCode`. */
function makeSched(job, exitCode, extraOptions = {}) {
  const dir = tmpDir();
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(job);
  const events = [];
  const spawned = [];
  const sched = new Scheduler(registry, state, {
    spawn: (cmd) => { spawned.push(cmd); return fakeChild(exitCode); },
    liveness: async () => false,
    eventPublisher: { publish: (event, payload) => events.push({ event, payload }) },
    ...extraOptions,
  });
  return { sched, state, registry, events, spawned, dir };
}

const names = (events) => events.map((e) => e.event);

const SCRAPER = {
  id: 'wa-scrape', type: 'startup', delaySeconds: 0, command: 'npm run scrape',
  enabled: true, triggerMode: 'wait', skipExitCodes: [2],
};

describe('an exit code listed in skipExitCodes is a skip, not a failure', () => {
  test('no job.failed is published', async () => {
    const { sched, events } = makeSched(SCRAPER, 2);

    await sched._fire(SCRAPER);

    assert.ok(!names(events).includes('job.failed'),
      `a declared skip was reported as a failure: ${names(events).join(', ')}`);
  });

  test('job.skipped is published instead, naming the exit code and the reason', async () => {
    const { sched, events } = makeSched(SCRAPER, 2);

    await sched._fire(SCRAPER);

    const skipped = events.find((e) => e.event === 'job.skipped');
    assert.ok(skipped, `nothing announced the skip: ${names(events).join(', ')}`);
    assert.equal(skipped.payload.jobId, 'wa-scrape');
    assert.equal(skipped.payload.exitCode, 2);
    assert.equal(skipped.payload.reason, 'exitCode',
      'the reason must tell a skipped exit code apart from a liveness skip');
  });

  test('the run is marked skipped in the history, so every reader can agree', async () => {
    const { sched, state } = makeSched(SCRAPER, 2);

    await sched._fire(SCRAPER);

    const entry = state.get('wa-scrape');
    assert.equal(entry.skipped, true);
    assert.equal(entry.exitCode, 2, 'the real exit code must survive -- a stuck lock stays diagnosable');
  });

  test('job-finished carries the flag, so the systray does not light up', async () => {
    const { sched } = makeSched(SCRAPER, 2);
    const seen = [];
    sched.on('job-finished', (ev) => seen.push(ev));

    await sched._fire(SCRAPER);

    assert.equal(seen.length, 1);
    assert.equal(seen[0].skipped, true,
      'the tray classifies on this event alone and would count the skip as a failure');
  });

  test('the consecutive-failure alert is not fed', async () => {
    const { sched, events } = makeSched({ ...SCRAPER, alertAfterFailures: 1 }, 2);

    await sched._fire({ ...SCRAPER, alertAfterFailures: 1 });

    assert.ok(!names(events).includes('alert.consecutive_failures'), names(events).join(', '));
  });

  test('a skip wins over a retry rule that also lists the code', async () => {
    const job = { ...SCRAPER, skipExitCodes: [2], retryOnExitCodes: [2], retryDelays: [1] };
    const { sched, events } = makeSched(job, 2);

    await sched._fire(job);

    assert.ok(!names(events).includes('job.failed'));
    assert.ok(names(events).includes('job.skipped'),
      'retrying a job that deliberately did nothing just repeats the no-op');
  });

  test('dependent jobs are not triggered -- the work never happened', async () => {
    const job = { ...SCRAPER, skipExitCodes: [2] };
    const { sched, registry, spawned } = makeSched(job, 2);
    registry.add({
      id: 'after', type: 'cron', schedule: '0 9 * * *', command: 'echo after',
      enabled: true, dependsOn: 'wa-scrape',
    });

    await sched._fire(job);

    assert.ok(!spawned.includes('echo after'),
      'a downstream job ran on the back of work that was skipped');
  });
});

describe('an exit code that is not listed is still a failure', () => {
  test('exit 1 fails normally even when 2 is skippable', async () => {
    const { sched, events, state } = makeSched(SCRAPER, 1);

    await sched._fire(SCRAPER);

    assert.ok(names(events).includes('job.failed'), names(events).join(', '));
    assert.ok(!state.get('wa-scrape').skipped);
  });

  test('with no skipExitCodes configured, exit 2 is a failure as before', async () => {
    const job = { ...SCRAPER, skipExitCodes: undefined };
    const { sched, events } = makeSched(job, 2);

    await sched._fire(job);

    assert.ok(names(events).includes('job.failed'),
      'the default changed for jobs that never opted in');
  });

  test('exit 0 stays a plain success', async () => {
    const { sched, events, state } = makeSched(SCRAPER, 0);

    await sched._fire(SCRAPER);

    assert.ok(names(events).includes('job.completed'));
    assert.ok(!state.get('wa-scrape').skipped);
  });
});

describe('the registry validates skipExitCodes', () => {
  test('a non-array is refused by name', () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));

    assert.throws(
      () => registry.add({ ...SCRAPER, skipExitCodes: 2 }),
      /skipExitCodes/,
    );
  });

  test('an array of non-numbers is refused by name', () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));

    assert.throws(
      () => registry.add({ ...SCRAPER, skipExitCodes: ['2'] }),
      /skipExitCodes/,
    );
  });

  test('a list of numbers is accepted and stored', () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));

    registry.add({ ...SCRAPER, skipExitCodes: [2, 75] });

    assert.deepEqual(registry.get('wa-scrape').skipExitCodes, [2, 75]);
  });
});
