'use strict';

// Scheduler is an EventEmitter AND publishes domain events through an EventPublisher. The publisher
// used to live in a field called `_events`, which is the name EventEmitter keeps its own listener
// table under. It worked by accident -- `on()` stored listeners as properties of the publisher -- until
// the last listener was removed: EventEmitter then replaces `_events` with a fresh table, taking the
// publisher with it, and the next publish() threw "is not a function" from inside a close handler.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-emitter-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add({
    id: 'j', type: 'cron', schedule: '0 8 * * *', command: 'node -v',
    enabled: true, triggerMode: 'fire-and-forget',
  });
  const published = [];
  const children  = [];
  const sched = new Scheduler(registry, state, {
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 7000 + children.length;
      children.push(child);
      return child;
    },
    liveness: async () => false,
    sampleUsage: async () => null,
    configDir: dir,
    eventPublisher: { publish: (event, payload) => published.push({ event, payload }) },
  });
  return { sched, registry, children, published };
}

describe('Scheduler as an EventEmitter', () => {
  test('publishing still works after the last listener is removed', async () => {
    const { sched, registry, children, published } = makeEnv();
    // once(): the listener is removed on its first call, which empties EventEmitter's table.
    sched.once('job-started', () => {});

    await sched._maybeSpawn(registry.get('j'));
    children[0].emit('close', 0);

    assert.ok(
      published.some((e) => e.event === 'job.completed'),
      'job.completed must still be published once the listener table has been emptied',
    );
  });

  test('listeners added with on() still receive the emitted events', async () => {
    const { sched, registry, children } = makeEnv();
    const seen = [];
    sched.on('job-finished', (ev) => seen.push(ev.id));

    await sched._maybeSpawn(registry.get('j'));
    children[0].emit('close', 0);

    assert.deepEqual(seen, ['j']);
  });
});
