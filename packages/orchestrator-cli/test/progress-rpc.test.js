'use strict';

// get-progress: the daemon RPC. One estimate per job with an open run, nothing for the others.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-progress-'));
  tmpDirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  const commands = makeCommands(registry, state, {}, dir);
  return { dir, registry, state, commands };
}

function addJob(registry, id, extra = {}) {
  registry.add({ id, type: 'cron', command: 'echo', schedule: '0 * * * *', ...extra });
}

function recordRuns(state, id, n, durationSec) {
  for (let i = 0; i < n; i++) {
    const start = Date.now() - (i + 2) * 3_600_000;
    state.record(id, {
      startedAt: new Date(start).toISOString(),
      finishedAt: new Date(start + durationSec * 1000).toISOString(),
      exitCode: 0, pid: 1,
    });
  }
}

describe('get-progress', () => {
  test('answers for a running job, and only for it', () => {
    const { registry, state, commands } = makeEnv();
    addJob(registry, 'run');
    addJob(registry, 'idle');
    recordRuns(state, 'run', 5, 600);
    recordRuns(state, 'idle', 5, 600);
    state.record('run', { startedAt: new Date(Date.now() - 300_000).toISOString(), exitCode: null, pid: 7 });

    const reply = commands['get-progress']();

    assert.deepEqual(Object.keys(reply), ['run']);
    assert.equal(reply.run.strategyId, 'history');
    assert.ok(Math.abs(reply.run.progress - 0.5) < 0.02, `progress ${reply.run.progress}`);
    assert.ok(Date.parse(reply.run.etaAt) > Date.now());
    assert.ok(!Number.isNaN(Date.parse(reply.run.serverNow)));
  });

  test('a running job with too little history says why', () => {
    const { registry, state, commands } = makeEnv();
    addJob(registry, 'new');
    state.record('new', { startedAt: new Date().toISOString(), exitCode: null, pid: 7 });

    const reply = commands['get-progress']({ jobIds: ['new'] });

    assert.equal(reply.new.progress, null);
    assert.match(reply.new.reason, /needs 3 usable runs, has 0/);
  });

  test('jobIds restricts the answer', () => {
    const { registry, state, commands } = makeEnv();
    for (const id of ['a', 'b']) {
      addJob(registry, id);
      state.record(id, { startedAt: new Date().toISOString(), exitCode: null, pid: 7 });
    }
    assert.deepEqual(Object.keys(commands['get-progress']({ jobIds: ['b'] })), ['b']);
  });

  test('an unknown job id is refused with the way to list them', () => {
    const { commands } = makeEnv();
    assert.throws(() => commands['get-progress']({ jobIds: ['ghost'] }), /Job not found: "ghost".*orch list/);
  });

  test('a malformed payload is refused, not ignored', () => {
    const { commands } = makeEnv();
    assert.throws(() => commands['get-progress']({ jobIds: 'a' }), /jobIds must be an array/);
    assert.throws(() => commands['get-progress']({ jobIds: ['../x'] }), /not a valid job id/);
  });

  test('a long-running job has no progress, with the reason', () => {
    const { registry, state, commands } = makeEnv();
    addJob(registry, 'svc', { timeoutSeconds: 0 });
    state.record('svc', { startedAt: new Date().toISOString(), exitCode: null, pid: 7 });
    assert.match(commands['get-progress']().svc.reason, /no completion expected \(no timeout\)/);
  });

  test('answers from the state on disk after a daemon restart', () => {
    const { dir, registry, state, commands } = makeEnv();
    addJob(registry, 'run');
    recordRuns(state, 'run', 5, 600);
    state.record('run', { startedAt: new Date(Date.now() - 300_000).toISOString(), exitCode: null, pid: 7 });
    state.flushNow();
    assert.ok(commands['get-progress']().run.progress > 0);

    const reborn = makeCommands(new Registry(path.join(dir, 'registry.json')), new State(path.join(dir, 'state.json')), {}, dir);
    assert.ok(Math.abs(reborn['get-progress']().run.progress - 0.5) < 0.02);
  });
});
