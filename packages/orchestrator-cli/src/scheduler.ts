import cron from 'node-cron';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { EventEmitter } from 'node:events';
import { checkLiveness } from './liveness.js';
import { RunLogger }     from './logger.js';
import { LOG_ROTATION_DEFAULTS, daemonLogRotation, resolveLogRotation, type ResolvedLogRotation } from './log-rotation.js';
import { jobEnvironment } from './job-env.js';
import { stripAnsi }      from './ansi.js';
import { OutputLines }     from './output-lines.js';
import { atomicWriteJson, ensureTmpDir, getErrorMessage, readJsonFile }  from './fsUtil.js';
import { killTree, killTreeSync } from './process-tree.js';
import { EventPublisher } from './event-publisher.js';
import { SecretsManager } from './secrets.js';
import { getLastFiring, getNextFirings } from './cronNext.js';
// pidusage: cross-platform CPU/RAM sampling by PID (types in pidusage.d.ts)
import pidusage from 'pidusage';
// pidtree: children of a PID. Jobs are spawned through a shell, so the direct child is
// a wrapper (cmd.exe / sh) that stays idle: sampling it alone reports ~0% CPU and only
// the wrapper's own few MB of RAM. The real work happens in its descendants.
import pidtree from 'pidtree';
import { PEAK_MEASURE_VERSION, type Job, type RestartResult, type RuntimeEntry, type TriggerResult, type TriggerSource } from './types.js';
import type { HookDispatcher } from '@wadeck-app/shared-cli/HookDispatcher';
import type { Registry } from './registry.js';
import type { State } from './state.js';
import { isFailure } from './state.js';
import { systemTime, waitUntil, type TimeService, type Timer } from './time-service.js';
import { DeadlineQueue, type DeadlineKind } from './deadlines.js';
import { windowStateAt, msUntilStart, msUntilEnd, type WindowState } from './active-window.js';
import { lookupProcessName } from './process-name.js';
import { JobTelemetry } from './job-telemetry.js';
import { resolveResourceLimits, RESOURCE_LIMIT_DEFAULTS, type EffectiveResourceLimits } from './resource-limits.js';
import { appendResourceHistory, type ResourceHistoryRecord } from './resource-history.js';
import { SupervisedChild, claimRun, isOurSupervisor, ownedByAnotherLiveDaemon, processStartsOf, type ProcessStartFn, type ProcessStartsFn, type SupervisedRequest } from './supervised-run.js';
import { EffectLedger, type EffectGroup } from './effect-ledger.js';
import { RESTART_STATE_FILE, parseRestartStates, planRestart, resolveRestartPolicy, restartConflictError, restartOnExitError, type RestartState } from './restart-policy.js';

// May be async: starting a job under a supervisor means waiting for its status file.
type SpawnFn    = (cmd: string, cwd?: string, env?: NodeJS.ProcessEnv, jobId?: string) => ChildProcess | Promise<ChildProcess>;
function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown }).then === 'function';
}

/** What following a run needs to know about it. */
type MonitorContext = Omit<RunContext, 'telemetry' | 'usage'>;

/** What the monitor saw of one run, handed to the end of the run for the long consumption history. */
interface RunUsage {
  samples: number;
  cpuSum:  number;
  ramSum:  number;
  /** The budgets the run was held to. */
  limits:  EffectiveResourceLimits;
}

/** What a run found again after a restart brings with it. */
interface ResumeState {
  peakCpuPct: number;
  peakRamMb:  number;
}

/** What the end of a run needs to know about the run, however the end was learned. */
interface RunContext {
  job:       Job;
  trigger:   TriggerSource;
  startedAt: string;
  pid:       number | null;
  jobLogger: RunLogger;
  telemetry: JobTelemetry | null;
  /** Absent for a run the daemon did not watch (found already ended after a restart). */
  usage?:    RunUsage;
  /** Whether the run before this one failed, read before this one was recorded. */
  previousRunFailed: boolean;
}

/** The limits a run found again is logged with: the ones its supervisor was given, none for a run that predates the rotation. */
function specRotation(spec: SupervisedSpec): ResolvedLogRotation | undefined {
  return spec.logRotation;
}

/** 50 MB and 5 segments: what a daemon without `logMaxSizeMb` / `logKeepSegments` in config.yml uses. */
export const DEFAULT_RUN_LOG_ROTATION: ResolvedLogRotation = daemonLogRotation({
  logMaxSizeMb: LOG_ROTATION_DEFAULTS.maxSizeMb,
  logKeepSegments: LOG_ROTATION_DEFAULTS.keepSegments,
});

/** What startSupervised wrote in spec.json, as far as recovery needs it. */
interface SupervisedSpec {
  command: string;
  logPath: string;
  /** The limits the supervisor of this run writes its log with; absent for a run started before the rotation existed. */
  logRotation?: ResolvedLogRotation;
  context: { jobId: string; label?: string; trigger: TriggerSource; startedAt: string };
}

/** What the supervisor wrote in status.json, as far as recovery needs it. */
interface SupervisedStatus {
  state: 'running' | 'exited' | 'failed-to-start';
  supervisorPid: number;
  supervisorStartedAt: string;
  childPid?: number;
  finishedAt?: string;
  exitCode?: number;
  signal?: string;
  killed?: boolean;
  killReason?: string;
  timedOut?: boolean;
}

/** What recoverRuns found and did. */
export interface RecoveryReport {
  /** Runs that ended while the daemon was down and were handled now. */
  finalized: number;
  /** Folders of runs already fully handled, removed. */
  cleaned: number;
  /** Runs still going whose job this daemon now follows again. */
  adopted: number;
  /** Runs whose supervisor is gone without having recorded an end; each entry says which. */
  lost: string[];
  /** Runs another live daemon already follows, left to it. */
  followedElsewhere: number;
  /** Folders that could not be read, left in place; each entry says which and why. */
  unreadable: string[];
}

/** How the end of a run reached the daemon, for the effects that depend on it. */
interface FinishOptions {
  /** The end was learned after the fact: the daemon was down when it happened. */
  late: boolean;
  /** Whether what ACTS may run: retry, dependents and their hooks. */
  actionsAllowed: boolean;
  /** The log line that says why they did not. */
  actionsSkippedNote?: string;
  /** Which groups of effects are already done; marked as they complete. Absent for a run seen live. */
  ledger?: EffectLedger;
  /** The caller already wrote the history entry (a run closed as interrupted keeps its own reading): only the rest is done. */
  recorded?: boolean;
}

const LIVE_FINISH: FinishOptions = { late: false, actionsAllowed: true };

type RunHistoryReason = ResourceHistoryRecord['endReason'];

/** How a run ended. `exitCode` is null for a run the user cancelled. */
interface RunOutcome {
  exitCode:              number | null;
  finishedAt:            string;
  durationMs:            number;
  cancelledByUser:       boolean;
  timedOut:              boolean;
  killedByResourceLimit: boolean;
  peakCpuPct:            number;
  peakRamMb:             number;
}

type LivenessFn = (job: Pick<Job, 'id' | 'liveness'>) => Promise<boolean>;
/** Starts a job under its own supervisor (supervised-run.ts), so it can outlive the daemon. */
type SupervisorFn = (request: SupervisedRequest) => Promise<SupervisedChild>;

interface SchedulerOptions {
  spawn?:                 SpawnFn;
  /** When set, jobs are started through it instead of `spawn`. */
  supervisor?:            SupervisorFn;
  liveness?:              LivenessFn;
  now?:                   () => Date;
  configDir?:             string;
  eventPublisher?:        EventPublisher;
  catchUpInitialDelayMs?: number;
  /** A run that ended while the daemon was down still retries and fires its dependents if it ended within this many ms (default 30 min). */
  lateActionWindowMs?:    number;
  /** When processes started, for telling a supervisor from a stranger that reused its pid (default: from the OS, one look for all). */
  processStarts?:         ProcessStartsFn;
  /** How often runs another daemon follows are checked for that daemon having gone (default 3000 ms). */
  ownerWatchMs?:          number;
  catchUpStaggerMs?:      number;
  /** How long restartJob waits for the ended instances to be gone before giving up (default 15 s). Lowered in tests. */
  restartGraceMs?:        number;
  hookDispatcher?:        HookDispatcher;
  /** How often a running job's resource peaks are written to state. Lowered in tests. */
  peakFlushMs?:           number;
  /**
   * How a running process tree's CPU and memory are measured. Defaults to the real sampler.
   *
   * Injectable so the monitor's timing can be tested at all. The kill path is guarded against
   * overlapping samples, and a guard whose only witness is a loaded CI runner is not guarded.
   */
  sampleUsage?:           (rootPid: number) => Promise<TreeUsage | null>;
  /**
   * How a pid is turned into an executable name for the line a resource-limit kill writes. Defaults to
   * tasklist/ps. Injectable so a test does not depend on which processes the machine happens to run.
   */
  processName?:           (pid: number) => Promise<string | undefined>;
  /**
   * How the whole process tree of a job is ended (killJob, restart-job, a resource-limit kill). Defaults to the real one.
   *
   * A test with a fake child must not use the real one: the fake pid belongs to some other process on the machine, and that
   * process and its descendants are what gets signalled (on a CI runner a pid like 4242 is a live one, the test runner's
   * own ancestors included).
   */
  killTree?:              (pid: number) => Promise<void>;
  /** Same as killTree, for the places that cannot wait (the job timeout, a resource-limit breach). */
  killTreeSync?:          (pid: number) => void;
  /**
   * How often the resource monitor samples. Lowered in tests.
   *
   * Needed alongside sampleUsage to test the overlap guard at all: overlap only happens when a
   * sample outlasts the interval, and at the production 2s a test would have to stall a fake
   * sampler for longer than that to provoke it.
   */
  sampleIntervalMs?:      number;
  /**
   * Replaces, for every job, the number of consecutive samples over the hard budget that make a breach
   * sustained (normally resourceLimits.sustainSeconds divided by the sample interval, 15 by default).
   * Lowered in tests, which would otherwise wait the 2 seconds that is the smallest sustainSeconds.
   */
  sustainSamples?:        number;
  /** `jobsNoColor` in config.yml (default true): jobs start with NO_COLOR=1 and FORCE_COLOR=0, see job-env.ts. */
  jobsNoColor?:           boolean;
  /**
   * The daemon-wide size limits of a run's log (`logMaxSizeMb` / `logKeepSegments` in config.yml), which a job's own
   * `logRotation` overrides key by key. Defaults to 50 MB and 5 segments.
   */
  logRotation?:           ResolvedLogRotation;
  /**
   * The passage of time. Defaults to the real clock.
   *
   * Everything this class does is about when, and it used the real timers - so testing it meant
   * sleeping, and two of those tests failed on a loaded CI runner because the machine decided the
   * timing. `now` alone was already injectable, which covers "what time is it" and not "time has
   * passed". See time-service.ts.
   */
  time?:                  TimeService;
}

/** One process the monitor counted towards a job. */
export interface TreeProcess {
  pid:    number;
  ppid:   number;
  ramMb:  number;
  cpuPct: number;
}

export interface TreeUsage {
  cpuPct: number;
  ramMb:  number;
  /**
   * What the totals were made of, biggest memory first. Absent from a sampler that cannot say.
   *
   * Kept because a total alone cannot answer the question a kill raises: "was that the job, or
   * something counted against it by mistake". The same job measured 17 MB in one run and 147 MB in
   * another, and nothing recorded which processes made up either figure.
   */
  processes?: TreeProcess[];
  /** Processes the tree walk offered. Against `counted`, it shows how many were refused as not ours. */
  walked?:    number;
  /** Processes that were counted. */
  counted?:   number;
}

/** Whether the job asks to be restarted (valid or not: an invalid setting still takes the place of a retry list, and is reported). */
function restartConfigured(job: Job): boolean {
  return job.restartOnExit !== undefined && job.restartOnExit !== null && job.restartOnExit !== false;
}

/** One job's intent, as configured, next to what the scheduler has actually armed for it. */
export interface TimerReport {
  jobId:   string;
  type:    string;
  enabled: boolean;
  /**
   * What the job is next waiting for, or null when nothing is armed for it.
   *
   * There is one vocabulary for this now - DeadlineKind - because there is one queue. It used to be
   * `'cron' | ArmedKind`, a union of a node-cron task and our own timer kinds, which is the shape the
   * two mechanisms forced.
   */
  armed:   DeadlineKind | null;
  /** When that moment is, ISO. */
  dueAt:   string | null;
  /**
   * When the active period closes and the job is disabled, ISO, when a timer is armed for it.
   *
   * Reported separately rather than folded into `armed`, because a cron job inside a window has BOTH
   * a cron task and this: collapsing them into one field hid the window entirely, and "why did my job
   * disable itself" is the question that needs it.
   */
  windowEndsAt: string | null;
  /** Next firing of a cron expression, computed from the expression, ISO. */
  nextFiring: string | null;
  windowState: WindowState | null;
  /**
   * A `once` job has already had its firing. False for every other type.
   *
   * Reported because it is the difference between the two ways a once job can have nothing armed:
   * finished, or never scheduled. Without it `orch timers` shows an identical line for both.
   */
  spent: boolean;
  /**
   * Why nothing will happen, when that is the case. Null when intent and reality agree.
   *
   * This is the field worth reading first: every "it was configured and never fired" bug in this
   * project has been a disagreement between the registry and what was armed.
   */
  problem: string | null;
}

/**
 * What the dashboard says about the timers, reduced from the same report `list-timers` returns.
 *
 * `desired` counts the jobs that should have a timer: enabled, not a spent `once`, not a `startup` job (it fires
 * once at start, nothing to arm), not a `manual` job (it only runs when triggered) and not past its active period. `armed` is how many of those have one.
 * `problems` is every report that carries a problem, whether or not it counts as desired.
 */
export function summarizeTimers(reports: TimerReport[]): { armed: number; desired: number; problems: Array<{ jobId: string; problem: string }> } {
  const desired = reports.filter(r =>
    r.enabled && !r.spent && r.type !== 'startup' && r.type !== 'manual' && r.windowState !== 'expired');
  return {
    armed:    desired.filter(r => r.armed !== null).length,
    desired:  desired.length,
    problems: reports.filter(r => r.problem !== null).map(r => ({ jobId: r.jobId, problem: r.problem as string })),
  };
}

/** Injection seam for the tests; production passes nothing and gets pidtree + pidusage. */
/**
 * What pidusage answers for one process. `elapsed` is its age at the moment THAT process was measured
 * and `timestamp` that moment, so only their difference (the creation time) is comparable between
 * processes. `timestamp` is optional because older fixtures and a few callers carry only `elapsed`.
 */
interface TreeSample { cpu: number; memory: number; elapsed: number; ppid: number; timestamp?: number }

interface TreeDeps {
  tree:  (pid: number) => Promise<number[]>;
  usage: (pid: number) => Promise<TreeSample>;
}

/**
 * Both figures come from separate calls against a clock of finite resolution, so a child spawned in
 * the same instant as its parent can measure a hair older. Refusing it would drop real descendants.
 */
const TREE_AGE_TOLERANCE_MS = 1_000;

/**
 * How many processes are measured at the same time.
 *
 * On macOS every measurement is a `ps` process of its own (Linux reads /proc and starts nothing). All of a
 * tree at once meant a job with 400 descendants started 400 processes in one instant, every sampling
 * interval: past a per-user process limit (1333 on the macOS CI runners) spawn fails with EAGAIN, for
 * this job and for whatever else on the machine is starting a process at that moment. The measurement
 * has to be complete, not simultaneous.
 */
export const MAX_CONCURRENT_USAGE_CALLS = 8;

/** Like Promise.all(items.map(fn)), with at most `limit` calls running at once. Results keep the items' order. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Sums CPU and RAM over a process and all its descendants.
 *
 * Returns null when the root itself could not be sampled, which lets the caller tell "the job exited"
 * apart from "the job is genuinely using 0%". Descendants are sampled independently because one can
 * exit between the tree walk and the sample, and a dead pid must not discard its siblings' readings.
 *
 * Processes older than the root are dropped: they cannot be its descendants. See the comment below
 * for why the tree walk offers them at all.
 */
