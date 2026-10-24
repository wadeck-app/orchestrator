'use strict';

// Every code path that closes a run in the history must announce it with ONE terminal event, or an agent waiting for
// "finished" waits for ever. The closers of a run are:
//   _finishRun               a run that ended while watched, or learned late after a restart   (events-contract, events-resource-late-exec)
//   _recordStartFailure      a run that could not be started                                   (events-job-lifecycle)
//   _recordSkip / _refuse*   a refused firing                                                   (events-job-lifecycle)
//   killJob, stale branch    `orch kill` on a run the history shows open and nothing watches    (here)
//   closeInterruptedRuns     the sweep of the runs a dead daemon left open, at daemon start     (here)
//   start(), stale cleanup   an open entry whose process is dead                                (here)
//   recoverRuns, "lost"      a supervisor gone with no record: the run stays open and is closed by the sweep above
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { assertNoProblems, makeHarness, cronJob } = require('./helpers/event-harness');
const { S } = require('./helpers/event-scenarios');

afterEach(assertNoProblems);

describe('a stale open run stopped with `orch kill`', () => {
  test('is announced as job.killed_manual (late, with the real end time) and recorded as cancelled, not as a failure', async () => {
    const h = await S.staleKill();
    assert.deepEqual(h.reply, { killed: true, count: 1 });
    assert.deepEqual(h.names(), ['job.killed_manual']);
    const { payload } = h.events[0];
    assert.equal(payload.late, true);
    assert.ok(Number.isInteger(payload.durationMs) && payload.durationMs >= 5 * 60_000, JSON.stringify(payload));
    const entry = h.state.get('job');
    assert.equal(entry.cancelledByUser, true);
    assert.equal(entry.exitCode, null, 'a stopped run has no exit code, and must not feed the failure streak');
    assert.ok(entry.finishedAt);
    assert.equal(h.state.getOpenRuns('job').length, 0);
  });

  test('a second kill finds nothing open and announces nothing more', async () => {
    const h = await S.staleKill();
    const again = await h.sched.killJob('job');
    assert.deepEqual(again, { killed: false, count: 0 });
    assert.equal(h.terminals().length, 1);
  });

  test('every open entry is announced, once each', async () => {
    const h = makeHarness([cronJob()]);
    for (const minutes of [10, 5]) {
      h.state.record('job', { startedAt: new Date(h.time.now() - minutes * 60_000).toISOString(), exitCode: null, pid: 2_000_000_000 });
    }
    await h.sched.killJob('job');
    assert.deepEqual(h.names(), ['job.killed_manual', 'job.killed_manual']);
  });
});

describe('the sweep of the runs a dead daemon left open', () => {
  test('each is announced as job.failed (late, exitCode 1): nothing says how it ended, and it did not succeed', async () => {
    const h = await S.orphanedAtStart();
    assert.equal(h.closed, 1);
    assert.deepEqual(h.names(), ['job.failed']);
    const { payload } = h.events[0];
    assert.equal(payload.late, true);
    assert.equal(payload.exitCode, 1);
  });

  test('the history keeps its own reading: interrupted (exit code null, orphaned), not a failure of the job', async () => {
    const h = await S.orphanedAtStart();
    const entry = h.state.get('job');
    assert.equal(entry.orphaned, true);
    assert.equal(entry.exitCode, null);
    assert.equal(h.state.getConsecutiveFailures('job'), 0);
  });

  test('a run another part of the daemon follows is left open and is not announced', async () => {
    const h = makeHarness([cronJob()]);
    const startedAt = new Date(h.time.now() - 60_000).toISOString();
    h.state.record('job', { startedAt, exitCode: null, pid: 2_000_000_000 });
    h.sched._followed.add(`job|${startedAt}`);
    assert.equal(h.sched.closeInterruptedRuns(new Date(h.time.now())), 0);
    assert.deepEqual(h.events, []);
    assert.equal(h.state.getOpenRuns('job').length, 1);
  });

  test('a second sweep announces nothing: the runs are closed', async () => {
    const h = await S.orphanedAtStart();
    assert.equal(h.sched.closeInterruptedRuns(new Date(h.time.now())), 0);
    assert.equal(h.terminals().length, 1);
  });

  test('it neither retries nor fires dependents for a run it did not see end', async () => {
    const h = makeHarness([cronJob({ retryOnExitCodes: [1], retryDelays: [5] }), cronJob({ id: 'after', dependsOn: 'job' })]);
    h.state.record('job', { startedAt: new Date(h.time.now() - 60_000).toISOString(), exitCode: null, pid: 2_000_000_000 });
    h.sched.closeInterruptedRuns(new Date(h.time.now()));
    await h.time.advanceAsync(10_000, 1000);
    assert.deepEqual(h.spawned, []);
  });
});

describe('Scheduler.start() finding an open entry whose process is dead', () => {
  test('closes it as a failure and announces it once, as the sweep does', async () => {
    const h = await S.staleAtStart();
    assert.deepEqual(h.names(), ['job.failed']);
    assert.equal(h.events[0].payload.late, true);
    assert.equal(h.state.getOpenRuns('job').length, 0);
  });
});

describe('recoverRuns finding a supervisor that is gone without a record', () => {
  test('the run is closed as interrupted and announced once, even when no sweep follows', async () => {
    const NOW = Date.parse('2026-10-18T12:00:00.000Z');
    const h = await S.lostSupervisor();
    const report = h.report;
    assert.equal(report.lost.length, 1);
    assert.deepEqual(h.names(), ['job.failed']);
    assert.equal(h.events[0].payload.late, true);
    assert.equal(h.state.getOpenRuns('job').length, 0);

    // The sweep that follows at daemon start finds nothing left to close.
    assert.equal(h.sched.closeInterruptedRuns(new Date(NOW)), 0);
    assert.equal(h.terminals().length, 1);
  });
});
