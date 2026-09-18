'use strict';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-scheduler-test-'));
}

function makeDeps(dir) {
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  return { registry, state };
}

function fakeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.pid = 12345;
  process.nextTick(() => child.emit('close', exitCode));
  return child;
}

const JOB_STARTUP_NOW = {
  id: 'svc-a',
  type: 'startup',
  delaySeconds: 0,
  command: 'echo hello',
  enabled: true,
  triggerMode: 'fire-and-forget',
  liveness: null,
};

const JOB_STARTUP_DELAYED = {
  id: 'svc-b',
  type: 'startup',
  delaySeconds: 60,
  command: 'echo delayed',
  enabled: true,
  triggerMode: 'fire-and-forget',
  liveness: null,
};

const JOB_STARTUP_DISABLED = {
  id: 'svc-c',
  type: 'startup',
  delaySeconds: 0,
  command: 'echo disabled',
  enabled: false,
  triggerMode: 'fire-and-forget',
  liveness: null,
};

const JOB_CRON = {
  id: 'cron-a',
  type: 'cron',
  schedule: '0 0 * * *',
  command: 'echo cron',
  enabled: true,
  triggerMode: 'fire-and-forget',
  missedFiring: 'skip',
  liveness: null,
};

// ---------------------------------------------------------------------------
// start() -- startup jobs
// ---------------------------------------------------------------------------

describe('start() -- startup jobs', () => {
  test('spawns enabled startup job with delaySeconds=0', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_NOW);

    let spawned = null;
    const spawn = (cmd, cwd) => { spawned = { cmd, cwd }; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.stop();

    assert.ok(spawned !== null, 'spawn should have been called');
    assert.equal(spawned.cmd, JOB_STARTUP_NOW.command);
  });

  test('does NOT spawn disabled startup job', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_DISABLED);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.stop();

    assert.equal(spawnCount, 0);
  });

  test('skips spawn when liveness returns true', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_NOW);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => true });
    await sched.start();
    await sched.stop();

    assert.equal(spawnCount, 0);
  });

  test('does NOT immediately spawn startup job with delaySeconds > 0', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_DELAYED);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    // Don't advance time -- timeout should not have fired
    await sched.stop(); // stop cancels the timeout

    assert.equal(spawnCount, 0);
  });
});

// ---------------------------------------------------------------------------
// _fire() -- state recording
// ---------------------------------------------------------------------------

describe('_fire() -- state recording', () => {
  test('records startedAt in state', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_NOW);

    const spawn = () => fakeChild(0);
    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });

    await sched._fire(JOB_STARTUP_NOW);
    // Give nextTick for fakeChild close event
    await new Promise(r => setImmediate(r));

    const s = state.get(JOB_STARTUP_NOW.id);
    assert.ok(s !== null, 'state should have entry');
    assert.ok(s.startedAt, 'startedAt should be set');
  });

  test('records exitCode in state after process exits', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_NOW);

    const spawn = () => fakeChild(42);
    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });

    await sched._fire(JOB_STARTUP_NOW);
    await new Promise(r => setTimeout(r, 20)); // let close event fire

    const s = state.get(JOB_STARTUP_NOW.id);
    assert.equal(s.exitCode, 42);
  });
});

// ---------------------------------------------------------------------------
// trigger()
// ---------------------------------------------------------------------------

describe('trigger()', () => {
  test('fires job regardless of enabled=false', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_DISABLED);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.trigger(JOB_STARTUP_DISABLED.id);
    await sched.stop();

    assert.equal(spawnCount, 1);
  });

  test('throws for unknown job id', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);

    const sched = new Scheduler(registry, state, { spawn: () => fakeChild(0), liveness: async () => false });
    await sched.start();
    await assert.rejects(() => sched.trigger('ghost'), /not found/i);
    await sched.stop();
  });
});

// ---------------------------------------------------------------------------
// stop() -- cancels pending timeouts
// ---------------------------------------------------------------------------

