import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DailyLogger } from './logger.js';
import { EventPublisher } from './event-publisher.js';
import { ensureTmpDir } from './fsUtil.js';

export interface ExecRun {
  runId: string;
  command: string;
  label?: string;
  cwd?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'done' | 'failed' | 'killed';
  exitCode: number | null;
  pid: number | null;
  logs: string[];
  ttlMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  label?: string;
}

export class ExecManager {
  private readonly _runs = new Map<string, ExecRun>();
  private readonly _pids = new Map<string, import('node:child_process').ChildProcess>();
  private readonly _configDir: string;
  private readonly _events: EventPublisher;
  private readonly _cleanupTimer: ReturnType<typeof setInterval>;

  constructor(configDir: string, events?: EventPublisher) {
    this._configDir = configDir;
    this._events = events ?? new EventPublisher();
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, run] of this._runs) {
        if (run.finishedAt && now - new Date(run.finishedAt).getTime() > run.ttlMs) {
          this._runs.delete(id);
          this._pids.delete(id);
        }
      }
    }, 60_000);
  }

  fireExec(command: string, opts: ExecOptions = {}): { runId: string; pid: number | null; status: 'running' } {
    const runId = `exec-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const run: ExecRun = {
      runId,
      command,
      label: opts.label,
      cwd: opts.cwd,
      startedAt: new Date().toISOString(),
      status: 'running',
      exitCode: null,
      pid: null,
      logs: [],
      ttlMs: 3_600_000,
    };
    this._runs.set(runId, run);

    const tmpDir = ensureTmpDir(this._configDir);
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [command];
    const [bin, ...args] = parts;
    const spawnEnv = opts.env ? { ...process.env, ...opts.env } : undefined;

    const child = nodeSpawn(bin!, args, {
      cwd: opts.cwd ?? tmpDir,
      windowsHide: true,
      shell: true,
      env: spawnEnv ?? process.env,
    });

    run.pid = child.pid ?? null;
    this._pids.set(runId, child);

    const logger = new DailyLogger(
      path.join(this._configDir, 'logs', 'exec'),
      runId,
    );

    child.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trimEnd();
      run.logs.push(line);
      if (run.logs.length > 1000) run.logs.shift();
      logger.write(line);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const line = `[stderr] ${d.toString().trimEnd()}`;
      run.logs.push(line);
      if (run.logs.length > 1000) run.logs.shift();
      logger.write(line);
    });

    const timeoutMs = (opts.timeout ?? 300) * 1000;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        if (run.status === 'running') {
          run.logs.push(`[warn] Exec ${runId} timed out after ${opts.timeout ?? 300}s - killing`);
          child.kill('SIGTERM');
          setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
        }
      }, timeoutMs);
    }

    child.on('close', (code) => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      const exitCode = code ?? 1;
      run.exitCode = exitCode;
      run.finishedAt = new Date().toISOString();
      run.status = run.status === 'killed' ? 'killed' : exitCode === 0 ? 'done' : 'failed';
      logger.close();
      this._pids.delete(runId);
      this._events.publish(exitCode === 0 ? 'exec.completed' : 'exec.failed', {
        runId, command, label: opts.label, exitCode,
        durationMs: Date.now() - new Date(run.startedAt).getTime(),
      });
    });

    this._events.publish('exec.started', { runId, command, label: opts.label, pid: run.pid });
    return { runId, pid: run.pid, status: 'running' };
  }

  get(runId: string): ExecRun | undefined { return this._runs.get(runId); }
  list(): ExecRun[] { return Array.from(this._runs.values()); }

  kill(runId: string): boolean {
    const run = this._runs.get(runId);
    if (!run || run.status !== 'running') return false;
    run.status = 'killed';
    const child = this._pids.get(runId);
    if (child && !child.killed) {
      child.kill('SIGTERM');
      setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 2000);
    }
    return true;
  }

  stop(): void { clearInterval(this._cleanupTimer); }
}
