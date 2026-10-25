'use strict';

// A child process of the daemon must not be able to kill the daemon.
//
// A ChildProcess emits 'error' when it could not be spawned (EAGAIN, EMFILE, EACCES, ENOENT) or could not be signalled,
// and each of its three pipes emits 'error' when the child goes away (EPIPE, ECONNRESET). An 'error' event with no
// listener is thrown from emit(): an uncaughtException, which is fatal in the daemon. Seen on 2026-10-25 with the tray;
// the same holds for every other child the daemon starts. Each is driven with the error and must not throw.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { ExecManager } = require('../src/exec-manager');
const { DashboardManager } = require('../src/dashboard-manager');
const { FakeTime } = require('../src/time-service');

const FAKE_PID = 2 ** 22 + 9;
const dirs = [];
afterEach(() => {
  while (dirs.length > 0) {
    try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-child-pipes-'));
  dirs.push(dir);
  return dir;
}

function errno(code, message) {
  return Object.assign(new Error(message ?? code), { code });
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = FAKE_PID;
  child.killed = false;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; return true; };
  return child;
}

const JOB = {
  id: 'j', type: 'startup', delaySeconds: 0, command: 'node script.js', timeoutSeconds: 30,
  enabled: true, triggerMode: 'fire-and-forget', liveness: null,
};

function schedulerWith(child) {
  const dir = tmpDir();
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(JOB);
  const sched = new Scheduler(registry, state, {
    configDir: dir, time: new FakeTime(Date.now()), spawn: () => child, liveness: async () => false, sampleUsage: async () => null,
    killTreeSync: () => {}, killTree: async () => {},
  });
  return { sched, dir };
}

function jobLog(dir) {
  const logDir = path.join(dir, 'logs', 'jobs', 'j');
  return fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
}

describe('a job the scheduler runs', () => {
  test('a spawn failure (the child emits error) does not throw, and the run records why', async () => {
    const child = fakeChild();
    const { sched, dir } = schedulerWith(child);
    await sched._fire(JOB);
    assert.doesNotThrow(() => child.emit('error', errno('EAGAIN', 'spawn EAGAIN')));
    assert.match(jobLog(dir), /\[error\].*EAGAIN/, 'the failure is in the run log, where the reader looks');
    // Node follows a failed spawn with close and a negative errno: the run still ends.
    child.emit('close', -11);
  });

  for (const stream of ['stdout', 'stderr']) {
    test(`an EPIPE on the job's ${stream} does not throw`, async () => {
      const child = fakeChild();
      const { sched } = schedulerWith(child);
      await sched._fire(JOB);
      assert.doesNotThrow(() => child[stream].emit('error', errno('EPIPE', 'read EPIPE')));
      child.emit('close', 0);
    });
  }
});

describe('an orch exec run', () => {
  function execWith(child) {
    const dir = tmpDir();
    const events = { publish() {} };
    const mgr = new ExecManager(dir, events, { spawn: () => child, time: new FakeTime(Date.now()) });
    return { mgr, dir };
  }

  test('a spawn failure does not throw, and the run is reported failed with the reason', () => {
    const child = fakeChild();
    const { mgr } = execWith(child);
    const { runId } = mgr.fireExec('echo hi', {});
    assert.doesNotThrow(() => child.emit('error', errno('EMFILE', 'spawn EMFILE')));
    child.emit('close', -24);
    const run = mgr.get(runId);
    assert.equal(run.status, 'failed');
    assert.ok(run.logs.some((l) => /EMFILE/.test(l)), run.logs.join(' | '));
  });

  for (const stream of ['stdout', 'stderr']) {
    test(`an EPIPE on the run's ${stream} does not throw`, () => {
      const child = fakeChild();
      const { mgr } = execWith(child);
      mgr.fireExec('echo hi', {});
      assert.doesNotThrow(() => child[stream].emit('error', errno('EPIPE')));
      child.emit('close', 0);
    });
  }
});

describe('the dashboard server child', () => {
  // The child is the real one (node running a script that stays up); only its streams get the errors.
  test('an EPIPE on its stdout or stderr does not throw', async () => {
    const dir = tmpDir();
    const script = path.join(dir, 'server.js');
    fs.writeFileSync(script, 'console.log(JSON.stringify({type:"ready",port:1})); setInterval(()=>{}, 1000);');
    const logs = [];
    const mgr = new DashboardManager(dir, script, (line) => logs.push(line));
    try {
      await mgr.start();
      const child = mgr._proc;
      assert.doesNotThrow(() => child.stdout.emit('error', errno('EPIPE')));
      assert.doesNotThrow(() => child.stderr.emit('error', errno('ECONNRESET')));
    } finally {
      await mgr.stop();
    }
  });
});
