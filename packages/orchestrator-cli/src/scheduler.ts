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
  private readonly _configDir: string;
  private readonly _tmpDir:    string;
  private readonly _events:    EventPublisher;
  private readonly _secrets:   SecretsManager;
  private readonly _cronTasks = new Map<string, ReturnType<typeof cron.schedule>>();
  private readonly _timeouts  = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly _activeChildren = new Map<string, ChildProcess>();
  private readonly _killedByUser   = new Set<string>();
  private readonly _skippedJobs    = new Map<string, number>();
  private readonly _catchUpInitialDelayMs: number;
  private readonly _catchUpStaggerMs:      number;
  private readonly _hookDispatcher:  HookDispatcher | null;
  private readonly _peakFlushMs:     number;
  private readonly _retryTimers    = new Map<string, ReturnType<typeof setTimeout>>();
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
    this._now       = options.now       ?? (() => new Date());
    this._configDir = options.configDir ?? (
      process.env['ORCH_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'orchestrator')
    );
    this._events    = options.eventPublisher ?? new EventPublisher();
    this._secrets   = new SecretsManager(this._configDir);
    this._catchUpInitialDelayMs = options.catchUpInitialDelayMs ?? 300_000;
    this._catchUpStaggerMs      = options.catchUpStaggerMs      ?? 300_000;
    this._hookDispatcher        = options.hookDispatcher        ?? null;
    this._peakFlushMs           = options.peakFlushMs           ?? 10_000;
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
                void this._fire(job, { kind: 'cron' });
              } else {
                setTimeout(() => { void this._fire(job, { kind: 'cron' }); }, delayMs);
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
          const handle = setTimeout(async () => {
            this._timeouts.delete(job.id);
            await this._maybeSpawn(job);
          }, delay);
          this._timeouts.set(job.id, handle);
        }
      }

      if (job.type === 'once') {
        const elapsed   = this._now().getTime() - new Date(job.scheduledAt!).getTime();
        const remaining = job.delayMs! - elapsed;
        if (remaining <= 0) {
          await this._fire(job);
          this._registry.remove(job.id);
        } else {
          const handle = setTimeout(async () => {
            this._timeouts.delete(job.id);
            await this._fire(job);
            this._registry.remove(job.id);
          }, remaining);
          this._timeouts.set(job.id, handle);
        }
      }
    }

    // Clean up stale "running" entries from previous sessions whose process is no longer alive
    for (const job of this._registry.list()) {
      const entry = this._state.get(job.id);
      if (entry && entry.exitCode === null) {
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

  async stop(): Promise<void> {
    for (const task of this._cronTasks.values()) task.stop();
    this._cronTasks.clear();
    for (const handle of this._timeouts.values()) clearTimeout(handle);
    this._timeouts.clear();
    for (const t of this._retryTimers.values()) clearTimeout(t);
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

  async trigger(id: string, source: TriggerSource = { kind: 'manual' }): Promise<{ pid: number | null } | { exitCode: number | null }> {
    const job = this._registry.get(id);
    if (!job) throw new Error(`Job not found: "${id}"`);
    return this._fire(job, source);
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
    if (!cron.validate(job.schedule ?? '')) return;
    const task = cron.schedule(job.schedule!, () => {
      const skipUntil = this._skippedJobs.get(job.id);
      if (skipUntil && Date.now() < skipUntil) {
        this._skippedJobs.delete(job.id);
        return; // occurrence was pre-empted by trigger-early
      }
      const scheduledAt = this._now().toISOString();
      void this._fire(job);
      // SLA window check: alert if job hasn't succeeded within slaWindowMinutes
      if (job.slaWindowMinutes && job.slaWindowMinutes > 0) {
        setTimeout(() => {
          const latest = this._state.get(job.id);
          const succeeded = latest && latest.exitCode === 0 &&
            new Date(latest.startedAt).getTime() >= new Date(scheduledAt).getTime();
          if (!succeeded) {
            this._events.publish('alert.sla_breach', {
              jobId: job.id, label: job.label,
              scheduledAt, windowMinutes: job.slaWindowMinutes,
            });
          }
        }, job.slaWindowMinutes * 60 * 1000);
      }
    });
    this._cronTasks.set(job.id, task);
  }

  private async _maybeSpawn(job: Job): Promise<void> {
    if (await this._liveness(job)) return;
    void this._fire(job);
  }

  private async _fire(job: Job, trigger: TriggerSource = { kind: 'cron' }): Promise<{ pid: number | null } | { exitCode: number | null }> {
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

    let resourceTimer: ReturnType<typeof setInterval> | null = null;
    if (pid) {
      const sample = (): void => {
        if (child.killed) { clearInterval(resourceTimer!); return; }
        sampleProcessTree(pid!).then(usage => {
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
            } else {
              const msg = `[warn] Hard resource limit exceeded for ${hardBreaches} consecutive samples (${over}) - killing`;
              try { process.stderr.write(msg + '\n'); } catch { /* EPIPE */ }
              this._events.publish('job.resource_hard_limit', { jobId: job.id, label: job.label, cpuPct, ramMb, hardThreshold, consecutiveSamples: hardBreaches });
              clearInterval(resourceTimer!);
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
      resourceTimer = setInterval(sample, 2000);
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
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        jobLogger.write(`[warn] Job ${job.id} timed out after ${job.timeoutSeconds ?? 300}s - killing process`);
        this._events.publish('job.timed_out', { jobId: job.id, label: job.label, timeoutSeconds: job.timeoutSeconds ?? 300 });
        // A timed-out job is one whose resource use is worth a look, so persist before killing.
        flushPeaks();
        this._killChild(child);
      }, timeoutMs);
    }

    const done = new Promise<{ exitCode: number | null }>((resolve) => {
      child.on('close', (code) => {
        this._activeChildren.delete(job.id);
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        if (resourceTimer !== null) clearInterval(resourceTimer);
        const rawExitCode = code ?? 1;
        const finishedAt = this._now().toISOString();
        const durationMs = Date.now() - new Date(startedAt).getTime();
        const cancelledByUser = this._killedByUser.delete(job.id);
        // exitCode=null + finishedAt = "Cancelled" in RunHistory
        const exitCode = cancelledByUser ? null : rawExitCode;

        // Recovery detection: was previous run a failure?
        const prev = this._state.get(job.id);
        const wasFailure = prev !== null && prev.exitCode !== null && prev.exitCode !== 0;

        this._state.record(job.id, {
          startedAt, finishedAt, exitCode, pid, triggeredBy: trigger,
          peakCpuPct: peakCpuPct > 0 ? peakCpuPct : undefined,
          peakRamMb:  peakRamMb  > 0 ? peakRamMb  : undefined,
          cancelledByUser: cancelledByUser || undefined,
        });
        jobLogger.write(`[job:finished] exitCode=${exitCode} duration=${Math.round(durationMs / 100) / 10}s`);
        jobLogger.close();
        this.emit('job-finished', { id: job.id, exitCode, job });

        if (cancelledByUser) {
          this._events.publish('job.killed_manual', { jobId: job.id, label: job.label, durationMs });
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
              const timer = setTimeout(() => {
                this._retryTimers.delete(job.id);
                void this._fire(job, { kind: 'retry', attempt: nextAttempt });
              }, delayMs);
              this._retryTimers.set(job.id, timer);
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

    if (job.triggerMode !== 'wait') {
      done.catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        jobLogger.write(`[error] Job promise rejected (fire-and-forget): ${reason}`);
      });
      return { pid };
    }

    return done;
  }
}
