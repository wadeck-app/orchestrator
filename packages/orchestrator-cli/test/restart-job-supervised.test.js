'use strict';

// restart-job end to end, with the real supervisor binary: the kill goes through the supervisor's kill file, the
// old process must be really gone before the new one starts, and a run followed again after a daemon restart is
// restarted the same way.
const { test, describe, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { makeCommands } = require('../src/commands');
const { findSupervisorBinary } = require('../src/platform-binary');
const { startSupervised } = require('../src/supervised-run');
const { endLeftoverRuns, withPidFile } = require('./helpers/end-leftover-runs');

const supervisorPath = findSupervisorBinary();
if (supervisorPath === null) {
  throw new Error(
    'No supervisor binary for this platform. Build it with: npm run build-supervisor --workspace=packages/orchestrator-cli '
    + '(needs Go). This test does not skip: a skipped test would report a green run that exercised nothing.',
  );
}

const schedulers = [];
const dirs = [];
afterEach(async () => {
  while (schedulers.length > 0) {
    const s = schedulers.pop();
    try { s.detachRuns(); } catch { /* already detached */ }
    await s.stop();
  }
});
after(async () => { await endLeftoverRuns(dirs); });

function longRunningJob(dir) {
  dirs.push(dir);
  const file = path.join(dir, 'server.js');
  fs.writeFileSync(file, withPidFile('setInterval(() => {}, 1000)'));
  return { id: 'srv', type: 'startup', label: 'Server', enabled: true, triggerMode: 'fire-and-forget', timeoutSeconds: 0, command: `node "${file}"` };
}

/** One "daemon": a state, a scheduler and the commands over the shared config dir. */
function daemon(dir, job) {
  const registry = new Registry(path.join(dir, 'registry.json'));
  registry.load();
  if (registry.get(job.id) === null) {
    registry.add(job);
  }
  const state = new State(path.join(dir, 'state.json'));
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    liveness: async () => false,
    sampleUsage: async () => null,
    eventPublisher: { publish: () => {} },
    supervisor: (request) => startSupervised({ supervisorPath, configDir: dir, heartbeatMs: 50, pollMs: 25 }, request),
    catchUpInitialDelayMs: 3_600_000,
  });
  schedulers.push(sched);
  const logged = [];
  const audit = { log: (event, payload) => logged.push({ event, payload }), readLast: () => [] };
  return { sched, state, logged, commands: makeCommands(registry, state, sched, dir, undefined, audit) };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(what, predicate, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-restart-sup-'));
  dirs.push(dir);
  return dir;
}

describe('restart-job on a supervised run', () => {
  test('ends the old process for good, starts a new one with another pid, and records the old run as a manual kill', async () => {
    const dir = tmpDir();
    const d = daemon(dir, longRunningJob(dir));
    const { pid: oldPid } = await d.sched.trigger('srv');

    const reply = await d.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.started, true, JSON.stringify(reply));
    assert.equal(reply.wasRunning, true);
    assert.equal(reply.killed, 1);
    assert.equal(typeof reply.pid, 'number');
    assert.notEqual(reply.pid, oldPid);
    // The reply is only sent once the old instance is registered as gone, so its process must not linger.
    await until('the old process to be gone', () => !isAlive(oldPid));
    assert.equal(isAlive(reply.pid), true, 'the new instance is running');
    assert.equal(d.sched.runningCount('srv'), 1);
    const history = [...d.state.getAll().srv].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    assert.equal(history.length, 2);
    assert.equal(history[0].cancelledByUser, true);
    assert.equal(history[1].pid, reply.pid);
    assert.equal(history[1].finishedAt, undefined);
    assert.equal(d.logged.filter((l) => l.event === 'job.restarted').length, 1);

    await d.sched.killJob('srv');
  });
});

describe('restart-job on a run found again after a daemon restart', () => {
  test('ends the followed run and starts a new one', async () => {
    const dir = tmpDir();
    const job = longRunningJob(dir);
    const a = daemon(dir, job);
    const { pid: oldPid } = await a.sched.trigger('srv');
    a.state.flushNow();
    a.sched.detachRuns();
    await a.sched.stop();
    const b = daemon(dir, job);
    const report = await b.sched.recoverRuns();
    assert.equal(report.adopted, 1);

    const reply = await b.commands['restart-job']({ id: 'srv' });

    assert.equal(reply.started, true, JSON.stringify(reply));
    assert.equal(reply.wasRunning, true);
    assert.equal(reply.killed, 1);
    assert.notEqual(reply.pid, oldPid);
    await until('the old process to be gone', () => !isAlive(oldPid));
    assert.equal(isAlive(reply.pid), true);
    assert.equal(b.sched.runningCount('srv'), 1);

    await b.sched.killJob('srv');
  });
});
