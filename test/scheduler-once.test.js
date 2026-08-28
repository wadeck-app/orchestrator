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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-once-test-'));
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

function makeOnceJob(overrides = {}) {
  return {
    id:          'once-a',
    type:        'once',
    delayMs:     5000,
    scheduledAt: new Date(Date.now() - 6000).toISOString(), // 6 s ago → already elapsed
    command:     'echo once',
    enabled:     true,
    triggerMode: 'fire-and-forget',
    liveness:    null,
    label:       'once-a',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// once job fires exactly once
// ---------------------------------------------------------------------------

describe('once jobs -- fires exactly once', () => {
  test('fires immediately when remaining delay <= 0', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);

    // scheduledAt 10 s ago, delayMs 5000 → remaining = -5000 ms → fire immediately
    const job = makeOnceJob({ scheduledAt: new Date(Date.now() - 10000).toISOString(), delayMs: 5000 });
    registry.add(job);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await new Promise(r => setImmediate(r));
    await sched.stop();

    assert.equal(spawnCount, 1, 'should have fired exactly once');
  });

  test('does not fire a second time after start/stop cycle', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);

    const job = makeOnceJob({ scheduledAt: new Date(Date.now() - 10000).toISOString(), delayMs: 5000 });
    registry.add(job);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await new Promise(r => setImmediate(r));
    await sched.stop();

    assert.equal(spawnCount, 1);
    // The job should be gone from registry now
    assert.equal(registry.get(job.id), null, 'job should have been removed');
  });
});

// ---------------------------------------------------------------------------
// once job is removed from registry after execution
// ---------------------------------------------------------------------------

describe('once jobs -- auto-removal', () => {
  test('removes job from registry after firing', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);

    const job = makeOnceJob({ scheduledAt: new Date(Date.now() - 10000).toISOString(), delayMs: 5000 });
    registry.add(job);

    assert.notEqual(registry.get(job.id), null, 'job should exist before start');

    const spawn = () => fakeChild(0);
    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await new Promise(r => setImmediate(r));
    await sched.stop();

    assert.equal(registry.get(job.id), null, 'job should be removed after firing');
  });
});

// ---------------------------------------------------------------------------
// On restart with remaining delay > 0: re-arms with remaining time
// ---------------------------------------------------------------------------

describe('once jobs -- restart re-arming', () => {
  test('does NOT fire immediately when remaining delay > 0', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);

    // scheduledAt just now, delayMs 60000 → remaining ~60000 ms
    const job = makeOnceJob({ scheduledAt: new Date().toISOString(), delayMs: 60000 });
    registry.add(job);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await new Promise(r => setImmediate(r));
    await sched.stop(); // cancels the pending timeout

    assert.equal(spawnCount, 0, 'should not have fired yet');
    // Job still in registry (not removed) because it never fired
    assert.notEqual(registry.get(job.id), null, 'job should still exist since it never fired');
  });

  test('re-arms and fires after correct remaining delay', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);

    // scheduledAt 90ms ago, delayMs 100ms → remaining ~10ms
    const job = makeOnceJob({ scheduledAt: new Date(Date.now() - 90).toISOString(), delayMs: 100 });
    registry.add(job);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();

    // Wait long enough for the ~10ms timeout to fire
    await new Promise(r => setTimeout(r, 80));
    await sched.stop();

    assert.equal(spawnCount, 1, 'should have fired once after remaining delay');
    assert.equal(registry.get(job.id), null, 'job should be removed after firing');
  });
});

// ---------------------------------------------------------------------------
// stop() cancels a pending once-job (no late fire)
// ---------------------------------------------------------------------------

describe('once jobs -- stop() cancels pending', () => {
  test('stop() prevents a pending once-job from firing', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);

    // Will fire in ~60s → stop() should cancel it before it fires
    const job = makeOnceJob({ scheduledAt: new Date().toISOString(), delayMs: 60000 });
    registry.add(job);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.stop(); // cancel immediately

    await new Promise(r => setImmediate(r));
    assert.equal(spawnCount, 0, 'spawn should not have been called after stop()');
  });
});
