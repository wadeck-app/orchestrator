'use strict';

// start() sweeps runs left open by a daemon that died, stamping them exitCode 1. It recognised an
// open run by `exitCode === null` alone -- but a null exit code is also how a finished run says "no
// process exit was observed": a run cancelled by the user (scheduler sets exitCode null on purpose),
// a run closed as orphaned by State.closeOrphanedRuns (whose own doc says "exitCode stays null so the
// run reads as interrupted rather than as a failure"), and now a firing skipped because the target
// was already alive.
//
// All three carry `finishedAt`, so all three were rewritten into "failed, exit 1" by the next daemon
// start. An open run is one with no finishedAt -- the same test State.closeOrphanedRuns already uses.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');

function makeEnv(entry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sweep-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add({
    id: 'wa', type: 'cron', schedule: '0 8 * * *', command: 'npm run scrape', enabled: true,
  });
  state.record('wa', entry);
  const sched = new Scheduler(registry, state, { spawn: () => { throw new Error('must not spawn'); } });
  return { sched, state };
}

const PAST = '2026-09-18T08:00:00.000Z';
// A pid that is certainly not running, so the sweep considers the run dead.
const DEAD_PID = 999999;

describe('the stale-run sweep only touches runs that are still open', () => {
  test('a skipped firing is left alone', async () => {
    const { sched, state } = makeEnv({
      startedAt: PAST, finishedAt: PAST, exitCode: null, pid: null, skipped: true,
    });

    await sched.start();
    await sched.stop();

    const entry = state.get('wa');
    assert.equal(entry.exitCode, null, 'the skip was rewritten as a failed run');
    assert.equal(entry.skipped, true);
  });

  test('a run cancelled by the user is left alone', async () => {
    const { sched, state } = makeEnv({
      startedAt: PAST, finishedAt: PAST, exitCode: null, pid: DEAD_PID, cancelledByUser: true,
    });

    await sched.start();
    await sched.stop();

    assert.equal(state.get('wa').exitCode, null,
      'a job the user killed came back as "failed exit 1" after a restart');
  });

  test('a run already closed as orphaned keeps reading as interrupted', async () => {
    const { sched, state } = makeEnv({
      startedAt: PAST, finishedAt: PAST, exitCode: null, pid: DEAD_PID, orphaned: true,
    });

    await sched.start();
    await sched.stop();

    assert.equal(state.get('wa').exitCode, null);
    assert.equal(state.get('wa').orphaned, true);
  });

  test('a genuinely open run whose process is gone is still closed', async () => {
    const { sched, state } = makeEnv({ startedAt: PAST, exitCode: null, pid: DEAD_PID });

    await sched.start();
    await sched.stop();

    const entry = state.get('wa');
    assert.equal(entry.exitCode, 1, 'a run left in flight by a dead daemon stayed open forever');
    assert.ok(entry.finishedAt, 'it was closed without a finishedAt');
  });
});
