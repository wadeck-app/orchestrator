'use strict';

// A daemon that was asked to stop must not start a tray again. The tray is a child process with piped stdio: one that
// is (re)started after TrayManager.stop() keeps the daemon's event loop alive for ever, so a stopped daemon never exits
// (seen twice in full runs of events-contract/events-delivery: "did not exit within 90 s of POST /quit", the daemon's
// output ending with a second "starting tray-go" after the stop). Three ways in, each reproduced here by driving the fake
// tray's exit and readiness by hand, with no process and no clock:
//   1. stop() kills a tray that exits with a non-zero code (a forced kill does, on Windows) and onExit schedules a restart;
//   2. stop() arrives while the tray is starting, the start then fails, and the failure schedules a restart;
//   3. stop() arrives before the start reached its spawn, and the spawn happens anyway.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { TrayManager } = require('../src/tray-manager');

const dirs = [];
const managers = [];
afterEach(() => {
  while (managers.length > 0) {
    const m = managers.pop();
    clearTimeout(m._restartTimer);
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

/** A TrayProcess whose exit and readiness the test decides. */
function fakeTray({ exitCodeWhenKilled = 1 } = {}) {
  const exitHandlers = [];
  let settleReady;
  const readyPromise = new Promise((resolve, reject) => { settleReady = { resolve, reject }; });
  readyPromise.catch(() => {});
  const tray = {
    killed: false,
    killCalls: 0,
    process: { pid: undefined, stdin: { write() {} } },
    onStreamError() {},
    onSendFailed() {},
    writeNow: () => true,
    onStderrLine() {},
    onError() {},
    onClicked() {},
    onExit(handler) { exitHandlers.push(handler); },
    ready: () => readyPromise,
    capturedStderr: () => '',
    async send() {},
    async kill() {
      tray.killCalls++;
      tray.killed = true;
      for (const handler of exitHandlers) { handler(exitCodeWhenKilled); }
    },
    becomeReady: () => settleReady.resolve(),
    failToStart: (message) => settleReady.reject(new Error(message)),
  };
  return tray;
}

function makeManager(trays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tray-stop-'));
  dirs.push(dir);
  const scheduler = Object.assign(new EventEmitter(), { runningCount: () => 0 });
  const mgr = new TrayManager(dir, scheduler, { getAll: () => ({}) }, { list: () => [] }, '0.0.0-test', undefined, null);
  managers.push(mgr);
  // No binary is looked for and no process is started: the fakes are handed out in order.
  mgr._findBinary = () => path.join(dir, 'fake-tray');
  mgr._buildMenu = () => ({ icon: '', isTemplateIcon: false, tooltip: '', items: [] });
  const created = [];
  mgr._createTray = () => {
    const tray = trays.shift();
    assert.ok(tray, 'a tray was started that the test did not provide: the stopped daemon started one');
    created.push(tray);
    return tray;
  };
  return { mgr, created };
}

describe('TrayManager.stop: no tray comes back afterwards', () => {
  test('a tray that has to be killed with a non-zero exit code is not restarted', async () => {
    const tray = fakeTray({ exitCodeWhenKilled: 1 });
    const { mgr, created } = makeManager([tray]);
    const spawning = mgr._spawnTray();
    tray.becomeReady();
    await spawning;

    await mgr.stop();

    assert.equal(tray.killCalls, 1);
    assert.equal(mgr._restartTimer, null, 'the exit caused by stop() armed a restart');
    assert.equal(created.length, 1);
  });

  test('a start that fails because stop() killed it is not retried', async () => {
    const tray = fakeTray();
    const { mgr } = makeManager([tray]);
    const spawning = mgr._spawnTray();

    const stopping = mgr.stop();
    tray.failToStart('tray process exited before ready (code=1)');
    await Promise.all([spawning, stopping]);

    assert.equal(mgr._restartTimer, null, 'the start that stop() interrupted armed a restart');
  });

  test('a start that reaches its spawn after stop() does not spawn', async () => {
    const { mgr, created } = makeManager([]);

    await mgr.stop();
    await mgr._spawnTray();

    assert.equal(created.length, 0);
    assert.equal(mgr._tp, null);
  });

  test('a restart that was already waiting is cancelled by stop()', async () => {
    const { mgr, created } = makeManager([]);
    mgr._scheduleRestart();
    assert.notEqual(mgr._restartTimer, null, 'precondition: a restart is armed');

    await mgr.stop();

    assert.equal(mgr._restartTimer, null);
    assert.equal(created.length, 0);
  });

  test('without stop(), a tray that crashes is still restarted', async () => {
    const tray = fakeTray();
    const { mgr } = makeManager([tray]);
    const spawning = mgr._spawnTray();
    tray.becomeReady();
    await spawning;

    // The tray dies by itself with a failure code: the supervision that stop() must switch off.
    await tray.kill();

    assert.notEqual(mgr._restartTimer, null, 'a crashed tray must be restarted while the daemon runs');
  });
});
