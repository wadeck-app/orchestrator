'use strict';

// The reported bug: clicking "update and restart" in the tray, and running `orch cli update`, both
// answered "deferred" and never updated. Measured on the live daemon: GET /health said 3 active jobs
// while nothing was executing, so onUpdateAvailable deferred 60s on every attempt, forever.
//
// Three causes, one per describe below.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { State } = require('../src/state');
const { countActiveJobs } = require('../src/active-jobs');

const tmpDirs = [];

function tmpState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-defer-'));
  tmpDirs.push(dir);
  return new State(path.join(dir, 'state.json'));
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Exercises the real rule the health handler uses, rather than a copy of it. */
function activeJobs(state) {
  return countActiveJobs(state.getAll());
}

describe('a finished run does not count as active', () => {
  // Cause 1: the count used exitCode === null, and a run cancelled by the user is recorded with
  // exitCode null on purpose so it reads as "Cancelled" rather than as a failure. It keeps its
  // finishedAt, so it is over -- but it was counted as running for the rest of the install's life.
  test('a cancelled run has exitCode null and must still count as finished', () => {
    const state = tmpState();
    state.record('j1', {
      startedAt: '2026-09-15T15:52:35.103Z',
      finishedAt: '2026-09-15T15:53:24.779Z',
      exitCode: null,
      cancelledByUser: true,
      pid: 29560,
    });

    const entry = state.get('j1');
    assert.equal(entry.exitCode, null, 'precondition: a cancelled run keeps a null exit code');
    assert.equal(activeJobs(state), 0, 'a cancelled run is counted as still running');
  });

  test('a genuinely running run does count', () => {
    const state = tmpState();
    state.record('j1', { startedAt: '2026-09-16T10:00:00.000Z', exitCode: null, pid: 1 });
    assert.equal(activeJobs(state), 1);
  });

  test('a normal completion does not count', () => {
    const state = tmpState();
    state.record('j1', {
      startedAt: '2026-09-16T10:00:00.000Z',
      finishedAt: '2026-09-16T10:00:05.000Z',
      exitCode: 0,
      pid: 1,
    });
    assert.equal(activeJobs(state), 0);
  });

  test('one job is counted once however many of its runs are open', () => {
    const state = tmpState();
    state.record('j1', { startedAt: '2026-09-16T10:00:00.000Z', exitCode: null, pid: 1 });
    state.record('j1', { startedAt: '2026-09-16T11:00:00.000Z', exitCode: null, pid: 2 });
    assert.equal(activeJobs(state), 1, 'active_jobs counts jobs, not runs');
  });
});

describe('runs left open by a dead daemon are closed at startup', () => {
  // Cause 2: nothing could ever close them. The child died with the daemon that spawned it, so no
  // exit event was coming. One such entry, two weeks old, was enough to block every update.
  test('an in-flight run with no finishedAt is closed and marked', () => {
    const state = tmpState();
    state.record('j1', { startedAt: '2026-09-02T21:50:46.778Z', exitCode: null, pid: 23408 });
    assert.equal(activeJobs(state), 1, 'precondition: it starts out counted as active');

    const closed = state.closeOrphanedRuns(new Date('2026-09-16T20:00:00.000Z'));

    assert.equal(closed, 1);
    assert.equal(activeJobs(state), 0, 'still counted as active after the sweep');
    const entry = state.get('j1');
    assert.equal(entry.finishedAt, '2026-09-16T20:00:00.000Z');
    assert.equal(entry.orphaned, true, 'nothing records why finishedAt appeared');
    assert.equal(entry.exitCode, null, 'an interrupted run must not be reported as a clean exit');
  });

  test('finished runs are left untouched', () => {
    const state = tmpState();
    state.record('j1', {
      startedAt: '2026-09-16T10:00:00.000Z',
      finishedAt: '2026-09-16T10:00:05.000Z',
      exitCode: 0,
      pid: 1,
    });

    assert.equal(state.closeOrphanedRuns(), 0);
    assert.equal(state.get('j1').orphaned, undefined);
    assert.equal(state.get('j1').finishedAt, '2026-09-16T10:00:05.000Z', 'a real finish time was rewritten');
  });

  test('it survives a round trip to disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-defer-disk-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'state.json');

    const first = new State(file);
    first.record('j1', { startedAt: '2026-09-02T21:50:46.778Z', exitCode: null, pid: 23408 });
    first.closeOrphanedRuns(new Date('2026-09-16T20:00:00.000Z'));
    first.shutdown();

    const reopened = new State(file);
    assert.equal(activeJobs(reopened), 0, 'the sweep was never written to disk');
    assert.equal(reopened.get('j1').orphaned, true);
  });

  test('the daemon runs the sweep at startup', () => {
    // Asserted on the source: the call sits inside createDaemon's setup, which a unit test cannot
    // drive without starting a real daemon and its tray.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    assert.match(src, /state\.closeOrphanedRuns\(\)/,
      'nothing closes orphaned runs at startup; they will block updates again');
  });
});

describe('an explicitly requested update is not deferred', () => {
  // Cause 3: UPDATER_FORCE meant "bypass autoUpdate:false" and nothing else, so a person clicking
  // the tray got the same "wait for a quiet moment" treatment as the background timer.
  const entry = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater', 'entry.ts'), 'utf8');

  test('the forced path returns apply-now before the active-jobs check', () => {
    const hook = entry.slice(entry.indexOf('onUpdateAvailable'));
    const forcedAt = hook.indexOf('if (isForced)');
    const activeCheck = hook.indexOf('activeJobs > 0');
    assert.ok(forcedAt !== -1, 'the forced request is not honoured in onUpdateAvailable');
    assert.ok(activeCheck !== -1, 'the active-jobs deferral has gone');
    assert.ok(forcedAt < activeCheck,
      'the force check comes after the deferral, so an explicit request still waits');
  });

  test('the deferral says why, since a silent one looks like nothing happened', () => {
    assert.match(entry, /deferring update to .*job\(s\) still running/s,
      'the deferral is not logged with its reason');
  });
});
