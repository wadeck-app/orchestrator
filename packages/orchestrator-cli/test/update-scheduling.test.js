'use strict';

// The daemon spawns the updater at startup, every 30 min and when the tray asks. A dev build must spawn
// none of them: the updater would compare 0.2.0 with the published CalVer and install it globally.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createUpdateScheduler } = require('../src/update-scheduling');

function make(version) {
  const spawned = [];
  const logs = [];
  const manager = { scheduleBackgroundUpdate: (bundle, name) => { spawned.push({ bundle, name, force: process.env.UPDATER_FORCE }); } };
  const scheduler = createUpdateScheduler({ version, bundlePath: '/pkg/dist/orchestrator.cjs', manager, log: (m) => logs.push(m) });
  return { scheduler, spawned, logs };
}

const RELEASE = '2026.10.24-514-aac78c7a';

describe('a release build', () => {
  test('spawns the orchestrator updater next to its own bundle', () => {
    const { scheduler, spawned, logs } = make(RELEASE);
    assert.equal(scheduler.request('startup'), 'scheduled');
    assert.deepEqual(spawned.map((s) => [s.bundle, s.name]), [['/pkg/dist/orchestrator.cjs', 'orchestrator-updater.cjs']]);
    assert.match(logs.join('\n'), /background update check triggered \(startup\)/);
  });

  test('oncePerRun skips a second request, a plain request does not', () => {
    const { scheduler, spawned } = make(RELEASE);
    assert.equal(scheduler.request('startup', { oncePerRun: true }), 'scheduled');
    assert.equal(scheduler.request('startup again', { oncePerRun: true }), 'skipped-already');
    assert.equal(scheduler.request('periodic'), 'scheduled');
    assert.equal(spawned.length, 2);
  });

  test('force sets UPDATER_FORCE for the spawn only and restores the caller environment', () => {
    delete process.env.UPDATER_FORCE;
    const { scheduler, spawned } = make(RELEASE);
    scheduler.request('tray', { force: true });
    assert.equal(spawned[0].force, '1');
    assert.equal(process.env.UPDATER_FORCE, undefined);
  });
});

describe('a development build', () => {
  for (const version of ['0.2.0', '0.0.0-dev', '2026.10.24-514-aac78c7a-local-dev']) {
    test(`${version} never spawns the updater`, () => {
      const { scheduler, spawned } = make(version);
      assert.equal(scheduler.request('startup', { oncePerRun: true }), 'skipped-dev');
      assert.equal(scheduler.request('periodic'), 'skipped-dev');
      assert.equal(scheduler.request('tray', { force: true }), 'skipped-dev');
      assert.deepEqual(spawned, []);
    });
  }

  test('an explicit request is always explained in the daemon log; background ones once per run', () => {
    const { scheduler, logs } = make('0.2.0');
    scheduler.request('startup', { oncePerRun: true });
    scheduler.request('periodic');
    scheduler.request('periodic');
    assert.equal(logs.filter((l) => /development build/.test(l)).length, 1, logs.join('\n'));
    scheduler.request('tray: manual check-update', { force: true });
    scheduler.request('tray: manual check-update', { force: true });
    assert.equal(logs.filter((l) => /development build/.test(l)).length, 3, logs.join('\n'));
    assert.match(logs.join('\n'), /version 0\.2\.0\): it does not update the global install/);
  });
});