describe('stop()', () => {
  test('cancels pending delayed startup timeout before it fires', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_STARTUP_DELAYED);

    let spawnCount = 0;
    const spawn = () => { spawnCount++; return fakeChild(0); };

    const sched = new Scheduler(registry, state, { spawn, liveness: async () => false });
    await sched.start();
    await sched.stop(); // cancels the 60s timeout before it fires

    // If we wait a tick, the cancelled timeout should not fire
    await new Promise(r => setImmediate(r));
    assert.equal(spawnCount, 0);
  });
});

// ---------------------------------------------------------------------------
// cron -- basic scheduling
// ---------------------------------------------------------------------------

describe('cron jobs', () => {
  test('registers a cron task without crashing', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_CRON);

    const sched = new Scheduler(registry, state, {
      spawn: () => fakeChild(0),
      liveness: async () => false,
    });
    await assert.doesNotReject(() => sched.start());
    await sched.stop();
  });
});

// ---------------------------------------------------------------------------
// killJob
// ---------------------------------------------------------------------------

describe('killJob', () => {
  const JOB_MANUAL = {
    id: 'manual-a',
    type: 'startup',
    delaySeconds: 0,
    command: 'echo manual',
    enabled: true,
    triggerMode: 'fire-and-forget',
    liveness: null,
  };

  test('killJob returns killed:true and kills the running child', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_MANUAL);

    let killedWith = null;
    const child = new EventEmitter();
    child.pid = 99999;
    child.killed = false;
    child.kill = (sig) => { killedWith = sig; child.killed = true; };
    child.stdout = null;
    child.stderr = null;

    const sched = new Scheduler(registry, state, {
      spawn: () => child,
      liveness: async () => false,
    });

    // Trigger (fire-and-forget -- does not wait for child to close)
    void sched.trigger('manual-a');
    await new Promise(r => setImmediate(r));

    const result = await sched.killJob('manual-a');
    assert.deepStrictEqual(result, { killed: true });

    // Deliberately no assertion on which signal or syscall was used. A stub cannot observe
    // a tree kill, and demanding child.kill() here is what previously forced _killChild to
    // signal the wrapper before the tree had been enumerated -- killing the job's parent and
    // orphaning the actual work. Death is asserted against real pids in the next test.
    void killedWith;

    // Let child close
    child.emit('close', 1);
  });

  test('killJob leaves no survivor in the process tree', async () => {
    // The sibling test above asserts which syscall was emitted, which stays green even if
    // the kill fails. This one spawns a real shell-wrapped job -- so child.pid is an idle
    // wrapper and the work runs in a descendant -- and asserts every pid actually died.
    const { isAlive } = require('../src/process-tree');
    // pidtree is ESM-first: under require() the callable sits on .default.
    const pidtreeMod = require('pidtree');
    const pidtree = typeof pidtreeMod === 'function' ? pidtreeMod : pidtreeMod.default;
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    const scriptPath = path.join(dir, 'survivor.js');
    fs.writeFileSync(scriptPath, 'const t = Date.now(); while (Date.now() - t < 30000);');
    registry.add({
      id: 'tree-a', type: 'startup', delaySeconds: 0,
      command: `"${process.execPath}" "${scriptPath}"`,
      enabled: true, triggerMode: 'fire-and-forget', liveness: null,
    });

    const sched = new Scheduler(registry, state, { configDir: dir, liveness: async () => false });
    void sched.trigger('tree-a');
    // Give the shell time to start its descendant, otherwise there is no tree to kill.
    await new Promise(resolve => setTimeout(resolve, 1200));

    const pid = state.get('tree-a').pid;
    assert.ok(pid, 'expected a recorded pid');
    const pids = await pidtree(pid, { root: true });
    // cmd.exe always stays around as a parent, so Windows must show a real tree. POSIX
    // shells often exec the command in place for a single command, collapsing the tree to
    // one pid -- asserting 2 there would fail in CI for the wrong reason.
    const minPids = process.platform === 'win32' ? 2 : 1;
    assert.ok(pids.length >= minPids, `expected at least ${minPids} pid(s), got ${pids.length}`);

    assert.deepStrictEqual(await sched.killJob('tree-a'), { killed: true });

    // Asserted with no grace period on purpose. killJob must not resolve until the tree is down,
    // because its `killed` flag is what the CLI and the dashboard report. Any wait here also
    // absorbs a killJob that resolved early and left the kill in flight -- verified: with a 1s
    // poll this test still passed when the await was dropped, so it was guarding nothing.
    const survivors = pids.filter(isAlive);
    assert.deepStrictEqual(survivors, [], `these pids survived killJob: ${survivors.join(', ')}`);
    await sched.stop();
  });

  test('killJob returns killed:false when job is not running', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    registry.add(JOB_MANUAL);

    const sched = new Scheduler(registry, state, {
      spawn: () => { throw new Error('should not spawn'); },
      liveness: async () => false,
    });

    const result = await sched.killJob('manual-a');
    assert.deepStrictEqual(result, { killed: false });
  });
});

