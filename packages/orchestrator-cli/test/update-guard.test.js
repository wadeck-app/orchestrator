'use strict';

// 2026-10-31: the real daemon restarted 822 times in a day. After `nvm use` the updater installed a new version into the
// npm prefix of the active node, while the long-lived launcher (started by `orch start`, which fixes LAUNCHER_BUNDLE_OVERRIDE
// for its whole life) kept starting the bundle of the old node. The daemon ran the old version, saw "an update exists",
// updated again, restarted, and so on every ~11 s, with a new tray icon each time.
// Two guards, independent of that cause: an update that did not change the running version stops the automatic updates and
// says why; and updates that restart the daemon too often stop them as well.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { staleUpdateProblem, updateStartLoopProblem, loadUpdateStarts, recordUpdateStart, guardUpdates } = require('../src/update-guard');
const { createUpdateScheduler } = require('../src/update-scheduling');

const OLD = '2026.10.31-570-7f35aaa1';
const NEW = '2026.10.31-571-169e111c';
const BUNDLE = 'C:\\App\\nvm\\v24.11.1\\node_modules\\@wadeck-app\\orchestrator-cli\\dist\\orchestrator.cjs';

describe('staleUpdateProblem: the update says it installed a version this daemon is not running', () => {
  test('nothing to say when the daemon runs the version the update installed', () => {
    assert.equal(staleUpdateProblem(NEW, { status: 'success', targetVersion: NEW }, BUNDLE), null);
  });

  test('says both versions, where this daemon runs from, and the way out, when they differ', () => {
    const problem = staleUpdateProblem(OLD, { status: 'success', targetVersion: NEW }, BUNDLE);
    assert.ok(problem, 'a mismatch must be reported');
    assert.ok(problem.includes(OLD) && problem.includes(NEW), problem);
    assert.ok(problem.includes(BUNDLE), 'names the bundle this daemon runs from');
    assert.match(problem, /orch stop/);
    assert.match(problem, /orch start/);
    assert.match(problem, /automatic updates are suspended/i);
  });

  test('reads the version from newVersion when targetVersion is absent', () => {
    assert.ok(staleUpdateProblem(OLD, { status: 'success', newVersion: NEW }, BUNDLE));
    assert.equal(staleUpdateProblem(NEW, { status: 'success', newVersion: NEW }, BUNDLE), null);
  });

  test('only a successful update can be stale: no state, a rollback, a failure and an update in progress are other stories', () => {
    for (const state of [null, { status: 'rolled-back', previousVersion: OLD }, { status: 'failed', error: 'x' }, { status: 'applying', targetVersion: NEW }]) {
      assert.equal(staleUpdateProblem(OLD, state, BUNDLE), null, JSON.stringify(state));
    }
  });

  test('a success without any version is not a mismatch we can name', () => {
    assert.equal(staleUpdateProblem(OLD, { status: 'success' }, BUNDLE), null);
  });

  test('a development build never updates, so it has nothing to compare', () => {
    assert.equal(staleUpdateProblem('0.2.0', { status: 'success', targetVersion: NEW }, BUNDLE), null);
  });
});

describe('updateStartLoopProblem: updates that keep restarting the daemon', () => {
  const NOW = Date.parse('2026-10-31T12:00:00Z');
  const MIN = 60_000;

  test('two restarts after an update in half an hour are fine', () => {
    assert.equal(updateStartLoopProblem([NOW - 20 * MIN, NOW - 1 * MIN], NOW), null);
  });

  test('three in half an hour are a loop, said with the count and the way out', () => {
    const problem = updateStartLoopProblem([NOW - 25 * MIN, NOW - 10 * MIN, NOW - 1 * MIN], NOW);
    assert.ok(problem);
    assert.match(problem, /3 times in the last 30 minutes/);
    assert.match(problem, /automatic updates are suspended/i);
    assert.match(problem, /orch cli update/);
  });

  test('restarts older than the window are forgotten', () => {
    assert.equal(updateStartLoopProblem([NOW - 90 * MIN, NOW - 80 * MIN, NOW - 70 * MIN, NOW - 1 * MIN], NOW), null);
  });
});

describe('the record of the starts that followed an update', () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const file = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-update-guard-'));
    dirs.push(dir);
    return path.join(dir, 'update-starts.json');
  };
  const MIN = 60_000;

  test('a missing file is an empty record, without a complaint', () => {
    assert.deepEqual(loadUpdateStarts(file()), { starts: [], problem: null });
  });

  test('a start is recorded, and what is older than the window goes', () => {
    const f = file();
    const now = Date.parse('2026-10-31T12:00:00Z');
    recordUpdateStart(f, now - 120 * MIN);
    assert.deepEqual(recordUpdateStart(f, now - 5 * MIN), [now - 5 * MIN]);
    assert.deepEqual(loadUpdateStarts(f).starts, [now - 5 * MIN]);
  });

  test('records accumulate inside the window', () => {
    const f = file();
    const now = Date.parse('2026-10-31T12:00:00Z');
    recordUpdateStart(f, now - 10 * MIN);
    recordUpdateStart(f, now - 5 * MIN);
    assert.deepEqual(recordUpdateStart(f, now), [now - 10 * MIN, now - 5 * MIN, now]);
  });

  test('a corrupt file is reported with its path, and counts as empty so the daemon still starts', () => {
    const f = file();
    fs.writeFileSync(f, '{not json');
    const loaded = loadUpdateStarts(f);
    assert.deepEqual(loaded.starts, []);
    assert.ok(loaded.problem && loaded.problem.includes(f), loaded.problem);
  });
});

