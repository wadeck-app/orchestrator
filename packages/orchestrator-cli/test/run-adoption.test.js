'use strict';

// A job still running when the daemon restarts. "Daemon A" starts a supervised job and goes away without ending
// it (detachRuns, which is what a shutdown does); "daemon B" starts from the same config dir and must follow the
// job again as if nothing had happened: same history entry, same log, kill, timeout, peaks, no second copy.
// Real supervisors and real processes: the thing under test is the agreement between the daemon and the files.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { spawn } = require('node:child_process');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { findSupervisorBinary } = require('../src/platform-binary');
const { startSupervised, runDirFor } = require('../src/supervised-run');

const supervisorPath = findSupervisorBinary();
if (supervisorPath === null) {
  throw new Error(
    'No supervisor binary for this platform. Build it with: npm run build-supervisor --workspace=packages/orchestrator-cli '
    + '(needs Go). This test does not skip: a skipped test would report a green run that exercised nothing.',
  );
}

const schedulers = [];
const helpers = [];
afterEach(async () => {
  while (schedulers.length > 0) {
    const s = schedulers.pop();
    try { s.detachRuns(); } catch { /* already detached */ }
    await s.stop();
  }
  while (helpers.length > 0) {
    try { helpers.pop().kill(); } catch { /* already gone */ }
  }
});

