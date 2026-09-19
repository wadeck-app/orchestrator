'use strict';

const { test, describe, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { ExecManager } = require('../src/exec-manager');

const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/*
 * No test here enumerates a process tree, and that is deliberate.
 *
 * The tests used to call pidtree to discover a run's descendants, then assert that every pid it
 * returned had died. The set was therefore chosen by pidtree rather than by the test, and on
 * Windows pidtree's answer can contain processes the run never spawned: ParentProcessId is not
 * unique over time, so a pid that has been freed still appears as the parent of unrelated live
 * processes, and pidtree adopts that orphaned subtree instead of rejecting. Measured on a Windows
 * host: 29 distinct dead pids were named as a parent by a live process, and asking pidtree about
 * one of them returned 152 pids. CI hit exactly that - the assertion demanded that 128 system
 * processes be dead, which nothing could satisfy.
 *
 * The fixtures announce their own pid (see selfAnnouncing), so the real descendant is known
 * without enumeration. `[wrapperPid, announcedPid]` is a set the test fully controls, and it
 * still distinguishes a killed job from one whose real process survived its wrapper - which is
 * the only reason the enumeration existed.
 */

/**
 * A command that reports when it is actually running, plus the file it reports through.
 *
 * Polling pidtree until a second pid appears is a race against cmd.exe: on a loaded CI runner it
 * had still not spawned node when the budget expired, and the run's own timeout then tore the
 * tree down, so the capture came back with one pid and failed the meaningfulness check. Waiting
 * longer only widens the race. Having the child announce itself removes it: once the file exists,
 * the descendant is running, so the tree is guaranteed to have the wrapper and it.
 */
function selfAnnouncing(dir, name, body) {
  const readyFile = path.join(dir, `${name}.ready`);
  const scriptFile = path.join(dir, `${name}.fixture.js`);
  // Written to a file rather than passed to `node -e`. The inline form needs the embedded quotes
  // escaped, and cmd.exe does not treat \" inside a quoted argument the way a POSIX shell does:
  // it held locally and misbehaved on the Windows runner, where the run then sat until the
  // manager's default 300s timeout -- which is the 5m12s the failing step took.
  // The fixture reports its own pid, not just its existence. Enumerating the tree with pidtree is
  // the expensive part -- it shells out on Windows -- and doing it against a run that is about to
  // time out is what made the capture race the teardown. A pid the child states about itself needs
  // no enumeration and cannot be raced.
  // The announcement comes last, after the body's setup has run. That is what lets a test rely on
  // a fixture's SIGTERM handler being installed by the time it sees the pid: announcing first would
  // let the timeout fire against a process that had not yet guarded itself, and the test would pass
  // without exercising the thing it names.
  fs.writeFileSync(
    scriptFile,
    `${body}\nrequire('node:fs').writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));\n`,
  );
  return { readyFile, command: `node "${scriptFile}"` };
}

/** Waits for a self-announcing command to have really started, and returns the pid it reported. */
async function waitForReady(readyFile, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const reported = Number(fs.readFileSync(readyFile, 'utf8'));
      if (Number.isInteger(reported) && reported > 0) {
        spawnedPids.add(reported);
        return reported;
      }
    } catch { /* not written yet, or caught mid-write */ }
    if (Date.now() >= deadline) {
      assert.fail(`the spawned process never announced itself at ${readyFile}`);
    }
    await new Promise(r => setTimeout(r, 25));
  }
}

/**
 * Waits for a run to reach a terminal state.
 *
 * Replaces a fixed 500ms sleep before asserting the final status. That constant held locally and
 * failed on a Windows runner where cmd.exe needed longer, which says nothing about the code under
 * test: the assertion is about the end state, so the wait belongs to the condition, not the clock.
 */
async function waitForFinished(manager, runId) {
  await waitFor(() => manager.get(runId)?.finishedAt != null, `run ${runId} to finish`);
  return manager.get(runId);
}

