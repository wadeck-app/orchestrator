'use strict';

// The shutdown path of the daemon, minus everything that is not the scheduler: detach from the supervised runs and
// stop. The process must then EXIT ON ITS OWN while the job keeps running. A daemon that cannot exit leaves the
// launcher waiting on it, the restart sentinel is never acted on, and the update this whole design exists for
// never completes. Run in a child process, because "does it exit" cannot be asked of the process running the test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawn } = require('node:child_process');

const { findSupervisorBinary } = require('../src/platform-binary');

if (findSupervisorBinary() === null) {
  throw new Error(
    'No supervisor binary for this platform. Build it with: npm run build-supervisor --workspace=packages/orchestrator-cli '
    + '(needs Go). This test does not skip: a skipped test would report a green run that exercised nothing.',
  );
}

const SRC = path.join(__dirname, '..', 'src');

/** What a daemon does between starting a supervised job and exiting for an update. */
function daemonScript(dir, jobFile) {
  return `
    require('tsx/cjs');
    const { Registry } = require(${JSON.stringify(path.join(SRC, 'registry'))});
    const { State } = require(${JSON.stringify(path.join(SRC, 'state'))});
    const { Scheduler } = require(${JSON.stringify(path.join(SRC, 'scheduler'))});
    const { startSupervised } = require(${JSON.stringify(path.join(SRC, 'supervised-run'))});
    const { findSupervisorBinary } = require(${JSON.stringify(path.join(SRC, 'platform-binary'))});
    (async () => {
      const dir = ${JSON.stringify(dir)};
      const job = { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'fire-and-forget',
        timeoutSeconds: 3600, command: 'node "' + ${JSON.stringify(jobFile)} + '"' };
      const registry = new Registry(dir + '/registry.json'); registry.load(); registry.add(job);
      const state = new State(dir + '/state.json');
      const scheduler = new Scheduler(registry, state, {
        configDir: dir, liveness: async () => false,
        eventPublisher: { publish: () => {} },
        supervisor: (req) => startSupervised({ supervisorPath: findSupervisorBinary(), configDir: dir, heartbeatMs: 50, pollMs: 25 }, req),
      });
      await scheduler.start();
      const { pid } = await scheduler._fire(job);
      process.stdout.write('JOB_PID=' + pid + '\\n');
      // A sample or two, so the resource monitor is really running when the daemon leaves.
      await new Promise((r) => setTimeout(r, 2500));
      // What onShutdown does:
      scheduler.detachRuns();
      void scheduler.stop();
      state.shutdown();
      process.stdout.write('SHUTDOWN_DONE\\n');
    })().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\\n'); process.exit(1); });
  `;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('a daemon that detached from a supervised job with a timeout and a resource monitor exits by itself, and the job keeps running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-detach-'));
  const jobFile = path.join(dir, 'job.js');
  fs.writeFileSync(jobFile, 'setInterval(() => {}, 1000)');
  const child = spawn(process.execPath, ['-e', daemonScript(dir, jobFile)], { stdio: ['ignore', 'pipe', 'pipe'], cwd: path.join(__dirname, '..') });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err += d.toString(); });

  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const verdict = await Promise.race([
    exited.then((code) => ({ code })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 20_000)),
  ]);

  const jobPid = Number(/JOB_PID=(\d+)/.exec(out)?.[1]);
  try {
    assert.ok(!verdict.timedOut, `the daemon process did not exit within 20 s of shutting down (stdout: ${out.trim()} stderr: ${err.trim()}): something it started keeps it alive`);
    assert.equal(verdict.code, 0, `the daemon exited with ${verdict.code}: ${err}`);
    assert.ok(Number.isInteger(jobPid) && jobPid > 0, `no job pid reported: ${out}`);
    assert.equal(isAlive(jobPid), true, 'the job must outlive the daemon that started it');
  } finally {
    if (verdict.timedOut) {
      child.kill();
    }
    if (Number.isInteger(jobPid) && isAlive(jobPid)) {
      // The supervisor ends the job's tree when asked; fall back to the pid itself.
      const runsRoot = path.join(dir, 'runs', 'job');
      for (const run of fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : []) {
        fs.writeFileSync(path.join(runsRoot, run, 'kill'), 'test-cleanup');
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (isAlive(jobPid)) {
        try { process.kill(jobPid); } catch { /* gone */ }
      }
    }
  }
});
