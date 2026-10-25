'use strict';

// What the QUEUE DAEMON receives, end to end: the real EventPublisher (the SDK, the token, the cwd rules) against the SDK's
// own throwaway queue daemon (`@wadeck-app/queue-sdk/testing`), and the real daemon process for the events only it publishes.
// For weeks no event reached the queue (a missing Bearer token made every push a silent 401) and no test noticed: these
// tests read the pushes on the receiving side.
const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startFakeQueueDaemon } = require('@wadeck-app/queue-sdk/testing');
const { EventPublisher } = require('../src/event-publisher');
const { EVENT_CATALOG, EVENT_SOURCE } = require('../src/event-catalog');
const { makeHarness, cronJob, settle, capturingPublisher, stopAll } = require('./helpers/event-harness');
const { startRealDaemon, commandsOf } = require('./helpers/event-scenarios');

const saved = {};
const queues = [];

beforeEach(() => {
  for (const k of ['QUEUE_SDK_OFF', 'QUEUE_CONFIG_DIR']) { saved[k] = process.env[k]; }
  // The preload of the suite switches the SDK off for every publisher the daemon code builds; these tests deliver.
  process.env.QUEUE_SDK_OFF = '0';
});
afterEach(async () => {
  for (const k of Object.keys(saved)) { if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; } }
  await stopAll();
});
after(async () => { for (const q of queues) { await q.close(); } });

async function newQueue(options) {
  const queue = await startFakeQueueDaemon(options);
  queues.push(queue);
  process.env.QUEUE_CONFIG_DIR = queue.configDir;
  return queue;
}

/** A scheduler wired like the daemon wires it (index.ts): the real publisher, a job's events carry the job's cwd. */
function wired(jobs, queue, options = {}) {
  const lines = [];
  const holder = {};
  const publisher = new EventPublisher('orchestrator', { write: (l) => lines.push(l) }, {
    cwd: path.resolve(os.tmpdir(), 'orch-delivery-config'),
    jobCwd: (id) => holder.h.registry.get(id)?.cwd,
  });
  const h = makeHarness(jobs, { ...options, scheduler: { ...options.scheduler, eventPublisher: publisher } });
  holder.h = h;
  return { h, publisher, lines, queue };
}

const pushedNames = (queue) => queue.pushes().map((p) => p.event);

describe('the order in which the queue receives the events', () => {
  // An agent that waits for job.completed must not see it before the job.started of the same run: the queue stores the
  // events in the order they arrive, so the publisher must not let a later push overtake an earlier one.
  test('events published one after the other arrive in that order, even in a burst', async () => {
    const queue = await newQueue();
    const publisher = new EventPublisher('orchestrator', { write: () => {} }, { cwd: path.resolve(os.tmpdir(), 'orch-delivery-config') });
    const published = [];
    for (let i = 0; i < 40; i++) {
      const event = i % 2 === 0 ? 'job.started' : 'job.completed';
      published.push(i);
      publisher.publish(event, { jobId: `j${i}`, label: 'x', seq: i });
    }
    await publisher.flush();
    assert.deepEqual(queue.pushes().map((p) => p.payload.seq), published);
  });
});

describe('the queue daemon receives the events of the scheduler', () => {
  test('a successful run: job.started then job.completed, with their payloads', async () => {
    const queue = await newQueue();
    const { h, publisher } = wired([cronJob()], queue, { exits: [0] });
    await h.sched.trigger('job');
    await settle();
    await publisher.flush();

    assert.deepEqual(pushedNames(queue), ['job.started', 'job.completed']);
    const [started, completed] = queue.pushes();
    assert.deepEqual(started.payload, { jobId: 'job', label: 'Job', pid: null, trigger: 'manual' });
    assert.equal(completed.payload.jobId, 'job');
    assert.equal(completed.payload.exitCode, 0);
  });

  test('a failed run, a refused firing and a stopped run each reach the queue once', async () => {
    const queue = await newQueue();
    const { h, publisher } = wired([cronJob({ id: 'bad' }), cronJob({ id: 'busy', maxConcurrency: 1 })], queue, { exits: [1, undefined] });
    await h.sched.trigger('bad');
    await settle();
    await h.sched.trigger('busy');
    await h.sched.trigger('busy');
    await h.sched.killJob('busy');
    await settle();
    await publisher.flush();

    const byJob = (id) => queue.pushes().filter((p) => p.payload.jobId === id).map((p) => p.event);
    assert.deepEqual(byJob('bad'), ['job.started', 'job.failed']);
    assert.deepEqual(byJob('busy'), ['job.started', 'job.skipped', 'job.killed_manual']);
  });

  test('a job with its own cwd is pushed with that cwd (so its project subscribers match), the others with the default one', async () => {
    const queue = await newQueue();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-delivery-project-'));
    const { h, publisher } = wired([cronJob({ id: 'own', cwd: projectDir }), cronJob({ id: 'plain' })], queue, { exits: [0] });
    await h.sched.trigger('own');
    await h.sched.trigger('plain');
    await settle();
    await publisher.flush();

    const cwdOf = (id) => [...new Set(queue.pushes().filter((p) => p.payload.jobId === id).map((p) => path.normalize(p.cwd)))];
    assert.deepEqual(cwdOf('own'), [path.normalize(projectDir)]);
    assert.deepEqual(cwdOf('plain'), [path.normalize(path.resolve(os.tmpdir(), 'orch-delivery-config'))]);
    for (const p of queue.pushes()) { assert.ok(path.isAbsolute(p.cwd), p.cwd); }
  });

  test('a request through the daemon commands (trigger then kill) reaches the queue in order', async () => {
    const queue = await newQueue();
    const { h, publisher } = wired([cronJob()], queue, { exits: [undefined] });
    const commands = commandsOf(h, { events: publisher });
    await commands['trigger-job']({ id: 'job', ip: '127.0.0.1', userAgent: 'orch-cli' });
    await commands['kill-job']({ id: 'job', ip: '127.0.0.1', userAgent: 'orch-cli' });
    await settle();
    await publisher.flush();

    assert.deepEqual(pushedNames(queue), ['job.triggered_manual', 'job.started', 'job.kill_requested', 'job.killed_manual']);
    assert.equal(queue.pushes()[2].payload.ip, '127.0.0.1');
  });

  test('every pushed payload validates against the schema the catalog declares for it', async () => {
    const queue = await newQueue();
    const { h, publisher } = wired([cronJob({ timeoutSeconds: 5, retryOnExitCodes: [9], retryDelays: [1] })], queue, { exits: [undefined, 9] });
    await h.sched.trigger('job');
    h.children[0].killExitCode = 9;
    await h.time.advanceAsync(5000, 1000);
    await settle();
    await h.time.advanceAsync(1000, 500);
    await settle();
    await publisher.flush();

    const checker = capturingPublisher();
    for (const p of queue.pushes()) { checker.publisher.publish(p.event, p.payload); }
    assert.deepEqual(
      [...pushedNames(queue)].sort(),
      ['alert.retry_exhausted', 'job.failed', 'job.failed', 'job.started', 'job.started', 'job.timed_out'],
    );
    assert.deepEqual(checker.problems, []);
  });

});