describe('hard resource budget', () => {
  // Seeds 3 successful runs with a negligible baseline so any real process is over the
  // hard budget on every sample. That isolates the "how many breaches before killing"
  // rule, which is the part that must never fire on a single spike.
  function seedTinyBaseline(state, id) {
    for (let i = 0; i < 3; i++) {
      state.record(id, {
        startedAt:  `2026-08-22T08:0${i}:00Z`,
        finishedAt: `2026-08-22T08:0${i}:05Z`,
        exitCode: 0, pid: 100 + i, peakCpuPct: 0.001, peakRamMb: 0.001,
      });
    }
    assert.ok(state.getResourceBaseline(id) !== null, 'baseline should exist after 3 good runs');
  }

  function busyJob(dir, id, ms) {
    const scriptPath = path.join(dir, `${id}.js`);
    fs.writeFileSync(scriptPath, `const t = Date.now(); while (Date.now() - t < ${ms});`);
    return {
      id, type: 'startup', delaySeconds: 0,
      command: `"${process.execPath}" "${scriptPath}"`,
      enabled: true, triggerMode: 'wait', liveness: null,
    };
  }

  test('a short over-budget burst does not kill the job', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    const events = [];
    seedTinyBaseline(state, 'burst');
    registry.add(busyJob(dir, 'burst', 2500));

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false,
      eventPublisher: { publish: (topic, payload) => events.push({ topic, payload }) },
    });
    await sched.trigger('burst');
    await sched.stop();

    // Samples land at ~0s and ~2s: two breaches, below the 3 required to kill.
    assert.equal(state.get('burst').exitCode, 0, 'job should have finished on its own');
    assert.equal(events.filter(e => e.topic === 'job.resource_hard_limit').length, 0,
      'no hard-limit kill should be emitted for a short burst');
  });

  test('a job that jumps straight past the hard budget still warns before it is killed', async () => {
    // The soft alert used to sit in an `else if` on the hard breach, so a job that went
    // straight over the hard threshold was killed on the third sample having never warned.
    // Delaying the kill is what makes those first samples worth reporting.
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    const events = [];
    seedTinyBaseline(state, 'loud');
    registry.add(busyJob(dir, 'loud', 20000));

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false,
      eventPublisher: { publish: (topic, payload) => events.push({ topic, payload }) },
    });
    await sched.trigger('loud');
    await sched.stop();

    const soft = events.filter(e => e.topic === 'job.resource_soft_limit');
    const hard = events.filter(e => e.topic === 'job.resource_hard_limit');
    assert.equal(soft.length, 1, 'expected exactly one soft warning');
    assert.equal(hard.length, 1, 'expected the kill to still happen');
  });

  /*
   * Sampling is async inside setInterval, so on a machine slow enough for a sample to outlast the
   * interval two walks were in flight at once. Both incremented the breach counter - making two
   * OVERLAPPING samples count as two CONSECUTIVE ones - and both reached the kill branch, because
   * clearInterval cannot retract a promise already scheduled. One kill, announced twice.
   *
   * It showed up once on a loaded CI runner as two job.resource_hard_limit events where the test
   * above expects one, and reproduced nowhere else: a guard whose only witness is a busy CI machine
   * is not a guard. The sampler is injectable so the overlap can be forced on purpose.
   */
  test('overlapping samples announce one kill, not one per sample', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    const events = [];
    seedTinyBaseline(state, 'slowsample');
    registry.add(busyJob(dir, 'slowsample', 6000));

    // Always over budget, and DELIBERATELY slower than the interval: 250ms answers on a 50ms tick,
    // so without the guard five walks are in flight at once. The first version of this test used a
    // 400ms sampler against the production 2s interval, which can never overlap - it passed with the
    // guard removed, and was worth nothing.
    let calls = 0;
    const sampleUsage = async () => {
      calls++;
      await new Promise(r => setTimeout(r, 250));
      return { cpuPct: 5000, ramMb: 5000 };
    };

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleUsage, sampleIntervalMs: 50,
      eventPublisher: { publish: (topic, payload) => events.push({ topic, payload }) },
    });
    await sched.trigger('slowsample');
    await sched.stop();
    // Let the walks that were still in flight when the kill landed resolve. Without this the
    // duplicate event arrives AFTER the assertion reads the array, and the test passes by being too
    // early rather than by the guard working.
    await new Promise(r => setTimeout(r, 600));

    const hard = events.filter(e => e.topic === 'job.resource_hard_limit');
    assert.equal(hard.length, 1, `expected exactly one kill event, got ${hard.length}`);
    assert.ok(calls > 1, 'the sampler should have been called more than once');
  });

  // The counter has to mean consecutive samples, not concurrent ones, or a job is killed early.
  test('a sample is skipped while the previous one is still in flight', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    seedTinyBaseline(state, 'inflight');
    registry.add(busyJob(dir, 'inflight', 3000));

    // Slower than the interval on purpose, so overlap is possible if nothing prevents it.
    let inFlight = 0;
    let maxInFlight = 0;
    const sampleUsage = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 250));
      inFlight--;
      // Under budget: this test is about overlap, not about killing.
      return { cpuPct: 0.001, ramMb: 0.001 };
    };

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleUsage, sampleIntervalMs: 50,
    });
    await sched.trigger('inflight');
    await sched.stop();

    assert.equal(maxInFlight, 1, `samples must not overlap, saw ${maxInFlight} at once`);
  });

  test('a sustained breach kills the job and reports the sample count', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    const events = [];
    seedTinyBaseline(state, 'sustained');
    registry.add(busyJob(dir, 'sustained', 20000));

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false,
      eventPublisher: { publish: (topic, payload) => events.push({ topic, payload }) },
    });
    const startedMs = Date.now();
    await sched.trigger('sustained');
    await sched.stop();
    const elapsedMs = Date.now() - startedMs;

    const hard = events.filter(e => e.topic === 'job.resource_hard_limit');
    assert.equal(hard.length, 1, 'expected exactly one hard-limit event');
    assert.ok(hard[0].payload.consecutiveSamples >= 3,
      `expected >= 3 consecutive samples, got ${hard[0].payload.consecutiveSamples}`);
    assert.ok(elapsedMs < 15000, `job should have been killed early, ran ${elapsedMs}ms`);
  });
});

