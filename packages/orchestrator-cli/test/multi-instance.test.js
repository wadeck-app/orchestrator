'use strict';

// A job can have several live instances (maxConcurrency above 1, or a forced trigger). Everything
// that used to assume one process per job has to answer for all of them: `orch kill` stopped only
// the newest, the first instance to end removed the others' registration, and the tray stopped
// showing a job as running as soon as any one of its instances finished.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { FakeTime }  = require('../src/time-service');

const JOB = {
  id: 'j', type: 'cron', schedule: '0 8 * * *', command: 'node -v',
  enabled: true, triggerMode: 'fire-and-forget', maxConcurrency: 3,
};

function makeEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-multi-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(JOB);
  const children = [];
  // One distinct millisecond per call: runs are keyed by startedAt, so two firings in the same
  // millisecond would be one run.
  let tick = Date.parse('2026-10-17T08:00:00.000Z');
  const sched = new Scheduler(registry, state, {
    spawn: () => {
      const child = new EventEmitter();
      // No pid on purpose: a made-up pid could belong to a real process, and killing the tree of one
      // is exactly what this suite must never do. Without a pid the scheduler calls child.kill().
      child.pid = undefined;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit('close', null));
        return true;
      };
      children.push(child);
      return child;
    },
    liveness: async () => false,
    sampleUsage: async () => null,
    configDir: dir,
    time: new FakeTime(),
    now: () => new Date(tick += 1000),
    eventPublisher: { publish: () => {} },
    ...extra,
  });
  return { sched, state, registry, children, dir };
}

const finish = (child, code = 0) => child.emit('close', code);
const settle = () => new Promise((r) => setImmediate(r));
const runLogs = (dir) => {
  const d = path.join(dir, 'logs', 'jobs', 'j');
  return fs.readdirSync(d).sort().map((f) => fs.readFileSync(path.join(d, f), 'utf8'));
};

async function startTwo(env) {
  await env.sched.trigger('j');
  await env.sched.trigger('j');
  assert.equal(env.children.length, 2);
}

describe('orch kill with several live instances', () => {
  test('stops every instance and says how many', async () => {
    const env = makeEnv();
    await startTwo(env);

    const result = await env.sched.killJob('j');
    await settle();

    assert.deepEqual(result, { killed: true, count: 2 });
    assert.equal(env.children[0].killed, true);
    assert.equal(env.children[1].killed, true);
  });

  test('records each killed run as a manual kill in its own history entry and log', async () => {
    const env = makeEnv();
    await startTwo(env);

    await env.sched.killJob('j');
    await settle();

    const history = env.state.getAll().j;
    assert.equal(history.length, 2);
    for (const entry of history) {
      assert.equal(entry.cancelledByUser, true, 'every killed run is marked cancelled');
      assert.ok(entry.finishedAt, 'every killed run is closed');
    }
    const logs = runLogs(env.dir);
    assert.equal(logs.length, 2);
    for (const log of logs) {
      assert.match(log, /reason=manual-kill/);
    }
  });

  test('an instance that ended on its own does not hide the one still running', async () => {
    const env = makeEnv();
    await startTwo(env);
    finish(env.children[0]);

    const result = await env.sched.killJob('j');
    await settle();

    assert.deepEqual(result, { killed: true, count: 1 });
    assert.equal(env.children[1].killed, true);
    assert.equal(env.children[0].killed, false, 'the finished instance is not killed again');
    const byStart = [...env.state.getAll().j].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    assert.equal(byStart[0].exitCode, 0, 'the run that ended by itself keeps its exit code');
    assert.equal(byStart[0].cancelledByUser, undefined);
    assert.equal(byStart[1].cancelledByUser, true);
  });

  test('a kill of one job leaves a normal exit of the other instances untouched', async () => {
    const env = makeEnv();
    await startTwo(env);

    await env.sched.killJob('j');
    await settle();
    // Nothing is left to kill, and asking again must not invent a kill.
    assert.deepEqual(await env.sched.killJob('j'), { killed: false, count: 0 });
  });

  test('a single instance behaves exactly as before', async () => {
    const env = makeEnv();
    await env.sched.trigger('j');

    const result = await env.sched.killJob('j');
    await settle();

    assert.deepEqual(result, { killed: true, count: 1 });
    const [entry] = env.state.getAll().j;
    assert.equal(entry.cancelledByUser, true);
    assert.equal(entry.exitCode, null);
  });

  test('nothing running answers killed:false', async () => {
    const env = makeEnv();

    assert.deepEqual(await env.sched.killJob('j'), { killed: false, count: 0 });
  });

  test('stale open entries with no process behind them are all closed', async () => {
    const env = makeEnv();
    env.state.record('j', { startedAt: '2026-10-17T07:00:00.000Z', exitCode: null, pid: null });
    env.state.record('j', { startedAt: '2026-10-17T07:30:00.000Z', exitCode: null, pid: null });

    const result = await env.sched.killJob('j');

    assert.deepEqual(result, { killed: true, count: 2 });
    for (const entry of env.state.getAll().j) {
      assert.ok(entry.finishedAt, 'every stale entry is closed, not only the newest');
    }
  });
});