function cronJob(dir, source, extra = {}) {
  const file = path.join(dir, `job-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, source);
  return { id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'fire-and-forget', command: `node "${file}"`, ...extra };
}

/** One "daemon": a state and a scheduler over the shared config dir. */
function daemon(dir, jobs, extra = {}) {
  const registry = new Registry(path.join(dir, 'registry.json'));
  registry.load();
  for (const job of jobs) {
    if (registry.get(job.id) === null) {
      registry.add(job);
    }
  }
  const state = new State(path.join(dir, 'state.json'));
  const events = [];
  const spawned = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    liveness: async () => false,
    sampleUsage: async () => null,
    eventPublisher: { publish: (event, payload) => events.push({ event, payload }) },
    supervisor: (request) => startSupervised({ supervisorPath, configDir: dir, heartbeatMs: 50, pollMs: 25 }, request),
    catchUpInitialDelayMs: 3_600_000,
    ...extra,
  });
  schedulers.push(sched);
  return { sched, state, registry, events, spawned };
}

const names = (events) => events.map((e) => e.event);

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(what, predicate, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function runLog(dir, jobId) {
  const folder = path.join(dir, 'logs', 'jobs', jobId);
  const files = fs.readdirSync(folder).filter((f) => f.endsWith('.log')).sort();
  return fs.readFileSync(path.join(folder, files[files.length - 1]), 'utf8');
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-adopt-'));
}

/** Daemon A starts the job and goes away, leaving it running. Returns what B needs to know. */
async function startAndLeave(dir, job, extra = {}) {
  const a = daemon(dir, [job], extra);
  const { pid } = await a.sched._fire(job);
  a.state.flushNow();
  a.sched.detachRuns();
  await a.sched.stop();
  return { pid, a };
}

describe('a job still running when the daemon restarts (case 3)', () => {
  test('is followed again: running, in the history, with the same pid', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => console.log("tick"), 100)');
    const { pid } = await startAndLeave(dir, job);
    const b = daemon(dir, [job]);

    const report = await b.sched.recoverRuns();

    assert.equal(report.adopted, 1);
    assert.equal(b.sched.runningCount('job'), 1);
    assert.equal(b.state.getOpenRuns('job').length, 1);
    assert.equal(b.state.getOpenRuns('job')[0].pid, pid);
    assert.equal(isAlive(pid), true);
    await b.sched.killJob('job');
  });

  test('keeps writing to the same run log, and says in it that the daemon is following the run again', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => console.log("tick"), 100)');
    await startAndLeave(dir, job);
    const before = runLog(dir, 'job').split('\n').filter((l) => l.includes('tick')).length;
    const b = daemon(dir, [job]);

    await b.sched.recoverRuns();
    await until('new output after the adoption', () => runLog(dir, 'job').split('\n').filter((l) => l.includes('tick')).length > before + 2);

    assert.match(runLog(dir, 'job'), /\[recovery\] the daemon is following this run again/);
    await b.sched.killJob('job');
  });

  test('can be killed after the restart: announced, cancelled in the history, the process gone', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => {}, 1000)');
    const { pid } = await startAndLeave(dir, job);
    const b = daemon(dir, [job]);
    await b.sched.recoverRuns();

    const killed = await b.sched.killJob('job');
    await until('the run to be closed', () => b.state.get('job').finishedAt !== undefined);

    assert.deepEqual(killed, { killed: true, count: 1 });
    assert.ok(names(b.events).includes('job.killed_manual'), names(b.events).join(', '));
    assert.equal(b.state.get('job').cancelledByUser, true);
    await until('the process to be gone', () => !isAlive(pid));
  });

  test('ends normally after the restart: real exit code, finish marker, events, not flagged late', async () => {
    const dir = tmpDir();
    // The job ends when told to, so it is certainly still going when the new daemon looks for it.
    const release = path.join(dir, 'release');
    const job = cronJob(dir, `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(6); }, 50)`);
    await startAndLeave(dir, job);
    const b = daemon(dir, [job]);
    const report = await b.sched.recoverRuns();
    assert.equal(report.adopted, 1);

    fs.writeFileSync(release, '');
    await until('the run to be closed', () => b.state.get('job').exitCode === 6);

    assert.deepEqual(names(b.events), ['job.failed']);
    assert.equal(b.events[0].payload.late, undefined, 'the daemon saw this end happen');
    assert.match(runLog(dir, 'job'), /\[job:finished\] exitCode=6 /);
  });

  test('the peaks measured before the restart are not lowered by the measures after it', async () => {
    const dir = tmpDir();
    const release = path.join(dir, 'release');
    const job = cronJob(dir, `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(0); }, 50)`);
    const a = daemon(dir, [job], { peakFlushMs: 0 });
    const { pid } = await a.sched._fire(job);
    const open = a.state.getOpenRuns('job')[0];
    a.state.record('job', { ...open, peakRamMb: 500, peakCpuPct: 40, peakMeasure: 2 });
    a.state.flushNow();
    a.sched.detachRuns();
    await a.sched.stop();
    const b = daemon(dir, [job], { sampleUsage: async () => ({ cpuPct: 1, ramMb: 5, processes: [], walked: 1, counted: 1 }) });
    await b.sched.recoverRuns();
    assert.equal(b.state.getOpenRuns('job')[0].pid, pid);

    // Let a few samples of 1 % / 5 MB come in, all of them lower than what was measured before the restart.
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(release, '');
    await until('the run to be closed', () => b.state.get('job').exitCode === 0);

    assert.equal(b.state.get('job').peakRamMb, 500);
    assert.equal(b.state.get('job').peakCpuPct, 40);
  });

  test('keeps enforcing the timeout with the time already used', async () => {
    const dir = tmpDir();
    // 4 s of timeout, 2.5 s of them used while the daemon is away: about 1.5 s are left when it comes back (less if
    // finding the run again is slow, as it is on a loaded Windows runner, and then the timeout is already over and
    // fires at once). A daemon that granted the whole timeout again would end the run 4 s AFTER it came back.
    const job = cronJob(dir, 'setInterval(() => {}, 1000)', { timeoutSeconds: 4 });
    await startAndLeave(dir, job);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const b = daemon(dir, [job]);
    await b.sched.recoverRuns();
    const cameBackAt = Date.now();

    await until('the timeout', () => names(b.events).includes('job.timed_out'), 20_000);

    const waited = Date.now() - cameBackAt;
    assert.ok(waited < 3000, `the run ended ${waited} ms after the daemon came back, with 4 s of timeout of which 2.5 s were already used: the whole timeout was granted again`);
    assert.match(runLog(dir, 'job'), /\[job:timeout\]/);
  });
});

describe('a startup job whose run is still going (case 11)', () => {
  test('is not started a second time when the daemon comes back; the skip is recorded with its reason', async () => {
    const dir = tmpDir();
    const job = { ...cronJob(dir, 'setInterval(() => {}, 1000)'), type: 'startup', delaySeconds: 0, schedule: undefined };
    await startAndLeave(dir, job);
    const b = daemon(dir, [job], { supervisor: () => { throw new Error('a second copy was started'); } });
    await b.sched.recoverRuns();

    await b.sched.start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(b.sched.runningCount('job'), 1);
    assert.ok(names(b.events).includes('job.skipped'), names(b.events).join(', '));
    assert.match(runLog(dir, 'job'), /still running from before the restart/);
    await b.sched.killJob('job');
  });

  // Seen live: every daemon restart wrote a history entry and a log file of its own for the refused startup firing.
  // That "run" was then the newest one, so the dashboard showed the server as ended (it decides from the newest
  // entry) and the log page labelled the empty one "Live" and pulled the tail off the real server's output.
  // The refusal belongs where a refusal for concurrency already goes: an event, and a line in the log of the run
  // that holds the slot.
  test('leaves no run of its own: the followed run stays the newest entry and the only log file', async () => {
    const dir = tmpDir();
    const job = { ...cronJob(dir, 'setInterval(() => {}, 1000)'), type: 'startup', delaySeconds: 0, schedule: undefined };
    await startAndLeave(dir, job);
    const b = daemon(dir, [job], { supervisor: () => { throw new Error('a second copy was started'); } });
    await b.sched.recoverRuns();
    const followed = b.state.getOpenRuns('job')[0];

    await b.sched.start();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const runs = b.state.getAll()['job'] ?? [];
    assert.equal(runs.length, 1, `a skip was recorded as a run: ${JSON.stringify(runs)}`);
    assert.equal(runs[0].startedAt, followed.startedAt);
    assert.equal(runs[0].skipped, undefined);
    assert.equal(fs.readdirSync(path.join(dir, 'logs', 'jobs', 'job')).filter((f) => f.endsWith('.log')).length, 1, 'the skip got a log file of its own');
    assert.match(runLog(dir, 'job'), /reason=adopted/);
    await b.sched.killJob('job');
  });
});

describe('finding the runs again takes one look at the process table, not one per run', () => {
  // Seen live: each look costs about a second on Windows, so seven runs delayed the daemon's readiness by nine
  // seconds, and `orch restart` took the silence for a dead daemon and started a second one.
  test('the start times of all the supervisors are asked for at once', async () => {
    const dir = tmpDir();
    const jobs = [1, 2, 3].map((n) => ({ ...cronJob(dir, 'setInterval(() => {}, 1000)'), id: `job${n}` }));
    const a = daemon(dir, jobs);
    for (const job of jobs) {
      await a.sched._fire(job);
    }
    a.state.flushNow();
    a.sched.detachRuns();
    await a.sched.stop();
    const asked = [];
    const { processStartsOf } = require('../src/supervised-run');
    const b = daemon(dir, jobs, {
      processStarts: async (pids) => { asked.push([...pids]); return processStartsOf(pids); },
    });

    const report = await b.sched.recoverRuns();

    assert.equal(report.adopted, 3);
    assert.equal(asked.length, 1, `the process table was read ${asked.length} times for 3 runs`);
    assert.equal(asked[0].length, 3);
    for (const job of jobs) {
      await b.sched.killJob(job.id);
    }
  });
});

describe('a run that cannot be followed', () => {
  test('a supervisor that is gone without recording an end is reported as lost and the run is closed, not adopted (case 6)', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => {}, 1000)');
    const { pid } = await startAndLeave(dir, job);
    const runDirs = fs.readdirSync(path.join(dir, 'runs', 'job'));
    const status = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'job', runDirs[0], 'status.json'), 'utf8'));
    process.kill(status.supervisorPid);
    await until('the supervisor to be gone', () => !isAlive(status.supervisorPid));
    const b = daemon(dir, [job]);

    const report = await b.sched.recoverRuns();

    assert.equal(report.adopted, 0);
    assert.equal(report.lost.length, 1);
    assert.match(report.lost[0], new RegExp(String(status.supervisorPid)));
    assert.equal(b.sched.runningCount('job'), 0);
    try { process.kill(pid); } catch { /* the job may have gone with it */ }
  });

  test('a supervisor pid now held by an unrelated process is not mistaken for the supervisor (case 8)', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => {}, 1000)');
    const { pid } = await startAndLeave(dir, job);
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    helpers.push(stranger);
    const runDirs = fs.readdirSync(path.join(dir, 'runs', 'job'));
    const statusFile = path.join(dir, 'runs', 'job', runDirs[0], 'status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    process.kill(status.supervisorPid);
    await until('the supervisor to be gone', () => !isAlive(status.supervisorPid));
    // The recorded supervisor pid is now "reused": alive, but started long after the supervisor did.
    fs.writeFileSync(statusFile, JSON.stringify({ ...status, supervisorPid: stranger.pid, supervisorStartedAt: '2020-01-01T00:00:00.000Z' }));
    const b = daemon(dir, [job]);

    const report = await b.sched.recoverRuns();

    assert.equal(report.adopted, 0, 'an unrelated process was adopted as a supervisor');
    assert.equal(report.lost.length, 1);
    try { process.kill(pid); } catch { /* already gone */ }
  });

  test('a run another live daemon already follows is left to it (case 12)', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => {}, 1000)');
    await startAndLeave(dir, job);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    helpers.push(other);
    const runDirs = fs.readdirSync(path.join(dir, 'runs', 'job'));
    fs.writeFileSync(path.join(dir, 'runs', 'job', runDirs[0], 'owner.json'), JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }));
    const b = daemon(dir, [job]);

    const report = await b.sched.recoverRuns();

    assert.equal(report.adopted, 0);
    assert.equal(report.followedElsewhere, 1);
    assert.equal(b.sched.runningCount('job'), 0);
    const owner = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'job', runDirs[0], 'owner.json'), 'utf8'));
    assert.equal(owner.pid, other.pid, 'the other daemon\'s claim must be left alone');
  });

  // Seen live: `orch restart` started a second daemon while the first was still finding its runs again. The
  // second one saw the runs as "followed elsewhere" and then ended five of them in the shared history as orphaned,
  // while they were running and being followed by the first.
  test('a run another live daemon follows is not closed as orphaned: the startup sweep must leave it open', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => {}, 1000)');
    await startAndLeave(dir, job);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    helpers.push(other);
    const runDirs = fs.readdirSync(path.join(dir, 'runs', 'job'));
    fs.writeFileSync(path.join(dir, 'runs', 'job', runDirs[0], 'owner.json'), JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }));
    const b = daemon(dir, [job]);
    await b.sched.recoverRuns();
    const open = b.state.getOpenRuns('job')[0];

    assert.equal(b.sched.isFollowing('job', open.startedAt), true);
    const closed = b.state.closeOrphanedRuns(new Date(), (id, entry) => b.sched.isFollowing(id, entry.startedAt));

    assert.equal(closed, 0, 'a run that is still going was closed as orphaned');
    assert.equal(b.state.getOpenRuns('job').length, 1);
  });

  test('a run left to another daemon is followed by this one when that daemon goes away', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => {}, 1000)');
    const { pid } = await startAndLeave(dir, job);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    helpers.push(other);
    const runDirs = fs.readdirSync(path.join(dir, 'runs', 'job'));
    fs.writeFileSync(path.join(dir, 'runs', 'job', runDirs[0], 'owner.json'), JSON.stringify({ pid: other.pid, startedAt: new Date().toISOString() }));
    const b = daemon(dir, [job], { ownerWatchMs: 100 });
    await b.sched.recoverRuns();
    assert.equal(b.sched.runningCount('job'), 0);

    other.kill();
    await until('the other daemon to be gone', () => !isAlive(other.pid));
    await until('this daemon to follow the run', () => b.sched.runningCount('job') === 1);

    assert.equal(b.state.getOpenRuns('job')[0].pid, pid);
    await b.sched.killJob('job');
  });

  test('a run whose owner is a dead daemon is taken over', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setInterval(() => {}, 1000)');
    await startAndLeave(dir, job);
    const runDirs = fs.readdirSync(path.join(dir, 'runs', 'job'));
    fs.writeFileSync(path.join(dir, 'runs', 'job', runDirs[0], 'owner.json'), JSON.stringify({ pid: 2_000_000_000, startedAt: '2020-01-01T00:00:00.000Z' }));
    const b = daemon(dir, [job]);

    const report = await b.sched.recoverRuns();

    assert.equal(report.adopted, 1);
    await b.sched.killJob('job');
  });
});

describe('detaching on shutdown (the daemon must be able to exit and leave the job running)', () => {
  test('a detached daemon neither follows nor ends the job, which keeps running', async () => {
    const dir = tmpDir();
    const job = cronJob(dir, 'setTimeout(() => process.exit(0), 600)');
    const a = daemon(dir, [job]);
    const { pid } = await a.sched._fire(job);

    a.sched.detachRuns();
    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal(isAlive(pid), false, 'the job should have ended by itself');
    assert.deepEqual(names(a.events), ['job.started'], 'a detached daemon must not finalize a run it no longer follows');
    assert.equal(a.state.getOpenRuns('job').length, 1, 'the run stays open, for the next daemon to finish');
    assert.ok(fs.existsSync(runDirFor(dir, 'job', a.state.getOpenRuns('job')[0].startedAt)), 'the run folder is what the next daemon needs');
  });
});
