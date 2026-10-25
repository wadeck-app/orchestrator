'use strict';

// What the events tests share: a Scheduler over a throwaway config dir whose children are fakes the test controls,
// a clock the test drives, and a publisher that checks every event against the catalog the moment it is published.
//
// Why a capturing publisher that VALIDATES instead of one that only records: for weeks no event reached the queue and no
// test noticed. A payload that drifts from its declared schema, an event the catalog does not know, a missing correlation
// key are the same kind of silent failure, so they are collected in `problems` and every test file fails on them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Ajv = require('ajv');

const { EVENT_CATALOG } = require('../../src/event-catalog');
const { Registry } = require('../../src/registry');
const { State } = require('../../src/state');
const { Scheduler } = require('../../src/scheduler');
const { FakeTime } = require('../../src/time-service');
const { runDirFor } = require('../../src/supervised-run');

const ajv = new Ajv({ strict: false, allErrors: true });
const BY_NAME = new Map(EVENT_CATALOG.map((e) => [e.name, e]));
const VALIDATORS = new Map(EVENT_CATALOG.map((e) => [e.name, ajv.compile(e.schema)]));

/** The events that end a run of a job, written down here on purpose: the catalog flags are checked AGAINST this contract. */
const JOB_TERMINAL = ['job.completed', 'job.failed', 'job.skipped', 'job.killed_manual'];

/** Collects the published events as the queue would receive them (a JSON round trip) and what is wrong with them. */
function capturingPublisher() {
  const events = [];
  const problems = [];
  const waiters = new Set();
  const publisher = {
    publish(event, payload) {
      const entry = BY_NAME.get(event);
      const wire = JSON.parse(JSON.stringify(payload));
      if (entry === undefined) {
        problems.push(`"${event}" is published but not declared in src/event-catalog.ts`);
      } else {
        const validate = VALIDATORS.get(event);
        if (!validate(wire)) {
          problems.push(`${event}: payload does not validate (${ajv.errorsText(validate.errors)}): ${JSON.stringify(wire)}`);
        }
        if (entry.correlationKey !== undefined) {
          const key = String(entry.correlationKey).replace(/^payload\./, '');
          if (typeof wire[key] !== 'string' || wire[key] === '') {
            problems.push(`${event}: the correlation key ${entry.correlationKey} is missing or empty: ${JSON.stringify(wire)}`);
          }
        }
      }
      events.push({ event, payload: wire });
      for (const waiter of [...waiters]) {
        if (waiter.predicate(events[events.length - 1])) {
          waiters.delete(waiter);
          waiter.resolve();
        }
      }
    },
  };
  /** A promise that settles when an event matching the predicate has been published (now or later). No timer: the event is the signal. */
  const when = (predicate) => new Promise((resolve) => {
    if (events.some(predicate)) { resolve(); return; }
    waiters.add({ predicate, resolve });
  });
  return { events, problems, publisher, when };
}

/** A child process the test controls: it stays alive until `exit(code)`, or ends when it is killed. */
class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    // No pid by default: the scheduler then ends it with child.kill() and never signals a real process by number.
    this.pid = pid;
    this.killed = false;
    this.exited = false;
    this.stdout = null;
    this.stderr = null;
    /** The exit code of a child that was killed (SIGTERM is 143 on a shell). */
    this.killExitCode = 143;
  }

  exit(code) {
    if (this.exited) { return; }
    this.exited = true;
    this.emit('close', code);
  }

  kill() {
    this.killed = true;
    process.nextTick(() => this.exit(this.killExitCode));
    return true;
  }
}

const harnesses = [];

function cronJob(extra = {}) {
  return { id: 'job', type: 'cron', schedule: '0 8 * * *', command: 'run it', label: 'Job', enabled: true, triggerMode: 'fire-and-forget', ...extra };
}

