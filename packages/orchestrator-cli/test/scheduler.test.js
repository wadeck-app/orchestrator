'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-scheduler-test-'));
}

function makeDeps(dir) {
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  return { registry, state };
}

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.pid = 12345;
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

const JOB_STARTUP_NOW = {
  id: 'svc-a',
  type: 'startup',
  delaySeconds: 0,
  command: 'echo hello',
  enabled: true,
  triggerMode: 'fire-and-forget',
  liveness: null,
};

const JOB_STARTUP_DELAYED = {
  id: 'svc-b',
  type: 'startup',
  delaySeconds: 60,
  command: 'echo delayed',
  enabled: true,
  triggerMode: 'fire-and-forget',
  liveness: null,
};

const JOB_STARTUP_DISABLED = {
  id: 'svc-c',
  type: 'startup',
  delaySeconds: 0,
  command: 'echo disabled',
  enabled: false,
  triggerMode: 'fire-and-forget',
  liveness: null,
};

const JOB_CRON = {
  id: 'cron-a',
  type: 'cron',
  schedule: '0 0 * * *',
  command: 'echo cron',
  enabled: true,
  triggerMode: 'fire-and-forget',
  missedFiring: 'skip',
  liveness: null,
};

// ---------------------------------------------------------------------------
// start() -- startup jobs
// ---------------------------------------------------------------------------

describe('start() -- startup jobs', () => {
  test('spawns enabled startup job with delaySeconds=0', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_NOW);

    let spawned = null;
    const spawn = (cmd, cwd) => { spawned = { cmd, cwd }; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.stop();

    assert.ok(spawned !== null, 'spawn should have been called');
    assert.equal(spawned.cmd, JOB_STARTUP_NOW.command);
  });

  test('does NOT spawn disabled startup job', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_DISABLED);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.stop();

    assert.equal(spawnCount, 0);
  });

  test('skips spawn when liveness returns true', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_NOW);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => true });
    await sched.start();
    await sched.stop();

    assert.equal(spawnCount, 0);
  });

  test('does NOT immediately spawn startup job with delaySeconds > 0', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_DELAYED);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    // Don't advance time -- timeout should not have fired
    await sched.stop(); // stop cancels the timeout

    assert.equal(spawnCount, 0);
  });
});

// ---------------------------------------------------------------------------
// _fire() -- state recording
// ---------------------------------------------------------------------------

describe('_fire() -- state recording', () => {
  test('records startedAt in state', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_NOW);

    const spawn = () => fakeChild(0);
    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });

    await sched._fire(JOB_STARTUP_NOW);
    // Give nextTick for fakeChild close event
    await new Promise(r => setImmediate(r));

    const s = state.get(JOB_STARTUP_NOW.id);
    assert.ok(s !== null, 'state should have entry');
    assert.ok(s.startedAt, 'startedAt should be set');
  });

  test('records exitCode in state after process exits', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_NOW);

    const spawn = () => fakeChild(42);
    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });

    await sched._fire(JOB_STARTUP_NOW);
    await new Promise(r => setTimeout(r, 20)); // let close event fire

    const s = state.get(JOB_STARTUP_NOW.id);
    assert.equal(s.exitCode, 42);
  });
});

// ---------------------------------------------------------------------------
// trigger()
// ---------------------------------------------------------------------------

describe('trigger()', () => {
  test('fires job regardless of enabled=false', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_DISABLED);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.trigger(JOB_STARTUP_DISABLED.id);
    await sched.stop();

    assert.equal(spawnCount, 1);
  });

  test('throws for unknown job id', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);

    const sched = new Scheduler(registry, state, { spawn: () => fakeChild(0), liveness: async () => false });
    await sched.start();
    await assert.rejects(() => sched.trigger('ghost'), /not found/i);
    await sched.stop();
  });
});

// ---------------------------------------------------------------------------
// stop() -- cancels pending timeouts
// ---------------------------------------------------------------------------

describe('stop()', () => {
  test('cancels pending delayed startup timeout before it fires', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_DELAYED);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.stop(); // cancels the 60s timeout before it fires

    // If we wait a tick, the cancelled timeout should not fire
    await new Promise(r => setImmediate(r));
    assert.equal(spawnCount, 0);
  });
});

// ---------------------------------------------------------------------------
// cron -- basic scheduling
// ---------------------------------------------------------------------------

describe('cron jobs', () => {
  test('registers a cron task without crashing', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_CRON);

    const sched = new Scheduler(registry, state, {
      spawn: () => fakeChild(0),
      liveness: async () => false,
    });
    await assert.doesNotReject(() => sched.start());
    await sched.stop();
  });
});
