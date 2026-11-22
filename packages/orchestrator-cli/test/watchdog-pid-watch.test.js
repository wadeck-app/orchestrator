'use strict';

// The daemon side of the Node watchdog on Windows (src/watchdog/pid-watch.ts): the daemon polls ORCH_WATCHDOG_PID and stops
// through its normal stop path when that process is gone. Timers and the process table are injected.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { startWatchdogWatch, stopWhenWatchdogGone, pidIsAlive, WATCHDOG_POLL_MS } = require('../src/watchdog/pid-watch');

function fakeTimers() {
  const t = { callbacks: [], cleared: 0, unrefs: 0, intervalMs: null };
  t.setInterval = (fn, ms) => {
    t.callbacks.push(fn);
    t.intervalMs = ms;
    return { unref: () => { t.unrefs++; } };
  };
  t.clearInterval = () => { t.cleared++; };
  t.tick = () => t.callbacks.forEach((fn) => fn());
  return t;
}

describe('startWatchdogWatch', () => {
  test('without ORCH_WATCHDOG_PID nothing starts and nothing is logged (Go launcher, manual run)', () => {
    const t = fakeTimers();
    const lines = [];
    const watch = startWatchdogWatch({ env: {}, log: (l) => lines.push(l), onGone: () => assert.fail('called'), setInterval: t.setInterval, clearInterval: t.clearInterval });
    assert.equal(watch, null);
    assert.equal(t.callbacks.length, 0);
    assert.deepEqual(lines, []);
  });

  for (const bad of ['abc', '0', '-4', '1.5', '12abc']) {
    test(`an unusable value is said in the log with its consequence, and nothing is watched: "${bad}"`, () => {
      const t = fakeTimers();
      const lines = [];
      const watch = startWatchdogWatch({ env: { ORCH_WATCHDOG_PID: bad }, log: (l) => lines.push(l), onGone: () => {}, setInterval: t.setInterval });
      assert.equal(watch, null);
      assert.equal(t.callbacks.length, 0);
      assert.ok(lines[0].includes(bad) && lines[0].includes('will NOT stop') && lines[0].includes('orch stop'), lines[0]);
    });
  }

  test('polls every 5 seconds with an unref\'d timer, so it never keeps the daemon alive', () => {
    const t = fakeTimers();
    startWatchdogWatch({ env: { ORCH_WATCHDOG_PID: '4321' }, log: () => {}, onGone: () => {}, isAlive: () => true, setInterval: t.setInterval, clearInterval: t.clearInterval });
    assert.equal(t.intervalMs, WATCHDOG_POLL_MS);
    assert.equal(WATCHDOG_POLL_MS, 5000);
    assert.equal(t.unrefs, 1);
  });

  test('a watchdog that is alive changes nothing, however many ticks', () => {
    const t = fakeTimers();
    let gone = 0;
    startWatchdogWatch({ env: { ORCH_WATCHDOG_PID: '4321' }, log: () => {}, onGone: () => { gone++; }, isAlive: () => true, setInterval: t.setInterval, clearInterval: t.clearInterval });
    for (let i = 0; i < 5; i++) {
      t.tick();
    }
    assert.equal(gone, 0);
  });

  test('a watchdog that is gone calls onGone once, stops the timer, and says so', () => {
    const t = fakeTimers();
    const lines = [];
    const probed = [];
    let alive = true;
    let gone = 0;
    startWatchdogWatch({
      env: { ORCH_WATCHDOG_PID: '4321' }, log: (l) => lines.push(l), onGone: () => { gone++; },
      isAlive: (pid) => { probed.push(pid); return alive; }, setInterval: t.setInterval, clearInterval: t.clearInterval,
    });
    t.tick();
    alive = false;
    t.tick();
    t.tick();
    assert.equal(gone, 1);
    assert.equal(t.cleared, 1);
    assert.deepEqual(new Set(probed), new Set([4321]));
    assert.ok(lines.some((l) => l.includes('pid 4321') && l.includes('is gone')), lines.join('\n'));
  });

  test('a probe that fails for an unknown reason keeps the daemon up, and is reported once', () => {
    const t = fakeTimers();
    const lines = [];
    let gone = 0;
    startWatchdogWatch({
      env: { ORCH_WATCHDOG_PID: '4321' }, log: (l) => lines.push(l), onGone: () => { gone++; },
      isAlive: () => { throw new Error('EIO'); }, setInterval: t.setInterval, clearInterval: t.clearInterval,
    });
    t.tick();
    t.tick();
    assert.equal(gone, 0);
    assert.equal(lines.filter((l) => l.includes('could not check the watchdog') && l.includes('EIO')).length, 1);
  });

  test('stop() ends the polling', () => {
    const t = fakeTimers();
    let gone = 0;
    const watch = startWatchdogWatch({ env: { ORCH_WATCHDOG_PID: '4321' }, log: () => {}, onGone: () => { gone++; }, isAlive: () => false, setInterval: t.setInterval, clearInterval: t.clearInterval });
    watch.stop();
    t.tick();
    assert.equal(gone, 0);
  });
});

describe('pidIsAlive', () => {
  const failing = (code) => () => { const e = new Error(code); e.code = code; throw e; };

  test('ESRCH is gone, EPERM is alive (it exists, it is not ours), success is alive, anything else is not a verdict', () => {
    assert.equal(pidIsAlive(1, () => {}), true);
    assert.equal(pidIsAlive(1, failing('ESRCH')), false);
    assert.equal(pidIsAlive(1, failing('EPERM')), true);
    assert.throws(() => pidIsAlive(1, failing('EIO')), /EIO/);
  });

  test('the real process table: this process is alive, a process that has ended is not', () => {
    assert.equal(pidIsAlive(process.pid), true);
    const finished = spawnSync(process.execPath, ['--version'], { windowsHide: true });
    assert.equal(finished.status, 0);
    assert.equal(pidIsAlive(finished.pid), false);
  });
});

describe('stopWhenWatchdogGone', () => {
  function setup(stop) {
    const lines = [];
    const exits = [];
    const timers = [];
    const onGone = stopWhenWatchdogGone({
      stop, exit: (c) => exits.push(c), log: (l) => lines.push(l),
      setTimeout: (fn, ms) => { const timer = { fn, ms, unref() { timer.unrefd = true; } }; timers.push(timer); return timer; },
    });
    return { lines, exits, timers, onGone };
  }

  test('stops through the normal stop path; a stop that completes leaves the exit to the process itself (no forced exit)', async () => {
    const stops = [];
    const { lines, exits, onGone } = setup(async () => { stops.push('normal stop'); });
    onGone();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stops, ['normal stop']);
    assert.deepEqual(exits, []);
    assert.ok(lines.some((l) => l.includes('no restart is requested')), lines.join('\n'));
  });

  test('arms an unref\'d fail-safe: a daemon still alive 10s after its stop exits 0 anyway, without a sentinel', async () => {
    const { exits, timers, onGone } = setup(async () => {});
    onGone();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 10_000);
    assert.equal(timers[0].unrefd, true, 'a timer that is not unref\'d would keep the daemon alive');
    timers[0].fn();
    assert.deepEqual(exits, [0]);
  });

  test('a stop that fails exits 1 and says what to do', async () => {
    const { lines, exits, onGone } = setup(async () => { throw new Error('port file locked'); });
    onGone();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(exits, [1]);
    assert.ok(lines.some((l) => l.includes('port file locked') && l.includes('orch start')), lines.join('\n'));
  });
});
