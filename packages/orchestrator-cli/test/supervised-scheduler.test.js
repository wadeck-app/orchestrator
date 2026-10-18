'use strict';

// The scheduler running jobs through the supervisor, end to end, with the real supervisor binary: what the
// daemon records for a supervised job must be what it recorded for a job it spawned itself.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { findSupervisorBinary } = require('../src/platform-binary');
const { startSupervised } = require('../src/supervised-run');

const supervisorPath = findSupervisorBinary();
if (supervisorPath === null) {
  throw new Error(
    'No supervisor binary for this platform. Build it with: npm run build-supervisor --workspace=packages/orchestrator-cli '
    + '(needs Go). This test does not skip: a skipped test would report a green run that exercised nothing.',
  );
}

const schedulers = [];
afterEach(async () => {
  while (schedulers.length > 0) {
    await schedulers.pop().stop();
  }
});

function makeEnv(job, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-supervised-sched-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(job);
  const events = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    liveness: async () => false,
    sampleUsage: async () => null,
    eventPublisher: { publish: (event, payload) => events.push({ event, payload }) },
    supervisor: (request) => startSupervised({ supervisorPath, configDir: dir, heartbeatMs: 50, pollMs: 25 }, request),
    ...extra,
  });
  schedulers.push(sched);
  return { sched, state, events, dir };
}

function script(dir, name, source) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source);
  return `node "${file}"`;
}

const names = (events) => events.map((e) => e.event);

function runLog(dir, jobId) {
  const folder = path.join(dir, 'logs', 'jobs', jobId);
  const files = fs.readdirSync(folder).filter((f) => f.endsWith('.log')).sort();
  return fs.readFileSync(path.join(folder, files[files.length - 1]), 'utf8');
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(what, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('a supervised job', () => {
  test('is recorded like any other: started, failed, the exit code, the output and the finish marker in its log', async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sup-script-'));
    const job = { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'wait',
      command: script(holder, 'job.js', 'console.log("working"); console.error("warning"); process.exit(4)') };
    const env = makeEnv(job);

    const result = await env.sched._fire(job);

    assert.deepEqual(result, { exitCode: 4 });
    assert.deepEqual(names(env.events), ['job.started', 'job.failed']);
    assert.equal(env.state.get('job').exitCode, 4);
    const log = runLog(env.dir, 'job');
    assert.match(log, /\[job:started\] pid=\d+/);
    assert.match(log, /\] working\n/);
    assert.match(log, /\] \[stderr\] warning\n/);
    assert.match(log, /\[job:finished\] exitCode=4 /);
  });

  test('records the job\'s own pid, the one the resource monitor and the kill act on', async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sup-script-'));
    const job = { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'fire-and-forget',
      command: script(holder, 'job.js', 'setTimeout(() => {}, 1500)') };
    const env = makeEnv(job);

    const { pid } = await env.sched._fire(job);

    assert.equal(typeof pid, 'number');
    assert.equal(env.state.get('job').pid, pid);
    assert.equal(isAlive(pid), true);
    await env.sched.killJob('job');
  });

  test('is ended by killJob: announced as a manual kill, history cancelled, process gone, the reason recorded', async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sup-script-'));
    const job = { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'fire-and-forget',
      command: script(holder, 'job.js', 'setInterval(() => {}, 1000)') };
    const env = makeEnv(job);
    const { pid } = await env.sched._fire(job);

    const killed = await env.sched.killJob('job');
    await until('the run to be recorded as ended', () => env.state.get('job').finishedAt !== undefined);

    assert.deepEqual(killed, { killed: true, count: 1 });
    assert.ok(names(env.events).includes('job.killed_manual'), names(env.events).join(', '));
    assert.equal(env.state.get('job').cancelledByUser, true);
    await until('the job process to be gone', () => !isAlive(pid));
    const runDirs = fs.readdirSync(path.join(env.dir, 'runs', 'job'));
    const status = JSON.parse(fs.readFileSync(path.join(env.dir, 'runs', 'job', runDirs[0], 'status.json'), 'utf8'));
    assert.equal(status.killReason, 'manual');
  });

  test('is ended by the daemon\'s own timeout first, which announces it and tells the supervisor why', async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sup-script-'));
    const job = { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'wait', timeoutSeconds: 1,
      command: script(holder, 'job.js', 'setInterval(() => {}, 1000)') };
    const env = makeEnv(job);

    await env.sched._fire(job);

    assert.ok(names(env.events).includes('job.timed_out'), names(env.events).join(', '));
    assert.match(runLog(env.dir, 'job'), /\[job:timeout\]/);
    assert.match(runLog(env.dir, 'job'), /\[job:finished\] .*reason=timeout/);
    const runDirs = fs.readdirSync(path.join(env.dir, 'runs', 'job'));
    const status = JSON.parse(fs.readFileSync(path.join(env.dir, 'runs', 'job', runDirs[0], 'status.json'), 'utf8'));
    assert.equal(status.killReason, 'timeout');
    assert.notEqual(status.timedOut, true, 'the supervisor\'s own deadline is later; the daemon acts first');
  });
});

