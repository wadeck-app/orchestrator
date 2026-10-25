'use strict';

// A scheduler test with a fake child (a pid that no process has) used to reach the REAL tree kill when the job timed out or
// was killed: taskkill /T /F /PID 4242 on Windows, pidtree(4242) then SIGTERM on every pid found on POSIX. Whatever process
// owns that pid on the machine running the tests is what gets killed, and on a CI runner a low number like 4242 or 12345 is
// a live pid (the runner's own processes and the test runner's ancestors live there), so a run can be killed from the inside
// ("Interrupted", exit 143). Traced on this suite: events-job-lifecycle-style timeouts sent `taskkill /T /F /PID 4242` and
// the killJob test sent `taskkill /T /F /PID 99999`.
//
// The scheduler takes the tree kill as an option (default: the real one), so a fake child gets a fake kill, and the test
// can say which pid the scheduler asked to end.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { FakeTime } = require('../src/time-service');

// A pid no system has (above the maximum of Linux, not a multiple of 4 on Windows): if the injected kill is ignored and the
// real one runs, it signals nobody.
const FAKE_PID = 2 ** 22 + 7;

const JOB = {
  id: 'j', type: 'startup', delaySeconds: 0, command: 'node script.js', timeoutSeconds: 30,
  enabled: true, triggerMode: 'fire-and-forget', liveness: null,
};

function fakeChild() {
  const child = new EventEmitter();
  child.pid = FAKE_PID;
  child.killed = false;
  child.stdout = null;
  child.stderr = null;
  child.kill = () => { child.killed = true; };
  return child;
}

function makeEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-kill-seam-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(JOB);
  const child = fakeChild();
  const time = new FakeTime();
  const killed = { sync: [], async: [] };
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    time,
    spawn: () => child,
    liveness: async () => false,
    sampleUsage: async () => null,
    killTreeSync: (pid) => { killed.sync.push(pid); },
    killTree: async (pid) => { killed.async.push(pid); },
    ...extra,
  });
  return { sched, child, time, killed };
}

describe('the scheduler ends a job through the tree kill it was given', () => {
  test('a job that times out: the pid goes to killTreeSync', async () => {
    const { sched, child, time, killed } = makeEnv();
    await sched._fire(JOB);

    time.advance(31_000);
    child.emit('close', 1);

    assert.deepEqual(killed.sync, [FAKE_PID]);
    assert.deepEqual(killed.async, []);
  });

  test('killJob: the pid goes to killTree, and the job is reported killed', async () => {
    const { sched, child, killed } = makeEnv();
    await sched._fire(JOB);

    const result = await sched.killJob('j');
    child.emit('close', 1);

    assert.deepEqual(result, { killed: true, count: 1 });
    assert.deepEqual(killed.async, [FAKE_PID]);
  });
});