describe('how many instances of a job are alive', () => {
  test('runningCount follows the instances as they start and end', async () => {
    const env = makeEnv();
    assert.equal(env.sched.runningCount('j'), 0);

    await startTwo(env);
    assert.equal(env.sched.runningCount('j'), 2);

    finish(env.children[0]);
    assert.equal(env.sched.runningCount('j'), 1);

    finish(env.children[1]);
    assert.equal(env.sched.runningCount('j'), 0);
  });
});

describe('State.getOpenRuns', () => {
  test('returns every run still open, whatever its position', () => {
    const { state } = makeEnv();
    state.record('j', { startedAt: '2026-10-17T07:00:00.000Z', exitCode: null, pid: 1 });
    state.record('j', { startedAt: '2026-10-17T07:10:00.000Z', exitCode: 0, pid: 2, finishedAt: '2026-10-17T07:11:00.000Z' });
    state.record('j', { startedAt: '2026-10-17T07:20:00.000Z', exitCode: null, pid: 3 });

    const open = state.getOpenRuns('j').map((e) => e.pid).sort();

    assert.deepEqual(open, [1, 3]);
  });

  test('a cancelled run (exitCode null, finishedAt set) is not open', () => {
    const { state } = makeEnv();
    state.record('j', { startedAt: '2026-10-17T07:00:00.000Z', exitCode: null, pid: 1, finishedAt: '2026-10-17T07:01:00.000Z', cancelledByUser: true });

    assert.deepEqual(state.getOpenRuns('j'), []);
  });

  test('an unknown job has none', () => {
    const { state } = makeEnv();

    assert.deepEqual(state.getOpenRuns('nope'), []);
  });
});

describe('what `orch kill` says', () => {
  const { runCli } = require('../src/cli');

  async function runKill(result) {
    const lines = [];
    const deps = {
      send: async (command) => (command === 'get-job' ? { id: 'j' } : result),
      startDaemon: async () => {},
      configDir: '/tmp/orch-test',
    };
    const origLog = console.log;
    console.log = (msg) => { lines.push(String(msg)); };
    try {
      await runCli(['kill', 'j'], deps);
    } finally {
      console.log = origLog;
    }
    return lines.join('\n');
  }

  test('one instance keeps the usual message', async () => {
    assert.equal(await runKill({ killed: true, count: 1 }), 'Job "j" killed.');
  });

  test('several instances say how many were stopped', async () => {
    assert.equal(await runKill({ killed: true, count: 3 }), 'Job "j" killed (3 instances).');
  });

  test('a daemon that does not report a count still gets the usual message', async () => {
    assert.equal(await runKill({ killed: true }), 'Job "j" killed.');
  });
});