/**
 * @param {object[]} jobs registered before the scheduler is built
 * @param {object} [options]
 * @param {Array<number|undefined>} [options.exits] exit code of the Nth child; `undefined` = stays alive until `exit()`. The last entry repeats.
 * @param {number} [options.startedAgoMs] where the fake clock starts, before now (so durations are positive)
 * @param {object} [options.scheduler] more Scheduler options (they win)
 */
function makeHarness(jobs, options = {}) {
  const { exits = [0], startedAgoMs = 60_000, scheduler: extra = {} } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-events-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.load();
  for (const job of jobs) {
    registry.add(job);
  }
  const captured = capturingPublisher();
  const time = new FakeTime(Date.now() - startedAgoMs);
  // Two runs of a job in the same millisecond share their start time, which is the key of the history entry: the second
  // would replace the first. The clock never gives the same instant twice.
  let ticks = 0;
  const children = [];
  const spawned = [];
  const signals = { finished: [], refused: [], interrupted: [] };
  let next = 0;
  // Runs that could not be started leave no job-finished: counted where the start was attempted and refused.
  let startFailures = 0;
  const countFailure = (fn) => (fn === undefined ? undefined : (...args) => {
    try {
      const result = fn(...args);
      return result && typeof result.then === 'function' ? result.catch((err) => { startFailures++; throw err; }) : result;
    } catch (err) {
      startFailures++;
      throw err;
    }
  });
  const killedPids = [];
  const endChildren = (pid) => {
    killedPids.push(pid);
    for (const child of children) {
      if (child.pid === pid) { child.kill(); }
    }
  };
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    time,
    now: () => new Date(time.now() + ticks++),
    spawn: (cmd, cwd, env, jobId) => {
      spawned.push({ cmd, jobId });
      const child = new FakeChild(options.pid);
      children.push(child);
      const code = exits.length === 0 ? 0 : exits[Math.min(next++, exits.length - 1)];
      if (code !== undefined) {
        process.nextTick(() => child.exit(code));
      }
      return child;
    },
    liveness: async () => false,
    sampleUsage: async () => null,
    // A fake child with a pid (options.pid) must not reach the real tree kill: its pid belongs to some other process on the
    // machine (see scheduler-kill-seam.test.js). The fake kill ends the fake child the way a real kill would. A scenario that
    // asks for real processes (`spawn: undefined`) keeps the real kill: it is killing its own.
    ...(('spawn' in extra) && extra.spawn === undefined ? {} : {
      killTree: async (pid) => { endChildren(pid); },
      killTreeSync: (pid) => { endChildren(pid); },
    }),
    eventPublisher: captured.publisher,
    ...extra,
    ...(extra.spawn === undefined ? {} : { spawn: countFailure(extra.spawn) }),
    ...(extra.supervisor === undefined ? {} : { supervisor: countFailure(extra.supervisor) }),
  });
  // The scheduler's own channels: independent witnesses of how many runs ended (see runEnds).
  sched.on('job-finished', (ev) => signals.finished.push(ev));
  sched.on('job-skipped', (ev) => signals.refused.push(ev));
  sched.on('job-interrupted', (ev) => signals.interrupted.push(ev));
  const harness = {
    dir, registry, state, sched, time, children, spawned, signals, killedPids,
    events: captured.events,
    problems: captured.problems,
    publisher: captured.publisher,
    when: captured.when,
    /** Resolves once `n` runs have ended (the scheduler's own 'job-finished'); awaited on the event, not on time. */
    untilFinished: (n = 1) => new Promise((resolve) => {
      if (signals.finished.length >= n) { resolve(); return; }
      const check = () => {
        if (signals.finished.length >= n) { sched.off('job-finished', check); resolve(); }
      };
      sched.on('job-finished', check);
    }),
    /** Event names, in publication order, for one job (or all). */
    names: (jobId) => captured.events.filter((e) => jobId === undefined || e.payload.jobId === jobId).map((e) => e.event),
    /** The events of one name. */
    of: (name, jobId) => captured.events.filter((e) => e.event === name && (jobId === undefined || e.payload.jobId === jobId)),
    /** The job terminal events, in order. */
    terminals: (jobId) => captured.events.filter((e) => JOB_TERMINAL.includes(e.event) && (jobId === undefined || e.payload.jobId === jobId)),
    /**
     * How many runs (or refused firings) ended, counted WITHOUT the events: from the scheduler's own `job-finished`
     * and `job-skipped`, plus the runs that could not start (no `job-finished` for them, the start itself failed).
     */
    runEnds: (jobId) => {
      const finished = signals.finished.filter((ev) => jobId === undefined || ev.id === jobId).length;
      const refused = signals.refused.filter((ev) => jobId === undefined || ev.id === jobId).length;
      const interrupted = signals.interrupted.filter((ev) => jobId === undefined || ev.id === jobId).length;
      // A run that could not be started ends through _finishRun like any other, so it is in 'job-finished' already.
      return finished + refused + interrupted;
    },
    /** How many starts were attempted and failed (the spawn threw, the supervisor rejected): what the scenarios expect to find in job-finished. */
    startFailures: () => startFailures,
  };
  harnesses.push(harness);
  return harness;
}