// Seen live: a run that ended while the daemon followed it was never marked as handled, so the NEXT daemon start
// found its folder, took it for a run that ended while it was away, and did it all again: events published a second
// time, retry and dependents fired a second time.
describe('a supervised run that ended in front of the daemon', () => {
  const { runDirFor } = require('../src/supervised-run');

  async function runOnce(extra = {}) {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sup-script-'));
    const job = { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'wait',
      command: script(holder, 'job.js', 'process.exit(5)'), ...extra };
    const env = makeEnv(job);
    await env.sched._fire(job);
    return { env, job };
  }

  test('is marked as handled, so nothing has to be done for it again', async () => {
    const { env } = await runOnce();

    const runsRoot = path.join(env.dir, 'runs', 'job');
    const folders = fs.readdirSync(runsRoot);
    assert.equal(folders.length, 1);
    assert.ok(fs.existsSync(path.join(runsRoot, folders[0], 'done')), 'the run was not marked as handled');
  });

  test('is not recovered a second time by the next daemon: no new event, no new history entry', async () => {
    const { env, job } = await runOnce();
    const eventsBefore = env.events.length;
    const historyBefore = JSON.stringify(env.state.getAll().job);
    const next = new (require('../src/scheduler').Scheduler)(env.sched._registry, env.state, {
      configDir: env.dir, liveness: async () => false, sampleUsage: async () => null,
      eventPublisher: { publish: (event, payload) => env.events.push({ event, payload }) },
    });
    schedulers.push(next);

    const report = await next.recoverRuns();

    assert.equal(report.finalized, 0, 'a run that had been handled was handled again');
    assert.equal(env.events.length, eventsBefore, 'its events were published a second time');
    assert.equal(JSON.stringify(env.state.getAll().job), historyBefore);
    assert.ok(job);
  });

  test('its folder is cleaned up once it has been handled for a while, when the job next starts', async () => {
    const { env, job } = await runOnce();
    const runsRoot = path.join(env.dir, 'runs', 'job');
    const old = fs.readdirSync(runsRoot)[0];
    const longAgo = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(runsRoot, old, 'done'), longAgo, longAgo);

    await env.sched._fire(job);

    assert.ok(!fs.existsSync(path.join(runsRoot, old)), 'a folder handled an hour ago is still there');
    assert.equal(fs.readdirSync(runsRoot).length, 1, 'the run that just ended keeps its folder for now');
    assert.ok(runDirFor);
  });
});

describe('a job that cannot be started', () => {
  test('is a failed run with the reason in its log, not an exception', async () => {
    const job = { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'wait', command: 'whatever' };
    const env = makeEnv(job, { supervisor: async () => { throw new Error('the supervisor did not report within 10000 ms'); } });

    const result = await env.sched._fire(job);

    assert.deepEqual(result, { exitCode: 1 });
    assert.deepEqual(names(env.events), ['job.failed']);
    assert.equal(env.state.get('job').exitCode, 1);
    assert.match(runLog(env.dir, 'job'), /\[error\] could not start the job: the supervisor did not report/);
  });

  test('a bad working directory is reported by the supervisor and ends as a failed run with the reason in the log', async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sup-script-'));
    const job = { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'wait',
      cwd: path.join(holder, 'missing'), command: script(holder, 'job.js', 'process.exit(0)') };
    const env = makeEnv(job);

    const result = await env.sched._fire(job);

    assert.deepEqual(result, { exitCode: 1 });
    assert.match(runLog(env.dir, 'job'), /\[error\] could not start the job: /);
  });
});