export async function sampleProcessTree(rootPid: number, deps?: Partial<TreeDeps>): Promise<TreeUsage | null> {
  const tree  = deps?.tree  ?? ((pid: number) => pidtree(pid, { root: true }));
  const usage = deps?.usage ?? ((pid: number) => pidusage(pid));

  let pids: number[];
  try {
    pids = await tree(rootPid);
  } catch {
    // The walk fails once the root is gone; still try the root, it may just have no children.
    pids = [rootPid];
  }

  const samples = await mapWithLimit(pids, MAX_CONCURRENT_USAGE_CALLS, async (pid) => {
    try {
      return { pid, sample: await usage(pid) };
    } catch {
      return null;
    }
  });

  // Without the root there is nothing to attribute usage to: the job has exited.
  const root = samples.find(s => s !== null && s.pid === rootPid);
  if (!root) {
    return null;
  }

  // The tree is rebuilt link by link rather than trusted as given. pidtree walks ParentProcessId, and
  // a pid is reused the moment its process dies, so the parent a process claims may be a pid that has
  // since been recycled onto one of ours -- which is how strangers arrive. Two things have to hold for
  // a link to be real: the claimed parent is itself part of the job, and the child did not start
  // before it. Age alone would not do, since a stranger hanging off a recycled DESCENDANT pid is
  // younger than the root.
  const byPid = new Map<number, TreeSample>();
  for (const s of samples) if (s !== null) {
    byPid.set(s.pid, s.sample);
  }

  let cpuPct   = root.sample.cpu;
  let ramBytes = root.sample.memory;
  // Creation times, not ages. `elapsed` is measured per process, and under load the answers arrive
  // seconds apart: a real child measured three seconds after its parent then looked three seconds OLDER
  // than it and was refused as a stranger, so the job was counted as its idle shell wrapper. That made
  // the same job measure 17 MB on one run and 147 MB on another. timestamp - elapsed does not depend on
  // when the process was asked about. A sample without a timestamp is taken as measured now, which is
  // the old comparison of ages.
  const measuredNow = Date.now();
  const startOf = (sample: TreeSample): number => (sample.timestamp ?? measuredNow) - sample.elapsed;
  const accepted = new Map([[rootPid, startOf(root.sample)]]);
  const counted: TreeProcess[] = [{ pid: rootPid, ppid: root.sample.ppid, ramMb: root.sample.memory / 1024 / 1024, cpuPct: root.sample.cpu }];
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const [pid, sample] of byPid) {
      if (accepted.has(pid)) {
        continue;
      }
      // Only against the pids accepted on the previous round, so one pass adds one generation and a
      // cycle in the claimed parent links cannot loop forever.
      if (!frontier.includes(sample.ppid)) {
        continue;
      }
      const parentStart = accepted.get(sample.ppid)!;
      if (startOf(sample) < parentStart - TREE_AGE_TOLERANCE_MS) {
        continue;
      }
      accepted.set(pid, startOf(sample));
      cpuPct   += sample.cpu;
      ramBytes += sample.memory;
      counted.push({ pid, ppid: sample.ppid, ramMb: sample.memory / 1024 / 1024, cpuPct: sample.cpu });
      next.push(pid);
    }
    frontier = next;
  }
  return {
    cpuPct,
    ramMb: ramBytes / 1024 / 1024,
    processes: counted.sort((a, b) => b.ramMb - a.ramMb),
    walked: pids.length,
    counted: counted.length,
  };
}

export class Scheduler extends EventEmitter {
  private readonly _registry:  Registry;
  private readonly _state:     State;
  private _spawn:              SpawnFn;
  private readonly _supervisor:  SupervisorFn | null;
  private readonly _liveness:  LivenessFn;
  private readonly _restartGraceMs: number;
  private readonly _now:       () => Date;
  private readonly _time:      TimeService;
  private readonly _configDir: string;
  private readonly _tmpDir:    string;
  private readonly _eventPublisher: EventPublisher;
  private readonly _secrets:   SecretsManager;
  /**
   * Every scheduled moment, behind one armed timer. See deadlines.ts.
   *
   * This replaced four collections: a node-cron task per cron job, plus one timer each for a once
   * job, a window start, a window end and a retry. Twenty jobs meant upwards of twenty timers in a
   * process whose whole purpose is to be the one thing on the machine that owns them - and no single
   * place could answer "what happens next", which is why every "configured but never fired" bug here
   * needed a code reading to find.
   *
   * The promise is precise, so it is worth stating exactly: an IDLE daemon arms one timer, whatever
   * the number of jobs. Two more exist per job that is CURRENTLY RUNNING - the resource sampler and
   * the job's own timeout - and both die with the child they measure. They are not future moments the
   * scheduler is waiting for, so they do not belong here.
   */
  private readonly _deadlines: DeadlineQueue;
  /** Every live child of a job. More than one when maxConcurrency allows it or a trigger is forced. */
  private readonly _activeChildren = new Map<string, Set<ChildProcess>>();
  /**
   * The children stopped on purpose. Per child, not per job id: with several instances alive, a
   * per-job flag was consumed by whichever instance closed first, so the others were recorded as
   * ordinary failures and the kill read as a crash.
   */
  private readonly _killedByUser   = new WeakSet<ChildProcess>();
  private readonly _skippedJobs    = new Map<string, number>();
  private readonly _catchUpInitialDelayMs: number;
  private readonly _lateActionWindowMs: number;
  private readonly _processStarts: ProcessStartsFn;
  private readonly _ownerWatchMs: number;
  /** `<jobId>|<startedAt>` -> run folder, for runs another live daemon follows: left open, taken over if it goes. */
  private readonly _followedElsewhere = new Map<string, string>();
  private _ownerWatch: ReturnType<typeof setInterval> | null = null;
  /** `<jobId>|<startedAt>` of every run this daemon found going after a restart and follows again. */
  private readonly _followed = new Set<string>();
  /** Stops following the supervised runs without ending them, one per run (see detachRuns). */
  private readonly _detachers = new Set<() => void>();
  /** Ids of the jobs whose run was found going, to announce once the tray is listening. */
  private readonly _adoptedIds: string[] = [];
  /** How many runs this daemon has followed again since it started; unlike _adoptedIds it is never drained. */
  private _followedAgainTotal = 0;
  private readonly _catchUpStaggerMs:      number;
  private readonly _hookDispatcher:  HookDispatcher | null;
  private readonly _peakFlushMs:     number;
  private readonly _sampleUsage:     (rootPid: number) => Promise<TreeUsage | null>;
  private readonly _processName:     (pid: number) => Promise<string | undefined>;
  private readonly _killTree:        (pid: number) => Promise<void>;
  private readonly _killTreeSync:    (pid: number) => void;
  private readonly _sampleIntervalMs: number;
  private readonly _sustainSamples: number | undefined;
  private readonly _jobsNoColor: boolean;
  private readonly _logRotation: ResolvedLogRotation;
  private readonly _retryCounters  = new Map<string, number>();
  /**
   * What restartOnExit remembers of a job between two exits: the attempt number and the restarts inside the window. Mirrored in
   * <configDir>/restart-state.json on every change except stop() (see _restoreRestartStates), so a daemon restart keeps the budget.
   */
  private readonly _restartStates  = new Map<string, RestartState>();
  /** The counters were read from the file (once per start, by recoverRuns or start(), whichever comes first). */
  private _restartStatesLoaded = false;
  /** Startup jobs whose restored counters the daemon's own startup firing must not clear (see _fire). */
  private readonly _startupKeepsRestartState = new Set<string>();
  /** Set by stop(): a run that ends after it must not schedule a restart (the daemon is going away). Cleared by start(). */
  private _stopped = false;
  /**
   * Live processes per job, for maxConcurrency and runningCount(). A counter of its own so that the
   * slot is released in the first `close` listener, before job-finished and the dependents it fires.
   */
  private readonly _running        = new Map<string, number>();
  /** Callers waiting for a job to have no live instance (see _waitUntilNoneRunning), woken by the close of the last one. */
  private readonly _idleWaiters    = new Map<string, Set<() => void>>();
  /** The restart of a job that is under way: the next restart of the same job waits for it (see restartJob). */
  private readonly _restartTurns   = new Map<string, Promise<void>>();
  /** The log of the newest live run per job: where a refused firing is written, so the reader sees it. */
  private readonly _liveLogger     = new Map<string, RunLogger>();

