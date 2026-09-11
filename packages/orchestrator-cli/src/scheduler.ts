import cron from 'node-cron';
import { spawn as nodeSpawn, execSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os   from 'node:os';
import { EventEmitter } from 'node:events';
import { checkLiveness } from './liveness.js';
import { RunLogger }     from './logger.js';
import { ensureTmpDir }  from './fsUtil.js';
import { EventPublisher } from './event-publisher.js';
import { SecretsManager } from './secrets.js';
import { getLastFiring, getNextFirings } from './cronNext.js';
// pidusage: cross-platform CPU/RAM sampling by PID (types in pidusage.d.ts)
import pidusage from 'pidusage';
import type { Job, TriggerSource } from './types.js';
import type { Registry } from './registry.js';
import type { State } from './state.js';

type SpawnFn    = (cmd: string, cwd?: string, env?: NodeJS.ProcessEnv) => ChildProcess;
type LivenessFn = (job: Pick<Job, 'id' | 'liveness'>) => Promise<boolean>;

interface SchedulerOptions {
  spawn?:                 SpawnFn;
  liveness?:              LivenessFn;
  now?:                   () => Date;
  configDir?:             string;
  eventPublisher?:        EventPublisher;
  catchUpInitialDelayMs?: number;
  catchUpStaggerMs?:      number;
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

  constructor(registry: Registry, state: State, options: SchedulerOptions = {}) {
    super();
    this._registry  = registry;
    this._state     = state;
    // Default spawn is set below after _tmpDir is resolved.
    this._spawn     = options.spawn     ?? ((cmd, cwd, env) => {
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
    // Ensure tmp dir exists; used as default cwd for jobs that don't specify one.
    this._tmpDir = ensureTmpDir(this._configDir);
    // Re-bind spawn now that _tmpDir is resolved (closure captures the value, not the field).
    if (!options.spawn) {
      const tmpDir = this._tmpDir;
      this._spawn = (cmd, cwd, env) => {
        const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [cmd];
        const [bin, ...args] = parts;
        return nodeSpawn(bin!, args, {
          cwd: cwd ?? tmpDir,
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

  private _killChild(child: ChildProcess): void {
    if (process.platform === 'win32' && child.pid) {
      try { execSync(`taskkill /f /t /pid ${child.pid}`, { stdio: 'ignore' }); } catch { /* already dead */ }
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
    }
  }

  killJob(id: string): { killed: boolean } {
    const child = this._activeChildren.get(id);
    if (child && !child.killed) {
      this._killedByUser.add(id);
      this._killChild(child);
      return { killed: true };
    }
    // Stale state: no active child but state still shows running - clean it up
    const entry = this._state.get(id);
    if (entry && entry.exitCode === null) {
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
    const child = this._spawn(job.command, job.cwd ?? undefined, jobEnv);
    const pid   = child.pid ?? null;

    // Per-run log: one file per execution — <jobId>-<startedAt>.log
    const jobLogger = new RunLogger(
      path.join(this._configDir, 'logs', job.id),
      job.id,
      startedAt,
    );

    this._activeChildren.set(job.id, child);
    this._state.record(job.id, { startedAt, exitCode: null, pid, triggeredBy: trigger });
    this._events.publish('job.started', { jobId: job.id, label: job.label, pid, trigger: trigger.kind });
    this.emit('job-started', { id: job.id });
    jobLogger.write(`[job:started] pid=${pid} triggeredBy=${trigger.kind}`);

    // Resource monitoring: sample CPU/RAM every 2s, enforce auto-budget thresholds
    let peakCpuPct = 0;
    let peakRamMb  = 0;
    let softAlertSent = false;
    const baseline      = this._state.getResourceBaseline(job.id);
    const softThreshold = baseline ? { cpuPct: baseline.cpuPct * 1.2, ramMb: baseline.ramMb * 1.2 } : null;
    const hardThreshold = baseline ? { cpuPct: baseline.cpuPct * 2.0, ramMb: baseline.ramMb * 2.0 } : null;
    let resourceTimer: ReturnType<typeof setInterval> | null = null;
    if (pid) {
      resourceTimer = setInterval(() => {
        if (child.killed) { clearInterval(resourceTimer!); return; }
        pidusage(pid!).then(stats => {
          const cpuPct = stats.cpu;
          const ramMb  = stats.memory / 1024 / 1024;
          if (cpuPct > peakCpuPct) peakCpuPct = cpuPct;
          if (ramMb  > peakRamMb)  peakRamMb  = ramMb;
          if (hardThreshold && (cpuPct > hardThreshold.cpuPct || ramMb > hardThreshold.ramMb)) {
            // Hard budget exceeded: kill
            const msg = `[warn] Hard resource limit exceeded (CPU: ${cpuPct.toFixed(1)}% threshold: ${hardThreshold.cpuPct.toFixed(1)}% / RAM: ${ramMb.toFixed(0)}MB threshold: ${hardThreshold.ramMb.toFixed(0)}MB) - killing`;
            try { process.stderr.write(msg + '\n'); } catch { /* EPIPE */ }
            this._events.publish('job.resource_hard_limit', { jobId: job.id, label: job.label, cpuPct, ramMb, hardThreshold });
            clearInterval(resourceTimer!);
            this._killChild(child);
          } else if (!softAlertSent && softThreshold && (cpuPct > softThreshold.cpuPct || ramMb > softThreshold.ramMb)) {
            softAlertSent = true;
            const msg = `[warn] Soft resource limit exceeded (CPU: ${cpuPct.toFixed(1)}% / RAM: ${ramMb.toFixed(0)}MB)`;
            try { process.stderr.write(msg + '\n'); } catch { /* EPIPE */ }
            this._events.publish('job.resource_soft_limit', { jobId: job.id, label: job.label, cpuPct, ramMb, softThreshold });
          }
        }).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          jobLogger.write(`[resource-monitor] Failed to get metrics: ${reason}`);
          clearInterval(resourceTimer!);
        });
      }, 2000);
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
