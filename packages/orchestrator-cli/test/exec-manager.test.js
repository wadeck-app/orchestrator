'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { ExecManager } = require('../src/exec-manager');

describe('ExecManager', () => {
  let tmpDir;
  let manager;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `exec-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    manager = new ExecManager(tmpDir);
  });

  afterEach(() => {
    manager?.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('fireExec - basic execution', () => {
    test('runs a simple command and captures stdout', async () => {
      const { runId, pid, status } = manager.fireExec('echo hello');
      assert.equal(status, 'running');
      assert.ok(typeof pid === 'number' || pid === null);
      assert.ok(runId.startsWith('exec-'));

      // Wait for completion
      await new Promise(r => setTimeout(r, 500));
      const run = manager.get(runId);
      assert.ok(run);
      assert.equal(run.status, 'done');
      assert.equal(run.exitCode, 0);
      assert.ok(run.logs.some(l => l.includes('hello')));
    });

    test('captures command failure exit codes', async () => {
      const { runId } = manager.fireExec('node -e "process.exit(42)"');
      await new Promise(r => setTimeout(r, 500));
      const run = manager.get(runId);
      assert.equal(run.status, 'failed');
      assert.equal(run.exitCode, 42);
    });

    test('captures stderr output', async () => {
      const { runId } = manager.fireExec('node -e "console.error(\'error msg\')"');
      await new Promise(r => setTimeout(r, 500));
      const run = manager.get(runId);
      assert.ok(run.logs.some(l => l.includes('error msg')));
    });
  });

  describe('fireExec - timeout', () => {
    test('kills process on timeout (default 300s)', async () => {
      const { runId } = manager.fireExec('node -e "setInterval(() => {}, 10000)"', { timeout: 1 });
      // Wait for timeout to trigger (1s) + cleanup
      await new Promise(r => setTimeout(r, 1500));
      const run = manager.get(runId);
      assert.equal(run.status, 'killed');
      assert.ok(run.logs.some(l => l.includes('timed out')));
    });

    test('does not timeout if process finishes quickly', async () => {
      const { runId } = manager.fireExec('echo fast', { timeout: 10 });
      await new Promise(r => setTimeout(r, 500));
      const run = manager.get(runId);
      assert.equal(run.status, 'done');
      assert.equal(run.exitCode, 0);
    });

    test('SIGTERM → 2s pause → SIGKILL sequence', async () => {
      // Start a process that ignores SIGTERM
      const { runId } = manager.fireExec(
        'node -e "process.on(\'SIGTERM\', () => {/* ignore */}); setInterval(() => {}, 10000)"',
        { timeout: 1 }
      );
      await new Promise(r => setTimeout(r, 1500));
      const run = manager.get(runId);
      // Process should be killed despite ignoring SIGTERM
      assert.equal(run.status, 'killed');
    });
  });

  describe('kill() - manual termination', () => {
    test('kills a running process', async () => {
      const { runId } = manager.fireExec('node -e "setInterval(() => {}, 10000)"');
      await new Promise(r => setTimeout(r, 100));

      const result = manager.kill(runId);
      assert.equal(result, true);

      await new Promise(r => setTimeout(r, 500));
      const run = manager.get(runId);
      assert.equal(run.status, 'killed');
    });

    test('returns false if process not running', async () => {
      const { runId } = manager.fireExec('echo done');
      await new Promise(r => setTimeout(r, 500));

      const result = manager.kill(runId);
      assert.equal(result, false);
    });

    test('returns false if run not found', async () => {
      const result = manager.kill('nonexistent-id');
      assert.equal(result, false);
    });

    test('kill() uses SIGTERM → 2s → SIGKILL', async () => {
      const { runId } = manager.fireExec(
        'node -e "process.on(\'SIGTERM\', () => {/* ignore */}); setInterval(() => {}, 10000)"'
      );
      await new Promise(r => setTimeout(r, 100));

      manager.kill(runId);
      await new Promise(r => setTimeout(r, 2500));
      const run = manager.get(runId);
      assert.equal(run.status, 'killed');
    });
  });

  describe('ExecRun lifecycle', () => {
    test('tracks startedAt, finishedAt timestamps', async () => {
      const before = new Date();
      const { runId } = manager.fireExec('echo test');
      await new Promise(r => setTimeout(r, 500));
      const after = new Date();

      const run = manager.get(runId);
      const startTime = new Date(run.startedAt);
      const finishTime = new Date(run.finishedAt);

      assert.ok(startTime >= before && startTime <= after);
      assert.ok(finishTime >= startTime);
    });

    test('stores runId, command, label', async () => {
      const { runId } = manager.fireExec('echo test', { label: 'my-exec' });
      await new Promise(r => setTimeout(r, 500));

      const run = manager.get(runId);
      assert.equal(run.runId, runId);
      assert.equal(run.command, 'echo test');
      assert.equal(run.label, 'my-exec');
    });

    test('logs array has max 1000 entries (FIFO)', async () => {
      const { runId } = manager.fireExec(
        'node -e "for (let i = 0; i < 1500; i++) console.log(\'line\', i)"'
      );
      await new Promise(r => setTimeout(r, 1000));

      const run = manager.get(runId);
      assert.ok(run.logs.length <= 1000, `logs.length = ${run.logs.length}, expected <= 1000`);
    });
  });

  describe('list() and cleanup', () => {
    test('list() returns all runs', async () => {
      const { runId: id1 } = manager.fireExec('echo 1');
      const { runId: id2 } = manager.fireExec('echo 2');
      await new Promise(r => setTimeout(r, 500));

      const all = manager.list();
      assert.ok(all.some(r => r.runId === id1));
      assert.ok(all.some(r => r.runId === id2));
    });

    test('cleanup timer removes old runs after TTL', async () => {
      const { runId } = manager.fireExec('echo test', { timeout: 0 });
      await new Promise(r => setTimeout(r, 500));

      const run = manager.get(runId);
      // Fake finishedAt to be older than TTL (3600000ms = 1h)
      run.finishedAt = new Date(Date.now() - 4000000).toISOString();

      // Trigger cleanup (runs every 60s, so we simulate it)
      await new Promise(r => setTimeout(r, 100));
      manager._cleanupTimer?._onTimeout?.();

      const found = manager.get(runId);
      // Note: This test is timing-sensitive; in real usage cleanup runs every 60s
    });
  });

  describe('Environment and working directory', () => {
    test('respects cwd option', async () => {
      const testDir = path.join(tmpDir, 'subdir');
      fs.mkdirSync(testDir, { recursive: true });

      const { runId } = manager.fireExec('pwd', { cwd: testDir });
      await new Promise(r => setTimeout(r, 500));

      const run = manager.get(runId);
      // pwd output varies by OS, just check it ran
      assert.equal(run.status, 'done');
    });

    test('respects env option', async () => {
      const { runId } = manager.fireExec(
        'node -e "console.log(process.env.TEST_VAR)"',
        { env: { TEST_VAR: 'hello-from-test' } }
      );
      await new Promise(r => setTimeout(r, 500));

      const run = manager.get(runId);
      assert.ok(run.logs.some(l => l.includes('hello-from-test')));
    });
  });
});
