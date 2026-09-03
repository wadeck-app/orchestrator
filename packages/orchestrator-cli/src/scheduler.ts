import cron from 'node-cron';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import os   from 'node:os';
import { EventEmitter } from 'node:events';
import { checkLiveness } from './liveness.js';
import { DailyLogger }   from './logger.js';
import { ensureTmpDir }  from './fsUtil.js';
import type { Job, TriggerSource } from './types.js';
import type { Registry } from './registry.js';
import type { State } from './state.js';

type SpawnFn    = (cmd: string, cwd?: string) => ChildProcess;
type LivenessFn = (job: Pick<Job, 'id' | 'liveness'>) => Promise<boolean>;

interface SchedulerOptions {
  spawn?:     SpawnFn;
  liveness?:  LivenessFn;
  now?:       () => Date;
  configDir?: string;
}

export class Scheduler extends EventEmitter {
  private readonly _registry:  Registry;
  private readonly _state:     State;
  private _spawn:              SpawnFn;
  private readonly _liveness:  LivenessFn;
  private readonly _now:       () => Date;
  private readonly _configDir: string;
  private readonly _tmpDir:    string;
  private readonly _cronTasks = new Map<string, ReturnType<typeof cron.schedule>>();
  private readonly _timeouts  = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(registry: Registry, state: State, options: SchedulerOptions = {}) {
    super();
    this._registry  = registry;
    this._state     = state;
    // Default spawn is set below after _tmpDir is resolved.
    this._spawn     = options.spawn     ?? ((cmd, cwd) => {
      const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [cmd];
      const [bin, ...args] = parts;
      return nodeSpawn(bin!, args, { cwd: cwd ?? os.homedir(), windowsHide: true, shell: true });
    });
    this._liveness  = options.liveness  ?? checkLiveness;
    this._now       = options.now       ?? (() => new Date());
    this._configDir = options.configDir ?? (
      process.env['ORCH_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'orchestrator')
    );
    // Ensure tmp dir exists; used as default cwd for jobs that don't specify one.
    this._tmpDir = ensureTmpDir(this._configDir);
    // Re-bind spawn now that _tmpDir is resolved (closure captures the value, not the field).
    if (!options.spawn) {
      const tmpDir = this._tmpDir;
      this._spawn = (cmd, cwd) => {
        const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [cmd];
        const [bin, ...args] = parts;
        return nodeSpawn(bin!, args, {
          cwd: cwd ?? tmpDir,
          windowsHide: true,
          shell: true,
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

  async trigger(id: string, source: TriggerSource = { kind: 'manual' }): Promise<{ pid: number | null } | { exitCode: number }> {
    const job = this._registry.get(id);
    if (!job) throw new Error(`Job not found: "${id}"`);
    return this._fire(job, source);
  }

  private _scheduleCron(job: Job): void {
    if (!cron.validate(job.schedule ?? '')) return;
    const task = cron.schedule(job.schedule!, () => { void this._fire(job); });
    this._cronTasks.set(job.id, task);
  }

  private async _maybeSpawn(job: Job): Promise<void> {
    if (await this._liveness(job)) return;
    void this._fire(job);
  }

  private async _fire(job: Job, trigger: TriggerSource = { kind: 'cron' }): Promise<{ pid: number | null } | { exitCode: number }> {
    const startedAt = this._now().toISOString();
    const child = this._spawn(job.command, job.cwd ?? undefined);
    const pid   = child.pid ?? null;

    this._state.record(job.id, { startedAt, exitCode: null, pid, triggeredBy: trigger });

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

    const done = new Promise<{ exitCode: number }>((resolve) => {
      child.on('close', (code) => {
        const exitCode = code ?? 1;
        this._state.record(job.id, { startedAt, exitCode, pid, triggeredBy: trigger });
        jobLogger.close();
        this.emit('job-finished', { id: job.id, exitCode, job });
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
