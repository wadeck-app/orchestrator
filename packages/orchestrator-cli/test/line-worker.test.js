'use strict';

// Starting a PowerShell per query is what made the job monitoring slow (30-40 s per start on one machine, each with
// a conhost.exe next to it). One long-lived worker answers every query; it is ended when nobody asks for a while, when
// it hangs, and when the daemon goes (stdin closes). Driven here with a fake worker speaking the same protocol.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { LineWorker } = require('../src/process-table');
const { isAlive } = require('../src/process-tree');

const FAKE = path.join(__dirname, 'helpers', 'fake-table-worker.js');
const workers = [];

function worker(mode, extra = {}) {
  const spawned = [];
  const w = new LineWorker({
    cmd: process.execPath, args: [FAKE, mode], what: 'the fake query', timeoutMs: 5_000, idleMs: 60_000,
    onSpawn: (pid) => spawned.push(pid),
    ...extra,
  });
  workers.push(w);
  return { w, spawned };
}

async function gone(pid) {
  for (let i = 0; i < 50 && isAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

afterEach(async () => {
  while (workers.length > 0) {
    await workers.pop().dispose();
  }
});

describe('the long-lived worker', () => {
  test('answers with the lines printed before the end marker', async () => {
    const { w, spawned } = worker('ok');
    const lines = await w.query();
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `${spawned[0]} 0 0 0 0`);
  });

  test('the next queries use the same process: one start for any number of queries', async () => {
    const { w, spawned } = worker('ok');
    await w.query();
    await w.query();
    const third = await w.query();
    assert.equal(spawned.length, 1);
    assert.match(third[1], /^3 /, 'the same process answered a third time');
  });

  test('queries asked together are answered one after the other, never interleaved', async () => {
    const { w } = worker('ok');
    const [a, b] = await Promise.all([w.query(), w.query()]);
    assert.match(a[1], /^1 /);
    assert.match(b[1], /^2 /);
  });

  test('an error line rejects with its message and leaves the worker usable', async () => {
    const { w, spawned } = worker('error');
    await assert.rejects(w.query(), /the fake query.*access denied by the fake/s);
    await assert.rejects(w.query(), /access denied by the fake/);
    assert.equal(spawned.length, 1);
  });

  test('a worker that does not answer is ended, its process is gone, and the next query starts a new one', async () => {
    const { w, spawned } = worker('hang', { timeoutMs: 300 });
    await assert.rejects(w.query(), /the fake query.*did not answer within 0\.3 s.*ended/s);
    assert.equal(await gone(spawned[0]), true, `process ${spawned[0]} is still running: it leaked`);
    await assert.rejects(w.query(), /did not answer/);
    assert.equal(spawned.length, 2);
    assert.equal(await gone(spawned[1]), true);
  });

  test('a worker that dies in the middle of a query rejects with its exit code, and the next query starts a new one', async () => {
    const { w, spawned } = worker('crash');
    await assert.rejects(w.query(), /the fake query.*exit code 7/s);
    await assert.rejects(w.query(), /exit code 7/);
    assert.equal(spawned.length, 2);
  });

  test('a worker nobody asks for is ended after the idle time, and the next query starts a new one', async () => {
    const { w, spawned } = worker('ok', { idleMs: 200 });
    await w.query();
    assert.equal(await gone(spawned[0]), true, 'the idle worker is still running');
    await w.query();
    assert.equal(spawned.length, 2);
  });

  test('dispose ends the worker', async () => {
    const { w, spawned } = worker('ok');
    await w.query();
    await w.dispose();
    assert.equal(await gone(spawned[0]), true);
  });

  // CI (Windows, no WMIC) caught this: the worker's pipes kept the daemon alive after it had detached from its jobs, so the
  // launcher waited on a daemon that never exited and an update never completed.
  test('an idle worker never keeps the process that started it alive', async () => {
    const probe = path.join(__dirname, 'helpers', 'line-worker-exit-probe.js');
    const child = spawn(process.execPath, [probe], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => { resolve(false); }, 15_000);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) {
      child.kill();
    }
    assert.match(stdout, /ANSWERED 2/, 'the probe never got its answer');
    assert.equal(exited, true, 'the process is still running 15 s after its last question: the worker holds it alive');
  });

  test('a command that is missing says so', async () => {
    const w = new LineWorker({ cmd: 'orch-no-such-binary', args: [], what: 'the fake query', timeoutMs: 1000, idleMs: 1000 });
    await assert.rejects(w.query(), /the fake query.*orch-no-such-binary/s);
  });
});
