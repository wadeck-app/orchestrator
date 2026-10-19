'use strict';

// `restart-job`: end every running instance of a job, wait until it is really gone, start a new run.
// The point of the wait: a startup job that owns a port must not collide with the instance being ended, and a
// job at maxConcurrency 1 must not see its own corpse as a reason to refuse. These tests use hand-made children
// that take a while to die, which is what makes "awaits the end" observable.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { makeCommands } = require('../src/commands');

const dirs = [];
after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const JOB = {
  id: 'srv', type: 'startup', label: 'Server', command: 'node server.js',
  enabled: true, triggerMode: 'fire-and-forget', timeoutSeconds: 0,
};

/**
 * @param {object} opts
 * @param {number} [opts.dieAfterMs] how long a killed child takes to close; Infinity = never closes.
 */
function makeEnv({ job = JOB, dieAfterMs = 40, liveness = async () => false, schedulerExtra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-restart-'));
  dirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(job);
  const timeline = [];
  const children = [];
  // One distinct millisecond per call: runs are keyed by startedAt.
  let tick = Date.parse('2026-10-19T08:00:00.000Z');
  const sched = new Scheduler(registry, state, {
    spawn: () => {
      const child = new EventEmitter();
      // No pid on purpose: killing the tree of a made-up pid could hit a real process.
      child.pid = undefined;
      child.killed = false;
      child.index = children.length;
      child.kill = () => {
        child.killed = true;
        if (Number.isFinite(dieAfterMs)) {
          setTimeout(() => { timeline.push(`close:${child.index}`); child.emit('close', null); }, dieAfterMs);
        }
        return true;
      };
      timeline.push(`spawn:${child.index}`);
      children.push(child);
      return child;
    },
    liveness,
    sampleUsage: async () => null,
    configDir: dir,
    now: () => new Date(tick += 1000),
    eventPublisher: { publish: () => {} },
    ...schedulerExtra,
  });
  const logged = [];
  const audit = { log: (event, payload) => logged.push({ event, payload }), readLast: () => [] };
  const commands = makeCommands(registry, state, sched, dir, undefined, audit);
  return { commands, sched, state, registry, children, timeline, logged };
}

describe('restart-job on a running long-running job', () => {
  test('ends the instance, waits until it is gone, then starts a new one and says so', async () => {
    const env = makeEnv();
    await env.commands['trigger-job']({ id: 'srv' });

    const reply = await env.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.id, 'srv');
    assert.equal(reply.wasRunning, true);
    assert.equal(reply.killed, 1);
    assert.equal(reply.started, true);
    assert.equal(reply.skipped, undefined);
    assert.equal(env.children.length, 2);
    // The whole point: the second copy starts only once the first one has closed.
    assert.deepEqual(env.timeline, ['spawn:0', 'close:0', 'spawn:1']);
    assert.equal(env.sched.runningCount('srv'), 1);
  });

  test('keeps the normal manual-kill record of the ended run', async () => {
    const env = makeEnv();
    await env.commands['trigger-job']({ id: 'srv' });

    await env.commands['restart-job']({ id: 'srv' });

    const history = [...env.state.getAll().srv].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    assert.equal(history.length, 2);
    assert.equal(history[0].cancelledByUser, true);
    assert.ok(history[0].finishedAt, 'the ended run is closed');
    assert.equal(history[1].finishedAt, undefined, 'the new run is open');
  });

  test('ends every instance when several are running', async () => {
    const env = makeEnv({ job: { ...JOB, maxConcurrency: 3 } });
    await env.commands['trigger-job']({ id: 'srv' });
    await env.commands['trigger-job']({ id: 'srv' });

    const reply = await env.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.killed, 2);
    assert.equal(reply.started, true);
    assert.equal(env.timeline.at(-1), 'spawn:2', 'the new run starts last');
    assert.ok(env.timeline.indexOf('close:0') < env.timeline.indexOf('spawn:2'));
    assert.ok(env.timeline.indexOf('close:1') < env.timeline.indexOf('spawn:2'));
    assert.equal(env.sched.runningCount('srv'), 1);
  });

  test('a job at maxConcurrency 1 is restarted, its own corpse does not count', async () => {
    const env = makeEnv({ job: { ...JOB, maxConcurrency: 1 } });
    await env.commands['trigger-job']({ id: 'srv' });

    const reply = await env.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.started, true);
  });

  test('audits exactly one job.restarted, with the job, the label, whether it ran and how many were ended', async () => {
    const env = makeEnv();
    await env.commands['trigger-job']({ id: 'srv' });
    env.logged.length = 0;

    await env.commands['restart-job']({ id: 'srv', ip: '127.0.0.1', userAgent: 'test' });

    const restarted = env.logged.filter((l) => l.event === 'job.restarted');
    assert.equal(restarted.length, 1, JSON.stringify(env.logged));
    assert.equal(restarted[0].payload.jobId, 'srv');
    assert.equal(restarted[0].payload.label, 'Server');
    assert.equal(restarted[0].payload.wasRunning, true);
    assert.equal(restarted[0].payload.killed, 1);
  });
});

