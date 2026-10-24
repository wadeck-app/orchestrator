'use strict';

// One function per way a job can start, end or be refused, each driving the REAL Scheduler / commands / ExecManager and
// returning the harness it ran in (see event-harness.js). The per-event tests assert what each scenario publishes; the
// contract test runs all of them and checks the properties that hold for every one (one terminal event per run, the
// catalog flags agree with what happened).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeHarness, cronJob, settle, leaveRun, capturingPublisher, track } = require('./event-harness');
const { makeCommands } = require('../../src/commands');
const { ExecManager } = require('../../src/exec-manager');
const { getNextFirings } = require('../../src/cronNext');
const { FakeTime } = require('../../src/time-service');
const { PEAK_MEASURE_VERSION } = require('../../src/types');

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Advances the fake clock to just after the next firing of the job's cron expression. */
async function fireNextCron(h, jobId = 'job') {
  const job = h.registry.get(jobId);
  const next = getNextFirings(job.schedule, 1, new Date(h.time.now()))[0];
  await h.time.advanceAsync(next.getTime() - h.time.now() + 1000, MINUTE);
  await settle();
  return next;
}

/** The commands the daemon serves, over a harness, with the capturing publisher as their event publisher. */
function commandsOf(h, extra = {}) {
  return makeCommands(h.registry, h.state, h.sched, h.dir, extra.tray, undefined, extra.events ?? h.publisher);
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs of a job, by how they end

const S = {};

S.success = async () => {
  const h = makeHarness([cronJob()], { exits: [0] });
  await h.sched.trigger('job');
  await settle();
  return h;
};

S.failure = async () => {
  const h = makeHarness([cronJob()], { exits: [3] });
  await h.sched.trigger('job');
  await settle();
  return h;
};

S.skipExitCode = async () => {
  const h = makeHarness([cronJob({ skipExitCodes: [3] })], { exits: [3] });
  await h.sched.trigger('job');
  await settle();
  return h;
};

S.manualKill = async () => {
  // A retry is configured: a stopped run must neither fail nor retry.
  const h = makeHarness([cronJob({ retryOnExitCodes: [143], retryDelays: [60] })], { exits: [undefined] });
  await h.sched.trigger('job');
  await h.sched.killJob('job');
  await settle();
  return h;
};

/** @param {number} exitAfterKill the code the process ends with once the timeout killed it */
S.timeout = async (exitAfterKill = 143, job = {}) => {
  const h = makeHarness([cronJob({ timeoutSeconds: 5, ...job })], { exits: [undefined] });
  await h.sched.trigger('job');
  h.children[0].killExitCode = exitAfterKill;
  await h.time.advanceAsync(5000, 1000);
  await settle();
  return h;
};

S.timeoutThenZero = () => S.timeout(0);
S.timeoutThenSkipCode = () => S.timeout(7, { skipExitCodes: [7] });

S.startFailure = async () => {
  const h = makeHarness([cronJob()], { scheduler: { spawn: () => { throw new Error('spawn ENOENT'); } } });
  await h.sched.trigger('job');
  await settle();
  return h;
};

S.supervisorStartFailure = async () => {
  const h = makeHarness([cronJob()], { scheduler: { supervisor: async () => { throw new Error('the supervisor did not answer'); } } });
  await h.sched.trigger('job');
  await settle();
  return h;
};

S.concurrencyRefusal = async () => {
  const h = makeHarness([cronJob({ maxConcurrency: 1 })], { exits: [undefined] });
  await h.sched.trigger('job');
  h.refusal = await h.sched.trigger('job');
  await settle();
  return h;
};

/** A cron firing while the target of the liveness check is already up. */
S.livenessSkip = async () => {
  const h = makeHarness([cronJob({ schedule: '*/5 * * * *' })], { scheduler: { liveness: async () => true } });
  await h.sched.start();
  await fireNextCron(h);
  return h;
};

/** A startup firing while the run of the job is still going from before the daemon restarted. */
S.adoptedRefusal = async () => {
  const h = makeHarness([cronJob({ type: 'startup', schedule: undefined, delaySeconds: 0 })], { exits: [0] });
  // The seam: a run found going after a restart is registered under this key (see run-adoption.test.js for the real thing).
  h.sched._followed.add('job|2026-01-01T00:00:00.000Z');
  await h.sched.start();
  await settle();
  return h;
};

/** A parent that succeeds while its dependent is at its limit. */
S.dependencyRefusal = async () => {
  const h = makeHarness([cronJob({ id: 'parent' }), cronJob({ id: 'child', dependsOn: 'parent', maxConcurrency: 1 })], { exits: [undefined] });
  await h.sched.trigger('child');
  await h.sched.trigger('parent');
  // The parent is the second child; it ends and its dependent, already at its limit, is refused.
  h.children[1].exit(0);
  await settle();
  return h;
};

S.recovered = async () => {
  const h = makeHarness([cronJob()], { exits: [1, 0] });
  await h.sched.trigger('job');
  await settle();
  await h.sched.trigger('job');
  await settle();
  return h;
};

S.anomaly = async () => {
  // The fake clock starts 30 s ago: the run lasts about 30 s against three earlier runs of one second.
  const h = makeHarness([cronJob()], { exits: [0], startedAgoMs: 30_000 });
  const hourAgo = Date.now() - 60 * MINUTE;
  for (let i = 0; i < 3; i++) {
    const start = new Date(hourAgo + i * MINUTE);
    h.state.record('job', { startedAt: start.toISOString(), finishedAt: new Date(start.getTime() + 1000).toISOString(), exitCode: 0, pid: 1 });
  }
  await h.sched.trigger('job');
  await settle();
  return h;
};

S.consecutiveFailures = async (failures = 4) => {
  const h = makeHarness([cronJob()], { exits: [1] });
  for (let i = 0; i < failures; i++) {
    await h.sched.trigger('job');
    await settle();
  }
  return h;
};

/** Exit code 75 is retried after 10 s then 20 s; the third attempt is the last. */
S.retryExhausted = async () => {
  const h = makeHarness([cronJob({ retryOnExitCodes: [75], retryDelays: [10, 20], alertAfterFailures: 99 })], { exits: [75] });
  await h.sched.trigger('job');
  await settle();
  await h.time.advanceAsync(10_000, 1000);
  await settle();
  await h.time.advanceAsync(20_000, 1000);
  await settle();
  return h;
};

/** A cron job with an SLA window of 3 minutes, firing every 5, whose runs end with `exit`. */
S.sla = async (exit = 1, windowMinutes = 3, firings = 1) => {
  const h = makeHarness([cronJob({ schedule: '*/5 * * * *', slaWindowMinutes: windowMinutes, alertAfterFailures: 99 })], { exits: [exit] });
  await h.sched.start();
  h.firedAt = [];
  for (let i = 0; i < firings; i++) {
    h.firedAt.push(await fireNextCron(h));
  }
  await h.time.advanceAsync(windowMinutes * MINUTE, MINUTE);
  await settle();
  return h;
};

S.windowExpired = async () => {
  const h = makeHarness([]);
  const activeUntil = new Date(h.time.now() + DAY).toISOString();
  h.registry.add(cronJob({ activeUntil }));
  h.activeUntil = activeUntil;
  await h.sched.start();
  await h.time.advanceAsync(DAY + MINUTE, 60 * MINUTE);
  await settle();
  return h;
};

// ---------------------------------------------------------------------------------------------------------------------
// Runs closed with no process to watch: every closer of a run in the history must announce it, exactly once

/** An entry left open by a daemon that is gone: started, never finished, its process (pid) does not exist. */
function leaveOpenEntry(h, startedAt = new Date(h.time.now() - 5 * MINUTE).toISOString()) {
  h.state.record('job', { startedAt, exitCode: null, pid: 2_000_000_000, triggeredBy: { kind: 'cron' } });
  return startedAt;
}

/** `orch kill` on a job the history shows running but that has no live process in this daemon. */
S.staleKill = async () => {
  const h = makeHarness([cronJob()]);
  h.startedAt = leaveOpenEntry(h);
  h.reply = await h.sched.killJob('job');
  await settle();
  return h;
};

/** recoverRuns finds a run whose supervisor is gone without having recorded an end. */
S.lostSupervisor = async () => {
  const h = makeHarness([cronJob()], {
    scheduler: { now: () => new Date(NOW), processStarts: async () => new Map(), spawn: () => { throw new Error('recovery must not start anything'); } },
  });
  leaveRun(h, NOW, { status: { state: 'running', supervisorPid: 2_000_000_000, supervisorStartedAt: '2026-10-18T10:30:00.000Z' } });
  h.report = await h.sched.recoverRuns();
  return h;
};

/** The daemon starts and sweeps the runs the previous daemon left open (index.ts, after recoverRuns). */
S.orphanedAtStart = async () => {
  const h = makeHarness([cronJob()]);
  h.startedAt = leaveOpenEntry(h);
  h.closed = h.sched.closeInterruptedRuns(new Date(h.time.now()));
  await settle();
  return h;
};

/** Scheduler.start() finds an open entry whose process is dead (the sweep above did not run first). */
S.staleAtStart = async () => {
  const h = makeHarness([cronJob({ type: 'startup', schedule: undefined, delaySeconds: 3600 })]);
  h.startedAt = leaveOpenEntry(h);
  await h.sched.start();
  await settle();
  return h;
};

// ---------------------------------------------------------------------------------------------------------------------
// Resource limits: a real process (so the kill is a real one), a sampler and a clock the test drives
//
// Nothing here waits for time: the sample interval runs on the fake clock, which the test advances; the process ends
// when the test releases it (a file it looks for) or when the monitor kills it, and the test awaits the scheduler's own
// 'job-finished' for that.

function resourceHarness({ sampleUsage, enforce, id = 'res' }) {
  // The fake clock starts a second ago: the run lasts about that long, well inside 3x the seeded 5 s runs (no anomaly).
  const h = makeHarness([], { startedAgoMs: 1000, scheduler: { spawn: undefined, sampleUsage, sampleIntervalMs: 50, sustainSamples: 2 } });
  h.release = path.join(h.dir, `${id}.release`);
  h.running = path.join(h.dir, `${id}.running`);
  const script = path.join(h.dir, `${id}.js`);
  // Says it is up before anything else: the monitor must not kill the shell around it while it is still starting.
  fs.writeFileSync(script, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(h.running)}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(h.release)})) { process.exit(0); } }, 10);`);
  // A baseline of 10 % / 100 MB: soft 15 % / 150 MB, hard 30 % / 300 MB.
  for (let i = 0; i < 3; i++) {
    h.state.record(id, {
      startedAt: `2026-08-22T08:0${i}:00Z`, finishedAt: `2026-08-22T08:0${i}:05Z`,
      exitCode: 0, pid: 100 + i, peakCpuPct: 10, peakRamMb: 100, peakMeasure: PEAK_MEASURE_VERSION,
    });
  }
  h.registry.add({
    id, type: 'cron', schedule: '0 8 * * *', label: 'Res', enabled: true, triggerMode: 'fire-and-forget',
    command: `"${process.execPath}" "${script}"`,
    ...(enforce === undefined ? {} : { resourceLimits: { enforce } }),
  });
  return h;
}

/** Runs `samples` sample intervals on the fake clock, then lets the process end by itself unless the monitor kills it first. */
async function runWithSamples(h, { samples, release }) {
  await h.sched.trigger('res');
  await untilTrue(() => fs.existsSync(h.running));
  await h.time.advanceAsync(samples * 50, 50);
  if (release) {
    fs.writeFileSync(h.release, '');
  }
  await h.untilFinished(1);
  await settle();
  return h;
}

/** Over the hard budget for good: the tree is killed and the run ends as a failure. */
S.resourceKill = () => runWithSamples(
  resourceHarness({ sampleUsage: async () => ({ cpuPct: 5000, ramMb: 5000 }) }),
  { samples: 4, release: false },
);

/** Same load, enforce: warn. The process is left alone and ends when released. */
S.resourceWarn = () => runWithSamples(
  resourceHarness({ enforce: 'warn', sampleUsage: async () => ({ cpuPct: 5000, ramMb: 5000 }) }),
  { samples: 6, release: true },
);

/** Over the soft budget (15 % / 150 MB), under the hard one (30 % / 300 MB). */
S.resourceSoft = () => runWithSamples(
  resourceHarness({ sampleUsage: async () => ({ cpuPct: 20, ramMb: 200 }) }),
  { samples: 6, release: true },
);

/** enforce: off checks nothing: the same load as the kill scenario, no resource event, the run ends when released. */
S.resourceOff = () => runWithSamples(
  resourceHarness({ enforce: 'off', sampleUsage: async () => ({ cpuPct: 5000, ramMb: 5000 }) }),
  { samples: 6, release: true },
);

// ---------------------------------------------------------------------------------------------------------------------
// Runs that ended while the daemon was down, learned when it came back

const NOW = Date.parse('2026-10-18T12:00:00.000Z');

async function lateRun(job, status, leave = {}) {
  const h = makeHarness([cronJob(job)], {
    scheduler: {
      now: () => new Date(NOW),
      lateActionWindowMs: 30 * MINUTE,
      spawn: () => { throw new Error('recovery must not start anything itself'); },
    },
  });
  h.left = leaveRun(h, NOW, { status, ...leave });
  h.report = await h.sched.recoverRuns();
  return h;
}

S.lateCompleted = () => lateRun({}, { exitCode: 0 });
S.lateFailed = () => lateRun({}, { exitCode: 5 });
S.lateSkipCode = () => lateRun({ skipExitCodes: [5] }, { exitCode: 5 });
S.lateTimeout = () => lateRun({ timeoutSeconds: 300 }, { exitCode: 143, timedOut: true, killed: true, killReason: 'timeout' });
S.lateKilledManual = () => lateRun({}, { exitCode: 143, killed: true, killReason: 'manual' });

// ---------------------------------------------------------------------------------------------------------------------
// The commands the daemon serves (the requests; the runs they cause are the scheduler's)

const ASKER = { ip: '10.0.0.7', userAgent: 'orch-cli/1' };

S.commandTrigger = async () => {
  const h = makeHarness([cronJob()], { exits: [0] });
  h.reply = await commandsOf(h)['trigger-job']({ id: 'job', ...ASKER });
  await settle();
  return h;
};

/** Triggered twice at maxConcurrency 1: the second request is refused (a request is still announced). */
S.commandTriggerRefused = async () => {
  const h = makeHarness([cronJob({ maxConcurrency: 1 })], { exits: [undefined] });
  const commands = commandsOf(h);
  h.replies = [await commands['trigger-job']({ id: 'job', ...ASKER }), await commands['trigger-job']({ id: 'job', ...ASKER })];
  await settle();
  return h;
};

S.commandKill = async () => {
  const h = makeHarness([cronJob()], { exits: [undefined] });
  const commands = commandsOf(h);
  await commands['trigger-job']({ id: 'job', ...ASKER });
  h.reply = await commands['kill-job']({ id: 'job', ...ASKER });
  await settle();
  return h;
};

/** A request to stop a job that is not running. */
S.commandKillIdle = async () => {
  const h = makeHarness([cronJob()], { exits: [0] });
  h.reply = await commandsOf(h)['kill-job']({ id: 'job', ...ASKER });
  await settle();
  return h;
};

S.commandRestartRunning = async () => {
  const h = makeHarness([cronJob()], { exits: [undefined], scheduler: { restartGraceMs: 2000 } });
  const commands = commandsOf(h);
  await commands['trigger-job']({ id: 'job', ...ASKER });
  h.mark = h.events.length;
  h.reply = await commands['restart-job']({ id: 'job', ...ASKER });
  await settle();
  return h;
};

S.commandRestartIdle = async () => {
  const h = makeHarness([cronJob()], { exits: [undefined], scheduler: { restartGraceMs: 2000 } });
  h.reply = await commandsOf(h)['restart-job']({ id: 'job', ...ASKER });
  await settle();
  return h;
};

/** `orch restart`: the tray is a stub, so the test process is not exited. */
S.daemonRestart = async () => {
  const h = makeHarness([], {});
  h.trayCalls = 0;
  const tray = { triggerRestart: async () => { h.trayCalls++; } };
  commandsOf(h, { tray })['restart']();
  await settle();
  return h;
};

// ---------------------------------------------------------------------------------------------------------------------
// `orch exec`: a real (short) process through the real ExecManager

const EXEC_END = (e) => e.event === 'exec.completed' || e.event === 'exec.failed';

/**
 * Resolves once the predicate holds. For a state of a process that is not ours (it has started, it has printed), which
 * gives no other signal; the outcome never depends on how long it takes, only on the condition becoming true.
 */
async function untilTrue(predicate) {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A command that says it is running, then stays up: killing it before it said so races with the shell starting it. */
const LONG_RUNNING = "console.log('ready'); setInterval(() => {}, 1000);";

/** @param {{kill?: boolean, timeoutSeconds?: number}} options a timeout runs on the fake clock, advanced by the test */
async function execRun(source, { kill = false, timeoutSeconds, label = 'build' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-exec-ev-'));
  const script = path.join(dir, 'exec.js');
  fs.writeFileSync(script, source);
  const captured = capturingPublisher();
  const time = new FakeTime(Date.now());
  const manager = new ExecManager(dir, captured.publisher, { time });
  const started = manager.fireExec(`"${process.execPath}" "${script}"`, { label, timeout: timeoutSeconds });
  const run = { kind: 'exec', dir, manager, started, events: captured.events, problems: captured.problems };
  track(run);
  if (kill || timeoutSeconds !== undefined) {
    await untilTrue(() => manager.get(started.runId).logs.includes('ready'));
  }
  if (kill) {
    manager.kill(started.runId);
  }
  if (timeoutSeconds !== undefined) {
    time.advance(timeoutSeconds * 1000);
  }
  await captured.when(EXEC_END);
  return run;
}

S.execSuccess = () => execRun('process.exit(0);');
S.execFailure = () => execRun('process.exit(3);');
S.execKilled = () => execRun(LONG_RUNNING, { kill: true });
S.execTimeout = () => execRun(LONG_RUNNING, { timeoutSeconds: 1 });

// ---------------------------------------------------------------------------------------------------------------------
// The real daemon process (src/index.ts) pushing to a fake queue daemon (the SDK's own testing double)

const DAEMON_ENTRY = path.join(__dirname, '..', '..', 'src', 'index.ts');

/**
 * Starts the real daemon against a throwaway config dir and a fake queue. No waiting on time anywhere:
 *   run.ready   resolves on the line the daemon prints once it is serving and its scheduler has started
 *   run.exited  resolves with the exit code when the process ends (a daemon that failed to start never gets ready)
 *   run.quit()  asks it to stop through its own /quit command, which flushes the events still in flight before it exits,
 *               so everything it published is at the queue when run.exited resolves
 * Cleaned by stopAll through `cleanup`.
 */
function startRealDaemon({ dir, queue, beforeStart } = {}) {
  const { startFakeQueueDaemon } = require('@wadeck-app/queue-sdk/testing');
  const { spawn, spawnSync } = require('node:child_process');
  const http = require('node:http');
  return (async () => {
    const ownQueue = queue === undefined;
    const fake = queue ?? await startFakeQueueDaemon();
    const configDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orch-daemon-ev-'));
    beforeStart?.(configDir);
    const child = spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), DAEMON_ENTRY, '--config-dir', configDir], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // The preload of the suite switches the SDK off: this test is the one that delivers, to the fake queue.
        QUEUE_SDK_OFF: '0',
        QUEUE_CONFIG_DIR: fake.configDir,
        ORCH_CONFIG_DIR: configDir,
        APP_CORE_CONFIG_DIR: path.join(configDir, 'no-app-core'),
      },
    });
    let output = '';
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    const exited = new Promise((resolve) => { child.once('exit', (code) => resolve(code)); });
    const onData = (d) => {
      output += d;
      if (/\[orchestrator\] daemon ready/.test(output)) { markReady(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const run = {
      kind: 'daemon', dir: configDir, queue: fake, child, problems: [], ready, exited,
      output: () => output,
      pushes: () => fake.pushes(),
      events: [],
      /** POST /quit with the daemon's own token, then wait for the process to end. */
      quit: async () => {
        const { port } = JSON.parse(fs.readFileSync(path.join(configDir, 'config.port'), 'utf8'));
        const token = fs.readFileSync(path.join(configDir, 'health_token'), 'utf8').trim();
        await new Promise((resolve, reject) => {
          const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/quit', headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' } }, (res) => { res.resume(); resolve(); });
          req.on('error', reject);
          req.end();
        });
        const code = await exited;
        run.events = fake.pushes().map((p) => ({ event: p.event, payload: p.payload }));
        return code;
      },
      cleanup: async () => {
        if (child.pid !== undefined && child.exitCode === null) {
          if (process.platform === 'win32') {
            spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
          } else {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
          }
        }
        if (ownQueue) { await fake.close(); }
      },
    };
    track(run);
    return run;
  })();
}

/** The scenario: a daemon starts, serves, and is stopped; what it pushed is what the queue holds once it is gone. */
S.daemonStart = async () => {
  const run = await startRealDaemon();
  await Promise.race([run.ready, run.exited]);
  if (run.child.exitCode !== null) {
    throw new Error(`the daemon exited before it was ready; it said:\n${run.output()}`);
  }
  await run.quit();
  return run;
};


module.exports = { startRealDaemon, S, NOW, MINUTE, DAY, fireNextCron, commandsOf, untilTrue, ASKER };
