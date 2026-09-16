'use strict';

// Peaks used to be written only by the close handler, so any run the daemon did not see finish
// left no CPU/RAM figures at all: a stop, a restart, a crash, a reboot. Those are the runs whose
// resource use is most worth knowing.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Scheduler } = require('../src/scheduler');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { killTree } = require('../src/process-tree');

const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-peaks-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** Waits for a predicate, failing with a named reason rather than a bare timeout. */
async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** A job that burns CPU long enough to be sampled, so the peaks are non-zero. */
function busyJob(dir, id, seconds) {
  const script = path.join(dir, `${id}.js`);
  fs.writeFileSync(script, `const t = Date.now(); while (Date.now() - t < ${seconds * 1000});`);
  return {
    id, type: 'startup', delaySeconds: 0,
    command: `"${process.execPath}" "${script}"`,
    enabled: true, triggerMode: 'fire-and-forget', liveness: null,
  };
}

describe('resource peaks are persisted while the job runs', () => {
  test('peaks land on the in-flight entry before the job exits', async () => {
    const dir = tmpDir();
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state = new State(path.join(dir, 'state.json'));
    registry.add(busyJob(dir, 'peaky', 20));

    // Flush aggressively so the test does not have to wait out the 10s production interval.
    const sched = new Scheduler(registry, state, {
      configDir: dir, liveness: async () => false, peakFlushMs: 100,
    });
    let pid;
    try {
      void sched.trigger('peaky');
      await waitFor(() => state.get('peaky')?.pid != null, 'the run to be recorded');
      pid = state.get('peaky').pid;

      // The point of the test: figures on disk while the run is still open.
      // Both fields, because they do not arrive together -- pidusage needs two samples of a pid to
      // derive a CPU percentage, so the first flush carries RAM alone. Waiting on RAM only would
      // pass without ever proving the CPU peak gets persisted.
      await waitFor(() => {
        const entry = state.get('peaky');
        return entry != null && entry.exitCode === null
          && entry.peakRamMb != null && entry.peakCpuPct != null;
      }, 'both peaks to be written to the in-flight entry');

      const entry = state.get('peaky');
      assert.equal(entry.exitCode, null, 'the run must still be open, or this proves nothing');
      assert.ok(entry.peakRamMb > 0, `expected a positive RAM peak, got ${entry.peakRamMb}`);
      assert.ok(entry.peakCpuPct > 0, `expected a positive CPU peak, got ${entry.peakCpuPct}`);

      // Read back from disk rather than from the in-memory cache: surviving a daemon that never
      // reaches its close handler is the whole point. State batches writes on a 500ms timer, so
      // the file lags the cache by up to that.
      await waitFor(() => {
        if (!fs.existsSync(path.join(dir, 'state.json'))) return false;
        const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
        const open = raw.jobs?.['peaky']?.find(e => e.exitCode === null);
        return open?.peakRamMb != null;
      }, 'the in-flight peaks to reach the file');

      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      const persisted = onDisk.jobs['peaky'].find(e => e.exitCode === null);
      assert.ok(persisted, 'no in-flight entry on disk');
      assert.ok(persisted.peakRamMb > 0, 'peaks were only in memory, not on disk');
    } finally {
      await sched.stop();
      if (pid) await killTree(pid);
    }
  });

  // shutdown() is State's only synchronous flush, and nothing called it: a stop or restart dropped
  // up to 500ms of records, which is exactly the window the mid-run peak writes land in.
  test('shutdown flushes pending records instead of dropping them', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'state.json');
    const state = new State(file);

    state.record('j', { startedAt: 'live', exitCode: null, peakCpuPct: 42, peakRamMb: 128 });
    // Nothing written yet: the 500ms timer has not fired.
    const beforeShutdown = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8')).jobs?.['j']
      : undefined;

    state.shutdown();

    assert.ok(fs.existsSync(file), 'shutdown wrote nothing at all');
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).jobs['j'][0];
    assert.equal(after.peakCpuPct, 42, `pending record lost on shutdown (before: ${JSON.stringify(beforeShutdown)})`);
    assert.equal(after.peakRamMb, 128);
  });

  test('the daemon calls it, so a stop actually flushes', () => {
    // Asserted against the source: the hook runs inside createDaemon, which a unit test cannot
    // drive without starting a real daemon and its tray.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const hook = src.slice(src.indexOf('onShutdown:'), src.indexOf('onShutdown:') + 800);
    assert.match(hook, /state\.shutdown\(\)/,
      'the shutdown hook no longer flushes state; pending records will be dropped on stop');
  });

  test('the baseline ignores in-flight peaks, so mid-run writes cannot skew the budget', () => {
    const dir = tmpDir();
    const state = new State(path.join(dir, 'state.json'));
    // Three finished runs are the minimum getResourceBaseline accepts.
    for (const [startedAt, cpu, ram] of [['a', 10, 100], ['b', 12, 110], ['c', 11, 105]]) {
      state.record('j', { startedAt, finishedAt: 'x', exitCode: 0, peakCpuPct: cpu, peakRamMb: ram });
    }
    const before = state.getResourceBaseline('j');
    assert.ok(before, 'expected a baseline from three finished runs');

    // An in-flight entry with an absurd peak must not move it.
    state.record('j', { startedAt: 'live', exitCode: null, peakCpuPct: 9000, peakRamMb: 90000 });
    const after = state.getResourceBaseline('j');

    assert.deepEqual(after, before, 'an open run leaked into the auto-budget baseline');
  });
});
