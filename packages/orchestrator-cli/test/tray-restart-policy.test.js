'use strict';

// What the daemon does about a tray that keeps dying.
//
// 2026-10-24: 199 tray exits in one day, some of them twice in 15 seconds. The old policy reset its back-off every time
// the new tray said "ready", which a tray does before anything can go wrong, so it restarted every second for ever; and
// the exit was logged with the last 500 characters of stderr and no signal, which is how a forced kill (exit code 1 on
// Windows, nothing on stderr) looked like a crash for a day. The daemon also started by killing every tray binary on
// the machine by image name, which is what actually killed the trays of other daemons.
//
// No process and no clock here: the fake tray's exit is driven by hand, the clock and the timers are seams.
const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { TrayManager } = require('../src/tray-manager');

const dirs = [];
const timers = [];
afterEach(() => {
  mock.restoreAll();
  while (timers.length > 0) {
    clearTimeout(timers.pop());
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

function fakeTray({ stderr = '' } = {}) {
  const exitHandlers = [];
  const streamHandlers = [];
  const sendFailedHandlers = [];
  const readyPromise = Promise.resolve();
  const tray = {
    killed: false,
    written: [],
    writeResult: true,
    process: { pid: 5150, stdin: { write() { throw new Error('the manager must not write to stdin itself'); } } },
    onStderrLine() {},
    onError() {},
    onClicked() {},
    onExit(handler) { exitHandlers.push(handler); },
    onStreamError(handler) { streamHandlers.push(handler); },
    onSendFailed(handler) { sendFailedHandlers.push(handler); },
    ready: () => readyPromise,
    capturedStderr: () => stderr,
    async send() { return true; },
    writeNow(msg) { tray.written.push(msg); return tray.writeResult; },
    async kill() { tray.killed = true; },
    die(code, signal = null) {
      tray.killed = true;
      for (const handler of exitHandlers) { handler(code, signal); }
    },
    breakStream(stream, err) { for (const handler of streamHandlers) { handler(stream, err); } },
    failSend(reason) { for (const handler of sendFailedHandlers) { handler(reason); } },
  };
  return tray;
}

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tray-policy-'));
  dirs.push(dir);
  const scheduler = Object.assign(new EventEmitter(), { runningCount: () => 0 });
  const mgr = new TrayManager(dir, scheduler, { getAll: () => ({}) }, { list: () => [] }, '0.0.0-test', undefined, null);
  mgr._findBinary = () => path.join(dir, 'fake-tray');
  mgr._buildMenu = () => ({ icon: '', isTemplateIcon: false, tooltip: '', items: [] });
  const logs = [];
  mgr.on('log', (line) => logs.push(line));
  const clock = { now: 1_000_000 };
  mgr._now = () => clock.now;
  // Every restart timer the manager arms is recorded, and held far in the future so nothing fires by itself.
  const armed = [];
  mgr._startTimer = (fn, ms) => {
    armed.push({ fn, ms });
    const handle = setTimeout(() => {}, 2_000_000_000);
    handle.unref();
    timers.push(handle);
    return handle;
  };
  return { mgr, dir, logs, clock, armed };
}

/** Starts a tray on the manager and returns it; the manager is told nothing else. */
async function spawnWith(mgr, tray) {
  mgr._createTray = () => tray;
  await mgr._spawnTray();
  return tray;
}

/** start() registers a process-wide 'exit' hook; the ones it adds are taken off again so no test leaves one behind. */
async function startWithoutExitHook(mgr) {
  const before = new Set(process.listeners('exit'));
  // The suite runs with ORCH_NO_TRAY=1; these tests exercise the real start() around a stubbed _spawnTray (no process).
  const previous = process.env.ORCH_NO_TRAY;
  process.env.ORCH_NO_TRAY = '0';
  try {
    await mgr.start();
  } finally {
    if (previous === undefined) { delete process.env.ORCH_NO_TRAY; } else { process.env.ORCH_NO_TRAY = previous; }
  }
  for (const listener of process.listeners('exit')) {
    if (!before.has(listener)) {
      process.removeListener('exit', listener);
    }
  }
}

describe('TrayManager restart policy: bounded and visible', () => {
  test('back-off grows with the crashes in the window even though every tray reaches ready', async () => {
    const { mgr, armed } = makeManager();
    const delays = [];
    for (let i = 0; i < 5; i++) {
      const tray = await spawnWith(mgr, fakeTray());
      tray.die(1);
      mgr._restartTimer = null;
      delays.push(armed[armed.length - 1].ms);
    }
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000]);
  });

  test('the sixth crash in ten minutes is not restarted at once: the manager gives up and says so', async () => {
    const { mgr, logs, armed } = makeManager();
    for (let i = 0; i < 6; i++) {
      const tray = await spawnWith(mgr, fakeTray());
      tray.die(1);
      mgr._restartTimer = null;
    }
    const last = armed[armed.length - 1];
    assert.equal(last.ms, 30 * 60_000, 'after giving up the next attempt is the cool-down, not a back-off of seconds');
    const message = logs.find((l) => /not restarting/.test(l));
    assert.ok(message, `no give-up line in: ${logs.join(' | ')}`);
    assert.match(message, /6 times in 10 minutes/);
    assert.match(message, /30 minutes/);
    assert.match(message, /orch restart/, 'the line must say what the user can do');
  });

  test('crashes older than the window are forgotten', async () => {
    const { mgr, clock, armed } = makeManager();
    for (let i = 0; i < 5; i++) {
      const tray = await spawnWith(mgr, fakeTray());
      tray.die(1);
      mgr._restartTimer = null;
    }
    clock.now += 10 * 60_000 + 1;
    const tray = await spawnWith(mgr, fakeTray());
    tray.die(1);
    assert.equal(armed[armed.length - 1].ms, 1000, 'a crash after a quiet ten minutes starts the back-off again');
  });

  test('after the cool-down the manager tries again and starts counting from zero', async () => {
    const { mgr, armed, logs } = makeManager();
    for (let i = 0; i < 6; i++) {
      const tray = await spawnWith(mgr, fakeTray());
      tray.die(1);
      mgr._restartTimer = null;
    }
    assert.equal(armed[armed.length - 1].ms, 30 * 60_000);
    const tray = await spawnWith(mgr, fakeTray());
    tray.die(1);
    assert.equal(armed[armed.length - 1].ms, 1000);
    assert.ok(logs.some((l) => /restart 1 of 5/.test(l)), logs.join(' | '));
  });

  test('every scheduled restart is a log line with its delay', async () => {
    const { mgr, logs } = makeManager();
    const tray = await spawnWith(mgr, fakeTray());
    tray.die(1);
    assert.ok(logs.some((l) => /restart 1 of 5 .* in 1s/.test(l)), logs.join(' | '));
  });
});

