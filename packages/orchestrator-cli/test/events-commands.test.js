'use strict';

// The events that announce a REQUEST (`orch trigger`, `orch kill`, `orch restart-job`, `orch restart`), driven through the
// real command handlers of the daemon (commands.ts) over a real Scheduler. A request is not a run: it never ends one, so
// each test also says which terminal event the run it causes ends with.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { assertNoProblems, makeHarness, cronJob, settle } = require('./helpers/event-harness');
const { S, commandsOf, ASKER } = require('./helpers/event-scenarios');

afterEach(assertNoProblems);

describe('job.triggered_manual', () => {
  test('is published per request, before the run starts, with who asked', async () => {
    const h = await S.commandTrigger();
    assert.deepEqual(h.names(), ['job.triggered_manual', 'job.started', 'job.completed']);
    assert.deepEqual(h.of('job.triggered_manual')[0].payload, { jobId: 'job', label: 'Job', ...ASKER });
    assert.equal(h.of('job.started')[0].payload.trigger, 'manual');
    assert.equal(h.terminals().length, 1, 'the request itself ends nothing');
  });

  test('carries null (not nothing) for a caller that did not say who it is', async () => {
    const h = makeHarness([cronJob()], { exits: [0] });
    await commandsOf(h)['trigger-job']({ id: 'job' });
    await settle();
    assert.deepEqual(h.of('job.triggered_manual')[0].payload, { jobId: 'job', label: 'Job', ip: null, userAgent: null });
  });

  test('a request refused by maxConcurrency is still announced, then ends with job.skipped and starts nothing', async () => {
    const h = await S.commandTriggerRefused();
    assert.deepEqual(h.names(), ['job.triggered_manual', 'job.started', 'job.triggered_manual', 'job.skipped']);
    assert.equal(h.replies[1].status, 'already-running');
    assert.equal(h.of('job.skipped')[0].payload.reason, 'concurrency');
  });

  test('force starts another run next to the first: the request, then a second job.started', async () => {
    const h = makeHarness([cronJob({ maxConcurrency: 1 })], { exits: [undefined] });
    const commands = commandsOf(h);
    await commands['trigger-job']({ id: 'job' });
    await commands['trigger-job']({ id: 'job', force: true });
    assert.deepEqual(h.names(), ['job.triggered_manual', 'job.started', 'job.triggered_manual', 'job.started']);
  });

  test('a request for an unknown job, or with an unusable id, is refused with what to do and publishes nothing', async () => {
    const h = makeHarness([cronJob()], { exits: [0] });
    const commands = commandsOf(h);
    await assert.rejects(async () => commands['trigger-job']({ id: 'nope' }), /Job not found: "nope".*orch list/);
    await assert.rejects(async () => commands['trigger-job']({ id: '../etc' }), /letters, digits and "-".*orch list/);
    await assert.rejects(async () => commands['trigger-job']({}), /letters, digits and "-"/);
    assert.deepEqual(h.events, []);
  });

  test('is not published for a run nobody asked for (schedule, retry, dependency)', async () => {
    const h = await S.retryExhausted();
    const dep = await S.dependencyRefusal();
    assert.deepEqual(h.of('job.triggered_manual'), []);
    // The dependency scenario triggers by the scheduler directly, then the parent ends: nothing came from a request.
    assert.deepEqual(dep.of('job.triggered_manual'), []);
  });
});