describe('restart-job on a job that is not running', () => {
  test('just starts it and says it was not running', async () => {
    const env = makeEnv();

    const reply = await env.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.wasRunning, false);
    assert.equal(reply.killed, 0);
    assert.equal(reply.started, true);
    assert.deepEqual(env.timeline, ['spawn:0']);
  });
});

describe('restart-job refuses what it cannot do, in words', () => {
  test('a start refused by the liveness check is started:false with the reason and what to do', async () => {
    const env = makeEnv({ liveness: async () => true });
    await env.sched.trigger('srv');

    const reply = await env.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.wasRunning, true);
    assert.equal(reply.killed, 1);
    assert.equal(reply.started, false);
    assert.equal(reply.skipped, 'liveness');
    assert.equal(reply.pid, null);
    assert.match(reply.reason, /liveness/i);
    assert.match(reply.reason, /orch trigger srv|orch restart-job srv/);
    // The old instance was ended and nothing replaced it.
    assert.deepEqual(env.timeline, ['spawn:0', 'close:0']);
  });

  test('a start refused by the concurrency limit is started:false with skipped "concurrency"', async () => {
    const env = makeEnv();
    env.sched._atLimit = () => ({ running: 1, maxConcurrency: 1 });

    const reply = await env.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.started, false);
    assert.equal(reply.skipped, 'concurrency');
    assert.match(reply.reason, /1 of 1/);
  });

  test('a run followed by another live daemon is started:false with skipped "adopted"', async () => {
    const env = makeEnv();
    env.sched._followedElsewhere.set('srv|2026-10-19T07:00:00.000Z', path.join(os.tmpdir(), 'nowhere'));

    const reply = await env.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.started, false);
    assert.equal(reply.skipped, 'adopted');
    assert.match(reply.reason, /another daemon/i);
    assert.equal(env.children.length, 0);
  });

  test('an instance that does not end in time is never replaced by a second copy', async () => {
    const env = makeEnv({ dieAfterMs: Infinity, schedulerExtra: { restartGraceMs: 150 } });
    await env.commands['trigger-job']({ id: 'srv' });

    const reply = await env.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.wasRunning, true);
    assert.equal(reply.started, false);
    assert.equal(reply.skipped, undefined);
    assert.match(reply.reason, /still running/);
    assert.match(reply.reason, /orch kill srv/);
    assert.equal(env.children.length, 1, 'no second copy');
  });

  test('an id that is not an id, an unknown job, a disabled job and a spent job are errors and leave no audit line', async () => {
    const env = makeEnv();
    env.registry.add({ id: 'off', type: 'cron', schedule: '0 8 * * *', command: 'node -v', enabled: false, triggerMode: 'fire-and-forget' });
    env.registry.add({ id: 'done', type: 'once', delayMs: 3600000, command: 'node -v', enabled: true, triggerMode: 'fire-and-forget' });
    env.registry.markSpent('done');

    await assert.rejects(() => env.commands['restart-job']({ id: '../etc' }), /job id.*orch list/is);
    await assert.rejects(() => env.commands['restart-job']({ id: '' }), /job id.*orch list/is);
    await assert.rejects(() => env.commands['restart-job']({ id: 'ghost' }), /Job not found: "ghost".*orch list/s);
    await assert.rejects(() => env.commands['restart-job']({ id: 'off' }), /disabled.*orch enable off/s);
    await assert.rejects(() => env.commands['restart-job']({ id: 'done' }), /already ran|spent/i);

    assert.deepEqual(env.logged, []);
    assert.equal(env.children.length, 0);
  });
});

describe('restart-job on a job whose triggerMode is "wait"', () => {
  test('replies once the new run has started, instead of waiting for a long-running job to end', async () => {
    const env = makeEnv({ job: { ...JOB, triggerMode: 'wait' } });

    const reply = await Promise.race([
      env.commands['restart-job']({ id: 'srv' }),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
    ]);

    assert.notEqual(reply, 'hung', 'the restart waited for the new run to end');
    assert.equal(reply.started, true);
  });
});