describe('TrayManager: the exit is logged with everything known about it', () => {
  test('the full captured stderr, the code and the signal', async () => {
    const stderr = 'line one\n' + 'x'.repeat(1500) + '\nthe last line\n';
    const { mgr, logs } = makeManager();
    const tray = await spawnWith(mgr, fakeTray({ stderr }));
    tray.die(null, 'SIGKILL');
    const line = logs.find((l) => /process exited/.test(l));
    assert.ok(line);
    assert.match(line, /code=null/);
    assert.match(line, /signal=SIGKILL/);
    assert.ok(line.includes(JSON.stringify(stderr)), 'stderr is cut: the cause of a crash is at its start as often as at its end');
  });

  test('a silent exit with code 1 says that nothing was written on stderr', async () => {
    const { mgr, logs } = makeManager();
    const tray = await spawnWith(mgr, fakeTray({ stderr: '' }));
    tray.die(1);
    const line = logs.find((l) => /process exited/.test(l));
    assert.match(line, /signal=none/);
    assert.match(line, /no stderr/i);
  });

  test('a broken pipe and a failed send reach the daemon log', async () => {
    const { mgr, logs } = makeManager();
    const tray = await spawnWith(mgr, fakeTray());
    tray.breakStream('stdin', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    tray.failSend('write EPIPE');
    assert.ok(logs.some((l) => /stdin.*EPIPE/.test(l)), logs.join(' | '));
    assert.ok(logs.some((l) => /could not send.*EPIPE/i.test(l)), logs.join(' | '));
  });

  test('the init message goes through writeNow, and a refused init is logged', async () => {
    const { mgr, logs } = makeManager();
    const tray = fakeTray();
    tray.writeResult = false;
    await spawnWith(mgr, tray);
    assert.equal(tray.written.length, 1);
    assert.equal(tray.written[0].type, 'init');
    assert.ok(logs.some((l) => /init not sent/.test(l)), logs.join(' | '));
  });
});

describe('TrayManager.start: only this daemon\'s own tray is ever killed', () => {
  test('no tray is killed by image name', async () => {
    const calls = [];
    mock.method(childProcess, 'execFileSync', (...args) => { calls.push(args); return Buffer.alloc(0); });
    const { mgr } = makeManager();
    mgr._spawnTray = async () => {};
    await startWithoutExitHook(mgr);
    const byImage = calls.filter(([cmd, args]) => cmd === 'pkill' || (Array.isArray(args) && args.includes('/IM')));
    assert.deepEqual(byImage, [], 'start() killed trays by image name: that takes down the trays of every other daemon');
  });

  test('the tray recorded in this config dir by a previous daemon is killed', async () => {
    const { mgr, dir } = makeManager();
    fs.writeFileSync(path.join(dir, 'config.tray-pid'), '31337');
    const killed = [];
    mgr._isTrayPid = () => true;
    mgr._killByPid = (pid) => { killed.push(pid); };
    mgr._spawnTray = async () => {};
    await startWithoutExitHook(mgr);
    assert.deepEqual(killed, [31337]);
    assert.equal(fs.existsSync(path.join(dir, 'config.tray-pid')), false, 'the pid file of the dead tray is removed');
  });

  test('a recorded pid that is not a tray any more is left alone and said so', async () => {
    const { mgr, dir, logs } = makeManager();
    fs.writeFileSync(path.join(dir, 'config.tray-pid'), '31337');
    const killed = [];
    mgr._isTrayPid = () => false;
    mgr._killByPid = (pid) => { killed.push(pid); };
    mgr._spawnTray = async () => {};
    await startWithoutExitHook(mgr);
    assert.deepEqual(killed, []);
    assert.ok(logs.some((l) => /31337.*not a tray/.test(l)), logs.join(' | '));
  });

  test('no pid file means nothing to kill and nothing to say', async () => {
    const { mgr, logs } = makeManager();
    const killed = [];
    mgr._killByPid = (pid) => { killed.push(pid); };
    mgr._spawnTray = async () => {};
    await startWithoutExitHook(mgr);
    assert.deepEqual(killed, []);
    assert.deepEqual(logs, []);
  });
});
