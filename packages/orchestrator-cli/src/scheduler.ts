import cron from 'node-cron';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os   from 'node:os';
import { EventEmitter } from 'node:events';
import { checkLiveness } from './liveness.js';
import { RunLogger }     from './logger.js';
import { ensureTmpDir, getErrorMessage }  from './fsUtil.js';
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
import type { Job, TriggerSource } from './types.js';
import type { HookDispatcher } from '@wadeck-app/shared-cli/HookDispatcher';
import type { Registry } from './registry.js';
import type { State } from './state.js';
import { isFailure } from './state.js';
import { systemTime, type TimeService, type Timer } from './time-service.js';
import { DeadlineQueue, type DeadlineKind } from './deadlines.js';
import { windowStateAt, msUntilStart, msUntilEnd, type WindowState } from './active-window.js';

type SpawnFn    = (cmd: string, cwd?: string, env?: NodeJS.ProcessEnv, jobId?: string) => ChildProcess;
type LivenessFn = (job: Pick<Job, 'id' | 'liveness'>) => Promise<boolean>;

interface SchedulerOptions {
  spawn?:                 SpawnFn;
  liveness?:              LivenessFn;
  now?:                   () => Date;
  configDir?:             string;
  eventPublisher?:        EventPublisher;
  catchUpInitialDelayMs?: number;
  catchUpStaggerMs?:      number;
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
   * How often the resource monitor samples. Lowered in tests.
   *
   * Needed alongside sampleUsage to test the overlap guard at all: overlap only happens when a
   * sample outlasts the interval, and at the production 2s a test would have to stall a fake
   * sampler for longer than that to provoke it.
   */
  sampleIntervalMs?:      number;
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

export interface TreeUsage {
  cpuPct: number;
  ramMb:  number;
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

/** Injection seam for the tests; production passes nothing and gets pidtree + pidusage. */
interface TreeDeps {
  tree:  (pid: number) => Promise<number[]>;
  usage: (pid: number) => Promise<{ cpu: number; memory: number; elapsed: number; ppid: number }>;
}

/**
 * Both figures come from separate calls against a clock of finite resolution, so a child spawned in
 * the same instant as its parent can measure a hair older. Refusing it would drop real descendants.
 */
const TREE_AGE_TOLERANCE_MS = 1_000;

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

  const samples = await Promise.all(pids.map(async (pid) => {
    try {
      return { pid, sample: await usage(pid) };
    } catch {
      return null;
    }
  }));

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
  const byPid = new Map<number, { cpu: number; memory: number; elapsed: number; ppid: number }>();
  for (const s of samples) if (s !== null) {
    byPid.set(s.pid, s.sample);
  }

  let cpuPct   = root.sample.cpu;
  let ramBytes = root.sample.memory;
  const accepted = new Map([[rootPid, root.sample.elapsed]]);
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
      const parentElapsed = accepted.get(sample.ppid)!;
      if (sample.elapsed > parentElapsed + TREE_AGE_TOLERANCE_MS) {
        continue;
      }
      accepted.set(pid, sample.elapsed);
      cpuPct   += sample.cpu;
      ramBytes += sample.memory;
      next.push(pid);
    }
    frontier = next;
  }
  return { cpuPct, ramMb: ramBytes / 1024 / 1024 };
}