  constructor(registry: Registry, state: State, options: SchedulerOptions = {}) {
    super();
    this._registry  = registry;
    this._state     = state;
    // Default spawn is set below after _tmpDir is resolved.
    this._spawn     = options.spawn     ?? ((cmd, cwd, env, _jobId) => {
      const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [cmd];
      const [bin, ...args] = parts;
      // violations-suppress: shared/no-out-of-repo-path a job with no configured cwd runs from the user's home, like a shell would -- the repo is not where a user's job belongs
      return nodeSpawn(bin!, args, { cwd: cwd ?? os.homedir(), windowsHide: true, shell: true, env: env ?? process.env });
    });
    this._supervisor = options.supervisor ?? null;
    // The warning goes to stderr, which the daemon copies into its log (stdio-bridge.ts).
    this._liveness  = options.liveness  ?? ((job) => checkLiveness(job, { time: this._time, warn: (m) => console.error(`[scheduler] ${m}`) }));
    this._time      = options.time      ?? systemTime;
    // Defaults to the time service rather than Date, so a test that moves the clock is not
    // contradicted by a `now` that never moved. An explicit `now` still wins, for the tests that only
    // needed to pin the date.
    this._now       = options.now       ?? (() => new Date(this._time.now()));
    this._configDir = options.configDir ?? (
      // violations-suppress: shared/no-out-of-repo-path the documented config dir; both a constructor option and ORCH_CONFIG_DIR override it
      process.env['ORCH_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'orchestrator')
    );
    this._eventPublisher    = options.eventPublisher ?? new EventPublisher('orchestrator', undefined, {
      cwd: this._configDir,
      jobCwd: (id) => this._registry.get(id)?.cwd,
    });
    this._secrets   = new SecretsManager(this._configDir);
    this._catchUpInitialDelayMs = options.catchUpInitialDelayMs ?? 300_000;
    this._lateActionWindowMs    = options.lateActionWindowMs    ?? 30 * 60_000;
    this._processStarts         = options.processStarts         ?? processStartsOf;
    this._ownerWatchMs          = options.ownerWatchMs          ?? 3000;
    this._catchUpStaggerMs      = options.catchUpStaggerMs      ?? 300_000;
    this._restartGraceMs        = options.restartGraceMs        ?? 15_000;
    this._hookDispatcher        = options.hookDispatcher        ?? null;
    this._peakFlushMs           = options.peakFlushMs           ?? 10_000;
    this._sampleUsage           = options.sampleUsage           ?? sampleProcessTree;
    this._processName           = options.processName           ?? lookupProcessName;
    this._killTree              = options.killTree              ?? killTree;
    this._killTreeSync          = options.killTreeSync          ?? killTreeSync;
    this._sampleIntervalMs      = options.sampleIntervalMs      ?? 2000;
    this._sustainSamples        = options.sustainSamples;
    this._jobsNoColor           = options.jobsNoColor           ?? true;
    this._logRotation           = options.logRotation           ?? DEFAULT_RUN_LOG_ROTATION;
    // Said out loud rather than swallowed: a deadline callback that throws is a job that will not run,
    // and the queue keeps going so one broken job cannot stop the others. Silence here would make the
    // difference invisible.
    this._deadlines = new DeadlineQueue(this._time, (jobId, kind, err) => {
      const msg = `[scheduler] the ${kind} deadline for job "${jobId}" failed: ${getErrorMessage(err)}`;
      try { process.stderr.write(`${msg}\n`); } catch { /* EPIPE */ }
    });
    // Ensure root tmp dir exists (will create per-job subdirs as needed).
    this._tmpDir = ensureTmpDir(this._configDir);
    // Re-bind spawn now that _tmpDir is resolved (closure captures the value, not the field).
    if (!options.spawn) {
      const configDir = this._configDir;
      this._spawn = (cmd, cwd, env, jobId) => {
        const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [cmd];
        const [bin, ...args] = parts;
        const jobTmpDir = jobId ? ensureTmpDir(configDir, jobId) : this._tmpDir;
        return nodeSpawn(bin!, args, {
          cwd: cwd ?? jobTmpDir,
          windowsHide: true,
          shell: true,
          env: env ?? process.env,
        });
      };
    }
  }

  async start(): Promise<void> {
    this._stopped = false;
    this._restoreRestartStates();
    this._startupKeepsRestartState.clear();
    // Stagger catch-up jobs to avoid simultaneous load on wake from hibernate.
    // First job fires after catchUpInitialDelayMs, subsequent jobs add catchUpStaggerMs each.
    let catchUpStaggerMs = this._catchUpInitialDelayMs;

    for (const job of this._registry.list()) {
      this._checkRestartConfig(job);
      if (job.type === 'startup' && this._restartStates.has(job.id)) {
        this._startupKeepsRestartState.add(job.id);
      }
      if (!job.enabled) {
        continue;
      }

      // A restart waiting for its delay is kept for the same reason as the retry below.
      const pendingRestart = this._deadlines.take(job.id, 'restart');
      // A retry that recoverRuns armed for a run that ended while the daemon was down: re-planning the job below
      // drops every deadline of the job, and the retry would be announced in the log and never happen.
      const pendingRetry = this._deadlines.take(job.id, 'retry');

      if (job.type === 'cron') {
        // Through scheduleJob, not _scheduleCron: that is where the active window is honoured, so a
        // job whose window has not opened waits and one whose window closed while the daemon was down
        // is disabled at startup rather than resuming.
        this.scheduleJob(job);
        // Catch-up only inside the window. Replaying a missed firing for a job that has expired, or
        // has not started yet, would run work the window exists to prevent.
        if (job.missedFiring === 'catch-up' && job.schedule && windowStateAt(job, this._time.now()) === 'active') {
          const lastFiring = getLastFiring(job.schedule, this._now());
          if (lastFiring) {
            const last = this._state.get(job.id);
            const lastRanAt = last?.startedAt ? new Date(last.startedAt).getTime() : 0;
            // Fire if the last expected firing is more recent than the last actual run
            if (lastFiring.getTime() > lastRanAt) {
              const delayMs = catchUpStaggerMs;
              catchUpStaggerMs += this._catchUpStaggerMs;
              if (delayMs === 0) {
                void this._maybeSpawn(job, { kind: 'cron' }, true);
              } else {
                this._deadlines.set(job.id, 'catch-up', this._time.now() + delayMs,
                  () => { void this._maybeSpawn(job, { kind: 'cron' }, true); });
              }
            }
          }
        }
      }

      if (job.type === 'startup') {
        const delay = (job.delaySeconds ?? 0) * 1000;
        if (delay === 0) {
          await this._maybeSpawn(job, { kind: 'cron' }, true);
        } else {
          this._deadlines.set(job.id, 'startup-delay', this._time.now() + delay,
            () => { void this._maybeSpawn(job, { kind: 'cron' }, true); });
        }
      }

      if (job.type === 'once') {
        await this._scheduleOnce(job);
      }

      if (pendingRetry !== null) {
        this._deadlines.set(job.id, 'retry', pendingRetry.dueAt, pendingRetry.run);
      }
      if (pendingRestart !== null) {
        this._deadlines.set(job.id, 'restart', pendingRestart.dueAt, pendingRestart.run);
      }
    }

    // Clean up stale "running" entries from previous sessions whose process is no longer alive.
    //
    // `finishedAt == null` is what makes a run open. exitCode alone does not: a null exit code is
    // also how a finished run says nobody observed the process end -- cancelled by the user, closed
    // as orphaned by State.closeOrphanedRuns, or a firing skipped because the target was already
    // alive. All three carry finishedAt, and all three used to be rewritten here into "failed,
    // exit 1" on the next daemon start, which even contradicted closeOrphanedRuns' own promise that
    // an interrupted run does not read as a failure.
    // Every open entry of the job, not the newest: with several instances a newer run that already
    // ended would hide an older one whose process is gone, and it would stay open for good.
    for (const job of this._registry.list()) {
      for (const entry of this._state.getOpenRuns(job.id)) {
        let alive = false;
        if (entry.pid) {
          try { process.kill(entry.pid, 0); alive = true; } catch { /* dead */ }
        }
        if (!alive) {
          const finishedAt = this._now().toISOString();
          const closed = { ...entry, exitCode: 1, finishedAt };
          this._state.record(job.id, closed);
          // Closed with nobody to say so: announced like every other end of a run.
          this._announceInterrupted(job.id, closed);
        }
      }
    }
  }

  /**
   * Sets a once job's timer, or runs it now if its moment has already passed.
   *
   * Resolves once the job has actually been dealt with, so start() still waits for an overdue one
   * before moving on; when a timer is set there is nothing to wait for and it resolves immediately.
   */
  private async _scheduleOnce(job: Job): Promise<void> {
    /*
     * A spent job is kept in the registry now rather than deleted, so "it is still listed" no longer
     * means "it is still to fire". Without this guard every daemon start would re-arm a job whose
     * moment is months past, find it overdue, and run it - once per restart, forever.
     */
    if (job.spent === true) {
      return;
    }

    const elapsed   = this._now().getTime() - new Date(job.scheduledAt!).getTime();
    const remaining = job.delayMs! - elapsed;
    // Marked either way: a once job is spent when its moment passes. If the liveness check
    // skipped it, the thing it was meant to bring up is already up, so its purpose is served.
    if (remaining <= 0) {
      await this._maybeSpawn(job);
      this._registry.markSpent(job.id);
      return;
    }
    // waitUntil, not after(remaining): a timer clamps a delay above ~24.85 days to 1ms, so a once
    // job scheduled further out than that used to fire on the next tick. The moment is absolute, so
    // it is also the same value a restart re-derives from the registry.
    this._deadlines.set(job.id, 'once', this._time.now() + remaining, () => {
      void (async () => {
        await this._maybeSpawn(job);
        // Removed while it waited or while it ran -- `orch remove` is allowed at any moment. Nothing
        // to mark then, and an unhandled rejection here would take the daemon down with it (P-1).
        if (this._registry.get(job.id) !== null) {
          this._registry.markSpent(job.id);
        }
      })();
    });
  }

  /**
   * Schedules one job, for a job that appeared or changed after the daemon was already running.
   *
   * Nothing used to call this, because nothing existed: `add-job` wrote the registry and logged to
   * the audit, and the scheduler only ever read the registry in start(). So a job added through the
   * CLI or the dashboard was invisible to the running daemon until the next restart.
   *
   * For a cron job that was merely late - the next restart picked it up and it fired on schedule
   * thereafter, so nobody noticed. For a `once` job it was fatal: its single moment passed with the
   * daemon oblivious, and the job sat in the registry having never run. Reproduced with a 15s delay:
   * due at 20:37:09, still unfired and still listed at 20:37:32.
   *
   * Idempotent - any existing timer or cron task for the id is cleared first, so it doubles as
   * "reschedule after an edit".
   */
  scheduleJob(job: Job): void {
    // A restart waiting for its delay is not a schedule: re-planning the job (an edit, an enable) must not lose it, or a job
    // that was about to come back would stay down with nothing saying so. unscheduleJob (disable, remove) still drops it.
    const pendingRestart = this._deadlines.take(job.id, 'restart');
    this.unscheduleJob(job.id);
    if (pendingRestart !== null && job.enabled) {
      this._deadlines.set(job.id, 'restart', pendingRestart.dueAt, pendingRestart.run);
    }
    if (!job.enabled) {
      return;
    }
    if (job.type === 'cron') {
      /*
       * A cron job can carry an active window: "active for three weeks", or a period that has not
       * opened yet.
       *
       * Three outcomes, and `pending` is why this is not a boolean. A job whose window opens later is
       * enabled and working as configured - it just waits, with a timer that arms the cron task when
       * the window opens. Expired means the window closed, and the job is DISABLED rather than
       * deleted: its definition, history and logs stay, and turning it back on is the user's decision.
       */
      const state = windowStateAt(job, this._time.now());
      if (state === 'expired') {
        this._expireJob(job);
        return;
      }
      if (state === 'pending') {
        const until = msUntilStart(job, this._time.now())!;
        this._deadlines.set(job.id, 'window-start', this._time.now() + until, () => {
          // Re-read: the job may have been edited or disabled while it waited.
          const current = this._registry.get(job.id);
          if (current) {
            this.scheduleJob(current);
          }
        });
        return;
      }
      this._scheduleCron(job);
      // Arms the end of the window too, so a job expires on time rather than at its next firing -
      // which for a weekly job could be six days late, and for a job that never fires again, never.
      const remaining = msUntilEnd(job, this._time.now());
      if (remaining !== null) {
        this._deadlines.set(job.id, 'window-end', this._time.now() + remaining, () => {
          const current = this._registry.get(job.id);
          if (current) {
            this._expireJob(current);
          }
        });
      }
      return;
    }
    if (job.type === 'once') {
      void this._scheduleOnce(job);
      return;
    }
    // `startup` means "when the daemon starts". A startup job added while it is already running has
    // nothing to schedule now, and firing it here would contradict the type's own meaning.
    // `manual` is never fired by the scheduler: nothing is armed, now or at daemon start.
  }

  /**
   * Where a job stands relative to its active window: pending, active or expired.
   *
   * Null for an unknown id. Exposed because "enabled" cannot answer it - a job waiting for its window
   * to open is enabled and not running, and a caller that can only see the boolean has to guess which
   * of the two it is looking at.
   */
  windowStateOf(id: string): WindowState | null {
    const job = this._registry.get(id);
    return job ? windowStateAt(job, this._time.now()) : null;
  }

  /** Cancels a job's pending cron task or timer. Safe for an id that has neither. */
  /**
   * `forgetRestarts`: the job is gone or switched off (remove, disable), so its restartOnExit counters go too. Not the default:
   * an edit goes through here as well (scheduleJob) and must keep the budget of a job that is crash-looping.
   */
  unscheduleJob(id: string, options: { forgetRestarts?: boolean } = {}): void {
    // Every kind at once. This used to reach into three collections by hand, and forgetting one was
    // exactly how a stopped scheduler kept a window timer armed - see the fix that preceded this.
    this._deadlines.clear(id);
    if (options.forgetRestarts === true) {
      this._forgetRestartState(id);
    }
  }

  /**
   * Ends a job's active window: disabled, not deleted.
   *
   * Persisted, so it survives a restart and the user sees a job that is off rather than one that
   * quietly stopped working. Announced, because a job going quiet on its own is otherwise
   * indistinguishable from a job that is broken.
   */
  /**
   * Reacts to a firing that arrived outside the window: expire it, or leave it waiting.
   *
   * Only reached when a timer did not do its job - a suspended machine, or a clock that moved - so it
   * corrects the state rather than merely declining to run.
   */
  private _expireOrWait(job: Job): void {
    if (windowStateAt(job, this._time.now()) === 'expired') {
      this._expireJob(job);
      return;
    }
    // Pending: the window opens later, so re-arm rather than disable.
    this.scheduleJob(job);
  }

  private _expireJob(job: Job): void {
    this.unscheduleJob(job.id);
    if (!job.enabled) {
      return;
    }
    this._registry.disable(job.id);
    this._eventPublisher.publish('job.window_expired', {
      jobId: job.id, label: job.label, activeUntil: job.activeUntil,
    });
  }

  async stop(): Promise<void> {
    // One call disarms everything. The previous version cancelled each collection by hand and had
    // silently missed the window timers, so a stopped scheduler could still disable a job days later.
    // A single queue makes that class of omission unexpressible.
    this._deadlines.clearAll();
    this._retryCounters.clear();
    // Memory only: the file keeps the counters for the next daemon. Stopping is not a crash and counts as no restart.
    this._restartStates.clear();
    this._restartStatesLoaded = false;
    this._startupKeepsRestartState.clear();
    this._stopped = true;
  }

  /**
   * What the scheduler has actually armed, per job, beside what the registry asks for.
   *
   * Exists because every "it was configured and never fired" bug in this daemon has been a
   * disagreement between those two, and there was no way to see it: the registry said cron, the
   * dashboard said cron, and nothing was armed. A job added at runtime was never scheduled, a once
   * job past a timer's ceiling fired immediately, a window beyond 24 days opened at once - each one
   * needed a code reading to find, and each one would have been one line of this output.
   *
   * Read `problem` first. Null there means intent and reality agree.
   */
  inspectTimers(): TimerReport[] {
    const now = this._time.now();
    const iso = (ms: number): string => new Date(ms).toISOString();

    return this._registry.list().map((job): TimerReport => {
      // One lookup, because there is one queue. This used to read three collections and infer which
      // of them counted, which is how the window end came to be invisible in the first version.
      const windowEnd = this._deadlines.find(job.id, 'window-end');
      // Earliest deadline for this job that is not the window end: the moment it will next act.
      const acting = this._deadlines.list()
        .find(d => d.jobId === job.id && d.kind !== 'window-end' && d.kind !== 'sla') ?? null;

      const windowState = job.type === 'cron' ? windowStateAt(job, now) : null;
      const nextFiring = job.type === 'cron' && job.schedule
        ? (getNextFirings(job.schedule, 1, new Date(now))[0]?.toISOString() ?? null)
        : null;

      return {
        jobId: job.id,
        type: job.type,
        enabled: job.enabled,
        armed: acting?.kind ?? null,
        dueAt: acting ? iso(acting.dueAt) : null,
        windowEndsAt: windowEnd ? iso(windowEnd.dueAt) : null,
        nextFiring,
        windowState,
        spent: job.type === 'once' && job.spent === true,
        problem: this._timerProblem(job, acting?.kind ?? null, windowState, nextFiring),
      };
    });
  }

  /**
   * How many timers the scheduler has armed. One, or none when nothing is outstanding.
   *
   * Exposed for the tests and for `orch timers`: the promise that this daemon owns a single timer is
   * worth being able to check rather than to trust.
   */
  get armedTimers(): number {
    return this._deadlines.armedTimers;
  }

  /**
   * Why a job will not fire, in the user's words, or null.
   *
   * Only states that are genuinely wrong are reported. A disabled job with nothing armed is correct,
   * and so is a cron job waiting for its window to open with a window-start timer set: saying
   * something about those would bury the one line that matters.
   */
  private _timerProblem(
    job: Job,
    armed: TimerReport['armed'],
    windowState: WindowState | null,
    nextFiring: string | null,
  ): string | null {
    if (!job.enabled) {
      return armed === null
        ? null
        : `disabled, yet a ${armed} timer is still armed -- it should have been cancelled`;
    }
    /*
     * A spent once job has nothing left to arm, and that is the correct state rather than a fault.
     *
     * Before spent jobs were kept, "a once job in the registry with nothing armed" could only mean the
     * scheduler had missed it, so the fallback below was right. Now it also describes every job that
     * has already run, and telling the user "enabled but NOTHING is armed for it: it will never fire"
     * about a job that fired successfully last Tuesday would bury the lines that do matter.
     */
    if (job.type === 'once' && job.spent === true) {
      return armed === null
        ? null
        : `already fired, yet a ${armed} timer is still armed -- it would run a second time`;
    }
    if (armed !== null) {
      // A cron task that is running but whose expression yields no next firing will never fire.
      if (armed === 'cron' && nextFiring === null) {
        return `schedule ${JSON.stringify(job.schedule)} has no next firing within a year, so this never runs`;
      }
      return null;
    }
    if (job.type === 'startup') {
      return null;
    }           // fires once at daemon start, nothing to arm
    // Runs only when triggered, so nothing armed is the correct state, not a job that was lost.
    if (job.type === 'manual') {
      return null;
    }
    if (windowState === 'expired') {
      return 'its active period has ended -- enabled but nothing armed; re-enable it to resume';
    }
    return `enabled but NOTHING is armed for it: it will never fire. ` +
      `Check the daemon log, then re-save the job (orch edit ${job.id} --label ${JSON.stringify(job.label ?? job.id)}) to re-arm it.`;
  }

  async dryRun(id: string): Promise<{ pid: number | null } | { exitCode: number | null } | { error: string }> {
    const job = this._registry.get(id);
    if (!job) {
      throw new Error(`Job not found: "${id}"`);
    }
    if (!job.dryRunSupported) {
      return { error: `Job "${id}" does not declare dryRunSupported: true` };
    }
    const dryJob = { ...job, command: job.command + ' --dry-run' };
    return this._fire(dryJob, { kind: 'manual' });
  }

  /**
   * Runs a job now, on request.
   *
   * `wait` belongs to this one call, not to the job: the job's own triggerMode governs its scheduled
   * firings. Without this, `orch trigger --wait` only waited on jobs already configured to be waited
   * on -- the ones that did not need the flag -- and returned immediately on every other job while
   * printing that it had finished.
   */
  async trigger(
    id: string,
    source: TriggerSource = { kind: 'manual' },
    wait = false,
    options: { force?: boolean; detach?: boolean } = {},
  ): Promise<TriggerResult> {
    return (await this._triggerDetailed(id, source, wait, options)).result;
  }

  /** trigger(), plus the reason the run could not be started when it could not (the public answer has no field for it). */
  private async _triggerDetailed(
    id: string, source: TriggerSource, wait: boolean, options: { force?: boolean; detach?: boolean },
  ): Promise<{ result: TriggerResult; startError?: string }> {
    const job = this._registry.get(id);
    if (!job) {
      throw new Error(`Job not found: "${id}"`);
    }

    /*
     * Asking by hand is not exempt from maxConcurrency, unlike liveness: the limit is the job's own
     * statement that two instances must not coexist, and a stray double-click or a script that
     * triggers twice is exactly what it is for. `force` is the explicit "I know, start another".
     *
     * Checked before the once-job consumption below, so a refused trigger does not spend the job.
     */
    if (options.force !== true) {
      const full = this._atLimit(job);
      if (full) {
        this._refuseForConcurrency(job, full);
        return { result: { status: 'already-running', ...full } };
      }
    }

    /*
     * Running a once job is what consumes it, whoever asked.
     *
     * This used to fire and leave the armed timer alone, so the job ran again when its moment
     * arrived: a job whose type is "once" ran twice, in silence. The scheduled firing marks it spent,
     * and a manual firing is the same event arriving early - so it takes the same path, unscheduled
     * first so the timer cannot outlive the job.
     *
     * Reported back rather than done quietly: the job leaving the default views is a side effect the
     * user did not ask for, and unexplained it reads as a bug.
     *
     * An already-spent job is not excluded. Asking for it by hand is an explicit "run this command
     * again", which is a new run of the same definition rather than a second consumption -- markSpent
     * keeps the original spentAt for exactly that reason.
     */
    const consumed = job.type === 'once';
    if (consumed) {
      this.unscheduleJob(job.id);
    }

    // `detach`: answer once the run has started even if the job's own triggerMode is "wait". A restart replies
    // with the new pid; waiting for a long-running job to end would never reply.
    const result = await this._fire(options.detach === true ? { ...job, triggerMode: 'fire-and-forget' } : job, source, wait);

    // After the fire, mirroring the scheduled path, so a `wait` trigger still has its job in place
    // while it runs.
    if (consumed && this._registry.get(job.id) !== null) {
      this._registry.markSpent(job.id);
    }

    const outcome = 'exitCode' in result
      ? { status: 'finished' as const, exitCode: result.exitCode }
      : { status: 'started' as const, pid: result.pid };
    return {
      result: { ...outcome, ...(consumed ? { consumed: true } : {}) },
      ...('startError' in result && result.startError !== undefined ? { startError: result.startError } : {}),
    };
  }

  /**
   * Fire-and-forget teardown, for callers that report to nobody: a timeout and a resource-limit
   * breach are decided here, so there is no reply whose truth depends on the kill having landed.
   *
   * killTreeSync owns the whole job: the root pid AND its descendants, plus the
   * SIGTERM-then-SIGKILL escalation. Signalling `child` ourselves in addition is not just
   * redundant, it breaks the kill on both platforms by orphaning the descendants before
   * they can be found: on Windows terminating cmd.exe leaves `taskkill /T` without a live
   * root to enumerate, and on POSIX our synchronous signal lands before the asynchronous
   * pidtree walk has even listed the tree. Either way the real work keeps running.
   */
  private _killChild(child: ChildProcess, reason: string): void {
    // Written first: the supervisor records why the job ended, and ends the tree itself if the daemon is gone.
    if (child instanceof SupervisedChild) {
      child.requestKill(reason);
    }
    if (child.pid !== undefined) {
      this._killTreeSync(child.pid);
      return;
    }
    // No pid: an unspawned or already-reaped handle. Signalling it is all we can do.
    child.kill('SIGTERM');
  }

  /**
   * Same teardown, but awaits it. Used where the outcome is reported back to a user, since
   * killTreeSync only tears the tree down inline on Windows: on POSIX it starts the pidtree walk
   * and returns, so killJob answered `killed: true` while every process was still running and the
   * dashboard showed the job as killed on the strength of a promise nobody held.
   */
  /**
   * The run's telemetry file, or null when it cannot be opened. A job id the file name cannot carry
   * (older registries allowed more than the current rule) costs the record, never the run, and says so
   * in the job's own log.
   */
  private _openTelemetry(jobId: string, startedAt: string, pid: number | null | undefined, jobLogger: RunLogger): JobTelemetry | null {
    try {
      return new JobTelemetry(this._configDir, jobId, startedAt, pid, {
        onWarn: (message) => jobLogger.write(`[resource-monitor] ${message}`),
      });
    } catch (err) {
      jobLogger.write(`[resource-monitor] no telemetry kept for this run: ${getErrorMessage(err)}`);
      return null;
    }
  }

  /**
   * Appends this run to the job's long consumption history. A record, never a duty: a failure is said once
   * in the run's own log (a run writes one record, so once is every time) and the run is untouched.
   * A run the daemon did not watch has no samples: its peaks come from what was saved, its averages are null.
   */
  private _recordResourceHistory(ctx: RunContext, outcome: RunOutcome, reason: RunHistoryReason): void {
    const { job, startedAt, jobLogger, usage } = ctx;
    // A run that never had a process (it could not be started) used no resources: no record of zeros.
    if (ctx.pid === null && usage === undefined && outcome.durationMs === 0) {
      return;
    }
    const round1 = (n: number): number => Math.round(n * 10) / 10;
    const samples = usage?.samples ?? 0;
    try {
      appendResourceHistory(this._configDir, job.id, {
        startedAt,
        finishedAt: outcome.finishedAt,
        durationMs: outcome.durationMs,
        exitCode:   outcome.exitCode,
        ...(reason !== undefined ? { endReason: reason } : {}),
        peakCpuPct: round1(outcome.peakCpuPct),
        peakRamMb:  round1(outcome.peakRamMb),
        avgCpuPct:  usage !== undefined && samples > 0 ? round1(usage.cpuSum / samples) : null,
        avgRamMb:   usage !== undefined && samples > 0 ? round1(usage.ramSum / samples) : null,
        samples,
        soft:       usage?.limits.soft ?? null,
        hard:       usage?.limits.hard ?? null,
        enforce:    usage?.limits.enforce ?? job.resourceLimits?.enforce ?? RESOURCE_LIMIT_DEFAULTS.enforce,
      });
    } catch (err) {
      jobLogger.write(`[resource-monitor] the resource history of job "${job.id}" could not be written (${getErrorMessage(err)}); the run is unaffected, only this record is lost. Check that ${path.join(this._configDir, 'resource-history')} is a writable directory.`);
    }
  }

  /**
   * One log line saying what the monitor was counting when it decided: how many processes of how many
   * walked, and the biggest few with their executable. Null when the sampler gave no breakdown.
   *
   * Never rejects and never takes long. A name that cannot be found is simply left out, because this
   * runs on the way to a kill that has to happen regardless.
   */
  private async _describeTree(usage: TreeUsage): Promise<string | null> {
    if (usage.processes === undefined || usage.processes.length === 0) {
      return null;
    }
    const top = usage.processes.slice(0, 5);
    const timeout = new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000).unref());
    const names = await Promise.all(top.map(p =>
      Promise.race([this._processName(p.pid), timeout]).catch((): undefined => undefined)));
    const parts = top.map((p, i) => {
      const name = names[i] === undefined ? '' : ` ${names[i]}`;
      return `pid ${p.pid}${name} (parent ${p.ppid}) ${Math.round(p.ramMb)}MB`;
    });
    const scope = usage.walked !== undefined && usage.counted !== undefined
      ? `${usage.counted} of ${usage.walked} processes counted; `
      : '';
    return `[resource-monitor] Process tree at kill: ${scope}biggest: ${parts.join(', ')}`;
  }

  private async _killChildAsync(child: ChildProcess, reason: string): Promise<void> {
    if (child instanceof SupervisedChild) {
      child.requestKill(reason);
    }
    if (child.pid !== undefined) {
      await this._killTree(child.pid);
      return;
    }
    child.kill('SIGTERM');
  }

  /**
   * Live runs across all jobs: how many are going, how many of those run under a supervisor, and how many this
   * daemon found going and followed again (since it started, whether at start or by taking over).
   */
  runCounts(): { running: number; supervised: number; followedAgain: number } {
    let running = 0;
    let supervised = 0;
    for (const children of this._activeChildren.values()) {
      for (const child of children) {
        running++;
        if (child instanceof SupervisedChild) {
          supervised++;
        }
      }
    }
    return { running, supervised, followedAgain: this._followedAgainTotal };
  }

  /** How many instances of the job are alive right now. */
  runningCount(id: string): number {
    return this._running.get(id) ?? 0;
  }

  /**
   * Stops every live instance of the job and says how many it stopped. `killed` is true iff at least
   * one was running.
   */
  async killJob(id: string): Promise<{ killed: boolean; count: number; cancelledRestart?: boolean }> {
    // Stopping a job by hand also cancels the restart it was waiting for and forgets its failures: a person has taken over
    // (restartOnExit never fights a manual kill). Said in the answer, or `orch kill` on a job that is only waiting reads "not running".
    const waiting = this._deadlines.find(id, 'restart') !== null;
    this._deadlines.clear(id, 'restart');
    this._forgetRestartState(id);
    const cancelledRestart = waiting ? { cancelledRestart: true } : {};
    const live = [...(this._activeChildren.get(id) ?? [])].filter(child => !child.killed);
    if (live.length > 0) {
      for (const child of live) {
        this._killedByUser.add(child);
      }
      await Promise.all(live.map(child => this._killChildAsync(child, 'manual')));
      return { killed: true, count: live.length, ...cancelledRestart };
    }
    // Stale state: no active child but state still shows running - clean it up.
    // Liveness is finishedAt, not exitCode: a run killed by signal has no exit code,
    // so testing exitCode would "kill" an already-cancelled run and wrongly report success.
    // Every open entry, not the newest: a newer run that already ended must not hide an older one.
    const open = this._state.getOpenRuns(id);
    if (open.length > 0) {
      for (const entry of open) {
        // The same path as a run learned late: recorded (cancelled, no exit code, so it does not feed the failure
        // streak) and announced with job.killed_manual, once. The process is not this daemon's to stop.
        const finishedAt = this._now().toISOString();
        this._finishRun(this._contextOfOpenRun(id, entry), {
          exitCode: null, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(entry.startedAt)),
          cancelledByUser: true, timedOut: false, killedByResourceLimit: false,
          peakCpuPct: entry.peakCpuPct ?? 0, peakRamMb: entry.peakRamMb ?? 0,
        }, { late: true, actionsAllowed: false });
      }
      return { killed: true, count: open.length, ...cancelledRestart };
    }
    return { killed: false, count: 0, ...cancelledRestart };
  }

  /** What _finishRun needs about a run that is open in the history and has no process this daemon watches. */
  private _contextOfOpenRun(id: string, entry: RuntimeEntry): RunContext {
    const job: Job = this._registry.get(id)
      ?? { id, type: 'cron', label: id, command: '', enabled: false, triggerMode: 'fire-and-forget' };
    const previous = this._state.getRunBefore(id, entry.startedAt);
    return {
      job,
      trigger: entry.triggeredBy ?? { kind: 'manual' },
      startedAt: entry.startedAt,
      pid: entry.pid ?? null,
      // Appends to the log the run already has.
      jobLogger: this._runLogger(job, entry.startedAt),
      telemetry: null,
      previousRunFailed: previous !== null && isFailure(previous),
    };
  }

  /**
   * Announces a run that was closed in the history because nothing is left of it (the daemon that started it is gone, or
   * its process is): job.failed, flagged late, through the same path as a run learned late after a restart. The history
   * entry is the caller's (it keeps its own reading); nothing acts on it (no retry, no dependents) since nobody saw it end.
   */
  private _announceInterrupted(id: string, entry: RuntimeEntry): void {
    const ctx = this._contextOfOpenRun(id, entry);
    const finishedAt = entry.finishedAt ?? this._now().toISOString();
    ctx.jobLogger.write('[recovery] this run was left open by a daemon that is gone, so it is closed as interrupted (its outcome is unknown)');
    this._finishRun(ctx, {
      exitCode: 1, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(entry.startedAt)),
      cancelledByUser: false, timedOut: false, killedByResourceLimit: false,
      peakCpuPct: entry.peakCpuPct ?? 0, peakRamMb: entry.peakRamMb ?? 0,
    }, {
      late: true, actionsAllowed: false, recorded: true,
      actionsSkippedNote: '[recovery] retry/restart/dependents skipped: nobody saw this run end',
    });
    this.emit('job-interrupted', { id, job: ctx.job });
  }

  /**
   * At daemon start, closes the runs a previous daemon left open (see State.closeOrphanedRuns) and announces each, so
   * whoever waits for the end of a run is not left waiting for ever. Returns how many were closed.
   */
  closeInterruptedRuns(now: Date): number {
    return this._state.closeOrphanedRuns(
      now,
      (id, entry) => this.isFollowing(id, entry.startedAt),
      (id, entry) => this._announceInterrupted(id, entry),
    );
  }

  /**
   * Ends every live instance of the job, waits until each is really gone, then starts a new run as a manual trigger.
   *
   * The wait is on the scheduler's own count, which only drops when the child's 'close' has been seen: killJob
   * answers once the kill has been delivered, which is earlier. Starting before that put a second copy next to the
   * one being ended (two servers on one port, or a refusal by maxConcurrency of a job that is going away).
   *
   * Unlike a plain manual trigger this one asks the liveness check: after the kill the target should be down, so a
   * target still answering is something else holding the port, and a new start would collide with it.
   *
   * Never throws for a refusal: the instances were ended, and the answer has to say so. `id` is for the caller to add.
   */
  async restartJob(id: string, source: TriggerSource = { kind: 'manual' }): Promise<Omit<RestartResult, 'id'>> {
    // One restart of a job at a time: two overlapping ones both saw the old instance go, then each started a
    // copy, leaving two running. The second now waits for the first and ends the copy it started.
    const turn = (this._restartTurns.get(id) ?? Promise.resolve()).then(() => this._restartNow(id, source));
    const settled = turn.then(() => undefined, () => undefined);
    this._restartTurns.set(id, settled);
    void settled.then(() => {
      if (this._restartTurns.get(id) === settled) {
        this._restartTurns.delete(id);
      }
    });
    return turn;
  }

  private async _restartNow(id: string, source: TriggerSource): Promise<Omit<RestartResult, 'id'>> {
    const job = this._registry.get(id);
    if (!job) {
      throw new Error(`Job not found: "${id}"`);
    }
    const { killed: wasRunning, count: killed } = await this.killJob(id);
    const refused = (reason: string, skipped?: RestartResult['skipped']): Omit<RestartResult, 'id'> =>
      ({ wasRunning, killed, started: false, pid: null, ...(skipped === undefined ? {} : { skipped }), reason });

    const gone = await this._waitUntilNoneRunning(id, this._restartGraceMs);
    if (!gone) {
      return refused(
        // Below one second a rounded figure would read "0s": the milliseconds are said as they are.
        `the ended instance of "${id}" is still running ${this._restartGraceMs < 1000 ? `${this._restartGraceMs} ms` : `${Math.round(this._restartGraceMs / 1000)}s`} after it was told to stop, so no second copy was started. `
        + `Check what is holding it, then run: orch kill ${id} and orch trigger ${id}.`,
      );
    }
    if (this._hasFollowedRun(id)) {
      return refused(
        `a run of "${id}" is followed by another daemon, which this daemon cannot end, so no second copy was started. `
        + 'Stop the other daemon (orch stop on its config dir), then run the restart again.',
        'adopted',
      );
    }
    if (await this._liveness(job)) {
      return refused(
        `the liveness check of "${id}" says its target is still alive after the instance was ended (something else holds the port or the pid file), so it was not started. `
        + `Free it, then run: orch trigger ${id}.`,
        'liveness',
      );
    }
    const { result, startError } = await this._triggerDetailed(id, source, false, { detach: true });
    if (startError !== undefined) {
      return refused(`"${id}" could not be started: ${startError}. Fix the cause (see \`orch logs\`), then run: orch trigger ${id}.`);
    }
    if (result.status === 'already-running') {
      return refused(
        `"${id}" is at its limit (${result.running} of ${result.maxConcurrency} running), so it was not started. `
        + `Run orch kill ${id}, then orch trigger ${id}.`,
        'concurrency',
      );
    }
    return { wasRunning, killed, started: true, pid: result.status === 'started' ? result.pid : null };
  }

  /**
   * Resolves true once no instance of the job is registered as running, false after `ms` (on the scheduler's clock).
   * Woken by the close of the last instance, not by polling: a poll would be a real wait a test cannot drive.
   */
  private _waitUntilNoneRunning(id: string, ms: number): Promise<boolean> {
    if ((this._running.get(id) ?? 0) === 0) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiters = this._idleWaiters.get(id) ?? new Set<() => void>();
      this._idleWaiters.set(id, waiters);
      const onIdle = (): void => finish(true);
      const timer = this._time.after(ms, () => finish(false));
      const finish = (idle: boolean): void => {
        timer.cancel();
        waiters.delete(onIdle);
        if (waiters.size === 0 && this._idleWaiters.get(id) === waiters) {
          this._idleWaiters.delete(id);
        }
        resolve(idle);
      };
      waiters.add(onIdle);
    });
  }

  skipNextFiring(id: string): void {
    const job = this._registry.get(id);
    if (!job || job.type !== 'cron' || !job.schedule) {
      return;
    }
    // Compute the next occurrence from 1 minute from now (avoids current-minute edge case)
    const firings = getNextFirings(job.schedule, 1, new Date(Date.now() + 60_000));
    if (firings.length > 0) {
      // Mark as skip-until 1 minute after that occurrence fires
      this._skippedJobs.set(id, firings[0]!.getTime() + 60_000);
    }
  }

  private _scheduleCron(job: Job): void {
    if (!cron.validate(job.schedule ?? '')) {
      /*
       * Said out loud. This used to be a bare `return`, so a job with an unrunnable schedule was
       * listed by `orch list` and shown in the dashboard with its schedule, and simply never fired -
       * the single hardest kind of failure to notice, because everything looks configured.
       *
       * The registry rejects these at write time now, so reaching here means a registry.json edited
       * by hand or written by an older version. Refusing to schedule is still right; doing it in
       * silence was not.
       */
      console.error(`[scheduler] job "${job.id}" has an unrunnable cron schedule ${JSON.stringify(job.schedule)} and will NEVER fire. Fix it with: orch edit ${job.id} --schedule "<cron>"`);
      return;
    }
    /*
     * Exactly five fields, checked separately from cron.validate.
     *
     * node-cron also accepts a SIX-field form whose first field is seconds, and the registry has
     * always refused it - CRON_RE is anchored on five. Our own matcher reads the first five fields
     * positionally, so a six-field expression reaching here would be read as minute-hour-dom-mon-dow
     * and mean something else entirely: "every second" would become "every minute of hour 0". Wrong
     * and silent, which is the one outcome worth a guard.
     */
    const fieldCount = job.schedule!.trim().split(/\s+/).length;
    if (fieldCount !== 5) {
      console.error(`[scheduler] job "${job.id}" has a ${fieldCount}-field cron schedule ${JSON.stringify(job.schedule)}; only the five-field form (minute hour day month weekday) is supported, so it will NOT fire. A seconds field is not supported.`);
      return;
    }
    this._armNextCronFiring(job);
  }

  /**
   * Puts a cron job's next occurrence on the queue, and nothing else.
   *
   * node-cron used to own this: one running task per cron job, each with its own heartbeat. It is
   * gone from the firing path - only its expression validator is still used, above, which arms
   * nothing. The next occurrence comes from getNextFirings, which was already ours and is what
   * `orch schedule` and the dashboard have always displayed, so the schedule shown and the schedule
   * armed are now computed by the same code rather than by two implementations that happened to
   * agree.
   *
   * Re-arms itself after each firing. getNextFirings starts its scan at the minute AFTER `from`, so
   * computing the next occurrence from the moment we just fired cannot return that same moment.
   */
  private _armNextCronFiring(job: Job): void {
    const next = getNextFirings(job.schedule!, 1, new Date(this._time.now()))[0];
    if (!next) {
      // A valid expression with no occurrence inside the scan horizon: a job that will never run
      // again. Said out loud, because the silent version of this is the hardest failure to notice.
      console.error(`[scheduler] job "${job.id}" has schedule ${JSON.stringify(job.schedule)} with no occurrence within a year and will NOT fire again.`);
      return;
    }

    this._deadlines.set(job.id, 'cron', next.getTime(), () => {
      // Re-read, so an edit that landed while this occurrence was waiting is honoured rather than
      // running the definition captured when it was armed.
      const current = this._registry.get(job.id) ?? job;

      // Re-armed before the run, not after, so a firing that throws still leaves the job scheduled.
      if (current.enabled && current.type === 'cron' && current.schedule) {
        this._armNextCronFiring(current);
      }

      const skipUntil = this._skippedJobs.get(current.id);
      if (skipUntil && this._time.now() < skipUntil) {
        this._skippedJobs.delete(current.id);
        return; // occurrence was pre-empted by trigger-early
      }

      const scheduledAt = this._now().toISOString();
      void this._maybeSpawn(current);

      // SLA window check: alert if the job has not succeeded within slaWindowMinutes.
      if (current.slaWindowMinutes && current.slaWindowMinutes > 0) {
        this._deadlines.set(current.id, 'sla', this._time.now() + current.slaWindowMinutes * 60_000, () => {
          const latest = this._state.get(current.id);
          const succeeded = latest && latest.exitCode === 0 &&
            new Date(latest.startedAt).getTime() >= new Date(scheduledAt).getTime();
          if (!succeeded) {
            this._eventPublisher.publish('alert.sla_breach', {
              jobId: current.id, label: current.label,
              scheduledAt, windowMinutes: current.slaWindowMinutes,
            });
          }
        });
      }
    });
  }

  /**
   * Fires unless the job's liveness check says the target is already up.
   *
   * Every scheduled path goes through here -- cron, catch-up, startup and once. It used to be
   * reachable from startup jobs only, so `--liveness-strategy` on a cron job was accepted by the CLI
   * and then ignored, which is the whole reason "this scraper is already running" surfaced as a
   * failed run instead of a skipped one.
   *
   * A manual `orch trigger` deliberately does not come through here: someone asking for a run
   * explicitly should not be second-guessed.
   */
  private async _maybeSpawn(job: Job, trigger: TriggerSource = { kind: 'cron' }, atStart = false): Promise<void> {
    /*
     * The window, checked again at the moment of firing.
     *
     * scheduleJob arms a timer to expire the job on time, so this should never be the thing that
     * stops it - but a timer is a promise about a machine that might sleep, hibernate or have its
     * clock moved, and none of those retract a cron task. This is the check that cannot be skipped by
     * time not passing the way the process expected.
     *
     * A manual trigger is exempt: asking for a run explicitly is not the schedule firing, and
     * refusing it would be answering a different question than the user asked.
     */
    if (trigger.kind !== 'manual' && windowStateAt(job, this._time.now()) !== 'active') {
      this._expireOrWait(job);
      return;
    }
    // The daemon has just come back and this run is still going from before: a startup or catch-up firing would
    // start a second copy of it (two servers on one port). A cron firing is left alone, as it is for a live run.
    if (atStart && this._hasFollowedRun(job.id)) {
      this._refuseForAdoption(job);
      return;
    }
    if (trigger.kind !== 'manual') {
      const full = this._atLimit(job);
      if (full) {
        this._refuseForConcurrency(job, full);
        return;
      }
    }
    if (await this._liveness(job)) {
      this._recordSkip(job, 'liveness');
      return;
    }
    void this._fire(job, trigger);
  }

  /** Null when the job may start another run, otherwise how full it is. */
  private _atLimit(job: Job): { running: number; maxConcurrency: number } | null {
    if (job.maxConcurrency === undefined) {
      return null;
    }
    const running = this._running.get(job.id) ?? 0;
    return running >= job.maxConcurrency ? { running, maxConcurrency: job.maxConcurrency } : null;
  }

  /**
   * Announces a firing that was due and spawned nothing, on both channels: the queue (job.skipped) and this
   * scheduler's own 'job-skipped', which the audit trail listens to. Publishing alone left the audit blind to
   * every refusal. The exit-code skip does not come through here: it is a run, reported by 'job-finished'.
   */
  private _announceSkip(
    job: Job, reason: 'concurrency' | 'adopted' | 'liveness',
    full?: { running: number; maxConcurrency: number },
  ): void {
    this._eventPublisher.publish('job.skipped', {
      jobId: job.id, label: job.label, exitCode: null, durationMs: 0, reason, ...full,
    });
    this.emit('job-skipped', { id: job.id, job, reason, ...full });
  }

  /**
   * Reports a firing refused because the job is at its maxConcurrency.
   *
   * Deliberately NOT _recordSkip: that writes a history entry and a log file of its own, and both
   * are "the newest run" to the readers. The dashboard decides whether a job is running from the
   * entry with the latest startedAt, and the live log follows the newest file -- so a skip written
   * while a run is in flight would show that run as ended and pull the tail off its output. The
   * refusal goes where it cannot masquerade as a run: an event (which reaches the audit trail) and
   * a line in the log of the run that is occupying the slot.
   */
  private _refuseForConcurrency(job: Job, full: { running: number; maxConcurrency: number }): void {
    this._liveLogger.get(job.id)?.write(
      `[job:skipped] reason=concurrency -- ${full.running} of ${full.maxConcurrency} already running`,
    );
    this._announceSkip(job, 'concurrency', full);
  }

  /**
   * Reports a startup or catch-up firing refused because the job's run is still going from before the restart.
   *
   * Not _recordSkip, for the reason _refuseForConcurrency gives: a history entry and a log file of its own are
   * "the newest run" to the readers. This was recorded that way at first, and every daemon restart then buried a
   * live server under a 119-byte "run": the dashboard read the job as ended and the log page named the empty one
   * "Live". The refusal goes in the log of the run that is going, when this daemon follows it, and in an event.
   */
  private _refuseForAdoption(job: Job): void {
    this._liveLogger.get(job.id)?.write(
      '[job:skipped] reason=adopted -- still running from before the restart, not started a second time',
    );
    this._announceSkip(job, 'adopted');
  }

  /** A firing that does not come from the schedule (retry, dependency), held to the same limit. */
  private _fireUnlessFull(job: Job, trigger: TriggerSource): void {
    const full = this._atLimit(job);
    if (full) {
      this._refuseForConcurrency(job, full);
      return;
    }
    void this._fire(job, trigger);
  }

  /**
   * Leaves a trace for a firing that never spawned anything.
   *
   * This was a bare `return`: no log line, no event, no history. "The job did not run and nothing
   * says why" is no better than a false failure, so the skip is recorded like any other outcome --
   * with exitCode null, because no process ran, and finishedAt set, so it does not read as a run
   * still in flight.
   */
  private _recordSkip(job: Job, reason: 'liveness'): void {
    const at = this._now().toISOString();
    this._state.record(job.id, {
      startedAt: at, finishedAt: at, exitCode: null, pid: null, skipped: true,
    });
    // Same per-run log file layout as a real run, so the skip shows up in `orch logs --job <id>`
    // right where the run would have been.
    const jobLogger = this._runLogger(job, at);
    jobLogger.write(`[job:skipped] reason=${reason} -- target already alive, nothing was done`);
    jobLogger.close();
    this._announceSkip(job, reason);
  }

  /**
   * Gives every run the supervisors left behind its due, at daemon start and before anything fires.
   *
   * A run whose supervisor recorded an end gets that end handled as if the daemon had seen it, flagged late
   * (policy C in .claude/plans/2026-10-18_update-with-jobs-running.md): it is always recorded and announced,
   * and only acts (retry, dependents) if it ended within the window. A run still going is followed again: same
   * history entry, same log, kill, timeout and peaks, as if the daemon had never been away.
   */
  async recoverRuns(): Promise<RecoveryReport> {
    // Before anything is decided about an ended run: its restart is planned from the counters of the daemon that died.
    this._restoreRestartStates();
    const report: RecoveryReport = { finalized: 0, cleaned: 0, adopted: 0, lost: [], followedElsewhere: 0, unreadable: [] };
    const root = path.join(this._configDir, 'runs');
    let jobDirs: string[];
    try {
      jobDirs = fs.readdirSync(root);
    } catch {
      return report;
    }
    const going: Array<{ runDir: string; spec: SupervisedSpec; status: SupervisedStatus }> = [];
    for (const jobDir of jobDirs) {
      let runNames: string[];
      try {
        runNames = fs.readdirSync(path.join(root, jobDir));
      } catch {
        continue;
      }
      for (const runName of runNames) {
        const runDir = path.join(root, jobDir, runName);
        if (fs.existsSync(path.join(runDir, 'done'))) {
          fs.rmSync(runDir, { recursive: true, force: true });
          report.cleaned++;
          continue;
        }
        const spec = readJsonFile<SupervisedSpec>(path.join(runDir, 'spec.json'));
        const status = readJsonFile<SupervisedStatus>(path.join(runDir, 'status.json'));
        if (spec === null || status === null || spec.context === undefined) {
          report.unreadable.push(`${runDir}: spec.json or status.json is missing or not valid JSON, left in place to be looked at`);
          continue;
        }
        if (status.state === 'running') {
          going.push({ runDir, spec, status });
          continue;
        }
        this._finalizeRecovered(runDir, spec, status);
        report.finalized++;
      }
    }
    // One look at the process table for every supervisor, not one per run: each look costs about a second on
    // Windows, and the daemon is not ready until this is done.
    const candidates = going.filter(run => !ownedByAnotherLiveDaemon(run.runDir));
    const starts = await this._processStarts(candidates.map(run => run.status.supervisorPid));
    const startOf: ProcessStartFn = async (pid) => starts.get(pid) ?? null;
    for (const run of going) {
      await this._followOrReport(run.runDir, run.spec, run.status, report, startOf);
    }
    return report;
  }

  /**
   * A run whose supervisor says it is still going: follow it again, unless another daemon already does, and
   * report it as lost when its supervisor is gone without having recorded an end.
   */
  private async _followOrReport(
    runDir: string, spec: SupervisedSpec, status: SupervisedStatus, report: RecoveryReport, startOf: ProcessStartFn,
  ): Promise<void> {
    if (ownedByAnotherLiveDaemon(runDir)) {
      report.followedElsewhere++;
      this._watchOwner(`${spec.context.jobId}|${spec.context.startedAt}`, runDir);
      return;
    }
    if (!(await isOurSupervisor(status, startOf))) {
      // The supervisor writes its final status and then exits, so a run that ended while we were looking can
      // show "running" in what we read and a dead supervisor a moment later. Read again before calling it lost.
      const fresh = readJsonFile<SupervisedStatus>(path.join(runDir, 'status.json'));
      if (fresh !== null && fresh.state !== 'running') {
        this._finalizeRecovered(runDir, spec, fresh);
        report.finalized++;
        return;
      }
      const note = `supervisor pid ${status.supervisorPid} of the run of "${spec.context.jobId}" started ${spec.context.startedAt} is not running (or is not the supervisor it was): the run ended without a record, so it is closed as interrupted. Its process ${status.childPid ?? '?'} may still be alive`;
      report.lost.push(`${runDir}: ${note}`);
      const jobLogger = new RunLogger(path.dirname(spec.logPath), spec.context.jobId, spec.context.startedAt, { rotation: specRotation(spec) });
      jobLogger.write(`[recovery] ${note}`);
      jobLogger.close();
      // Closed and announced now, not left for the sweep at daemon start: a run found lost while the daemon is already
      // up (an owner that went away) would otherwise stay open for ever, and nobody would hear it ended.
      const open = this._state.getRun(spec.context.jobId, spec.context.startedAt);
      if (open !== null && open.finishedAt == null) {
        const closed = { ...open, finishedAt: this._now().toISOString(), orphaned: true };
        this._state.record(spec.context.jobId, closed);
        this._announceInterrupted(spec.context.jobId, closed);
      }
      return;
    }
    this._adopt(runDir, spec, status);
    report.adopted++;
  }

  /**
   * A run another live daemon follows is left to it, but not forgotten: if that daemon goes away (an update replaces
   * it, it crashes) nobody would follow the run, and it would sit in the history as running with no one watching.
   */
  private _watchOwner(key: string, runDir: string): void {
    this._followedElsewhere.set(key, runDir);
    if (this._ownerWatch !== null) {
      return;
    }
    this._ownerWatch = setInterval(() => { void this._takeOverRuns(); }, this._ownerWatchMs);
    this._ownerWatch.unref();
  }

  private _takingOver = false;

  private async _takeOverRuns(): Promise<void> {
    if (this._takingOver) {
      return;
    }
    this._takingOver = true;
    try {
      for (const [key, runDir] of [...this._followedElsewhere]) {
        if (!fs.existsSync(runDir)) {
          this._followedElsewhere.delete(key);
          continue;
        }
        if (ownedByAnotherLiveDaemon(runDir)) {
          continue;
        }
        this._followedElsewhere.delete(key);
        const spec = readJsonFile<SupervisedSpec>(path.join(runDir, 'spec.json'));
        const status = readJsonFile<SupervisedStatus>(path.join(runDir, 'status.json'));
        if (spec === null || status === null || spec.context === undefined || fs.existsSync(path.join(runDir, 'done'))) {
          continue;
        }
        const report: RecoveryReport = { finalized: 0, cleaned: 0, adopted: 0, lost: [], followedElsewhere: 0, unreadable: [] };
        if (status.state === 'running') {
          const starts = await this._processStarts([status.supervisorPid]);
          await this._followOrReport(runDir, spec, status, report, async (pid) => starts.get(pid) ?? null);
        } else {
          this._finalizeRecovered(runDir, spec, status);
          report.finalized++;
        }
        this.announceAdopted();
        this.emit('recovery', report);
      }
    } finally {
      this._takingOver = false;
      if (this._followedElsewhere.size === 0 && this._ownerWatch !== null) {
        clearInterval(this._ownerWatch);
        this._ownerWatch = null;
      }
    }
  }

  /** Follows a run found going: registers it like a live one and hands it to the same monitoring. */
  private _adopt(runDir: string, spec: SupervisedSpec, status: SupervisedStatus): void {
    const { jobId, startedAt } = spec.context;
    const job = this._registry.get(jobId) ?? this._jobFromSpec(spec);
    const entry = this._state.getRun(jobId, startedAt);
    const previous = this._state.getRunBefore(jobId, startedAt);
    const child = new SupervisedChild(runDir, status.childPid);
    const jobLogger = new RunLogger(path.dirname(spec.logPath), jobId, startedAt, { rotation: specRotation(spec) });
    const siblings = this._register(child, job, jobLogger);
    claimRun(runDir);
    const key = `${jobId}|${startedAt}`;
    this._followed.add(key);
    child.once('close', () => { this._followed.delete(key); });
    this._adoptedIds.push(jobId);
    this._followedAgainTotal++;
    jobLogger.write(`[recovery] the daemon is following this run again (pid ${status.childPid ?? '?'})`);
    const ctx: MonitorContext = {
      job,
      trigger: spec.context.trigger,
      startedAt,
      pid: entry?.pid ?? status.childPid ?? null,
      jobLogger,
      previousRunFailed: previous !== null && isFailure(previous),
    };
    void this._monitor(child, ctx, siblings, false, { peakCpuPct: entry?.peakCpuPct ?? 0, peakRamMb: entry?.peakRamMb ?? 0 });
    // After the monitoring has attached its listeners: a run that ended meanwhile is closed by the first read.
    child.watch(250);
  }

  /** Whether a run of the job was found going and is followed again, so a startup firing must not start another. */
  private _hasFollowedRun(jobId: string): boolean {
    for (const key of [...this._followed, ...this._followedElsewhere.keys()]) {
      if (key.startsWith(`${jobId}|`)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Whether this very run is followed, by this daemon or by another live one, so State.closeOrphanedRuns leaves it
   * open: closing it would show a run that is still going as ended.
   */
  isFollowing(jobId: string, startedAt: string): boolean {
    const key = `${jobId}|${startedAt}`;
    return this._followed.has(key) || this._followedElsewhere.has(key);
  }

  /** Tells the tray and the dashboard about the runs found going, once they are listening. */
  announceAdopted(): void {
    for (const id of this._adoptedIds.splice(0)) {
      this.emit('job-started', { id });
    }
  }

  /**
   * Stops following every supervised run without ending any of them, for a daemon that is shutting down: their
   * timers must not keep it alive, and what they would do next (a timeout kill, a finish) belongs to the daemon
   * that comes back, which reads the same files.
   */
  detachRuns(): void {
    for (const detach of [...this._detachers]) {
      detach();
    }
    this._detachers.clear();
    if (this._ownerWatch !== null) {
      clearInterval(this._ownerWatch);
      this._ownerWatch = null;
    }
  }

  /** Handles the end of one run that the daemon was not there to see. */
  private _finalizeRecovered(runDir: string, spec: SupervisedSpec, status: SupervisedStatus): void {
    const { jobId, startedAt } = spec.context;
    const job = this._registry.get(jobId) ?? this._jobFromSpec(spec);
    const entry = this._state.getRun(jobId, startedAt);
    const previous = this._state.getRunBefore(jobId, startedAt);
    const finishedAt = status.finishedAt ?? this._now().toISOString();
    const cancelledByUser = status.killed === true && status.killReason === 'manual';
    const agoMs = Math.max(0, this._now().getTime() - Date.parse(finishedAt));
    const withinWindow = agoMs <= this._lateActionWindowMs;
    // Seconds under two minutes: "ended 1 min before (window 1 min)" reads as if it were inside the window.
    const spoken = (ms: number): string => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

    const ctx: RunContext = {
      job,
      trigger: spec.context.trigger,
      startedAt,
      pid: entry?.pid ?? status.childPid ?? null,
      jobLogger: new RunLogger(path.dirname(spec.logPath), jobId, startedAt, { rotation: specRotation(spec) }),
      telemetry: null,
      previousRunFailed: previous !== null && isFailure(previous),
    };
    const outcome: RunOutcome = {
      // A run killed by a signal has no code; the live path records 1 for it, so does this.
      exitCode: cancelledByUser ? null : (status.exitCode ?? 1),
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      cancelledByUser,
      timedOut: status.timedOut === true || status.killReason === 'timeout',
      killedByResourceLimit: status.killReason === 'resource-limit',
      peakCpuPct: entry?.peakCpuPct ?? 0,
      peakRamMb: entry?.peakRamMb ?? 0,
    };
    this._finishRun(ctx, outcome, {
      late: true,
      actionsAllowed: withinWindow,
      actionsSkippedNote: `[recovery] retry/restart/dependents skipped: the run ended ${spoken(agoMs)} before the daemon came back (window ${spoken(this._lateActionWindowMs)})`,
      ledger: new EffectLedger(path.join(runDir, 'effects.json')),
    });
    fs.writeFileSync(path.join(runDir, 'done'), '');
    fs.rmSync(runDir, { recursive: true, force: true });
  }

  /** A job deleted while the daemon was down, rebuilt from what its run recorded, enough to be finalized and announced. */
  private _jobFromSpec(spec: SupervisedSpec): Job {
    return {
      id: spec.context.jobId,
      type: 'cron',
      label: spec.context.label ?? spec.context.jobId,
      command: spec.command,
      enabled: false,
      triggerMode: 'fire-and-forget',
    };
  }

  /** Removes the folders of this job's runs that were fully handled more than ten minutes ago. */
  private _cleanHandledRuns(jobId: string): void {
    const root = path.join(this._configDir, 'runs', jobId);
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      let handledAt: number;
      try {
        handledAt = fs.statSync(path.join(root, name, 'done')).mtimeMs;
      } catch {
        // No done marker (a run still going, or one that is to be recovered), or already gone: left alone.
        continue;
      }
      if (Date.now() - handledAt <= 10 * 60_000) {
        continue;
      }
      const folder = path.join(root, name);
      try {
        fs.rmSync(folder, { recursive: true, force: true });
      } catch (e) {
        // Best effort, but not silent: on Windows the supervisor of the run may still be exiting and hold a file in it.
        console.error(`[scheduler] could not remove the folder of the handled run ${folder} (${getErrorMessage(e)}); it is tried again at the next start of "${jobId}"`);
      }
    }
  }

  /** The log of one run of `job`, with the rotation limits that apply to it (its own setting over the daemon-wide default). */
  private _runLogger(job: Job, startedAt: string): RunLogger {
    return new RunLogger(path.join(this._configDir, 'logs', 'jobs', job.id), job.id, startedAt, {
      rotation: resolveLogRotation(job.logRotation, this._logRotation),
    });
  }

  /** What the supervisor needs to run this job: the same command line, directory and environment as a direct spawn. */
  private _supervisedRequest(job: Job, trigger: TriggerSource, startedAt: string, env: NodeJS.ProcessEnv | undefined): SupervisedRequest {
    // Tokens re-joined with single spaces, which is what node's `shell: true` hands to the shell.
    const parts = job.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [job.command];
    return {
      jobId: job.id,
      startedAt,
      command: parts.join(' '),
      cwd: job.cwd ?? ensureTmpDir(this._configDir, job.id),
      env: env ?? process.env,
      timeoutSeconds: job.timeoutSeconds ?? 300,
      label: job.label,
      trigger,
      logRotation: resolveLogRotation(job.logRotation, this._logRotation),
    };
  }

  /**
   * A run that could not even be started (the supervisor did not answer, its executable is missing): recorded as
   * a failed run with the reason in its log, like any other, instead of an exception nobody catches.
   */
  private _recordStartFailure(
    job: Job, trigger: TriggerSource, startedAt: string, err: unknown, waitForExit: boolean,
  ): { pid: number | null; startError?: string } | { exitCode: number | null } {
    const reason = getErrorMessage(err);
    const jobLogger = this._runLogger(job, startedAt);
    jobLogger.write(`[error] could not start the job: ${reason}`);
    // A failed run like any other (exit code 1): the history entry, the log marker, job.failed, the consecutive-failure
    // alert, the retry policy and the signal the tray and the audit listen to all come from _finishRun. Read before the
    // entry exists, as in _fire.
    const previousEntry = this._state.get(job.id);
    this._finishRun(
      { job, trigger, startedAt, pid: null, jobLogger, telemetry: null, previousRunFailed: previousEntry !== null && isFailure(previousEntry) },
      {
        exitCode: 1, finishedAt: this._now().toISOString(), durationMs: 0, cancelledByUser: false, timedOut: false,
        killedByResourceLimit: false, peakCpuPct: 0, peakRamMb: 0,
      },
    );
    return waitForExit || job.triggerMode === 'wait' ? { exitCode: 1 } : { pid: null, startError: reason };
  }

  /**
   * Everything that happens when a run is over: the history entry, the log marker, the events, and what the
   * outcome sets in motion (dependents, retry, alerts).
   *
   * Its own method, and not the body of the child's close handler, because the same effects have to run for
   * a job that ended while the daemon was down. Nothing in here may assume the child is still around.
   */
  private _finishRun(ctx: RunContext, outcome: RunOutcome, finish: FinishOptions = LIVE_FINISH): void {
    const { job, trigger, startedAt, pid, jobLogger, telemetry } = ctx;
    const { exitCode, finishedAt, durationMs, cancelledByUser, timedOut, killedByResourceLimit, peakCpuPct, peakRamMb } = outcome;
    const ledger = finish.ledger;
    const done = (group: EffectGroup): boolean => ledger?.done(group) ?? false;

    // Declared by the job as "nothing was done", so it is neither a success nor a failure. The
    // real exit code is still recorded: a lock left stuck stays diagnosable.
    const skipped = !cancelledByUser && exitCode !== null
      && (job.skipExitCodes?.includes(exitCode) ?? false);

    // Whether the run BEFORE this one failed was decided when this one started (ctx.previousRunFailed): by
    // now the newest entry is this run's own, which had not failed, so "recovered" could never be true.
    const wasFailure = ctx.previousRunFailed;

    const reason = timedOut ? 'timeout'
      : cancelledByUser ? 'manual-kill'
      : killedByResourceLimit ? 'resource-limit'
      : undefined;
    const finishedReason = reason === undefined ? '' : ` reason=${reason}`;

    if (!done('state') && finish.recorded !== true) {
      this._state.record(job.id, {
        startedAt, finishedAt, exitCode, pid, triggeredBy: trigger,
        peakCpuPct: peakCpuPct > 0 ? peakCpuPct : undefined,
        peakRamMb:  peakRamMb  > 0 ? peakRamMb  : undefined,
        peakMeasure: peakRamMb > 0 || peakCpuPct > 0 ? PEAK_MEASURE_VERSION : undefined,
        cancelledByUser: cancelledByUser || undefined,
        endReason: reason,
        late: finish.late || undefined,
        skipped: skipped || undefined,
      });
      telemetry?.event('end', { exitCode, durationMs, reason });
      this._recordResourceHistory(ctx, outcome, reason);
      // For an end the daemon learned late, the line says when it really happened.
      const endedAt = finish.late ? new Date(finishedAt) : undefined;
      if (finish.late && timedOut) {
        // The daemon's own timer wrote this when it fired; for an end it did not see, nobody has.
        jobLogger.write(`[job:timeout] jobId=${job.id} timeoutSeconds=${job.timeoutSeconds ?? 300}`, endedAt);
      }
      jobLogger.write(skipped
        ? `[job:skipped] exitCode=${exitCode} duration=${Math.round(durationMs / 100) / 10}s reason=skipExitCodes`
        : `[job:finished] exitCode=${exitCode} duration=${Math.round(durationMs / 100) / 10}s${finishedReason}`, endedAt);
      // `skipped` and `cancelledByUser` travel with the event because the systray classifies on these alone.
      this.emit('job-finished', { id: job.id, exitCode, job, skipped, cancelledByUser, endReason: reason, durationMs, trigger, late: finish.late });
      if (ledger !== undefined) {
        // The exit code is the one fact that cannot be learned again once the run folder is gone.
        this._state.flushNow();
        ledger.mark('state');
      }
    }

    // A published event says when the run really ended if the daemon only learned it afterwards.
    const publishing = !done('events');
    const publish = (event: string, payload: Record<string, unknown>): void => {
      if (publishing) {
        this._eventPublisher.publish(event, finish.late ? { ...payload, late: true, finishedAt } : payload);
      }
    };
    // What acts on the world: marked before it starts, see EffectGroup.
    const mayAct = finish.actionsAllowed && !done('actions');
    let actionsMarked = false;
    const startActing = (): void => {
      if (!actionsMarked) {
        actionsMarked = true;
        ledger?.mark('actions');
      }
    };
    const explainNoAction = (): void => {
      if (!finish.actionsAllowed && finish.actionsSkippedNote !== undefined && !done('actions')) {
        jobLogger.write(finish.actionsSkippedNote);
      }
    };

    if (finish.late && timedOut) {
      publish('job.timed_out', { jobId: job.id, label: job.label, timeoutSeconds: job.timeoutSeconds ?? 300 });
    }

    if (cancelledByUser) {
      publish('job.killed_manual', { jobId: job.id, label: job.label, durationMs });
    } else if (skipped) {
      // No dependents and no retry: both would act on work that never happened. The retry
      // counter is left alone, since a skip says nothing about whether the last attempt failed.
      publish('job.skipped', {
        jobId: job.id, label: job.label, exitCode, durationMs, reason: 'exitCode',
      });
    } else if (exitCode === 0) {
      this._retryCounters.delete(job.id);
      publish('job.completed', { jobId: job.id, label: job.label, exitCode, durationMs });
      // Trigger dependent jobs
      if (mayAct) {
        startActing();
        for (const dep of this._registry.list().filter(j => j.dependsOn === job.id && j.enabled)) {
          this._fireUnlessFull(dep, { kind: 'dependency', dependsOnJobId: job.id });
        }
      } else if (this._registry.list().some(j => j.dependsOn === job.id && j.enabled)) {
        explainNoAction();
      }
      if (wasFailure) {
        publish('job.recovered', { jobId: job.id, label: job.label });
      }
      // Anomaly detection: emit if duration is 3x longer than rolling average
      const avgMs = this._state.getRollingAvgDurationMs(job.id);
      if (avgMs !== null && durationMs > 3 * avgMs) {
        jobLogger.write(`[warn] Job ${job.id} took ${durationMs}ms (3x avg ${Math.round(avgMs)}ms) - anomaly detected`);
        publish('job.anomaly', { jobId: job.id, label: job.label, durationMs, avgMs: Math.round(avgMs), multiplier: 3 });
      }
    } else if (exitCode !== null) {
      publish('job.failed', { jobId: job.id, label: job.label, exitCode, durationMs });
      // Consecutive-failure alert
      const threshold = job.alertAfterFailures ?? 3;
      const consecutive = this._state.getConsecutiveFailures(job.id);
      if (consecutive >= threshold) {
        publish('alert.consecutive_failures', { jobId: job.id, label: job.label, consecutiveFailures: consecutive, threshold });
      }
      // Retry on specific exit codes (extension point: hooks fire for each retry/exhaustion)
      // restartOnExit wins over a retry list (the registry refuses both; a hand-edited one is warned about at start).
      if (job.retryOnExitCodes?.includes(exitCode) && !restartConfigured(job)) {
        if (!mayAct) {
          explainNoAction();
        } else {
          startActing();
          // After a restart the in-memory counter is gone; a run that was itself a retry carries its attempt.
          const attempts = this._retryCounters.get(job.id) ?? (trigger.kind === 'retry' ? trigger.attempt : 0);
          const delays   = job.retryDelays ?? [];
          if (attempts < delays.length) {
            const delayMs     = delays[attempts]! * 1000;
            const nextAttempt = attempts + 1;
            this._retryCounters.set(job.id, nextAttempt);
            jobLogger.write(`[retry] attempt ${nextAttempt}/${delays.length} in ${delays[attempts]}s (exitCode=${exitCode})`);
            void this._hookDispatcher?.dispatch('onJobRetry' as never, {
              jobId: job.id, label: job.label, exitCode,
              attempt: nextAttempt, totalAttempts: delays.length, delaySeconds: delays[attempts],
            }, (err: unknown) => console.error('[hook:onJobRetry]', err));
            this._deadlines.set(job.id, 'retry', this._time.now() + delayMs, () => {
              this._fireUnlessFull(job, { kind: 'retry', attempt: nextAttempt });
            });
          } else {
            this._retryCounters.delete(job.id);
            jobLogger.write(`[retry] exhausted after ${delays.length} attempts (exitCode=${exitCode}) -- permanent failure`);
            void this._hookDispatcher?.dispatch('onJobExhausted' as never, {
              jobId: job.id, label: job.label, exitCode, attempts: delays.length,
            }, (err: unknown) => console.error('[hook:onJobExhausted]', err));
            publish('alert.retry_exhausted', { jobId: job.id, label: job.label, exitCode, attempts: delays.length });
          }
        }
      }
    }

    if (!cancelledByUser) {
      this._applyRestartPolicy(ctx, outcome, reason, { mayAct, startActing, explainNoAction, publish });
    }

    if (publishing) {
      ledger?.mark('events');
    }
    // Closed last: the retry and anomaly markers above are written to this logger, and used to be dropped
    // because it was already closed.
    jobLogger.close();
  }

  /**
   * restartOnExit: what follows a run that ended on its own. Never reached for a manual kill.
   *
   * Decided here, in the daemon, and not by the supervisor: the supervisor only watches one run, the policy needs the
   * history of the job (attempts, window), and a run found again after a daemon restart goes through the same code.
   * The numbers come from planRestart (restart-policy.ts); this method does the effects: log lines, events, the timer.
   */
  private _applyRestartPolicy(
    ctx: RunContext, outcome: RunOutcome, endReason: 'timeout' | 'resource-limit' | 'manual-kill' | undefined,
    act: { mayAct: boolean; startActing: () => void; explainNoAction: () => void; publish: (event: string, payload: Record<string, unknown>) => void },
  ): void {
    const { job, trigger, startedAt, jobLogger } = ctx;
    if (!restartConfigured(job)) {
      return;
    }
    const problem = restartOnExitError(job.restartOnExit);
    if (problem !== null) {
      jobLogger.write(`[restart] not restarting: restartOnExit is invalid -- ${problem}`);
      return;
    }
    if (this._stopped) {
      jobLogger.write('[restart] not restarting: the daemon is stopping');
      return;
    }
    if (!act.mayAct) {
      act.explainNoAction();
      return;
    }
    act.startActing();

    const policy = resolveRestartPolicy(job.restartOnExit)!;
    const exitCode = outcome.exitCode!;
    const plan = planRestart(policy, this._restartStates.get(job.id), {
      nowMs: this._time.now(),
      startedAtMs: Date.parse(startedAt),
      endedAtMs: Date.parse(outcome.finishedAt),
      // After a daemon restart the memory is gone; a run that was itself a restart still carries its attempt.
      ...(trigger.kind === 'restart' ? { seedAttempt: trigger.attempt } : {}),
    });
    const reason = endReason === 'timeout' || endReason === 'resource-limit' ? { endReason } : {};
    if (plan.stable) {
      const lasted = Date.parse(outcome.finishedAt) - Date.parse(startedAt);
      const spoken = lasted < 120_000 ? `${Math.round(lasted / 1000)}s` : `${Math.round(lasted / 60_000)}min`;
      jobLogger.write(`[restart] this run stayed up for ${spoken} (stable after ${policy.stableAfterSeconds}s): the backoff and the restart count start over`);
    }

    if (plan.action === 'abandon') {
      this._forgetRestartState(job.id);
      const counted = `${plan.restartsInWindow} restarts in the last ${policy.windowSeconds}s`;
      jobLogger.write(
        `[restart] giving up: ${counted} is the limit (maxRestarts=${policy.maxRestarts}, windowSeconds=${policy.windowSeconds}); `
        + `the job stays stopped. Start it again with: orch trigger ${job.id}`,
      );
      console.error(
        `[scheduler] job "${job.id}" is no longer restarted: ${counted} reached the limit (maxRestarts=${policy.maxRestarts}). `
        + `It stays stopped; start it again with: orch trigger ${job.id}`,
      );
      act.publish('job.restart_abandoned', {
        jobId: job.id, label: job.label, cause: plan.cause, exitCode, attempts: plan.attempts,
        restartsInWindow: plan.restartsInWindow, maxRestarts: policy.maxRestarts, windowSeconds: policy.windowSeconds, ...reason,
      });
      return;
    }

    this._rememberRestartState(job.id, plan.state);
    jobLogger.write(
      `[restart] attempt ${plan.attempt} in ${plan.delaySeconds}s (exitCode=${exitCode}; `
      + `${plan.restartsInWindow} of ${policy.maxRestarts} restarts allowed in ${policy.windowSeconds}s)`,
    );
    act.publish('job.restart_scheduled', {
      jobId: job.id, label: job.label, exitCode, attempt: plan.attempt, delaySeconds: plan.delaySeconds,
      restartsInWindow: plan.restartsInWindow, maxRestarts: policy.maxRestarts, windowSeconds: policy.windowSeconds, ...reason,
    });
    this._deadlines.set(job.id, 'restart', this._time.now() + plan.delaySeconds * 1000, () => {
      this._startPendingRestart(job.id, plan.attempt);
    });
  }

  /** The delay of a restart is over: start the job again, unless something changed while it waited. Each refusal is said in the daemon log. */
  private _startPendingRestart(id: string, attempt: number): void {
    const cancelled = (why: string): void => {
      console.error(`[scheduler] job "${id}": the pending restart was cancelled because ${why}`);
      this._forgetRestartState(id);
    };
    // The job as it is now, not as it was when it ended: an edit (the command, a new policy) applies to the restart.
    const current = this._registry.get(id);
    if (current === null) {
      cancelled('the job no longer exists');
      return;
    }
    if (!current.enabled) {
      cancelled('the job is disabled');
      return;
    }
    if (!restartConfigured(current)) {
      cancelled('restartOnExit was removed from the job');
      return;
    }
    const problem = restartOnExitError(current.restartOnExit);
    if (problem !== null) {
      cancelled(`its restartOnExit is invalid (${problem})`);
      return;
    }
    if ((this._running.get(id) ?? 0) > 0) {
      console.error(`[scheduler] job "${id}": the restart was skipped, the job is already running`);
      return;
    }
    this._fireUnlessFull(current, { kind: 'restart', attempt });
  }

  /** The restarts that wait for their delay: which job, when (ISO) and which attempt it will be. What `orch status` shows. */
  pendingRestarts(): Array<{ jobId: string; dueAt: string; attempt: number }> {
    const pending: Array<{ jobId: string; dueAt: string; attempt: number }> = [];
    for (const d of this._deadlines.list().filter(item => item.kind === 'restart').sort((a, b) => a.dueAt - b.dueAt)) {
      const attempt = this._restartStates.get(d.jobId)?.attempt;
      if (attempt === undefined) {
        // A restart is only ever armed together with its counters (_applyRestartPolicy): reaching this is a bug, not a state.
        console.error(`[scheduler] job "${d.jobId}" has a restart armed but no restart counters; it is left out of the pending restarts. Please report this.`);
        continue;
      }
      pending.push({ jobId: d.jobId, dueAt: new Date(d.dueAt).toISOString(), attempt });
    }
    return pending;
  }

  private _rememberRestartState(id: string, state: RestartState): void {
    this._restartStates.set(id, state);
    this._saveRestartStates();
  }

  /** Drops a job's counters; the file is only written when there was something to drop. */
  private _forgetRestartState(id: string): void {
    if (this._restartStates.delete(id)) {
      this._saveRestartStates();
    }
  }

  private _saveRestartStates(): void {
    const file = path.join(this._configDir, RESTART_STATE_FILE);
    const jobs: Record<string, RestartState> = {};
    for (const [id, state] of this._restartStates) {
      jobs[id] = { attempt: state.attempt, restarts: state.restarts };
    }
    try {
      atomicWriteJson(file, { version: 1, jobs });
    } catch (e) {
      console.error(
        `[scheduler] the restart counters could not be saved to ${file} (${getErrorMessage(e)}). Jobs keep restarting as configured, but a daemon restart will not remember the counters. `
        + `Check that the folder is writable and that ${RESTART_STATE_FILE} is a file, not a folder.`,
      );
    }
  }

  /**
   * Reads the counters the previous daemon left, once per start. Dropped, and said: an entry of a job that was removed or no
   * longer restarts, or that is invalid. Dropped quietly: the restarts older than the job's window (nothing left to count).
   * A file that cannot be read is reported and the daemon starts with empty counters; the next change rewrites it.
   */
  private _restoreRestartStates(): void {
    if (this._restartStatesLoaded) {
      return;
    }
    this._restartStatesLoaded = true;
    const file = path.join(this._configDir, RESTART_STATE_FILE);
    const empty = 'the daemon starts with empty counters: jobs that were restarting get a fresh restart budget';
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      // No file is the normal first start (or nothing was restarting).
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[scheduler] ${file} could not be read (${getErrorMessage(e)}): ${empty}. Check the permissions of the file.`);
      }
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      console.error(`[scheduler] ${file} is corrupt (${getErrorMessage(e)}): ${empty}. Delete the file if this message comes back; the next restart rewrites it.`);
      return;
    }
    const now = this._time.now();
    const parsed = parseRestartStates(raw, now);
    if (parsed.fileProblem !== null) {
      console.error(`[scheduler] ${file} is unusable (${parsed.fileProblem}): ${empty}. Delete the file if this message comes back; the next restart rewrites it.`);
      return;
    }
    let changed = false;
    for (const { jobId, problem, dropped } of parsed.entryProblems) {
      console.error(`[scheduler] restart counters of job "${jobId}": ${problem}${dropped ? '; counters dropped' : ''}`);
      changed = true;
    }
    for (const [id, state] of parsed.states) {
      const job = this._registry.get(id);
      let why: string | null = null;
      if (job === null) {
        why = 'no longer exists';
      } else if (!restartConfigured(job) || restartOnExitError(job.restartOnExit) !== null) {
        why = 'has no restartOnExit any more';
      }
      if (why !== null) {
        console.error(`[scheduler] job "${id}" ${why}: counters dropped`);
        changed = true;
        continue;
      }
      const policy = resolveRestartPolicy(job!.restartOnExit)!;
      const restarts = state.restarts.filter(t => t > now - policy.windowSeconds * 1000);
      if (restarts.length === 0) {
        changed = true;
        continue;
      }
      this._restartStates.set(id, { attempt: state.attempt, restarts });
      console.error(`[scheduler] restart counters restored for job "${id}": attempt ${state.attempt}, ${restarts.length} restarts in the last ${policy.windowSeconds}s`);
    }
    // Entries of the file that were not kept must not come back at the next start.
    if (changed) {
      this._saveRestartStates();
    }
  }

  /** Says at daemon start what is wrong with a job's restartOnExit, once, where the daemon log is read. Nothing is changed. */
  private _checkRestartConfig(job: Job): void {
    const problem = restartOnExitError(job.restartOnExit);
    if (problem !== null) {
      console.error(`[scheduler] job "${job.id}" has an invalid restartOnExit: ${problem}. The job will NOT be restarted; fix it with: orch edit ${job.id} --restart-on-exit (or --unset restartOnExit)`);
      return;
    }
    if (restartConfigured(job) && restartConflictError(job) !== null) {
      console.error(`[scheduler] job "${job.id}" has both restartOnExit and retryOnExitCodes/retryDelays: restartOnExit wins and the retry settings are ignored. Remove one: orch edit ${job.id} --unset retryOnExitCodes,retryDelays`);
    }
  }

  /**
   * Makes a child count as one of the job's live runs: findable to kill, taking one of its places, owning the
   * log that refused firings write to. Undone by the child's own close, in a listener of its own.
   */
  private _register(child: ChildProcess, job: Job, jobLogger: RunLogger): Set<ChildProcess> {
    const siblings = this._activeChildren.get(job.id) ?? new Set<ChildProcess>();
    siblings.add(child);
    this._activeChildren.set(job.id, siblings);

    // The slot is tied to the child's own lifetime from this line on, in a listener of its own: if
    // anything between here and the main close handler threw, the slot would otherwise never be given
    // back and the job could not start again until the daemon restarted. Registered first, so the main
    // handler's dependency and retry firings already see the slot free.
    this._running.set(job.id, (this._running.get(job.id) ?? 0) + 1);
    this._liveLogger.set(job.id, jobLogger);
    child.once('close', () => {
      if (child instanceof SupervisedChild && child.lostReason !== undefined) {
        jobLogger.write(`[recovery] ${child.lostReason}`);
      }
      const left = (this._running.get(job.id) ?? 1) - 1;
      if (left > 0) {
        this._running.set(job.id, left);
      } else {
        this._running.delete(job.id);
        // Whoever waits for the job to be gone (restartJob) is released by this very close.
        for (const wake of [...(this._idleWaiters.get(job.id) ?? [])]) {
          wake();
        }
      }
      if (this._liveLogger.get(job.id) === jobLogger) {
        this._liveLogger.delete(job.id);
      }
    });

    return siblings;
  }

  private async _fire(job: Job, trigger: TriggerSource = { kind: 'cron' }, waitForExit = false): Promise<{ pid: number | null; startError?: string } | { exitCode: number | null }> {
    // Anything but the restart policy itself starting the job (a person, the schedule, a dependency) takes over: the restart
    // that was waiting is no longer needed, and the failures it counted belong to a series that is over.
    if (trigger.kind !== 'restart') {
      this._deadlines.clear(job.id, 'restart');
      // The one exception: the firing of a startup job by the daemon that has just started is not "someone taking over", it
      // is the same crash loop going on, and the counters read from the file are what keeps it from a fresh budget.
      if (!(trigger.kind === 'cron' && this._startupKeepsRestartState.delete(job.id))) {
        this._forgetRestartState(job.id);
      }
    }
    const startedAt = this._now().toISOString();
    const secretEnv = job.secrets?.length ? this._secrets.resolveForJob(job.secrets) : {};
    // Both paths (a direct spawn and the supervisor, whose environment the job inherits) start from this one value.
    // Always built: even with nothing of its own, a job must not inherit the daemon's launcher variables.
    const jobEnv = jobEnvironment({ ...process.env, ...job.env, ...secretEnv }, job.env, this._jobsNoColor, secretEnv);
    // Awaited only when it IS a promise: an `await` on a plain child would move everything below to a later
    // tick, and a child that closes right after being spawned (every test double, and a command that fails
    // at once) would emit before its listeners exist.
    let child: ChildProcess;
    if (this._supervisor !== null) {
      this._cleanHandledRuns(job.id);
    }
    try {
      const spawned = this._supervisor !== null
        ? this._supervisor(this._supervisedRequest(job, trigger, startedAt, jobEnv))
        : this._spawn(job.command, job.cwd ?? undefined, jobEnv, job.id);
      child = isPromiseLike(spawned) ? await spawned : spawned;
    } catch (err) {
      return this._recordStartFailure(job, trigger, startedAt, err, waitForExit);
    }
    const pid   = child.pid ?? null;

    // Per-run log: one file per execution -- <jobId>-<startedAt>.log
    const jobLogger = this._runLogger(job, startedAt);

    const siblings = this._register(child, job, jobLogger);
    if (child instanceof SupervisedChild && child.startError !== undefined) {
      jobLogger.write(`[error] could not start the job: ${child.startError}`);
    }

    // Read before this run's own entry exists, or the newest entry would be this run itself.
    const previousEntry = this._state.get(job.id);
    const previousRunFailed = previousEntry !== null && isFailure(previousEntry);

    this._state.record(job.id, {
      startedAt, exitCode: null, pid, triggeredBy: trigger,
      retryAttempt: trigger.kind === 'retry' ? trigger.attempt : undefined,
      supervised: child instanceof SupervisedChild || undefined,
    });
    this._eventPublisher.publish('job.started', { jobId: job.id, label: job.label, pid, trigger: trigger.kind });
    this.emit('job-started', { id: job.id });
    jobLogger.write(`[job:started] pid=${pid} triggeredBy=${trigger.kind}`);

    const ctx = { job, trigger, startedAt, pid, jobLogger, previousRunFailed };
    return this._monitor(child, ctx, siblings, waitForExit);
  }

  /**
   * Follows a run from the moment it is going until its end: resource samples and limits, peaks, the timeout,
   * and the close that hands over to _finishRun. Starts the same way for a run this daemon launched and for one
   * it found still going after a restart (`resume`), which is why nothing in it assumes it spawned the child.
   */
  private _monitor(
    child: ChildProcess, ctx: MonitorContext, siblings: Set<ChildProcess>, waitForExit: boolean, resume?: ResumeState,
  ): { pid: number | null } | Promise<{ exitCode: number | null }> {
    const { job, trigger, startedAt, pid, jobLogger, previousRunFailed } = ctx;
    // Resource monitoring: sample CPU/RAM every 2s, enforce auto-budget thresholds
    let peakCpuPct = resume?.peakCpuPct ?? 0;
    let peakRamMb  = resume?.peakRamMb  ?? 0;
    let softAlertSent = false;
    // CPU% is spiky by nature, so the hard budget only counts once the breach is sustained over this
    // many consecutive samples. A single spike must never kill a job. The number comes from the job's
    // resourceLimits.sustainSeconds (default 30 s), see resource-limits.ts.
    let hardBreaches = 0;
    let warnedThisBreach = false;
    const baseline = this._state.getResourceBaseline(job.id);
    const resolved = resolveResourceLimits(job.resourceLimits, baseline, this._sampleIntervalMs);
    const limits   = this._sustainSamples === undefined ? resolved : { ...resolved, sustainSamples: this._sustainSamples };
    const softThreshold = limits.soft;
    const hardThreshold = limits.hard;
    const HARD_BREACHES_TO_KILL = limits.sustainSamples;
    const checkThresholds = limits.enforce !== 'off';
    const runUsage: RunUsage = { samples: 0, cpuSum: 0, ramSum: 0, limits };
    // What the monitor sees of this run, kept next to the job for later. Opened here so the thresholds
    // it enforces are the first thing in the record.
    const telemetry = this._openTelemetry(job.id, startedAt, pid, jobLogger);
    telemetry?.event(resume === undefined ? 'start' : 'adopt', {
      soft: softThreshold, hard: hardThreshold, enforce: limits.enforce, sustainSamples: limits.sustainSamples,
    });
    /**
     * Writes the peaks measured so far onto the in-flight entry.
     *
     * The close handler used to be the only writer, so any run the daemon did not see finish left
     * no numbers at all: a stop, a restart, a crash, a machine reboot. Those are precisely the runs
     * whose resource use is worth knowing, since a job heavy enough to take the daemon down is the
     * one you want the figures for.
     *
     * record() replaces the entry at the matching startedAt rather than merging into it, so every
     * field of the in-flight entry has to be repeated here. getResourceBaseline only reads entries
     * with a non-null exitCode, so writing peaks mid-run cannot skew the auto-budget thresholds.
     */
    let peakDirty    = false;
    let peakFlushedAt = Date.now();
    // Set to true in the close handler so that any in-flight sampleUsage() Promise that resolves
    // after close cannot call flushPeaks() and overwrite finishedAt with exitCode:null.
    // clearInterval cannot retract a Promise already in-flight, so this flag is the guard.
    let jobFinished  = false;
    /** The monitor stopped this run. Reported in [job:finished], or its exit code reads as the job failing. */
    let killedByResourceLimit = false;
    const flushPeaks = (): void => {
      if (!peakDirty || jobFinished) {
        return;
      }
      peakDirty     = false;
      peakFlushedAt = Date.now();
      this._state.record(job.id, {
        startedAt, exitCode: null, pid, triggeredBy: trigger,
        retryAttempt: trigger.kind === 'retry' ? trigger.attempt : undefined,
        supervised: child instanceof SupervisedChild || undefined,
        peakCpuPct: peakCpuPct > 0 ? peakCpuPct : undefined,
        peakRamMb:  peakRamMb  > 0 ? peakRamMb  : undefined,
        peakMeasure: peakRamMb > 0 || peakCpuPct > 0 ? PEAK_MEASURE_VERSION : undefined,
      });
    };

    let resourceTimer: Timer | null = null;
    if (pid) {
      /*
       * One sample at a time, and one kill at a time.
       *
       * Sampling is async inside setInterval, so on a machine slow enough for a sample to outlast
       * the interval two walks were in flight at once. Both incremented `hardBreaches` - making two
       * overlapping samples count as two CONSECUTIVE ones, so a job could be killed early - and
       * both then reached the kill branch, because clearInterval cannot retract a promise that has
       * already been scheduled. The result was one kill announced twice and _killChild called twice.
       *
       * Seen on a loaded CI runner as two job.resource_hard_limit events where the test expected
       * one. It reproduced nowhere else, which is exactly what a load-dependent race looks like.
       */
      let samplingSince: number | null = null;
      let killing = false;
      /*
       * How long an outstanding walk may block the next one.
       *
       * Skipping while a walk is in flight is what keeps "consecutive samples" honest, but skipping
       * UNCONDITIONALLY means one call that never settles kills monitoring for the whole run - and
       * pidtree/pidusage on a loaded Windows runner is exactly where that happens. CI caught it: the
       * peaks test timed out waiting for readings that were never going to come.
       *
       * So the skip is bounded. Past this, a new walk starts anyway; overlap is the lesser evil, and
       * the kill path is separately guarded against firing twice.
       */
      const samplingStallMs = this._sampleIntervalMs * 3;
      /*
       * Identifies the walk that currently owns `samplingSince`.
       *
       * Needed because the escape hatch above is meant to fire once for a stalled walk, not to
       * disarm the guard. Clearing `samplingSince` unconditionally let the OVERTAKEN walk clear the
       * marker belonging to its own successor, which was still outstanding - so from the first stall
       * onwards the guard was open and every tick started another walk. That is both of the bugs
       * this block exists to prevent: overlapping walks counting as consecutive `hardBreaches`, and
       * more than one reaching the kill branch.
       */
      let currentWalk = 0;
      const sample = (): void => {
        if (child.killed) { resourceTimer?.cancel(); return; }
        if (samplingSince !== null && Date.now() - samplingSince < samplingStallMs) {
          return;
        }
        const walk = ++currentWalk;
        samplingSince = Date.now();
        this._sampleUsage(pid!).finally(() => {
          // A walk that was overtaken leaves the marker to whoever overtook it.
          if (walk === currentWalk) { samplingSince = null; }
        }).then(tree => {
          // Every pid in the tree vanished between the walk and the sample: the job is
          // finishing. Keep the timer -- the exit handler owns clearing it.
          if (tree === null) {
            return;
          }
          const cpuPct = tree.cpuPct;
          const ramMb  = tree.ramMb;
          telemetry?.sample({ cpuPct, ramMb, walked: tree.walked, counted: tree.counted, processes: tree.processes });
          runUsage.samples++;
          runUsage.cpuSum += cpuPct;
          runUsage.ramSum += ramMb;
          if (cpuPct > peakCpuPct) { peakCpuPct = cpuPct; peakDirty = true; }
          if (ramMb  > peakRamMb)  { peakRamMb  = ramMb;  peakDirty = true; }
          // Throttled here rather than inside flushPeaks, so the kill paths below can force a
          // write. Peaks only ever climb, so a settled job stops writing on its own.
          if (peakDirty && Date.now() - peakFlushedAt >= this._peakFlushMs) {
            flushPeaks();
          }
          // enforce: off checks nothing; the peaks, the telemetry and the history above are still kept.
          if (!checkThresholds) {
            return;
          }
          const overHard = hardThreshold !== null
            && ((hardThreshold.cpuPct !== null && cpuPct > hardThreshold.cpuPct)
              || (hardThreshold.ramMb !== null && ramMb > hardThreshold.ramMb));
          // Any sample back under the hard budget means the spike was transient.
          if (!overHard) {
            hardBreaches = 0;
            // A breach that ended and begins again is a new one: announced again in warn mode.
            warnedThisBreach = false;
          }
          // Warn on the soft budget independently of the hard one. Gating this behind "not over
          // hard" meant a job that jumped straight past the hard threshold was killed on the
          // third sample having never emitted a warning -- and now that the kill is delayed on
          // purpose, those first samples are exactly when the warning is worth something.
          if (!softAlertSent && softThreshold && (cpuPct > softThreshold.cpuPct || ramMb > softThreshold.ramMb)) {
            softAlertSent = true;
            const msg = `[warn] Soft resource limit exceeded (CPU: ${cpuPct.toFixed(1)}% / RAM: ${ramMb.toFixed(0)}MB)`;
            try { process.stderr.write(msg + '\n'); } catch { /* EPIPE */ }
            this._eventPublisher.publish('job.resource_soft_limit', { jobId: job.id, label: job.label, cpuPct, ramMb, softThreshold });
          }
          if (overHard) {
            hardBreaches++;
            const cpuLimit = hardThreshold!.cpuPct === null ? 'none' : `${hardThreshold!.cpuPct.toFixed(1)}%`;
            const ramLimit = hardThreshold!.ramMb  === null ? 'none' : `${hardThreshold!.ramMb.toFixed(0)}MB`;
            const over = `CPU: ${cpuPct.toFixed(1)}% threshold: ${cpuLimit} / RAM: ${ramMb.toFixed(0)}MB threshold: ${ramLimit}`;
            if (hardBreaches < HARD_BREACHES_TO_KILL) {
              // Over budget but not yet sustained: record it and leave the job alone.
              jobLogger.write(`[resource-monitor] Over hard budget ${hardBreaches}/${HARD_BREACHES_TO_KILL} (${over})`);
            } else if (limits.enforce === 'warn') {
              // Said once per continuous breach, not every sample: the log would otherwise repeat the
              // same sentence every two seconds for as long as the job stays heavy.
              if (!warnedThisBreach) {
                warnedThisBreach = true;
                jobLogger.write(`[resource-monitor] Hard limit exceeded for ${hardBreaches}/${HARD_BREACHES_TO_KILL} consecutive samples (${over}) - would be killed (enforce: warn), nothing is killed`);
                this._eventPublisher.publish('job.resource_hard_limit', { jobId: job.id, label: job.label, cpuPct, ramMb, hardThreshold, consecutiveSamples: hardBreaches, enforced: false });
              }
            } else if (!killing) {
              // Guarded even with the in-flight check above: a walk that had already resolved when
              // the kill started must not announce a second one. One kill, one event, one _killChild.
              killing = true;
              killedByResourceLimit = true;
              const msg = `[warn] Hard resource limit exceeded for ${hardBreaches} consecutive samples (${over}) - killing`;
              try { process.stderr.write(msg + '\n'); } catch { /* EPIPE */ }
              // In the job's own log as well: stderr is the daemon's, which reaches no file, so a kill
              // that left only that read as the job failing by itself ("Over hard budget 2/3", then
              // "[job:finished] exitCode=1").
              jobLogger.write(`[resource-monitor] Hard limit exceeded for ${hardBreaches}/${HARD_BREACHES_TO_KILL} consecutive samples (${over}) - killing the process tree`);
              this._eventPublisher.publish('job.resource_hard_limit', { jobId: job.id, label: job.label, cpuPct, ramMb, hardThreshold, consecutiveSamples: hardBreaches, enforced: true });
              resourceTimer?.cancel();
              // Forced before the kill: the numbers that justified killing this job are the ones
              // most worth keeping, and clearing the timer above means no later sample will write.
              flushPeaks();
              telemetry?.event('resource-kill', { consecutiveSamples: hardBreaches, cpuPct, ramMb });
              // Names are looked up while the processes are still alive, so the kill waits for them,
              // bounded. A job that ended on its own meanwhile is left alone.
              void this._describeTree(tree).then((line) => {
                if (line !== null) {
                  jobLogger.write(line);
                }
              }).finally(() => {
                if (!jobFinished) {
                  this._killChild(child, 'resource-limit');
                }
              });
            }
          }
        }).catch((err: unknown) => {
          // Sampling is best-effort telemetry: log and keep going. Clearing the timer here
          // would let one transient failure silently disable monitoring for the whole run.
          jobLogger.write(`[resource-monitor] Failed to get metrics: ${getErrorMessage(err)}`);
        });
      };
      resourceTimer = this._time.every(this._sampleIntervalMs, sample);
      // Sample at once so sub-2s jobs are not left with an empty history. pidusage needs
      // two samples of a pid to derive a CPU percentage, so this first one also primes it.
      sample();
    }
    // The job's lines go through writeOutput, which strips escape sequences; the echo to the daemon's own stdout
    // (its log) is stripped too, for a chunk that has any.
    const echo = (stream: NodeJS.WriteStream, d: Buffer): void => {
      try { stream.write(d.includes(0x1b) ? stripAnsi(d.toString()) : d); } catch { /* EPIPE: launcher pipe closed */ }
    };
    // One per stream: a chunk can end inside an escape sequence or a multibyte character (see output-lines.ts).
    const stdoutLines = new OutputLines();
    const stderrLines = new OutputLines();
    child.stdout?.on('data', (d: Buffer) => {
      for (const line of stdoutLines.push(d)) {
        jobLogger.writeOutput(line);
      }
      echo(process.stdout, d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      for (const line of stderrLines.push(d)) {
        jobLogger.writeOutput(line, '[stderr] ');
      }
      echo(process.stderr, d);
    });
    // A child that could not be spawned (EAGAIN, EMFILE, EACCES...) emits 'error', and so does each of its pipes when it
    // goes away. With no listener that is an uncaughtException, fatal for the daemon: one job must never be able to take
    // the scheduler of every other job down. A failed spawn is followed by 'close' with a negative errno, which ends the run
    // through the usual path; this only records why, in the run's own log.
    child.on('error', (err) => { jobLogger.write(`[error] the job's process reported an error: ${getErrorMessage(err)}`); });
    child.stdout?.on('error', (err) => { jobLogger.write(`[warn] the job's stdout pipe failed: ${getErrorMessage(err)}`); });
    child.stderr?.on('error', (err) => { jobLogger.write(`[warn] the job's stderr pipe failed: ${getErrorMessage(err)}`); });

    // Job timeout: kill process if it exceeds timeoutSeconds (default 5 min = 300s; 0 = no timeout).
    const fullTimeoutMs = (job.timeoutSeconds ?? 300) * 1000;
    // A run found again after a restart has already used part of its time.
    const timeoutMs = fullTimeoutMs > 0 && resume !== undefined
      ? Math.max(1, fullTimeoutMs - (this._time.now() - Date.parse(startedAt)))
      : fullTimeoutMs;
    let timeoutHandle: Timer | null = null;
    let timedOut = false;
    if (timeoutMs > 0) {
      // waitUntil, not after(timeoutMs): a timer clamps a delay above ~24.85 days to 1ms, so
      // `--timeout 31536000` (one year) used to kill the job on the next tick instead of after a
      // year. See waitUntil in time-service.ts.
      timeoutHandle = waitUntil(this._time, this._time.now() + timeoutMs, () => {
        timedOut = true;
        jobLogger.write(`[warn] Job ${job.id} timed out after ${job.timeoutSeconds ?? 300}s - killing process`);
        jobLogger.write(`[job:timeout] jobId=${job.id} timeoutSeconds=${job.timeoutSeconds ?? 300}`);
        this._eventPublisher.publish('job.timed_out', { jobId: job.id, label: job.label, timeoutSeconds: job.timeoutSeconds ?? 300 });
        // A timed-out job is one whose resource use is worth a look, so persist before killing.
        flushPeaks();
        this._killChild(child, 'timeout');
      });
    }

    const done = new Promise<{ exitCode: number | null }>((resolve) => {
      child.on('close', (code) => {
        // What the streams still hold (an escape sequence that never ended) goes in before the run's closing markers.
        for (const line of stdoutLines.flush()) { jobLogger.writeOutput(line); }
        for (const line of stderrLines.flush()) { jobLogger.writeOutput(line, '[stderr] '); }
        jobFinished = true;
        // Only this instance: deleting the job's whole entry made the others unreachable to kill.
        siblings.delete(child);
        if (siblings.size === 0 && this._activeChildren.get(job.id) === siblings) {
          this._activeChildren.delete(job.id);
        }
        timeoutHandle?.cancel();
        resourceTimer?.cancel();
        const rawExitCode = code ?? 1;
        const finishedAt = this._now().toISOString();
        const durationMs = Date.now() - new Date(startedAt).getTime();
        const cancelledByUser = this._killedByUser.has(child);
        // exitCode=null + finishedAt = "Cancelled" in RunHistory
        const exitCode = cancelledByUser ? null : rawExitCode;

        // A supervised run leaves its folder behind: what is done for its end is written there, so that the next
        // daemon does not find it and do it all again.
        const ledger = child instanceof SupervisedChild ? new EffectLedger(path.join(child.runDir, 'effects.json')) : undefined;
        this._finishRun(
          { job, trigger, startedAt, pid, jobLogger, telemetry, usage: runUsage, previousRunFailed },
          { exitCode, finishedAt, durationMs, cancelledByUser, timedOut, killedByResourceLimit, peakCpuPct, peakRamMb },
          ledger === undefined ? LIVE_FINISH : { ...LIVE_FINISH, ledger },
        );
        if (child instanceof SupervisedChild) {
          child.markHandled();
        }
        resolve({ exitCode });
      });
    });

    if (child instanceof SupervisedChild) {
      const detach = (): void => {
        flushPeaks();
        timeoutHandle?.cancel();
        resourceTimer?.cancel();
        child.stopWatching();
      };
      this._detachers.add(detach);
      child.once('close', () => { this._detachers.delete(detach); });
    }

    // An explicit wait from the caller overrides the job's scheduling mode for this run only.
    if (!waitForExit && job.triggerMode !== 'wait') {
      done.catch((err: unknown) => {
        const reason = getErrorMessage(err);
        jobLogger.write(`[error] Job promise rejected (fire-and-forget): ${reason}`);
      });
      return { pid };
    }

    return done;
  }

}