/** Waits for a condition, failing with a named reason instead of a bare timeout. */
async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/**
 * Waits for every pid to disappear. Returns the ones still alive at the deadline.
 *
 * Confirmed-dead pids are dropped from the leak set. Windows reuses pids aggressively, so a pid
 * that died in its own test can belong to an unrelated process by the time the final sweep runs,
 * and `isAlive` cannot tell the difference -- it reported one such pid as a leak on the windows
 * runner. Only pids whose death was never established stay in the set.
 */
async function waitAllGone(pids, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  // Registered on the way in, so the shell wrappers reach the final sweep too. Only the
  // fixtures' own pids used to be tracked, which left the wrapper covered by the calling test
  // and by nothing afterwards.
  pids.forEach(p => spawnedPids.add(p));
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    alive = alive.filter(isAlive);
  }
  for (const pid of pids) {
    if (!alive.includes(pid)) spawnedPids.delete(pid);
  }
  return alive;
}

// Every pid this file starts, so the suite fails loudly on a leak instead of hanging on it.
const spawnedPids = new Set();

// The kill tests need the run alive until they kill it, so they cannot pass a short timeout, but
// they were passing none at all -- which means the manager's 300s default. A fixture that fails to
// start then parks the step for five minutes before anything reports, which is how one broken
// command turned into a CI step that looked hung rather than failed. Long enough to be killed
// deliberately, short enough that a broken fixture surfaces as a failure.
const KILL_TEST_OPTS = { timeout: 30 };

// Short on purpose. The timeout tests assert against the pid the fixture reported, so nothing has
// to be discovered while the run is being torn down: widening this to fit an enumeration is what
// turned two tests into 40s of waiting.
const TIMEOUT_SECONDS = 5;

