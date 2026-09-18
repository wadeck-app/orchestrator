'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

/*
 * Every job mutation has to reach the RUNNING scheduler.
 *
 * add-job used to write the registry and log to the audit, and stop. The scheduler only read the
 * registry in start(), so nothing a caller did while the daemon was running changed what the daemon
 * would actually do until the next restart.
 *
 * For a cron job that was merely late: the next restart picked it up and it fired on schedule
 * thereafter, so nobody noticed. For a `once` job it meant never - its single moment passed with the
 * daemon oblivious and the job sat in the registry unfired. Reproduced against the dev daemon with a
 * 15s delay: due at 20:37:09, still listed and still unrun at 20:37:32. That is the user-visible bug
 * these tests exist for.
 */

const tmpDirs = [];

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resched-'));
  tmpDirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  const calls = [];
  const scheduler = {
    killJob: async () => ({ killed: false }),
    skipNextFiring: () => {},
    scheduleJob: (job) => calls.push({ fn: 'scheduleJob', id: job.id, type: job.type, enabled: job.enabled }),
    unscheduleJob: (id) => calls.push({ fn: 'unscheduleJob', id }),
  };
  return { commands: makeCommands(registry, state, scheduler, dir), registry, calls };
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('a job added while the daemon runs is scheduled immediately', () => {
  // The case that was broken outright.
  test('add-job schedules a once job', () => {
    const { commands, calls } = makeEnv();

    commands['add-job']({ id: 'o', type: 'once', command: 'node -v', label: 'O', delayMs: 15_000 });

    const scheduled = calls.filter(c => c.fn === 'scheduleJob');
    assert.equal(scheduled.length, 1, 'the new job must be handed to the scheduler');
    assert.equal(scheduled[0].id, 'o');
    assert.equal(scheduled[0].type, 'once');
  });

  test('add-job schedules a cron job', () => {
    const { commands, calls } = makeEnv();

    commands['add-job']({ id: 'c', type: 'cron', command: 'node -v', label: 'C', schedule: '0 9 * * *' });

    assert.deepEqual(
      calls.filter(c => c.fn === 'scheduleJob').map(c => c.id),
      ['c'],
    );
  });

  // Scheduled from the STORED job, not the payload: defaults are applied on write, and a once job's
  // scheduledAt is one of them - scheduling the raw payload would pass a job with no origin for its
  // delay.
  test('schedules the stored job, so applied defaults are present', () => {
    const { commands, registry, calls } = makeEnv();

    commands['add-job']({ id: 'o', type: 'once', command: 'node -v', label: 'O', delayMs: 15_000 });

    const scheduled = calls.find(c => c.fn === 'scheduleJob');
    assert.equal(scheduled.enabled, true, 'enabled is a default applied on write');
    assert.ok(registry.get('o').scheduledAt, 'and scheduledAt too');
  });
});

describe('the other mutations reach the scheduler as well', () => {
  test('remove-job unschedules', () => {
    const { commands, calls } = makeEnv();
    commands['add-job']({ id: 'c', type: 'cron', command: 'node -v', label: 'C', schedule: '0 9 * * *' });

    commands['remove-job']({ id: 'c' });

    assert.ok(calls.some(c => c.fn === 'unscheduleJob' && c.id === 'c'));
  });

  // Otherwise a disabled cron job keeps firing until the next restart.
  test('disable-job unschedules', () => {
    const { commands, calls } = makeEnv();
    commands['add-job']({ id: 'c', type: 'cron', command: 'node -v', label: 'C', schedule: '0 9 * * *' });

    commands['disable-job']({ id: 'c' });

    assert.ok(calls.some(c => c.fn === 'unscheduleJob' && c.id === 'c'));
  });

  // And a re-enabled one has to go back on the clock rather than sitting enabled and idle.
  test('enable-job schedules again', () => {
    const { commands, calls } = makeEnv();
    commands['add-job']({ id: 'c', type: 'cron', command: 'node -v', label: 'C', schedule: '0 9 * * *' });
    commands['disable-job']({ id: 'c' });
    calls.length = 0;

    commands['enable-job']({ id: 'c' });

    const scheduled = calls.filter(c => c.fn === 'scheduleJob');
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].enabled, true, 'must be handed the job in its enabled state');
  });

  test('edit-job reschedules with the new definition', () => {
    const { commands, calls } = makeEnv();
    commands['add-job']({ id: 'c', type: 'cron', command: 'node -v', label: 'C', schedule: '0 9 * * *' });
    calls.length = 0;

    commands['edit-job']({ id: 'c', updates: { schedule: '0 18 * * *' } });

    assert.ok(calls.some(c => c.fn === 'scheduleJob' && c.id === 'c'), 'an edited schedule must replace the running one');
  });
});

/*
 * The audit could not distinguish a spent once job from a cron run, because job.added and
 * job.deleted recorded no type. That is what blocked showing past once jobs from the audit alone.
 */
describe('the audit records the job type', () => {
  function auditing() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-resched-audit-'));
    tmpDirs.push(dir);
    const entries = [];
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state = new State(path.join(dir, 'state.json'));
    const scheduler = {
      killJob: async () => ({ killed: false }), skipNextFiring: () => {},
      scheduleJob: () => {}, unscheduleJob: () => {},
    };
    const audit = { log: (event, payload) => entries.push({ event, payload }) };
    return { commands: makeCommands(registry, state, scheduler, dir, undefined, audit), entries };
  }

  test('job.added carries the type', () => {
    const { commands, entries } = auditing();

    commands['add-job']({ id: 'o', type: 'once', command: 'node -v', label: 'O', delayMs: 1000 });

    const added = entries.find(e => e.event === 'job.added');
    assert.equal(added.payload.type, 'once');
  });

  test('job.deleted carries the type, which is the only record left once it is gone', () => {
    const { commands, entries } = auditing();
    commands['add-job']({ id: 'o', type: 'once', command: 'node -v', label: 'O', delayMs: 1000 });

    commands['remove-job']({ id: 'o' });

    const deleted = entries.find(e => e.event === 'job.deleted');
    assert.equal(deleted.payload.type, 'once');
  });
});
