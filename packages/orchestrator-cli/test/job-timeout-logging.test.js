'use strict';

// Verifies that the log produced when a job times out or is killed manually
// identifies the reason, so ops tooling can distinguish timeout / manual-kill
// from a real crash without reading across multiple log entries.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-timeout-log-test-'));
}

// A child that never exits on its own; it emits 'close' only when killed.
function hangingChild(exitCode = 1) {
  const child = new EventEmitter();
  child.pid   = undefined; // no real PID → _killChild falls through to child.kill()
  child.killed = false;
  child.stdout = null;
  child.stderr = null;
  child.kill  = () => {
    child.killed = true;
    process.nextTick(() => child.emit('close', exitCode));
  };
  return child;
}

function readJobLog(dir, jobId) {
  const logDir = path.join(dir, 'logs', 'jobs', jobId);
  const files  = fs.readdirSync(logDir);
  assert.equal(files.length, 1, `expected one log file, got: ${files.join(', ')}`);
  return fs.readFileSync(path.join(logDir, files[0]), 'utf8');
}

// triggerMode: 'wait' makes _fire() return the done promise instead of { pid },
// so await sched._fire(job) waits for the child to close (after being killed by timeout).
const BASE_JOB = {
  type: 'startup', delaySeconds: 0, command: 'node script.js',
  enabled: true, triggerMode: 'wait', liveness: null,
};

describe('timeout logging', () => {
  test('[job:timeout] entry appears immediately after the [warn] kill line', async () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    const job = { ...BASE_JOB, id: 'sync-a', timeoutSeconds: 0.001 };
    registry.add(job);

    const child = hangingChild(1);
    const sched = new Scheduler(registry, state, {
      spawn: () => child,
      liveness: async () => false,
      configDir: dir,
    });

    await sched._fire(job);

    const log = readJobLog(dir, 'sync-a');
    const lines = log.split('\n').filter(Boolean);

    const warnIdx    = lines.findIndex(l => l.includes('[warn]') && l.includes('timed out'));
    const timeoutIdx = lines.findIndex(l => l.includes('[job:timeout]'));

    assert.ok(warnIdx >= 0,    'missing [warn] timed out line');
    assert.ok(timeoutIdx >= 0, 'missing [job:timeout] line');
    assert.equal(timeoutIdx, warnIdx + 1, '[job:timeout] should immediately follow the [warn] line');
  });

  test('[job:timeout] line contains jobId and timeoutSeconds', async () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    const job = { ...BASE_JOB, id: 'sync-b', timeoutSeconds: 3600 };
    registry.add(job);

    // Fake time service: after() fires its callback on the next tick regardless of ms,
    // so the timeout triggers immediately without waiting 3600 seconds.
    const fakeTime = {
      now:   () => Date.now(),
      after: (_, fn) => { process.nextTick(fn); return { cancel: () => {} }; },
      every: (ms, fn) => { const h = setInterval(fn, ms); return { cancel: () => clearInterval(h) }; },
    };

    const sched = new Scheduler(registry, state, {
      spawn: () => hangingChild(1),
      liveness: async () => false,
      configDir: dir,
      time: fakeTime,
    });

    await sched._fire(job);

    const log = readJobLog(dir, 'sync-b');
    assert.ok(log.includes('[job:timeout] jobId=sync-b timeoutSeconds=3600'),
      `[job:timeout] line missing or malformed:\n${log}`);
  });

  test('[job:finished] has reason=timeout when a job is killed by the timeout', async () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    const job = { ...BASE_JOB, id: 'sync-c', timeoutSeconds: 0.001 };
    registry.add(job);

    const sched = new Scheduler(registry, state, {
      spawn: () => hangingChild(1),
      liveness: async () => false,
      configDir: dir,
    });

    await sched._fire(job);

    const log = readJobLog(dir, 'sync-c');
    assert.ok(log.includes('[job:finished] exitCode=1') && log.includes('reason=timeout'),
      `[job:finished] missing reason=timeout:\n${log}`);
  });

  test('[job:finished] does NOT carry reason=timeout for a normal failure', async () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    const job = { ...BASE_JOB, id: 'sync-d', timeoutSeconds: 3600 };
    registry.add(job);

    const child = new EventEmitter();
    child.pid    = undefined;
    child.killed = false;
    child.stdout = null;
    child.stderr = null;
    child.kill   = () => {};
    process.nextTick(() => child.emit('close', 1));

    const sched = new Scheduler(registry, state, {
      spawn: () => child,
      liveness: async () => false,
      configDir: dir,
    });

    await sched._fire(job);

    const log = readJobLog(dir, 'sync-d');
    assert.ok(!log.includes('reason=timeout'),
      `reason=timeout must not appear for a plain non-zero exit:\n${log}`);
    assert.ok(log.includes('[job:finished] exitCode=1'),
      `[job:finished] line missing:\n${log}`);
  });
});

describe('manual-kill logging', () => {
  test('[job:finished] has reason=manual-kill when killed via killJob()', async () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    const job = { ...BASE_JOB, id: 'sync-e', triggerMode: 'wait', timeoutSeconds: 3600 };
    registry.add(job);

    const child = hangingChild(1);
    const sched = new Scheduler(registry, state, {
      spawn: () => child,
      liveness: async () => false,
      configDir: dir,
    });

    const fired = sched._fire(job);
    // Give the scheduler a tick to register the active child before killing.
    await new Promise(r => setImmediate(r));
    await sched.killJob('sync-e');
    await fired;

    const log = readJobLog(dir, 'sync-e');
    assert.ok(log.includes('reason=manual-kill'),
      `[job:finished] missing reason=manual-kill:\n${log}`);
  });

  test('[job:finished] does NOT carry reason=manual-kill for a normal success', async () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    const job = { ...BASE_JOB, id: 'sync-f', timeoutSeconds: 3600 };
    registry.add(job);

    const child = new EventEmitter();
    child.pid    = undefined;
    child.killed = false;
    child.stdout = null;
    child.stderr = null;
    child.kill   = () => {};
    process.nextTick(() => child.emit('close', 0));

    const sched = new Scheduler(registry, state, {
      spawn: () => child,
      liveness: async () => false,
      configDir: dir,
    });

    await sched._fire(job);

    const log = readJobLog(dir, 'sync-f');
    assert.ok(!log.includes('reason=manual-kill'),
      `reason=manual-kill must not appear for a normal exit:\n${log}`);
  });
});
