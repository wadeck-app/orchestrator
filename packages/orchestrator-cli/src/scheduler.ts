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

/**
 * Sums CPU and RAM over a process and all its descendants.
 *
 * Returns null when not a single pid could be sampled, which lets the caller tell
 * "the job exited" apart from "the job is genuinely using 0%". Individual pids are
 * sampled independently because a descendant can exit between the tree walk and the
 * sample, and one dead pid must not discard the readings of its siblings.
 */
export async function sampleProcessTree(rootPid: number): Promise<TreeUsage | null> {
  let pids: number[];
  try {
    pids = await pidtree(rootPid, { root: true });
  } catch {
    // The walk fails once the root is gone; still try the root, it may just have no children.
    pids = [rootPid];
  }
  const samples = await Promise.allSettled(pids.map(p => pidusage(p)));
  let cpuPct   = 0;
  let ramBytes = 0;
  let sampled  = 0;
  for (const s of samples) {
    if (s.status !== 'fulfilled') continue;
    cpuPct   += s.value.cpu;
    ramBytes += s.value.memory;
    sampled++;
  }
  if (sampled === 0) return null;
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
  private readonly _cronTasks = new Map<string, ReturnType<typeof cron.schedule>>();
  private readonly _timeouts  = new Map<string, Timer>();
  private readonly _activeChildren = new Map<string, ChildProcess>();
  private readonly _killedByUser   = new Set<string>();
  private readonly _skippedJobs    = new Map<string, number>();
  private readonly _catchUpInitialDelayMs: number;
  private readonly _catchUpStaggerMs:      number;
  private readonly _hookDispatcher:  HookDispatcher | null;
  private readonly _peakFlushMs:     number;
  private readonly _sampleUsage:     (rootPid: number) => Promise<TreeUsage | null>;
  private readonly _sampleIntervalMs: number;
  private readonly _retryTimers    = new Map<string, Timer>();
  private readonly _retryCounters  = new Map<string, number>();

  constructor(registry: Registry, state: State, options: SchedulerOptions = {}) {
    super();
    this._registry  = registry;
    this._state     = state;
    // Default spawn is set below after _tmpDir is resolved.
    this._spawn     = options.spawn     ?? ((cmd, cwd, env, _jobId) => {
      const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [cmd];
      const [bin, ...args] = parts;
      return nodeSpawn(bin!, args, { cwd: cwd ?? os.homedir(), windowsHide: true, shell: true, env: env ?? process.env });
    });
    this._liveness  = options.liveness  ?? checkLiveness;
    this._time      = options.time      ?? systemTime;
    // Defaults to the time service rather than Date, so a test that moves the clock is not
    // contradicted by a `now` that never moved. An explicit `now` still wins, for the tests that only
    // needed to pin the date.
    this._now       = options.now       ?? (() => new Date(this._time.now()));
    this._configDir = options.configDir ?? (
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
      if (!job.enabled) continue;

      if (job.type === 'cron') {
        this._scheduleCron(job);
        if (job.missedFiring === 'catch-up' && job.schedule) {
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
                this._time.after(delayMs, () => { void this._maybeSpawn(job); });
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
          this._timeouts.set(job.id, this._time.after(delay, () => {
            this._timeouts.delete(job.id);
            void this._maybeSpawn(job);
          }));
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
    const elapsed   = this._now().getTime() - new Date(job.scheduledAt!).getTime();
    const remaining = job.delayMs! - elapsed;
    // Removed either way: a once job is spent when its moment passes. If the liveness check
    // skipped it, the thing it was meant to bring up is already up, so its purpose is served.
    if (remaining <= 0) {
      await this._maybeSpawn(job);
      this._registry.remove(job.id);
      return;
    }
    this._timeouts.set(job.id, this._time.after(remaining, () => {
      this._timeouts.delete(job.id);
      void (async () => {
        await this._maybeSpawn(job);
        this._registry.remove(job.id);
      })();
    }));
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
      this._scheduleCron(job);
      return;
    }
    if (job.type === 'once') {
      void this._scheduleOnce(job);
      return;
    }
    // `startup` means "when the daemon starts". A startup job added while it is already running has
    // nothing to schedule now, and firing it here would contradict the type's own meaning.
  }

  /** Cancels a job's pending cron task or timer. Safe for an id that has neither. */
  unscheduleJob(id: string): void {
    const task = this._cronTasks.get(id);
    if (task) {
      task.stop();
      this._cronTasks.delete(id);
    }
    const handle = this._timeouts.get(id);
    if (handle) {
      handle.cancel();
      this._timeouts.delete(id);
    }
  }

  async stop(): Promise<void> {
    for (const task of this._cronTasks.values()) task.stop();
    this._cronTasks.clear();
    for (const handle of this._timeouts.values()) handle.cancel();
    this._timeouts.clear();
    for (const t of this._retryTimers.values()) t.cancel();
    this._retryTimers.clear();
    this._retryCounters.clear();
  }

  async dryRun(id: string): Promise<{ pid: number | null } | { exitCode: number | null } | { error: string }> {
    const job = this._registry.get(id);
    if (!job) throw new Error(`Job not found: "${id}"`);
    if (!job.dryRunSupported) return { error: `Job "${id}" does not declare dryRunSupported: true` };
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
  async trigger(id: string, source: TriggerSource = { kind: 'manual' }, wait = false): Promise<{ pid: number | null } | { exitCode: number | null }> {
    const job = this._registry.get(id);
    if (!job) throw new Error(`Job not found: "${id}"`);
    return this._fire(job, source, wait);
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
    if (!job || job.type !== 'cron' || !job.schedule) return;
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
    const task = cron.schedule(job.schedule!, () => {
      const skipUntil = this._skippedJobs.get(job.id);
      if (skipUntil && Date.now() < skipUntil) {
        this._skippedJobs.delete(job.id);
        return; // occurrence was pre-empted by trigger-early
      }
      const scheduledAt = this._now().toISOString();
      void this._maybeSpawn(job);
      // SLA window check: alert if job hasn't succeeded within slaWindowMinutes
      if (job.slaWindowMinutes && job.slaWindowMinutes > 0) {
        this._time.after(job.slaWindowMinutes * 60_000, () => {
          const latest = this._state.get(job.id);
          const succeeded = latest && latest.exitCode === 0 &&
            new Date(latest.startedAt).getTime() >= new Date(scheduledAt).getTime();
          if (!succeeded) {
            this._events.publish('alert.sla_breach', {
              jobId: job.id, label: job.label,
              scheduledAt, windowMinutes: job.slaWindowMinutes,
            });
          }
        });
      }
    });
    this._cronTasks.set(job.id, task);
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

    // Per-run log: one file per execution — <jobId>-<startedAt>.log
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
      if (!peakDirty) return;
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
      const sample = (): void => {
        if (child.killed) { resourceTimer?.cancel(); return; }
        if (samplingSince !== null && Date.now() - samplingSince < samplingStallMs) {
          return;
        }
        samplingSince = Date.now();
        this._sampleUsage(pid!).finally(() => { samplingSince = null; }).then(usage => {
          // Every pid in the tree vanished between the walk and the sample: the job is
          // finishing. Keep the timer -- the exit handler owns clearing it.
          if (usage === null) return;
          const cpuPct = usage.cpuPct;
          const ramMb  = usage.ramMb;
          if (cpuPct > peakCpuPct) { peakCpuPct = cpuPct; peakDirty = true; }
          if (ramMb  > peakRamMb)  { peakRamMb  = ramMb;  peakDirty = true; }
          // Throttled here rather than inside flushPeaks, so the kill paths below can force a
          // write. Peaks only ever climb, so a settled job stops writing on its own.
          if (peakDirty && Date.now() - peakFlushedAt >= this._peakFlushMs) flushPeaks();
          const overHard = hardThreshold !== null && (cpuPct > hardThreshold.cpuPct || ramMb > hardThreshold.ramMb);
          // Any sample back under the hard budget means the spike was transient.
          if (!overHard) hardBreaches = 0;
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
              this._retryTimers.set(job.id, this._time.after(delayMs, () => {
                this._retryTimers.delete(job.id);
                void this._fire(job, { kind: 'retry', attempt: nextAttempt });
              }));
            } else {
              this._retryCounters.delete(job.id);
              jobLogger.write(`[retry] exhausted after ${delays.length} attempts (exitCode=${exitCode}) — permanent failure`);
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
        const reason = err instanceof Error ? err.message : String(err);
        jobLogger.write(`[error] Job promise rejected (fire-and-forget): ${reason}`);
      });
      return { pid };
    }

    return done;
  }
}