/** Lets the closes queued with process.nextTick, and what they start, run. */
async function settle(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Registers something that published events (an exec run has no scheduler), so its problems are reported too. */
function track(run) {
  harnesses.push(run);
  return run;
}

/** Stops every scheduler built since the last call and returns what was wrong with the events they published. */
async function stopAll() {
  const problems = [];
  while (harnesses.length > 0) {
    const h = harnesses.pop();
    await h.sched?.stop();
    await h.cleanup?.();
    problems.push(...h.problems);
  }
  return problems;
}

/** For `afterEach`: the tests of a file fail when any event was invalid, even if the test did not look. */
async function assertNoProblems() {
  const problems = await stopAll();
  assert.deepEqual(problems, [], `events that do not match src/event-catalog.ts:\n  ${problems.join('\n  ')}`);
}

/**
 * Leaves what a daemon and a supervisor leave behind when the daemon dies mid-run and the job then ends: an open entry
 * in the state, a run folder with the spec and the supervisor's final status, and the job's output in the log.
 * Same fixture as run-recovery.test.js; the scheduler must be built with `now` pinned (see makeLateHarness).
 */
function leaveRun(h, now, { jobId = 'job', startedMinutesAgo = 90, endedMinutesAgo = 60, status = {}, trigger = { kind: 'cron' } } = {}) {
  const MINUTE = 60_000;
  const at = (minutesAgo) => new Date(now - minutesAgo * MINUTE).toISOString();
  const startedAt = at(startedMinutesAgo);
  h.state.record(jobId, { startedAt, exitCode: null, pid: 4242, triggeredBy: trigger });
  h.state.flushNow();
  const runDir = runDirFor(h.dir, jobId, startedAt);
  fs.mkdirSync(runDir, { recursive: true });
  const logDir = path.join(h.dir, 'logs', 'jobs', jobId);
  fs.mkdirSync(logDir, { recursive: true });
  const compact = startedAt.replace(/:/g, '-').slice(0, 19);
  const logPath = path.join(logDir, `${jobId}-${compact}.log`);
  fs.writeFileSync(logPath, '[job:started] pid=4242\n');
  fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify({
    command: 'run it', cwd: h.dir, logPath, timeoutSeconds: 315, heartbeatMs: 2000,
    context: { jobId, label: 'Job', trigger, startedAt },
  }));
  fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify({
    state: 'exited', supervisorPid: 1, childPid: 4242, startedAt, finishedAt: at(endedMinutesAgo), exitCode: 0, ...status,
  }));
  return { runDir, startedAt, finishedAt: at(endedMinutesAgo) };
}

module.exports = { makeHarness, FakeChild, cronJob, settle, stopAll, track, assertNoProblems, leaveRun, capturingPublisher, JOB_TERMINAL, BY_NAME, EVENT_CATALOG };
