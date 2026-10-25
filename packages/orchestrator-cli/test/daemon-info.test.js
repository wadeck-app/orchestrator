'use strict';

// get-daemon-info: what the dashboard shows about the daemon itself. Field shapes, the unsupervised case, and the
// promise that nothing a job holds (environment, secrets, command line) travels in the reply.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { resolveSupervisor } = require('../src/supervised-run');
const { summarizeTimers } = require('../src/scheduler');

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const CONFIG = {
  supervisedJobs: true, lateActionWindowMinutes: 30, autoUpdate: true, appCore: true,
  catchUpInitialDelaySeconds: 300, catchUpStaggerSeconds: 300,
};

function timer(jobId, over = {}) {
  return {
    jobId, type: 'cron', enabled: true, armed: 'cron', dueAt: null, windowEndsAt: null,
    nextFiring: null, windowState: null, spent: false, problem: null, ...over,
  };
}

function makeEnv({ timers = [], supervisor, info = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-info-'));
  tmpDirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  const scheduler = {
    inspectTimers: () => timers,
    runCounts: () => ({ running: 3, supervised: 2, followedAgain: 1 }),
  };
  const commands = makeCommands(registry, state, scheduler, dir, undefined, undefined, undefined, undefined, {
    version: '9.9.9',
    port: () => 47900,
    startedAt: new Date(Date.now() - 125_000),
    config: CONFIG,
    supervisor: supervisor ?? { requested: true, active: true },
    ...info,
  });
  return { commands, registry };
}

describe('get-daemon-info', () => {
  test('has the documented shape', () => {
    const { commands } = makeEnv({ timers: [timer('a'), timer('b')] });

    const reply = commands['get-daemon-info']();

    assert.equal(reply.version, '9.9.9');
    assert.equal(reply.pid, process.pid);
    assert.equal(reply.port, 47900);
    assert.ok(!Number.isNaN(Date.parse(reply.startedAt)), 'startedAt is an ISO date');
    assert.equal(new Date(reply.startedAt).toISOString(), reply.startedAt);
    assert.ok(reply.uptimeSeconds >= 125 && reply.uptimeSeconds < 135, `uptimeSeconds ${reply.uptimeSeconds}`);
    assert.deepEqual(reply.config, CONFIG);
    assert.deepEqual(reply.supervisor, { requested: true, active: true });
    assert.deepEqual(reply.runs, { running: 3, supervised: 2, followedAgain: 1 });
    assert.deepEqual(reply.scheduler, { armed: 2, desired: 2, problems: [] });
  });

  test('reports a daemon whose supervisor was asked for and is missing, with the note', () => {
    const { requested, active, note } = resolveSupervisor({
      enabled: true, configDir: '/x', locate: () => null, log: () => {},
    }).status;
    const { commands } = makeEnv({ supervisor: { requested, active, note } });

    const reply = commands['get-daemon-info']();

    assert.equal(reply.supervisor.requested, true);
    assert.equal(reply.supervisor.active, false);
    assert.match(reply.supervisor.note, new RegExp(process.platform));
    assert.match(reply.supervisor.note, /supervisedJobs: false/);
  });

  test('the missing-supervisor note says jobs die on stop, restart and update, and that supervisedJobs: false only hides the message', () => {
    const { note } = resolveSupervisor({ enabled: true, configDir: '/x', locate: () => null, log: () => {} }).status;

    assert.match(note, /killed with the daemon on orch stop, orch restart and orch cli update/);
    assert.match(note, /supervisedJobs: false/);
    assert.match(note, /only hides this message/);
  });

  test('reports the unsupervised case as off, without a note', () => {
    const { status } = resolveSupervisor({
      enabled: false, configDir: '/x', locate: () => { throw new Error('must not be looked for'); }, log: () => {},
    });
    assert.deepEqual(status, { requested: false, active: false });

    const { commands } = makeEnv({ supervisor: status });
    assert.deepEqual(commands['get-daemon-info']().supervisor, { requested: false, active: false });
  });

  test('says the same thing in the note as in the daemon log', () => {
    const lines = [];
    const { status } = resolveSupervisor({ enabled: true, configDir: '/x', locate: () => null, log: (l) => lines.push(l) });

    assert.equal(lines.length, 1);
    assert.equal(status.note, lines[0]);
  });

  test('counts only timers that should be armed, and lists the problems with their job ids', () => {
    const { commands } = makeEnv({
      timers: [
        timer('ok'),
        timer('broken', { armed: null, problem: 'enabled but NOTHING is armed for it' }),
        timer('off', { enabled: false, armed: null }),
        timer('spent', { type: 'once', armed: null, spent: true }),
        timer('boot', { type: 'startup', armed: null }),
        timer('over', { armed: null, windowState: 'expired', problem: 'its active period has ended' }),
      ],
    });

    const { scheduler } = commands['get-daemon-info']();

    assert.deepEqual(scheduler, {
      armed: 1,
      desired: 2,
      problems: [
        { jobId: 'broken', problem: 'enabled but NOTHING is armed for it' },
        { jobId: 'over', problem: 'its active period has ended' },
      ],
    });
  });

  test('summarizeTimers is what list-timers data reduces to', () => {
    assert.deepEqual(summarizeTimers([]), { armed: 0, desired: 0, problems: [] });
  });

  test('carries nothing a job holds: no environment, secret, or command line', () => {
    const { commands, registry } = makeEnv({ timers: [timer('leaky')] });
    registry.add({
      id: 'leaky', type: 'cron', schedule: '0 9 * * *', label: 'Leaky',
      command: 'node deploy.js --token=CMD-TOKEN-4711',
      env: { API_KEY: 'ENV-SECRET-8123' },
    });
    commands['set-secret']({ name: 'DB_PASSWORD', value: 'STORED-SECRET-5521' });

    const text = JSON.stringify(commands['get-daemon-info']());

    for (const forbidden of ['ENV-SECRET-8123', 'CMD-TOKEN-4711', 'STORED-SECRET-5521', 'API_KEY', 'DB_PASSWORD', 'deploy.js']) {
      assert.ok(!text.includes(forbidden), `the reply must not contain ${forbidden}`);
    }
  });

  test('uptimeSeconds is 0, never negative, when the start time is in the future (a clock that moved back)', () => {
    const future = new Date(Date.now() + 3_600_000);
    const { commands } = makeEnv({ info: { startedAt: future } });

    const reply = commands['get-daemon-info']();

    assert.equal(reply.uptimeSeconds, 0);
    assert.equal(reply.startedAt, future.toISOString(), 'the start time itself is reported as it is');
  });

  test('a key added to the source config does not leak into config: only the documented ones travel', () => {
    const { commands } = makeEnv({ info: { config: { ...CONFIG, apiToken: 'TOKEN-IN-CONFIG-9931', somethingNew: 7 } } });

    const reply = commands['get-daemon-info']();

    assert.deepEqual(reply.config, CONFIG);
    assert.ok(!JSON.stringify(reply).includes('TOKEN-IN-CONFIG-9931'));
  });

  test('the port is asked at request time, not once at wiring: a daemon that moved reports where it is now', () => {
    let port = 47900;
    let asked = 0;
    const { commands } = makeEnv({ info: { port: () => { asked++; return port; } } });
    assert.equal(asked, 0, 'port() was evaluated while the commands were being built');

    assert.equal(commands['get-daemon-info']().port, 47900);
    port = 47911;
    assert.equal(commands['get-daemon-info']().port, 47911);
    assert.equal(asked, 2);
  });

  test('on the real scheduler: runs and scheduler come from it, and a manual job is not a timer that should exist', async () => {
    const { Scheduler } = require('../src/scheduler');
    const { FakeTime } = require('../src/time-service');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-info-real-'));
    tmpDirs.push(dir);
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state = new State(path.join(dir, 'state.json'));
    registry.add({ id: 'cron1', type: 'cron', schedule: '0 9 * * *', command: 'echo c', enabled: true, triggerMode: 'fire-and-forget' });
    registry.add({ id: 'man1', type: 'manual', command: 'echo m', enabled: true, triggerMode: 'fire-and-forget' });
    registry.add({ id: 'man2', type: 'manual', command: 'echo m', enabled: false, triggerMode: 'fire-and-forget' });
    const sched = new Scheduler(registry, state, {
      configDir: dir, time: new FakeTime(), liveness: async () => false, sampleUsage: async () => null, eventPublisher: { publish: () => {} },
    });
    const commands = makeCommands(registry, state, sched, dir, undefined, undefined, undefined, undefined, {
      version: '9.9.9', port: () => 47900, startedAt: new Date(), config: CONFIG, supervisor: { requested: false, active: false },
    });
    await sched.start();
    try {
      const reply = commands['get-daemon-info']();

      assert.deepEqual(reply.scheduler, { armed: 1, desired: 1, problems: [] });
      assert.deepEqual(reply.runs, { running: 0, supervised: 0, followedAgain: 0 });
    } finally {
      await sched.stop();
    }
  });

  test('fails loudly when the daemon was built without the source of this information', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-info-'));
    tmpDirs.push(dir);
    const commands = makeCommands(
      new Registry(path.join(dir, 'registry.json')), new State(path.join(dir, 'state.json')),
      { inspectTimers: () => [], runCounts: () => ({ running: 0, supervised: 0, followedAgain: 0 }) }, dir,
    );

    assert.throws(() => commands['get-daemon-info'](), /daemon info/i);
  });
});
