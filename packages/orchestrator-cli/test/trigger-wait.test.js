'use strict';

// `orch trigger <id> --wait` printed "finished (exit ?)" and returned before the job was done.
//
// The CLI sent `wait: true`, the RPC handler dropped it, and _fire decided on its own: it returns
// { pid } as soon as the job's own triggerMode is not 'wait'. So --wait only worked on jobs that were
// already configured to be waited on -- exactly the ones that did not need the flag. A flag that
// claims to wait and does not is worse than no flag: an agent chaining commands on it proceeds on an
// unfinished job.
//
// The job's triggerMode governs SCHEDULED firings. An explicit --wait is a property of this one call.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { makeCommands } = require('../src/commands');

function makeEnv(job, { exitCode = 0, closeDelayMs = 20 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wait-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(job);
  const sched = new Scheduler(registry, state, {
    // Deliberately slow to close, so "returned too early" is observable rather than a race.
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 777;
      setTimeout(() => child.emit('close', exitCode), closeDelayMs);
      return child;
    },
    liveness: async () => false,
    configDir: dir,
  });
  return { sched, state, registry, dir };
}

const FIRE_AND_FORGET = {
  id: 'j1', type: 'cron', schedule: '0 8 * * *', command: 'node -v',
  enabled: true, triggerMode: 'fire-and-forget',
};

describe('trigger(id, source, wait) waits when asked', () => {
  test('a fire-and-forget job still reports its exit code when wait is requested', async () => {
    const { sched } = makeEnv(FIRE_AND_FORGET, { exitCode: 3 });

    const result = await sched.trigger('j1', { kind: 'manual' }, true);

    assert.equal(result.exitCode, 3, `--wait returned before the job finished: ${JSON.stringify(result)}`);
  });

  test('it really waits: the run is finished in the history by the time it returns', async () => {
    const { sched, state } = makeEnv(FIRE_AND_FORGET, { exitCode: 0 });

    await sched.trigger('j1', { kind: 'manual' }, true);

    const entry = state.get('j1');
    assert.ok(entry.finishedAt, 'returned while the run was still in flight');
    assert.equal(entry.exitCode, 0);
  });

  test('without wait it returns the pid immediately, as before', async () => {
    const { sched } = makeEnv(FIRE_AND_FORGET);

    const result = await sched.trigger('j1', { kind: 'manual' });

    assert.equal(result.pid, 777);
    assert.ok(!('exitCode' in result), 'the default became blocking');
  });

  test("a job whose own triggerMode is 'wait' is unaffected", async () => {
    const { sched } = makeEnv({ ...FIRE_AND_FORGET, triggerMode: 'wait' }, { exitCode: 1 });

    const result = await sched.trigger('j1', { kind: 'manual' });

    assert.equal(result.exitCode, 1);
  });

  // The flag is per call: waiting once must not turn the job into a waiting job for its schedule.
  test('waiting once does not change the stored job', async () => {
    const { sched, registry } = makeEnv(FIRE_AND_FORGET);

    await sched.trigger('j1', { kind: 'manual' }, true);

    assert.equal(registry.get('j1').triggerMode, 'fire-and-forget');
  });
});

describe('the trigger-job RPC passes wait through', () => {
  function makeCmds(job) {
    const { sched, state, registry } = makeEnv(job, { exitCode: 5 });
    return { commands: makeCommands(registry, state, sched, '/tmp'), sched };
  }

  test('wait: true reaches the scheduler', async () => {
    const { commands } = makeCmds(FIRE_AND_FORGET);

    const result = await commands['trigger-job']({ id: 'j1', wait: true });

    assert.equal(result.exitCode, 5, 'the handler dropped wait on the floor');
  });

  test('wait absent keeps the fire-and-forget answer', async () => {
    const { commands } = makeCmds(FIRE_AND_FORGET);

    const result = await commands['trigger-job']({ id: 'j1' });

    assert.equal(result.pid, 777);
  });
});