export class Scheduler extends EventEmitter {
  private readonly _registry:  Registry;
  private readonly _state:     State;
  private _spawn:              SpawnFn;
  private readonly _liveness:  LivenessFn;
  private readonly _now:       () => Date;
  private readonly _time:      TimeService;
  private readonly _configDir: string;
  private readonly _tmpDir:    string;
  private readonly _events:    EventPublisher;
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
  private readonly _activeChildren = new Map<string, ChildProcess>();
  private readonly _killedByUser   = new Set<string>();
  private readonly _skippedJobs    = new Map<string, number>();
  private readonly _catchUpInitialDelayMs: number;
  private readonly _catchUpStaggerMs:      number;
  private readonly _hookDispatcher:  HookDispatcher | null;
  private readonly _peakFlushMs:     number;
  private readonly _sampleUsage:     (rootPid: number) => Promise<TreeUsage | null>;
  private readonly _sampleIntervalMs: number;
  private readonly _retryCounters  = new Map<string, number>();

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
    this._liveness  = options.liveness  ?? checkLiveness;
    this._time      = options.time      ?? systemTime;
    // Defaults to the time service rather than Date, so a test that moves the clock is not
    // contradicted by a `now` that never moved. An explicit `now` still wins, for the tests that only
    // needed to pin the date.
    this._now       = options.now       ?? (() => new Date(this._time.now()));
    this._configDir = options.configDir ?? (
      // violations-suppress: shared/no-out-of-repo-path the documented config dir; both a constructor option and ORCH_CONFIG_DIR override it
      process.env['ORCH_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'orchestrator')
    );
    this._events    = options.eventPublisher ?? new EventPublisher();
    this._secrets   = new SecretsManager(this._configDir);
    this._catchUpInitialDelayMs = options.catchUpInitialDelayMs ?? 300_000;
    this._catchUpStaggerMs      = options.catchUpStaggerMs      ?? 300_000;
    this._hookDispatcher        = options.hookDispatcher        ?? null;
    this._peakFlushMs           = options.peakFlushMs           ?? 10_000;
    this._sampleUsage           = options.sampleUsage           ?? sampleProcessTree;
    this._sampleIntervalMs      = options.sampleIntervalMs      ?? 2000;
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
    // Stagger catch-up jobs to avoid simultaneous load on wake from hibernate.
    // First job fires after catchUpInitialDelayMs, subsequent jobs add catchUpStaggerMs each.
    let catchUpStaggerMs = this._catchUpInitialDelayMs;

    for (const job of this._registry.list()) {
      if (!job.enabled) {
        continue;
      }

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
                void this._maybeSpawn(job);
              } else {
                this._deadlines.set(job.id, 'catch-up', this._time.now() + delayMs,
                  () => { void this._maybeSpawn(job); });
              }
            }
          }
        }
      }

      if (job.type === 'startup') {
        const delay = (job.delaySeconds ?? 0) * 1000;
        if (delay === 0) {
          await this._maybeSpawn(job);
        } else {
          this._deadlines.set(job.id, 'startup-delay', this._time.now() + delay,
            () => { void this._maybeSpawn(job); });
        }
      }

      if (job.type === 'once') {
        await this._scheduleOnce(job);
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
    for (const job of this._registry.list()) {
      const entry = this._state.get(job.id);
      if (entry && entry.exitCode === null && entry.finishedAt == null) {
        let alive = false;
        if (entry.pid) {
          try { process.kill(entry.pid, 0); alive = true; } catch { /* dead */ }
        }
        if (!alive) {
          const finishedAt = this._now().toISOString();
          this._state.record(job.id, { ...entry, exitCode: 1, finishedAt });
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
    this.unscheduleJob(job.id);
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
  unscheduleJob(id: string): void {
    // Every kind at once. This used to reach into three collections by hand, and forgetting one was
    // exactly how a stopped scheduler kept a window timer armed - see the fix that preceded this.
    this._deadlines.clear(id);
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
    this._events.publish('job.window_expired', {
      jobId: job.id, label: job.label, activeUntil: job.activeUntil,
    });
  }

  async stop(): Promise<void> {
    // One call disarms everything. The previous version cancelled each collection by hand and had
    // silently missed the window timers, so a stopped scheduler could still disable a job days later.
    // A single queue makes that class of omission unexpressible.
    this._deadlines.clearAll();
    this._retryCounters.clear();
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
  async trigger(id: string, source: TriggerSource = { kind: 'manual' }, wait = false): Promise<{ pid: number | null; consumed?: boolean } | { exitCode: number | null; consumed?: boolean }> {
    const job = this._registry.get(id);
    if (!job) {
      throw new Error(`Job not found: "${id}"`);
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

    const result = await this._fire(job, source, wait);

    // After the fire, mirroring the scheduled path, so a `wait` trigger still has its job in place
    // while it runs.
    if (consumed && this._registry.get(job.id) !== null) {
      this._registry.markSpent(job.id);
    }

    return { ...result, ...(consumed ? { consumed: true } : {}) };
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
  private _killChild(child: ChildProcess): void {
    if (child.pid !== undefined) {
      killTreeSync(child.pid);
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
  private async _killChildAsync(child: ChildProcess): Promise<void> {
    if (child.pid !== undefined) {
      await killTree(child.pid);
      return;
    }
    child.kill('SIGTERM');
  }

  async killJob(id: string): Promise<{ killed: boolean }> {
    const child = this._activeChildren.get(id);
    if (child && !child.killed) {
      this._killedByUser.add(id);
      await this._killChildAsync(child);
      return { killed: true };
    }
    // Stale state: no active child but state still shows running - clean it up.
    // Liveness is finishedAt, not exitCode: a run killed by signal has no exit code,
    // so testing exitCode would "kill" an already-cancelled run and wrongly report success.
    const entry = this._state.get(id);
    if (entry && entry.finishedAt == null) {
      const finishedAt = this._now().toISOString();
      this._state.record(id, { ...entry, exitCode: 1, finishedAt, cancelledByUser: true });
      return { killed: true };
    }
    return { killed: false };
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
            this._events.publish('alert.sla_breach', {
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
  private async _maybeSpawn(job: Job, trigger: TriggerSource = { kind: 'cron' }): Promise<void> {
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
    if (await this._liveness(job)) {
      this._recordSkip(job, 'liveness');
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
    const jobLogger = new RunLogger(path.join(this._configDir, 'logs', 'jobs', job.id), job.id, at);
    jobLogger.write(`[job:skipped] reason=${reason} -- target already alive, nothing was done`);
    jobLogger.close();
    this._events.publish('job.skipped', {
      jobId: job.id, label: job.label, exitCode: null, durationMs: 0, reason,
    });
  }

  private async _fire(job: Job, trigger: TriggerSource = { kind: 'cron' }, waitForExit = false): Promise<{ pid: number | null } | { exitCode: number | null }> {
    const startedAt = this._now().toISOString();
    const secretEnv = job.secrets?.length ? this._secrets.resolveForJob(job.secrets) : {};
    const jobEnv = (job.env || job.secrets?.length)
      ? { ...process.env, ...job.env, ...secretEnv }
      : undefined;
    const child = this._spawn(job.command, job.cwd ?? undefined, jobEnv, job.id);
    const pid   = child.pid ?? null;

    // Per-run log: one file per execution -- <jobId>-<startedAt>.log
    const jobLogger = new RunLogger(
      path.join(this._configDir, 'logs', 'jobs', job.id),
      job.id,
      startedAt,
    );

    this._activeChildren.set(job.id, child);
    this._state.record(job.id, {
      startedAt, exitCode: null, pid, triggeredBy: trigger,
      retryAttempt: trigger.kind === 'retry' ? trigger.attempt : undefined,
    });
    this._events.publish('job.started', { jobId: job.id, label: job.label, pid, trigger: trigger.kind });
    this.emit('job-started', { id: job.id });
    jobLogger.write(`[job:started] pid=${pid} triggeredBy=${trigger.kind}`);

    // Resource monitoring: sample CPU/RAM every 2s, enforce auto-budget thresholds
    let peakCpuPct = 0;
    let peakRamMb  = 0;
    let softAlertSent = false;
    // CPU% is spiky by nature, so the hard budget only kills once the breach is sustained
    // over this many consecutive samples (2s apart). A single spike must never kill a job.
    // 3 matches the consecutive-failure threshold used elsewhere (NOTIF-02).
    let hardBreaches = 0;
    const HARD_BREACHES_TO_KILL = 3;
    const baseline      = this._state.getResourceBaseline(job.id);
    const softThreshold = baseline ? { cpuPct: baseline.cpuPct * 1.2, ramMb: baseline.ramMb * 1.2 } : null;
    const hardThreshold = baseline ? { cpuPct: baseline.cpuPct * 2.0, ramMb: baseline.ramMb * 2.0 } : null;
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
    const flushPeaks = (): void => {
      if (!peakDirty) {
        return;
      }
      peakDirty     = false;
      peakFlushedAt = Date.now();
      this._state.record(job.id, {
        startedAt, exitCode: null, pid, triggeredBy: trigger,
        retryAttempt: trigger.kind === 'retry' ? trigger.attempt : undefined,
        peakCpuPct: peakCpuPct > 0 ? peakCpuPct : undefined,
        peakRamMb:  peakRamMb  > 0 ? peakRamMb  : undefined,
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
        }).then(usage => {
          // Every pid in the tree vanished between the walk and the sample: the job is
          // finishing. Keep the timer -- the exit handler owns clearing it.
          if (usage === null) {
            return;
          }
          const cpuPct = usage.cpuPct;
          const ramMb  = usage.ramMb;
          if (cpuPct > peakCpuPct) { peakCpuPct = cpuPct; peakDirty = true; }
          if (ramMb  > peakRamMb)  { peakRamMb  = ramMb;  peakDirty = true; }
          // Throttled here rather than inside flushPeaks, so the kill paths below can force a
          // write. Peaks only ever climb, so a settled job stops writing on its own.
          if (peakDirty && Date.now() - peakFlushedAt >= this._peakFlushMs) {
            flushPeaks();
          }
          const overHard = hardThreshold !== null && (cpuPct > hardThreshold.cpuPct || ramMb > hardThreshold.ramMb);
          // Any sample back under the hard budget means the spike was transient.
          if (!overHard) {
            hardBreaches = 0;
          }
          // Warn on the soft budget independently of the hard one. Gating this behind "not over
          // hard" meant a job that jumped straight past the hard threshold was killed on the
          // third sample having never emitted a warning -- and now that the kill is delayed on
          // purpose, those first samples are exactly when the warning is worth something.
          if (!softAlertSent && softThreshold && (cpuPct > softThreshold.cpuPct || ramMb > softThreshold.ramMb)) {
            softAlertSent = true;
            const msg = `[warn] Soft resource limit exceeded (CPU: ${cpuPct.toFixed(1)}% / RAM: ${ramMb.toFixed(0)}MB)`;
            try { process.stderr.write(msg + '\n'); } catch { /* EPIPE */ }
            this._events.publish('job.resource_soft_limit', { jobId: job.id, label: job.label, cpuPct, ramMb, softThreshold });
          }
          if (overHard) {
            hardBreaches++;
            const over = `CPU: ${cpuPct.toFixed(1)}% threshold: ${hardThreshold!.cpuPct.toFixed(1)}% / RAM: ${ramMb.toFixed(0)}MB threshold: ${hardThreshold!.ramMb.toFixed(0)}MB`;
            if (hardBreaches < HARD_BREACHES_TO_KILL) {
              // Over budget but not yet sustained: record it and leave the job alone.
              jobLogger.write(`[resource-monitor] Over hard budget ${hardBreaches}/${HARD_BREACHES_TO_KILL} (${over})`);
            } else if (!killing) {
              // Guarded even with the in-flight check above: a walk that had already resolved when
              // the kill started must not announce a second one. One kill, one event, one _killChild.
              killing = true;
              const msg = `[warn] Hard resource limit exceeded for ${hardBreaches} consecutive samples (${over}) - killing`;
              try { process.stderr.write(msg + '\n'); } catch { /* EPIPE */ }
              this._events.publish('job.resource_hard_limit', { jobId: job.id, label: job.label, cpuPct, ramMb, hardThreshold, consecutiveSamples: hardBreaches });
              resourceTimer?.cancel();
              // Forced before the kill: the numbers that justified killing this job are the ones
              // most worth keeping, and clearing the timer above means no later sample will write.
              flushPeaks();
              this._killChild(child);
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
    child.stdout?.on('data', (d: Buffer) => {
      jobLogger.write(d.toString().trimEnd());
      try { process.stdout.write(d); } catch { /* EPIPE: launcher pipe closed */ }
    });
    child.stderr?.on('data', (d: Buffer) => {
      jobLogger.write(`[stderr] ${d.toString().trimEnd()}`);
      try { process.stderr.write(d); } catch { /* EPIPE: launcher pipe closed */ }
    });

    // Job timeout: kill process if it exceeds timeoutSeconds (default 5 min = 300s)
    const timeoutMs = (job.timeoutSeconds ?? 300) * 1000;
    let timeoutHandle: Timer | null = null;
    if (timeoutMs > 0) {
      timeoutHandle = this._time.after(timeoutMs, () => {
        jobLogger.write(`[warn] Job ${job.id} timed out after ${job.timeoutSeconds ?? 300}s - killing process`);
        this._events.publish('job.timed_out', { jobId: job.id, label: job.label, timeoutSeconds: job.timeoutSeconds ?? 300 });
        // A timed-out job is one whose resource use is worth a look, so persist before killing.
        flushPeaks();
        this._killChild(child);
      });
    }

    const done = new Promise<{ exitCode: number | null }>((resolve) => {
      child.on('close', (code) => {
        this._activeChildren.delete(job.id);
        timeoutHandle?.cancel();
        resourceTimer?.cancel();
        const rawExitCode = code ?? 1;
        const finishedAt = this._now().toISOString();
        const durationMs = Date.now() - new Date(startedAt).getTime();
        const cancelledByUser = this._killedByUser.delete(job.id);
        // exitCode=null + finishedAt = "Cancelled" in RunHistory
        const exitCode = cancelledByUser ? null : rawExitCode;

        // Declared by the job as "nothing was done", so it is neither a success nor a failure. The
        // real exit code is still recorded: a lock left stuck stays diagnosable.
        const skipped = !cancelledByUser && exitCode !== null
          && (job.skipExitCodes?.includes(exitCode) ?? false);

        // Recovery detection: was previous run a failure?
        const prev = this._state.get(job.id);
        const wasFailure = prev !== null && isFailure(prev);

        this._state.record(job.id, {
          startedAt, finishedAt, exitCode, pid, triggeredBy: trigger,
          peakCpuPct: peakCpuPct > 0 ? peakCpuPct : undefined,
          peakRamMb:  peakRamMb  > 0 ? peakRamMb  : undefined,
          cancelledByUser: cancelledByUser || undefined,
          skipped: skipped || undefined,
        });
        jobLogger.write(skipped
          ? `[job:skipped] exitCode=${exitCode} duration=${Math.round(durationMs / 100) / 10}s reason=skipExitCodes`
          : `[job:finished] exitCode=${exitCode} duration=${Math.round(durationMs / 100) / 10}s`);
        jobLogger.close();
        // `skipped` travels with the event because the systray classifies on this alone.
        this.emit('job-finished', { id: job.id, exitCode, job, skipped });

        if (cancelledByUser) {
          this._events.publish('job.killed_manual', { jobId: job.id, label: job.label, durationMs });
        } else if (skipped) {
          // No dependents and no retry: both would act on work that never happened. The retry
          // counter is left alone, since a skip says nothing about whether the last attempt failed.
          this._events.publish('job.skipped', {
            jobId: job.id, label: job.label, exitCode, durationMs, reason: 'exitCode',
          });
        } else if (exitCode === 0) {
          this._retryCounters.delete(job.id);
          this._events.publish('job.completed', { jobId: job.id, label: job.label, exitCode, durationMs });
          // Trigger dependent jobs
          for (const dep of this._registry.list().filter(j => j.dependsOn === job.id && j.enabled)) {
            void this._fire(dep, { kind: 'dependency', dependsOnJobId: job.id });
          }
          if (wasFailure) {
            this._events.publish('job.recovered', { jobId: job.id, label: job.label });
          }
          // Anomaly detection: emit if duration is 3x longer than rolling average
          const avgMs = this._state.getRollingAvgDurationMs(job.id);
          if (avgMs !== null && durationMs > 3 * avgMs) {
            jobLogger.write(`[warn] Job ${job.id} took ${durationMs}ms (3x avg ${Math.round(avgMs)}ms) - anomaly detected`);
            this._events.publish('job.anomaly', { jobId: job.id, label: job.label, durationMs, avgMs: Math.round(avgMs), multiplier: 3 });
          }
        } else if (exitCode !== null) {
          this._events.publish('job.failed', { jobId: job.id, label: job.label, exitCode, durationMs });
          // Consecutive-failure alert
          const threshold = job.alertAfterFailures ?? 3;
          const consecutive = this._state.getConsecutiveFailures(job.id);
          if (consecutive >= threshold) {
            this._events.publish('alert.consecutive_failures', { jobId: job.id, label: job.label, consecutiveFailures: consecutive, threshold });
          }
          // Retry on specific exit codes (extension point: hooks fire for each retry/exhaustion)
          if (job.retryOnExitCodes?.includes(exitCode)) {
            const attempts = this._retryCounters.get(job.id) ?? 0;
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
                void this._fire(job, { kind: 'retry', attempt: nextAttempt });
              });
            } else {
              this._retryCounters.delete(job.id);
              jobLogger.write(`[retry] exhausted after ${delays.length} attempts (exitCode=${exitCode}) -- permanent failure`);
              void this._hookDispatcher?.dispatch('onJobExhausted' as never, {
                jobId: job.id, label: job.label, exitCode, attempts: delays.length,
              }, (err: unknown) => console.error('[hook:onJobExhausted]', err));
              this._events.publish('alert.retry_exhausted', { jobId: job.id, label: job.label, exitCode, attempts: delays.length });
            }
          }
        }

        resolve({ exitCode });
      });
    });

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