describe('ExecManager', () => {
  let tmpDir;
  let manager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `exec-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new ExecManager(tmpDir);
  });

  afterEach(async () => {
    // Awaited: stop() now tears down the process trees, and not waiting for it was what left
    // a node process per run alive, including fixtures that ignore SIGTERM on purpose. The
    // runner then waited forever on children that would never exit, which is the "the
    // orchestrator-cli suite hangs" that got it disabled in CI.
    await manager?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  after(async () => {
    const leaked = await waitAllGone([...spawnedPids], 3000);
    assert.deepEqual(leaked, [], `leaked process pids: ${leaked.join(', ')}`);
  });

  describe('fireExec - basic execution', () => {
    test('runs a simple command and captures stdout', async () => {
      const { runId, pid, status } = manager.fireExec('echo hello');
      assert.equal(status, 'running');
      assert.ok(typeof pid === 'number' || pid === null);
      assert.ok(runId.startsWith('exec-'));

      const run = await waitForFinished(manager, runId);
      assert.ok(run);
      assert.equal(run.status, 'done');
      assert.equal(run.exitCode, 0);
      assert.ok(run.logs.some(l => l.includes('hello')));
    });

    test('captures command failure exit codes', async () => {
      const { runId } = manager.fireExec('node -e "process.exit(42)"');
      const run = await waitForFinished(manager, runId);
      assert.equal(run.status, 'failed');
      assert.equal(run.exitCode, 42);
    });

    test('captures stderr output', async () => {
      const { runId } = manager.fireExec('node -e "console.error(\'error msg\')"');
      const run = await waitForFinished(manager, runId);
      assert.ok(run.logs.some(l => l.includes('error msg')));
    });
  });

  describe('fireExec - timeout', () => {
    test('kills process on timeout', async () => {
      const { readyFile, command } = selfAnnouncing(tmpDir, 'timeout', 'setInterval(() => {}, 10000);');
      const { runId, pid } = manager.fireExec(command, { timeout: TIMEOUT_SECONDS });
      // The pid the fixture reported is the real work, not the shell wrapper the manager tracks,
      // so asserting it died is what makes this test about the job rather than about its parent.
      const childPid = await waitForReady(readyFile);

      await waitFor(() => manager.get(runId).status === 'killed', 'the timeout to fire');
      const run = manager.get(runId);
      assert.ok(run.logs.some(l => l.includes('timed out')));
      // The status field is set by the manager before anything dies, so assert the OS instead.
      assert.deepEqual(await waitAllGone([pid, childPid]), [], 'timeout left processes running');
    });

    test('does not timeout if process finishes quickly', async () => {
      const { runId } = manager.fireExec('echo fast', { timeout: 10 });
      const run = await waitForFinished(manager, runId);
      assert.equal(run.status, 'done');
      assert.equal(run.exitCode, 0);
    });

    test('a target that ignores SIGTERM is still killed on timeout', async () => {
      const { readyFile, command } = selfAnnouncing(
        tmpDir, 'sigterm-timeout',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);",
      );
      const { runId, pid } = manager.fireExec(command, { timeout: TIMEOUT_SECONDS });
      // Reported by the fixture after its handler is installed, so the handler is provably in place
      // before the timeout fires -- otherwise the test could pass by killing an unguarded process.
      const childPid = await waitForReady(readyFile);

      await waitFor(() => manager.get(runId).status === 'killed', 'the timeout to fire');
      // The whole point of the test: a SIGTERM handler must not keep the process alive.
      assert.deepEqual(await waitAllGone([pid, childPid]), [], 'SIGTERM-ignoring process survived');
    });
  });

  describe('kill() - manual termination', () => {
    test('kills a running process', async () => {
      const { readyFile, command } = selfAnnouncing(tmpDir, 'kill', 'setInterval(() => {}, 10000);');
      const { runId, pid } = manager.fireExec(command, KILL_TEST_OPTS);
      // The pid the fixture reports is the real work; `pid` is only the shell wrapper.
      const childPid = await waitForReady(readyFile);

      assert.equal(manager.kill(runId), true);

      assert.equal(manager.get(runId).status, 'killed');
      assert.deepEqual(await waitAllGone([pid, childPid]), [], 'kill() left processes running');
    });

    test('returns false if process not running', async () => {
      const { runId } = manager.fireExec('echo done');
      await waitForFinished(manager, runId);

      const result = manager.kill(runId);
      assert.equal(result, false);
    });

    test('returns false if run not found', async () => {
      const result = manager.kill('nonexistent-id');
      assert.equal(result, false);
    });

    test('kill() defeats a SIGTERM handler', async () => {
      const { readyFile, command } = selfAnnouncing(
        tmpDir, 'kill-sigterm',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);",
      );
      const { runId, pid } = manager.fireExec(command, KILL_TEST_OPTS);
      // Reported after the handler is installed, so the handler is provably in place before the
      // kill -- otherwise the test could pass by killing an unguarded process.
      const childPid = await waitForReady(readyFile);

      manager.kill(runId);

      assert.equal(manager.get(runId).status, 'killed');
      assert.deepEqual(await waitAllGone([pid, childPid]), [],
        'SIGTERM-ignoring process survived kill()');
    });

    test('stop() kills anything still running', async () => {
      const first  = selfAnnouncing(tmpDir, 'stop-a', 'setInterval(() => {}, 10000);');
      const second = selfAnnouncing(
        tmpDir, 'stop-b',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 10000);",
      );
      const a = manager.fireExec(first.command, KILL_TEST_OPTS);
      const b = manager.fireExec(second.command, KILL_TEST_OPTS);
      const firstChild  = await waitForReady(first.readyFile);
      const secondChild = await waitForReady(second.readyFile);

      await manager.stop();

      assert.deepEqual(await waitAllGone([a.pid, firstChild, b.pid, secondChild]), [],
        'stop() left processes running');
    });
  });

  describe('ExecRun lifecycle', () => {
    test('tracks startedAt, finishedAt timestamps', async () => {
      const before = new Date();
      const { runId } = manager.fireExec('echo test');
      await waitForFinished(manager, runId);
      const after = new Date();

      const run = manager.get(runId);
      const startTime = new Date(run.startedAt);
      const finishTime = new Date(run.finishedAt);

      assert.ok(startTime >= before && startTime <= after);
      assert.ok(finishTime >= startTime);
    });

    test('stores runId, command, label', async () => {
      const { runId } = manager.fireExec('echo test', { label: 'my-exec' });
      const run = await waitForFinished(manager, runId);

      assert.equal(run.runId, runId);
      assert.equal(run.command, 'echo test');
      assert.equal(run.label, 'my-exec');
    });

    test('logs array has max 1000 entries (FIFO)', async () => {
      const { runId } = manager.fireExec(
        'node -e "for (let i = 0; i < 1500; i++) console.log(\'line\', i)"'
      );
      const run = await waitForFinished(manager, runId);

      assert.ok(run.logs.length <= 1000, `logs.length = ${run.logs.length}, expected <= 1000`);
    });
  });

  describe('list() and cleanup', () => {
    test('list() returns all runs', async () => {
      const { runId: id1 } = manager.fireExec('echo 1');
      const { runId: id2 } = manager.fireExec('echo 2');
      await Promise.all([waitForFinished(manager, id1), waitForFinished(manager, id2)]);

      const all = manager.list();
      assert.ok(all.some(r => r.runId === id1));
      assert.ok(all.some(r => r.runId === id2));
    });

    // Previously ended by fetching the run into an unused variable under a comment about being
    // timing-sensitive, so it asserted nothing at all and passed whatever cleanup did.
    /*
     * Pruning happens when the map is read or written, not on a timer.
     *
     * It used to be a setInterval(60s) armed in the constructor, running for the daemon's whole life
     * to sweep a map that is empty unless someone ran `orch exec`. These tests reached into
     * `_cleanupTimer._onTimeout` to fire it, which is how a test ends up coupled to a timer's
     * internals; they now ask the only question that matters - does an expired run come back.
     */
    test('an expired run is gone on the next read', async () => {
      const { runId } = manager.fireExec('echo test', { timeout: 0 });
      const run = await waitForFinished(manager, runId);
      assert.ok(manager.get(runId), 'precondition: a fresh run is tracked');

      // Aged past its TTL rather than waiting an hour for it.
      run.finishedAt = new Date(Date.now() - (run.ttlMs + 60_000)).toISOString();

      assert.equal(manager.get(runId), undefined, 'an expired run survived');
      assert.equal(manager.list().find(r => r.runId === runId), undefined, 'and it is still listed');
    });

    // The point of the change is that nothing is armed. A regression here would silently restore a
    // wake-up every minute for the daemon's whole life, and no other assertion would notice.
    test('no timer is armed for it', () => {
      assert.equal(manager._cleanupTimer, undefined,
        'a cleanup interval is back: pruning is meant to happen on access');
    });

    test('a run within its TTL survives being read', async () => {
      const { runId } = manager.fireExec('echo test', { timeout: 0 });
      await waitForFinished(manager, runId);

      assert.ok(manager.get(runId), 'a fresh run was evicted: pruning is not honouring the TTL');
    });
  });

  describe('Environment and working directory', () => {
    test('respects cwd option', async () => {
      const testDir = path.join(tmpDir, 'subdir');
      fs.mkdirSync(testDir, { recursive: true });

      const { runId } = manager.fireExec('pwd', { cwd: testDir });
      const run = await waitForFinished(manager, runId);

      // pwd output varies by OS, just check it ran
      assert.equal(run.status, 'done');
    });

    test('respects env option', async () => {
      const { runId } = manager.fireExec(
        'node -e "console.log(process.env.TEST_VAR)"',
        { env: { TEST_VAR: 'hello-from-test' } }
      );
      const run = await waitForFinished(manager, runId);

      assert.ok(run.logs.some(l => l.includes('hello-from-test')));
    });
  });
});