describe('job.kill_requested', () => {
  test('is published per request, before the stopped run ends with job.killed_manual; it is not that end', async () => {
    const h = await S.commandKill();
    assert.deepEqual(h.names(), ['job.triggered_manual', 'job.started', 'job.kill_requested', 'job.killed_manual']);
    assert.deepEqual(h.of('job.kill_requested')[0].payload, { jobId: 'job', label: 'Job', ...ASKER });
    assert.deepEqual(h.reply, { killed: true, count: 1 });
    assert.equal(h.terminals().length, 1);
  });

  test('a request with nothing running is still published, and no terminal event follows', async () => {
    const h = await S.commandKillIdle();
    assert.deepEqual(h.names(), ['job.kill_requested']);
    assert.deepEqual(h.reply, { killed: false, count: 0 });
    assert.deepEqual(h.terminals(), []);
  });

  test('a request for a job that does not exist is announced under its id, and kills nothing', async () => {
    const h = makeHarness([cronJob()], { exits: [0] });
    const reply = await commandsOf(h)['kill-job']({ id: 'ghost' });
    assert.deepEqual(reply, { killed: false, count: 0 });
    assert.deepEqual(h.of('job.kill_requested')[0].payload, { jobId: 'ghost', label: 'ghost', ip: null, userAgent: null });
  });

  test('a request without a job id is refused with what to do, and publishes nothing', async () => {
    const h = makeHarness([cronJob()], { exits: [0] });
    const commands = commandsOf(h);
    await assert.rejects(async () => commands['kill-job']({}), /kill-job needs a job id.*orch list/s);
    await assert.rejects(async () => commands['kill-job'](undefined), /kill-job needs a job id/);
    assert.deepEqual(h.events, []);
  });

  test('the stop half of a timeout or a resource kill is NOT announced as a request', async () => {
    const h = await S.timeout(143);
    assert.deepEqual(h.of('job.kill_requested'), []);
  });
});

describe('job.restarted', () => {
  test('a running job: its run ends with job.killed_manual, a new one starts, then the restart is announced once', async () => {
    const h = await S.commandRestartRunning();
    const after = h.names().slice(h.mark);
    assert.deepEqual(after, ['job.killed_manual', 'job.started', 'job.restarted']);
    assert.deepEqual(h.of('job.restarted')[0].payload, {
      jobId: 'job', label: 'Job', wasRunning: true, killed: 1, started: true, ...ASKER,
    });
    assert.equal(h.of('job.started')[1].payload.trigger, 'manual');
    assert.equal(h.of('job.kill_requested').length, 0, 'a restart is its own request');
    assert.equal(h.sched.runningCount('job'), 1, 'one copy runs, not two');
  });

  test('a job that was not running is started, and the announcement says so', async () => {
    const h = await S.commandRestartIdle();
    assert.deepEqual(h.names(), ['job.started', 'job.restarted']);
    const { payload } = h.of('job.restarted')[0];
    assert.equal(payload.wasRunning, false);
    assert.equal(payload.killed, 0);
    assert.equal(payload.started, true);
  });

  test('when the new run is refused (liveness still answers), the old run ended and the restart says started: false', async () => {
    const h = makeHarness([cronJob()], { exits: [undefined], scheduler: { restartGraceMs: 2000 } });
    const commands = commandsOf(h);
    await commands['trigger-job']({ id: 'job' });
    h.sched._liveness = async () => true;
    const reply = await commands['restart-job']({ id: 'job' });
    await settle();
    assert.equal(reply.started, false);
    assert.deepEqual(h.names().slice(2), ['job.killed_manual', 'job.restarted']);
    assert.equal(h.of('job.restarted')[0].payload.started, false);
    assert.equal(h.of('job.started').length, 1, 'no second copy was started');
  });

  test('a disabled job, a spent one-shot job, an unknown one and a bad id are refused with what to do, and publish nothing', async () => {
    const h = makeHarness([cronJob({ enabled: false }), cronJob({ id: 'once-done', type: 'once', schedule: undefined, delayMs: 1000, scheduledAt: new Date(Date.now() - 60_000).toISOString(), spent: true })], { exits: [0] });
    const commands = commandsOf(h);
    await assert.rejects(async () => commands['restart-job']({ id: 'job' }), /disabled.*orch enable job/);
    await assert.rejects(async () => commands['restart-job']({ id: 'once-done' }), /already ran.*orch trigger once-done/);
    await assert.rejects(async () => commands['restart-job']({ id: 'nope' }), /Job not found.*orch list/);
    await assert.rejects(async () => commands['restart-job']({ id: '' }), /letters, digits and "-"/);
    assert.deepEqual(h.events, []);
  });
});

describe('daemon.restarted', () => {
  test('is published once per `orch restart` with the pid of the daemon that is about to exit, and the restart is handed to the tray', async () => {
    const h = await S.daemonRestart();
    assert.deepEqual(h.names(), ['daemon.restarted']);
    assert.deepEqual(h.events[0].payload, { pid: process.pid });
    assert.equal(h.trayCalls, 1);
  });

  test('is not published by the restart of a job', async () => {
    const h = await S.commandRestartRunning();
    assert.deepEqual(h.of('daemon.restarted'), []);
  });
});
