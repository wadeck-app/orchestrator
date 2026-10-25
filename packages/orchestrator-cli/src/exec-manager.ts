import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DailyLogger } from './logger.js';
import { EventPublisher } from './event-publisher.js';
import { ensureTmpDir, getErrorMessage } from './fsUtil.js';
import { killTree, killTreeSync } from './process-tree.js';
import { jobEnvironment } from './job-env.js';
import { stripAnsi } from './ansi.js';
import { OutputLines } from './output-lines.js';
import { systemTime, type TimeService, type Timer } from './time-service.js';

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
  /** `jobsNoColor` in config.yml: an exec starts with NO_COLOR=1 and FORCE_COLOR=0 like a job (see job-env.ts). */
  private readonly _noColor: boolean;
  /** The clock and the timeout timer. Defaults to the real ones; a test drives its own (see time-service.ts). */
  private readonly _time: TimeService;
  /** How a command is started; a test replaces it with a scripted child. */
  private readonly _spawn: typeof nodeSpawn;
  constructor(configDir: string, events?: EventPublisher, options: { jobsNoColor?: boolean; time?: TimeService; spawn?: typeof nodeSpawn } = {}) {
    this._spawn = options.spawn ?? nodeSpawn;
    this._configDir = configDir;
    this._noColor = options.jobsNoColor ?? true;
    this._time = options.time ?? systemTime;
    this._events = events ?? new EventPublisher('orchestrator', undefined, { cwd: configDir });
  }

  /**
   * Drops finished runs past their TTL.
   *
   * Called when the map is read or written rather than from a timer. This used to be a
   * setInterval(60s) armed in the constructor, which ran for the daemon's whole life to sweep a map
   * that is empty unless someone ran `orch exec` - and orch's own purpose is to be the one thing on
   * the machine that owns timers, so spending one on a minute-by-minute sweep of usually nothing was
   * the wrong trade.
   *
   * Nothing observes an expired run except through this class, so pruning late is unobservable: an
   * entry now disappears on the first read after its TTL instead of within a minute of it. That is
   * the whole behavioural difference.
   */
  private _prune(): void {
    const now = this._time.now();
    for (const [id, run] of this._runs) {
      if (run.finishedAt && now - new Date(run.finishedAt).getTime() > run.ttlMs) {
        this._runs.delete(id);
        this._pids.delete(id);
      }
    }
  }

  fireExec(command: string, opts: ExecOptions = {}): { runId: string; pid: number | null; status: 'running' } {
    const runId = `exec-${this._time.now()}-${randomUUID().slice(0, 8)}`;
    const run: ExecRun = {
      runId,
      command,
      label: opts.label,
      cwd: opts.cwd,
      startedAt: new Date(this._time.now()).toISOString(),
      status: 'running',
      exitCode: null,
      pid: null,
      logs: [],
      ttlMs: 3_600_000,
    };
    // Pruned on the way in too, so a long-lived daemon that is never read cannot accumulate
    // finished runs indefinitely.
    this._prune();
    this._runs.set(runId, run);

    const tmpDir = ensureTmpDir(this._configDir, runId);
    const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [command];
    const [bin, ...args] = parts;
    const spawnEnv = jobEnvironment({ ...process.env, ...opts.env }, opts.env, this._noColor);

    const child = this._spawn(bin!, args, {
      cwd: opts.cwd ?? tmpDir,
      windowsHide: true,
      shell: true,
      env: spawnEnv ?? process.env,
    });

    run.pid = child.pid ?? null;
    this._pids.set(runId, child);

    const logger = new DailyLogger(
      path.join(this._configDir, 'logs', 'app'),
      runId,
    );

    // A program that ignores the environment and prints escape sequences anyway: they stay out of the run's lines
    // (what the dashboard and `orch exec` show) and out of the log file.
    // One per stream: a chunk can end inside an escape sequence or a multibyte character (see output-lines.ts).
    const stdoutLines = new OutputLines();
    const stderrLines = new OutputLines();
    const takeStdout = (raw: string[]): void => {
      for (const line of raw.map(stripAnsi).filter(l => l.trimEnd())) {
        const trimmed = line.trimEnd();
        run.logs.push(trimmed);
        if (run.logs.length > 1000) { run.logs.shift(); }
        logger.write(trimmed);
      }
    };
    const takeStderr = (raw: string[]): void => {
      for (const line of raw.map(stripAnsi).filter(l => l.trimEnd())) {
        const entry = `[stderr] ${line.trimEnd()}`;
        run.logs.push(entry);
        if (run.logs.length > 1000) { run.logs.shift(); }
        logger.write(entry);
      }
    };
    child.stdout?.on('data', (d: Buffer) => { takeStdout(stdoutLines.push(d)); });
    child.stderr?.on('data', (d: Buffer) => { takeStderr(stderrLines.push(d)); });
    // Same rule as for scheduled jobs: an 'error' with no listener (spawn failure, broken pipe) is fatal for the daemon.
    child.on('error', (err) => { takeStderr([`[error] the process reported an error: ${getErrorMessage(err)}`]); });
    child.stdout?.on('error', (err) => { takeStderr([`[warn] stdout pipe failed: ${getErrorMessage(err)}`]); });
    child.stderr?.on('error', (err) => { takeStderr([`[warn] stderr pipe failed: ${getErrorMessage(err)}`]); });

    const timeoutMs = (opts.timeout ?? 300) * 1000;
    let timeoutHandle: Timer | null = null;
    if (timeoutMs > 0) {
      timeoutHandle = this._time.after(timeoutMs, () => {
        if (run.status === 'running') {
          run.logs.push(`[warn] Exec ${runId} timed out after ${opts.timeout ?? 300}s - killing`);
          run.status = 'killed';
          void this._terminate(runId);
        }
      });
    }

    child.on('close', (code) => {
      takeStdout(stdoutLines.flush());
      takeStderr(stderrLines.flush());
      timeoutHandle?.cancel();
      const exitCode = code ?? 1;
      run.exitCode = exitCode;
      run.finishedAt = new Date(this._time.now()).toISOString();
      run.status = run.status === 'killed' ? 'killed' : exitCode === 0 ? 'done' : 'failed';
      logger.close();
      this._pids.delete(runId);
      this._events.publish(exitCode === 0 ? 'exec.completed' : 'exec.failed', {
        runId, command, label: opts.label, exitCode,
        durationMs: this._time.now() - new Date(run.startedAt).getTime(),
      });
    });

    this._events.publish('exec.started', { runId, command, label: opts.label, pid: run.pid });
    return { runId, pid: run.pid, status: 'running' };
  }

  get(runId: string): ExecRun | undefined {
    this._prune();
    return this._runs.get(runId);
  }

  list(): ExecRun[] {
    this._prune();
    return Array.from(this._runs.values());
  }

  kill(runId: string): boolean {
    const run = this._runs.get(runId);
    if (!run || run.status !== 'running') {
      return false;
    }
    run.status = 'killed';
    void this._terminate(runId);
    return true;
  }

  /**
   * Kills the whole process tree behind a run. Commands go through a shell, so the tracked
   * child is only the wrapper: signalling it left the real process running, which is what
   * leaked a node process per killed run.
   */
  private async _terminate(runId: string): Promise<void> {
    const child = this._pids.get(runId);
    const pid = child?.pid;
    if (pid === undefined) {
      return;
    }
    await killTree(pid);
  }

  /**
   * Kills anything still running. Returns once the trees are gone, so a caller that needs a clean
   * slate (daemon shutdown, a test teardown) can await it; callers that do not care may ignore the
   * promise.
   */
  async stop(): Promise<void> {
    const running = Array.from(this._runs.entries())
      .filter(([, run]) => run.status === 'running')
      .map(([runId]) => runId);
    await Promise.all(running.map((runId) => this._terminate(runId)));
  }

  /**
   * Teardown for callers that cannot await, such as a synchronous shutdown hook. Windows tears
   * the trees down inline; on POSIX the kill is started and not awaited, which is all a sync
   * caller can offer. Prefer stop() wherever a promise can be awaited.
   *
   * Without this, the daemon's shutdown hook dropped stop()'s promise and exited first, leaking
   * the very trees this class was changed to reap.
   */
  stopSync(): void {
    for (const [runId, run] of this._runs) {
      if (run.status !== 'running') {
        continue;
      }
      const pid = this._pids.get(runId)?.pid;
      if (pid !== undefined) {
        killTreeSync(pid);
      }
    }
  }
}
