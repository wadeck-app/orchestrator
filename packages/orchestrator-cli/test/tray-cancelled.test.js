'use strict';

// A run the user ended (orch kill, the Kill button) has no exit code, and is not a failure: the history does not
// count it as one. The tray did: it listed every run whose code was not 0, so ending a server by hand left
// "[fail] 1 job(s) failed" and a red icon on a machine whose jobs were all fine.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { TrayManager } = require('../src/tray-manager');

function makeManager(jobs) {
  const scheduler = Object.assign(new EventEmitter(), { stop: () => {}, runningCount: () => 0 });
  const registry = { list: () => Object.values(jobs), get: (id) => jobs[id] ?? null };
  return { scheduler, mgr: new TrayManager('/tmp/fake-config', scheduler, { getAll: () => ({}) }, registry, '0.0.0-test', undefined, null) };
}

const tooltip = (mgr) => mgr._buildMenu().tooltip;
const job = { id: 'server', label: 'Server' };

describe('the tray and a run the user ended', () => {
  test('does not list it as a failure', () => {
    const { mgr } = makeManager({ server: job });

    mgr._onJobFinished({ id: 'server', exitCode: null, job, cancelledByUser: true });

    assert.equal(tooltip(mgr), 'Orchestrator - all jobs OK');
  });

  test('a real failure of the same job is still listed', () => {
    const { mgr } = makeManager({ server: job });

    mgr._onJobFinished({ id: 'server', exitCode: 1, job });

    assert.match(tooltip(mgr), /1 job\(s\) failed/);
  });

  // Pinned as it was: a run that ended without a code for another reason (timeout, resource limit) is listed.
  test('a run that ended without a code and was not ended by the user is still listed', () => {
    const { mgr } = makeManager({ server: job });

    mgr._onJobFinished({ id: 'server', exitCode: null, job });

    assert.match(tooltip(mgr), /1 job\(s\) failed/);
  });

  test('ending a run by hand leaves an earlier failure of that job where it was', () => {
    const { mgr } = makeManager({ server: job });
    mgr._onJobFinished({ id: 'server', exitCode: 2, job });

    mgr._onJobFinished({ id: 'server', exitCode: null, job, cancelledByUser: true });

    assert.match(tooltip(mgr), /1 job\(s\) failed/);
  });
});
