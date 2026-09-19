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

/**
 * Waits for a condition instead of sleeping for however long it is guessed to take.
 *
 * The tests below need a shell to have spawned its descendant before there is anything to look at,
 * and each waited a flat 1200ms/700ms for it. A fixed sleep is both slower than the wait usually
 * needs to be and shorter than a loaded runner sometimes needs, so it cost real time on every run
 * and still failed on the runs it was there to protect. Fails with a named reason rather than a bare
 * timeout.
 *
 * `predicate` is awaited, unlike the sync-only copies in exec-manager.test.js and job-peaks.test.js,
 * because one caller has to await a pidtree walk.
 */
async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
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

  /*
   * The sibling test above asserts which syscall was emitted, which stays green even if the kill
   * fails. This one spawns a real shell-wrapped job -- so child.pid is an idle wrapper and the work
   * runs in a descendant -- and asserts the real processes died.
   *
   * It does NOT enumerate the tree, and that is the whole point of its shape. It used to call
   * pidtree and assert that every pid the answer contained had died, which made pidtree choose the
   * assertion set. On Windows that set can contain strangers: ParentProcessId is not unique over
   * time, so a freed pid still appears as the parent of unrelated live processes and pidtree adopts
   * the orphaned subtree. That is measured in process-tree-strangers.test.js (29 dead pids named as
   * a parent by a live process, one yielding 152 pids) and it is why exec-manager.test.js stopped
   * enumerating too. It bit here as well: a run of this test reported nine survivors, one of which
   * was a node process that had been running since the previous day.
   *
   * The first attempt at a fix was a 1200ms sleep plus a poll until the tree had two pids. Both are
   * wrong, and exec-manager.test.js already says why in one line -- "waiting longer only widens the
   * race". A sleep cannot fix ppid recycling, because the strangers are not late, they are not ours.
   *
   * So the fixture announces its own pid, as in exec-manager.test.js. `[wrapperPid, announcedPid]`
   * is a set this test fully controls, it still distinguishes a killed job from one whose real work
   * survived its wrapper -- the only reason the enumeration ever existed -- and it needs no sleep,
   * because the file existing IS the proof that the descendant is running.
   */
  test('killJob leaves no survivor in the process tree', async () => {
    const { isAlive } = require('../src/process-tree');
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    const readyFile = path.join(dir, 'survivor.ready');
    const scriptPath = path.join(dir, 'survivor.js');
    // The announcement comes after the busy loop is armed, so seeing the pid means the work is
    // genuinely running. setInterval rather than a spin loop: this process only has to be alive to
    // be killed, and burning a core for 30s slows every test sharing the runner.
    fs.writeFileSync(
      scriptPath,
      'setInterval(() => {}, 10000);\n'
      + `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));\n`,
    );
    registry.add({
      id: 'tree-a', type: 'startup', delaySeconds: 0,
      command: `"${process.execPath}" "${scriptPath}"`,
      enabled: true, triggerMode: 'fire-and-forget', liveness: null,
    });

    const sched = new Scheduler(registry, state, { configDir: dir, liveness: async () => false });
    void sched.trigger('tree-a');

    let announcedPid = 0;
    await waitFor(() => {
      try {
        announcedPid = Number(fs.readFileSync(readyFile, 'utf8'));
      } catch {
        // Not written yet, or read mid-write.
        return false;
      }
      return Number.isInteger(announcedPid) && announcedPid > 0;
    }, `the job's real process to announce itself at ${readyFile}`);

    const wrapperPid = state.get('tree-a')?.pid;
    assert.ok(wrapperPid, 'expected a recorded pid');
    // The descendant must be a different process from the wrapper, or "the tree was killed" would
    // be claimed by a test that only ever saw one process. On POSIX a single command is often
    // exec'd in place, so the two legitimately coincide there and only Windows can demand a split.
    if (process.platform === 'win32') {
      assert.notEqual(announcedPid, wrapperPid,
        'expected the shell wrapper and the real process to be distinct pids');
    }

    assert.deepStrictEqual(await sched.killJob('tree-a'), { killed: true });

    // Asserted with no grace period on purpose. killJob must not resolve until the tree is down,
    // because its `killed` flag is what the CLI and the dashboard report. Any wait here also
    // absorbs a killJob that resolved early and left the kill in flight -- verified: with a 1s
    // poll this test still passed when the await was dropped, so it was guarding nothing.
    const watched = [wrapperPid, announcedPid];
    const survivors = watched.filter(isAlive);
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
    registry.add(busyJob(dir, 'burst', 800));

    /*
     * The burst is stated by the sampler rather than left to arithmetic on the clock. This used to
     * run a 2.5s job on the production 2s interval and rely on it finishing before a third tick --
     * so it asserted "2 breaches do not kill" only as long as the host kept up, and a slow runner
     * would have turned a passing rule into a spurious kill.
     *
     * Two breaches, then one calm sample, then two more. That shape is deliberate: it is what makes
     * the test prove the counter means CONSECUTIVE samples rather than cumulative ones. A sampler
     * that simply went over twice and then stayed calm forever leaves `if (!overHard) hardBreaches =
     * 0` unasserted -- delete that line and the test still passes, because the over-budget branch is
     * never entered again and a counter stuck at 2 is unobservable. Going back over budget afterwards
     * is what makes the reset load-bearing: without it the count reaches 3 on the fourth breach and
     * the job is killed.
     */
    let calls = 0;
    const OVER = { cpuPct: 5000, ramMb: 5000 };
    const CALM = { cpuPct: 0.0001, ramMb: 0.0001 };
    const sampleUsage = async () => {
      calls++;
      if (calls <= 2) {
        return OVER;
      }
      if (calls === 3) {
        return CALM;
      }
      if (calls <= 5) {
        return OVER;
      }
      return CALM;
    };

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleUsage, sampleIntervalMs: 25,
      eventPublisher: { publish: (topic, payload) => events.push({ topic, payload }) },
    });
    await sched.trigger('burst');
    await sched.stop();

    // Asserted before the sample count, so a real regression -- a kill on the second breach --
    // names the kill instead of complaining that too few samples were taken.
    assert.equal(events.filter(e => e.topic === 'job.resource_hard_limit').length, 0,
      'no hard-limit kill should be emitted for two non-consecutive bursts');
    assert.equal(state.get('burst').exitCode, 0, 'job should have finished on its own');
    // The whole pattern has to have been played, or the reset is untested rather than tested.
    assert.ok(calls >= 6, `the burst/calm/burst pattern needs 6 samples, only ${calls} were taken`);
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

    // Always over budget, so the kill lands on the third tick. The interval is injected only to
    // stop the test waiting 6s of real time for a rule that does not depend on how long a tick is.
    const sampleUsage = async () => ({ cpuPct: 5000, ramMb: 5000 });

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleUsage, sampleIntervalMs: 25,
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
    let inFlight = 0;
    let maxInFlight = 0;
    const outstanding = [];
    const sampleUsage = () => {
      calls++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const walk = new Promise(r => setTimeout(r, 250))
        .then(() => { inFlight--; return { cpuPct: 5000, ramMb: 5000 }; });
      outstanding.push(walk);
      return walk;
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
    // Awaited on the walks themselves rather than on a 600ms guess: a sleep sized to "probably long
    // enough" is the same bet the guard exists to remove, and it would hide the duplicate again the
    // day a runner is slower than the number chosen here.
    await Promise.allSettled(outstanding);
    await new Promise(resolve => setImmediate(resolve));

    const hard = events.filter(e => e.topic === 'job.resource_hard_limit');
    assert.equal(hard.length, 1, `expected exactly one kill event, got ${hard.length}`);
    assert.ok(calls > 1, 'the sampler should have been called more than once');
    // Without this the test can pass having never overlapped anything: if ticks are delayed past
    // the sampler's 250ms on a loaded runner, one kill is trivially one kill and the guard under
    // test is never reached. `calls > 1` does not imply two walks were ever in flight at once.
    assert.ok(maxInFlight >= 2,
      `the overlap this test exists to force did not happen, saw ${maxInFlight} walk(s) at once`);
  });

  /*
   * The escape hatch on that guard.
   *
   * Skipping while a walk is outstanding is right, but skipping unconditionally means one call that
   * never settles stops monitoring for the rest of the run - no peaks, no budget enforcement, in
   * silence. CI found it: the peaks test timed out waiting for readings that could never arrive,
   * because pidtree on a loaded Windows runner had hung and nothing would ever start another walk.
   */
  test('a hung sample does not disable monitoring for the whole run', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    seedTinyBaseline(state, 'hung');
    // 800ms is ~16 ticks and well past the 3-tick stall window, so recovery has plenty of room:
    // the old 3000ms was the child's lifetime, not anything this test needed.
    registry.add(busyJob(dir, 'hung', 800));

    let started = 0;
    const sampleUsage = () => {
      started++;
      // The first walk never settles. Every later one answers at once.
      return started === 1
        ? new Promise(() => {})
        : Promise.resolve({ cpuPct: 0.001, ramMb: 0.001 });
    };

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleUsage, sampleIntervalMs: 50,
    });
    await sched.trigger('hung');
    await sched.stop();

    assert.ok(started > 1, `monitoring must recover from a hung walk, only ${started} started`);
  });

  // The counter has to mean consecutive samples, not concurrent ones, or a job is killed early.
  test('a sample is skipped while the previous one is still in flight', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    seedTinyBaseline(state, 'inflight');
    // Long enough for ticks to keep arriving while a 100ms walk is outstanding, which is the whole
    // point; the old 3000ms just made the test wait for a child it was not measuring.
    registry.add(busyJob(dir, 'inflight', 800));

    /*
     * 100ms on a 50ms tick: slower than the interval, so ticks arrive while a walk is outstanding and
     * overlap happens unless something prevents it.
     *
     * What is asserted is the guard's actual rule, not `maxInFlight === 1`. The scheduler is allowed
     * to start a second walk once the outstanding one has been running for 3 intervals -- that is the
     * deliberate escape hatch for a walk that never settles. A flat "never two at once" therefore
     * asserts something the code does not promise, and it failed on the Windows runner for exactly
     * that reason: a 100ms sampler against a 150ms window is only 1.5x of margin, so when the host
     * stretched the sampler's timer past 150ms the escape fired legitimately and the test called it a
     * bug. Widening the numbers only moves that threshold, because the window is a multiple of the
     * interval and the sampler has to outlast the interval for the test to mean anything.
     *
     * So an overlap counts as a violation only when it happens BEFORE the escape is due. Removing the
     * guard from the scheduler still fails this immediately -- a second walk would start on the very
     * next tick, ~50ms in, far inside the window -- while a merely busy host does not.
     */
    // Mirrors samplingStallMs in scheduler.ts, which is sampleIntervalMs * 3.
    const SAMPLE_INTERVAL_MS = 50;
    const STALL_MS = SAMPLE_INTERVAL_MS * 3;
    let inFlight = 0;
    let outstandingSince = 0;
    let maxInFlight = 0;
    const prematureOverlaps = [];
    const sampleUsage = async () => {
      if (inFlight > 0) {
        const heldForMs = Date.now() - outstandingSince;
        if (heldForMs < STALL_MS) prematureOverlaps.push(heldForMs);
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      outstandingSince = Date.now();
      await new Promise(r => setTimeout(r, 100));
      inFlight--;
      // Under budget: this test is about overlap, not about killing.
      return { cpuPct: 0.001, ramMb: 0.001 };
    };

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleUsage,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    });
    await sched.trigger('inflight');
    await sched.stop();

    assert.deepStrictEqual(prematureOverlaps, [],
      `a walk was started while another had been running for only ${prematureOverlaps.join(', ')}ms,`
      + ` inside the ${STALL_MS}ms stall window -- the skip guard is not holding`);
    // Guards the other direction: if no tick ever landed during a walk, nothing above was exercised
    // and the assertion passed vacuously.
    assert.ok(maxInFlight >= 1, 'the sampler was never called');
  });

  test('a sustained breach kills the job and reports the sample count', async () => {
    const dir = tmpDir();
    const { registry, state } = makeDeps(dir);
    const events = [];
    seedTinyBaseline(state, 'sustained');
    registry.add(busyJob(dir, 'sustained', 20000));

    const sampleUsage = async () => ({ cpuPct: 5000, ramMb: 5000 });

    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, sampleUsage, sampleIntervalMs: 25,
      eventPublisher: { publish: (topic, payload) => events.push({ topic, payload }) },
    });
    const startedMs = Date.now();
    await sched.trigger('sustained');
    await sched.stop();
    const elapsedMs = Date.now() - startedMs;

    const hard = events.filter(e => e.topic === 'job.resource_hard_limit');
    assert.equal(hard.length, 1, 'expected exactly one hard-limit event');
    // Exactly 3, not >= 3. The injected sampler resolves in a microtask so walks never overlap and
    // the counter advances once per tick, which makes the kill land on the third breach and no other.
    // `>= 3` was right when a real sampler could overlap and inflate it; it now only lets an
    // off-by-one that kills a sample or two late go unnoticed.
    assert.equal(hard[0].payload.consecutiveSamples, 3,
      `expected the kill on the 3rd consecutive sample, got ${hard[0].payload.consecutiveSamples}`);
    // The job asks for 20s, so finishing well inside that is what proves the monitor killed it.
    // Kept as a real-clock assertion on purpose -- it is the one thing here a stubbed sampler
    // cannot fake -- and kept LOOSE on purpose: tightened to 5000 it failed at 7910ms on a machine
    // that was merely busy, which tests the host rather than the code.
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
    //
    // Do not shorten this, and do not shorten it by lowering sampleIntervalMs either. That was
    // tried (250ms interval, 3s job) on the reasoning that serialised walks make a short interval
    // buy MORE attempts: it passed 4/4 locally and then failed on the Windows runner with exactly
    // the `undefined` this comment already described. What sets the floor here is WMI latency on a
    // loaded runner, which a local machine does not reproduce, so local green proves nothing about
    // it. 7s of suite time is the price of the only end-to-end check that the Peak CPU column is
    // fed by the real path.
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

      // Guard against the assertion going vacuous again if a shell ever collapses the tree.
      const pidtreeMod = require('pidtree');
      const listPids = typeof pidtreeMod === 'function' ? pidtreeMod : pidtreeMod.default;
      // Waited on rather than slept for: the descendant is what the comparison needs, so the tree
      // having appeared is the condition, and 700ms was only ever a guess at it.
      //
      // The reason it can wait on pidtree's answer here, where killJob's sibling test deliberately
      // does not, is that a stranger in the answer cannot make THIS assertion pass wrongly: an extra
      // pid only inflates the tree's RAM total, and the test would still fail if the descendant were
      // missing. A kill test asserting that pidtree's whole answer is dead has the opposite exposure.
      //
      // Wrapped so a shell that collapses the tree reports the vacuousness rather than a bare
      // timeout -- that case is real, it failed on macOS once, and the message is the point.
      let treePids = [];
      // The walk's error is kept rather than swallowed. pidtree shells out to `ps` on POSIX, so in an
      // environment without it every call throws -- and a bare `.catch(() => [])` turned that into a
      // 20s wait reporting "the shell to spawn its descendant", which sends the next person after a
      // slow runner instead of a missing binary.
      let lastWalkError = null;
      try {
        await waitFor(async () => {
          treePids = await listPids(child.pid, { root: true })
            .catch((err) => { lastWalkError = err; return []; });
          return treePids.length >= 2;
        }, 'the shell to spawn its descendant', 10000);
      } catch {
        assert.fail(`expected a wrapper plus a descendant, got ${treePids.length} pid(s):`
          + ` the RAM comparison would be vacuous.`
          + (lastWalkError ? ` The tree walk kept failing: ${lastWalkError.message}` : ''));
      }

      const tree = await sampleProcessTree(child.pid);
      assert.ok(tree !== null, 'expected the tree to be sampleable while the job runs');

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
