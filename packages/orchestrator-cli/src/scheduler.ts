import cron from 'node-cron';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os   from 'node:os';
import { EventEmitter } from 'node:events';
import { checkLiveness } from './liveness.js';
import { DailyLogger }   from './logger.js';
import { ensureTmpDir }  from './fsUtil.js';
import { EventPublisher } from './event-publisher.js';
import { SecretsManager } from './secrets.js';
import type { Job, TriggerSource } from './types.js';
import type { Registry } from './registry.js';
import type { State } from './state.js';

type SpawnFn    = (cmd: string, cwd?: string, env?: NodeJS.ProcessEnv) => ChildProcess;
type LivenessFn = (job: Pick<Job, 'id' | 'liveness'>) => Promise<boolean>;

interface SchedulerOptions {
  spawn?:          SpawnFn;
  liveness?:       LivenessFn;
  now?:            () => Date;
  configDir?:      string;
  eventPublisher?: EventPublisher;
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
    for (const job of this._registry.list()) {
      if (!job.enabled) continue;

      if (job.type === 'cron') {
        this._scheduleCron(job);
        if (job.missedFiring === 'catch-up') {
          const last = this._state.get(job.id);
          if (!last || last.exitCode === null) void this._fire(job);
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
  }

  async stop(): Promise<void> {
    for (const task of this._cronTasks.values()) task.stop();
    this._cronTasks.clear();
    for (const handle of this._timeouts.values()) clearTimeout(handle);
    this._timeouts.clear();
  }

  async dryRun(id: string): Promise<{ pid: number | null } | { exitCode: number } | { error: string }> {
    const job = this._registry.get(id);
    if (!job) throw new Error(`Job not found: "${id}"`);
    if (!job.dryRunSupported) return { error: `Job "${id}" does not declare dryRunSupported: true` };
    const dryJob = { ...job, command: job.command + ' --dry-run' };
    return this._fire(dryJob, { kind: 'manual' });
  }

  async trigger(id: string, source: TriggerSource = { kind: 'manual' }): Promise<{ pid: number | null } | { exitCode: number }> {
    const job = this._registry.get(id);
    if (!job) throw new Error(`Job not found: "${id}"`);
    return this._fire(job, source);
  }

  private _scheduleCron(job: Job): void {
    if (!cron.validate(job.schedule ?? '')) return;
    const task = cron.schedule(job.schedule!, () => {
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

  private async _fire(job: Job, trigger: TriggerSource = { kind: 'cron' }): Promise<{ pid: number | null } | { exitCode: number }> {
    const startedAt = this._now().toISOString();
    const secretEnv = job.secrets?.length ? this._secrets.resolveForJob(job.secrets) : {};
    const jobEnv = (job.env || job.secrets?.length)
      ? { ...process.env, ...job.env, ...secretEnv }
      : undefined;
    const child = this._spawn(job.command, job.cwd ?? undefined, jobEnv);
    const pid   = child.pid ?? null;

    this._state.record(job.id, { startedAt, exitCode: null, pid, triggeredBy: trigger });
    this._events.publish('job.started', { jobId: job.id, label: job.label, pid, trigger: trigger.kind });
    this.emit('job-started', { id: job.id });

    // Per-job rotating log: tee stdout/stderr to file + terminal.
    // Log file: <configDir>/logs/<jobId>/<jobId>-YYYY-MM-DD.log
    const jobLogger = new DailyLogger(
      path.join(this._configDir, 'logs', job.id),
      job.id,
    );
    child.stdout?.on('data', (d: Buffer) => {
      jobLogger.write(d.toString().trimEnd());
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      jobLogger.write(`[stderr] ${d.toString().trimEnd()}`);
      process.stderr.write(d);
    });

    // Job timeout: kill process if it exceeds timeoutSeconds (default 5 min = 300s)
    const timeoutMs = (job.timeoutSeconds ?? 300) * 1000;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        jobLogger.write(`[warn] Job ${job.id} timed out after ${job.timeoutSeconds ?? 300}s - killing process`);
        this._events.publish('job.timed_out', { jobId: job.id, label: job.label, timeoutSeconds: job.timeoutSeconds ?? 300 });
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000);
      }, timeoutMs);
    }

    const done = new Promise<{ exitCode: number }>((resolve) => {
      child.on('close', (code) => {
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
        const exitCode = code ?? 1;
        const finishedAt = this._now().toISOString();
        const durationMs = Date.now() - new Date(startedAt).getTime();

        // Recovery detection: was previous run a failure?
        const prev = this._state.get(job.id);
        const wasFailure = prev !== null && prev.exitCode !== null && prev.exitCode !== 0;

        this._state.record(job.id, { startedAt, finishedAt, exitCode, pid, triggeredBy: trigger });
        jobLogger.close();
        this.emit('job-finished', { id: job.id, exitCode, job });

        if (exitCode === 0) {
          this._events.publish('job.completed', { jobId: job.id, label: job.label, exitCode, durationMs });
          // Trigger dependent jobs
          for (const dep of this._registry.list().filter(j => j.dependsOn === job.id && j.enabled)) {
            void this._fire(dep, { kind: 'dependency', dependsOnJobId: job.id });
          }
          if (wasFailure) {
            this._events.publish('job.recovered', { jobId: job.id, label: job.label });
          }
          // Anomaly detection: emit if duration is 3× longer than rolling average
          const avgMs = this._state.getRollingAvgDurationMs(job.id);
          if (avgMs !== null && durationMs > 3 * avgMs) {
            jobLogger.write(`[warn] Job ${job.id} took ${durationMs}ms (3x avg ${Math.round(avgMs)}ms) - anomaly detected`);
            this._events.publish('job.anomaly', { jobId: job.id, label: job.label, durationMs, avgMs: Math.round(avgMs), multiplier: 3 });
          }
        } else {
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
      done.catch(() => {});
      return { pid };
    }

    return done;
  }
}