describe('the update scheduler once the guard has suspended the automatic updates', () => {
  function make(suspended) {
    const spawned = [];
    const logs = [];
    const manager = { scheduleBackgroundUpdate: (bundle, name, currentVersion) => { spawned.push({ bundle, name, currentVersion }); } };
    const scheduler = createUpdateScheduler({ version: OLD, bundlePath: BUNDLE, manager, log: (m) => logs.push(m), suspended: () => suspended });
    return { scheduler, spawned, logs };
  }

  test('a background request spawns nothing and says why, once per run', () => {
    const { scheduler, spawned, logs } = make('the update did not change the running version');
    assert.equal(scheduler.request('startup', { oncePerRun: true }), 'skipped-suspended');
    assert.equal(scheduler.request('periodic, every 30m'), 'skipped-suspended');
    assert.equal(scheduler.request('periodic, every 30m'), 'skipped-suspended');
    assert.deepEqual(spawned, []);
    const said = logs.filter((l) => l.includes('the update did not change the running version'));
    assert.equal(said.length, 1, `the reason is said once, not at every tick: ${JSON.stringify(logs)}`);
  });

  test('an explicit request (tray) still goes through: a person asked', () => {
    const { scheduler, spawned } = make('suspended');
    assert.equal(scheduler.request('tray', { force: true }), 'scheduled');
    assert.equal(spawned.length, 1);
  });

  test('nothing changes while the guard has nothing to say', () => {
    const { scheduler, spawned } = make(null);
    assert.equal(scheduler.request('periodic'), 'scheduled');
    assert.equal(spawned.length, 1);
  });
});

describe('guardUpdates: what the daemon does with the update state it reads at start', () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const MIN = 60_000;
  const NOW = Date.parse('2026-10-31T12:00:00Z');

  function setup(extra = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-guard-updates-'));
    dirs.push(dir);
    const logs = [];
    const startsFile = path.join(dir, 'update-starts.json');
    const call = (state, over = {}) => guardUpdates({ version: OLD, state, bundlePath: BUNDLE, startsFile, now: NOW, log: (l) => logs.push(l), ...extra, ...over });
    return { call, logs, startsFile };
  }

  test('no update state: nothing suspended, nothing recorded, nothing said', () => {
    const { call, logs, startsFile } = setup();
    assert.equal(call(null), null);
    assert.equal(fs.existsSync(startsFile), false);
    assert.deepEqual(logs, []);
  });

  test('an update that took effect is recorded as a start and suspends nothing', () => {
    const { call, logs, startsFile } = setup();
    assert.equal(call({ status: 'success', targetVersion: OLD }), null);
    assert.deepEqual(loadUpdateStarts(startsFile).starts, [NOW]);
    assert.deepEqual(logs, []);
  });

  test('an update that did not change the running version suspends the updates and says so as an error', () => {
    const { call, logs } = setup();
    const why = call({ status: 'success', targetVersion: NEW });
    assert.ok(why && why.includes(NEW) && why.includes(OLD));
    assert.ok(logs.some((l) => /^ERROR automatic updates suspended: /.test(l) && l.includes(why)), JSON.stringify(logs));
  });

  test('the third restart by an update inside half an hour suspends the updates, even though each update took effect', () => {
    const { call, logs, startsFile } = setup();
    fs.writeFileSync(startsFile, JSON.stringify([NOW - 20 * MIN, NOW - 10 * MIN]));
    const why = call({ status: 'success', targetVersion: OLD });
    assert.match(why, /3 times in the last 30 minutes/);
    assert.ok(logs.some((l) => l.startsWith('ERROR automatic updates suspended: ')));
    assert.equal(loadUpdateStarts(startsFile).starts.length, 3);
  });

  test('when both guards fire, the version mismatch is the one said: it names the cause', () => {
    const { call, startsFile } = setup();
    fs.writeFileSync(startsFile, JSON.stringify([NOW - 20 * MIN, NOW - 10 * MIN]));
    const why = call({ status: 'success', targetVersion: NEW });
    assert.match(why, /orch stop/);
  });

  test('a record that cannot be read is said, and the daemon goes on with an empty one', () => {
    const { call, logs, startsFile } = setup();
    fs.writeFileSync(startsFile, '{not json');
    assert.equal(call({ status: 'success', targetVersion: OLD }), null);
    assert.ok(logs.some((l) => l.includes(startsFile) && /not valid JSON/.test(l)), JSON.stringify(logs));
    assert.deepEqual(loadUpdateStarts(startsFile).starts, [NOW]);
  });

  test('a record that cannot be written is said and does not stop the daemon', () => {
    const { call, logs, startsFile } = setup();
    fs.mkdirSync(startsFile);
    assert.doesNotThrow(() => call({ status: 'success', targetVersion: OLD }));
    assert.ok(logs.some((l) => l.includes(startsFile) && /could not be written/.test(l)), JSON.stringify(logs));
  });
});