describe('sampleProcessTree', () => {
  const { sampleProcessTree } = require('../src/scheduler');
  const { spawn } = require('node:child_process');
  const pidusage = require('pidusage');

  test('a real run records a non-zero peakCpuPct in state', async () => {
    // End-to-end through the production path: real shell spawn -> tree sampling ->
    // state.record. Before the tree walk this always stored undefined, which is why the
    // Peak CPU column rendered "-" for every run ever.
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    const scriptPath = path.join(dir, 'busy.js');
    // Deriving a CPU percentage needs two samples of the same pid, so the job has to outlive
    // at least two 2s ticks. It runs 10s rather than 3s because pidusage shells out to WMI on
    // Windows, and on a CI runner that is slow enough that a 3s job ended with a single
    // usable sample -- peakCpuPct stayed 0 and was recorded as undefined.
    fs.writeFileSync(scriptPath, 'const t = Date.now(); while (Date.now() - t < 10000);');
    registry.add({
      id: 'cpu-burner', type: 'startup', delaySeconds: 0,
      command: `"${process.execPath}" "${scriptPath}"`,
      enabled: true, triggerMode: 'wait', liveness: null,
    });

    const sched = new Scheduler(registry, state, { configDir: dir, liveness: async () => false });
    await sched.trigger('cpu-burner');
    await sched.stop();

    const entry = state.get('cpu-burner');
    assert.ok(entry !== null, 'expected a recorded run');
    assert.equal(entry.exitCode, 0);
    assert.ok(entry.peakCpuPct != null && entry.peakCpuPct > 0,
      `expected a non-zero peakCpuPct, got ${String(entry.peakCpuPct)}`);
    assert.ok(entry.peakRamMb != null && entry.peakRamMb > 0,
      `expected a non-zero peakRamMb, got ${String(entry.peakRamMb)}`);
  });

  test('returns null when no pid in the tree can be sampled', async () => {
    // A pid that cannot exist: nothing to sample, so the caller can tell "gone" apart
    // from "genuinely using 0%".
    assert.equal(await sampleProcessTree(2147483646), null);
  });

  test('counts descendants, not just the shell wrapper', async () => {
    // Jobs run through a shell, so the direct child is an idle wrapper. Sampling that
    // wrapper alone is what left Peak CPU empty and Peak RAM stuck at a constant.
    // The busy loop lives in a file: passing it via -e would expose `<` to cmd.exe,
    // which reads it as input redirection and kills the command.
    // 20s, killed in the finally: the job only has to outlive the sampling, and pidusage goes
    // through WMI on Windows. On a CI runner a 3s job had already exited by the time the
    // wrapper baseline was read, which surfaced as an opaque ENOENT from gwmi.
    const scriptPath = path.join(os.tmpdir(), `orch-busy-${process.pid}-${Date.now()}.js`);
    fs.writeFileSync(scriptPath, 'const t = Date.now(); while (Date.now() - t < 20000);');
    // The trailing `&& exit 0` is what makes this test mean anything on POSIX: for a single
    // command `sh -c` execs it in place, so there is no separate wrapper and "tree > wrapper"
    // compares a process against itself -- it failed on macOS with 50.1MB vs 50.1MB. A list
    // forces the shell to stay and wait, giving a real parent on every platform. Relaxing the
    // comparison instead would have made the assertion vacuous exactly where it matters.
    const child = spawn(`"${process.execPath}" "${scriptPath}" && exit 0`, { shell: true, windowsHide: true, stdio: 'ignore' });
    try {
      assert.ok(child.pid, 'expected the wrapper to have a pid');
      await new Promise(resolve => setTimeout(resolve, 700));

      const tree = await sampleProcessTree(child.pid);
      assert.ok(tree !== null, 'expected the tree to be sampleable while the job runs');

      // Guard against the assertion going vacuous again if a shell ever collapses the tree.
      const pidtreeMod = require('pidtree');
      const listPids = typeof pidtreeMod === 'function' ? pidtreeMod : pidtreeMod.default;
      const treePids = await listPids(child.pid, { root: true });
      assert.ok(treePids.length >= 2,
        `expected a wrapper plus a descendant, got ${treePids.length} pid(s): the RAM comparison would be vacuous`);

      // Read the wrapper on its own for the comparison. Surface a real message if it has gone:
      // pidusage throws a bare ENOENT, which says nothing about the job having outrun the test.
      const wrapper = await pidusage(child.pid).catch(() => null);
      assert.ok(wrapper !== null, 'the wrapper exited before it could be sampled: job too short for this runner');
      const wrapperRamMb = wrapper.memory / 1024 / 1024;
      // The busy node descendant dwarfs the wrapper, so the tree total must exceed it.
      assert.ok(tree.ramMb > wrapperRamMb,
        `tree RAM ${tree.ramMb.toFixed(1)}MB should exceed wrapper-only ${wrapperRamMb.toFixed(1)}MB`);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
      try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }
    }
  });
});