describe('the declaration of the events', () => {
  test('registrations() holds the source and exactly the catalog, entry for entry', async () => {
    const queue = await newQueue();
    const publisher = new EventPublisher('orchestrator', { write: () => {} }, { cwd: path.resolve(os.tmpdir(), 'orch-delivery-config') });
    await publisher.declareEvents(EVENT_SOURCE, EVENT_CATALOG);
    const registrations = queue.registrations();
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].source, 'orchestrator');
    assert.deepEqual(registrations[0].events, JSON.parse(JSON.stringify(EVENT_CATALOG)));
    assert.equal(EVENT_CATALOG.length, 24);
  });
});

describe('the real daemon process', () => {
  async function started(queue, options) {
    const run = await startRealDaemon({ queue, ...options });
    await Promise.race([run.ready, run.exited]);
    return run;
  }

  test('pushes daemon.started once (pid and version of the process), declares the catalog, both with the config dir as cwd', async () => {
    const queue = await newQueue();
    const run = await started(queue);
    assert.equal(run.child.exitCode, null, `daemon output:\n${run.output()}`);
    await run.quit();

    const pushed = queue.pushes().filter((p) => p.event === 'daemon.started');
    assert.equal(pushed.length, 1, `daemon output:\n${run.output()}`);
    assert.equal(pushed[0].payload.pid, run.child.pid);
    assert.equal(pushed[0].payload.version, require('../package.json').version);
    assert.equal(path.normalize(pushed[0].cwd), path.normalize(run.dir));
    assert.equal(queue.registrations().length, 1);
    assert.deepEqual(queue.registrations()[0].events, JSON.parse(JSON.stringify(EVENT_CATALOG)));
  });

  test('daemon.started means it is serving: it comes after the daemon ready line, never from a daemon that failed to start', async () => {
    const queue = await newQueue();
    // A directory where the port file must be written: the daemon cannot publish its port, so it cannot serve.
    const run = await started(queue, { beforeStart: (dir) => fs.mkdirSync(path.join(dir, 'config.port'), { recursive: true }) });
    const code = await run.exited;

    assert.notEqual(code, 0, `the daemon should have failed to start; it said:\n${run.output()}`);
    assert.match(run.output(), /fatal/);
    assert.equal(queue.pushes().filter((p) => p.event === 'daemon.started').length, 0, 'a daemon that never served announced itself');
  });

  // The kit's design, not a defect: a daemon that starts on a config dir where one already lives asks it to quit (POST /quit),
  // waits for its port to close, and takes over. Two daemons are never left serving the same config dir.
  test('a second daemon on the same config dir takes over: the first one is asked to quit and exits, each announces itself once', async () => {
    const queue = await newQueue();
    const first = await started(queue);
    assert.equal(first.child.exitCode, null, first.output());

    const second = await started(queue, { dir: first.dir });
    assert.equal(second.child.exitCode, null, second.output());
    assert.notEqual(await first.exited, null, 'the first daemon was told to quit by the second');
    await second.quit();

    const pids = queue.pushes().filter((p) => p.event === 'daemon.started').map((p) => p.payload.pid).sort();
    assert.deepEqual(pids, [first.child.pid, second.child.pid].sort());
    assert.equal(queue.pushes().filter((p) => p.event === 'daemon.restarted').length, 0, 'a takeover is not an `orch restart`');
  });
});
