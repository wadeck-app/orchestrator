import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { spawn } from 'node:child_process';
import { LIVENESS_COMMAND_TIMEOUT_SECONDS } from './types.js';
import type { Job } from './types.js';
import { systemTime, type TimeService } from './time-service.js';
import { killTree } from './process-tree.js';

export { LIVENESS_COMMAND_TIMEOUT_SECONDS };

/** A started liveness command: `result` is true for exit 0, false for anything else; `kill` ends it and its children. */
export interface RunningCommand {
  result: Promise<boolean>;
  kill:   () => void;
}

export interface LivenessDeps {
  /** Default: the real clock. */
  time?:  TimeService;
  /** Default: a shell command. Injectable so a test decides when the command ends. */
  start?: (command: string) => RunningCommand;
  /** Where the timeout is said (default: nowhere; the scheduler passes its log). */
  warn?:  (message: string) => void;
}

/**
 * Runs `command` in a shell and keeps no output: with no pipe there is nothing a child of the shell could hold open
 * after the shell is gone, which would leave the answer pending. `kill` ends the whole tree, the shell being only a wrapper.
 */
export function startShellCommand(command: string): RunningCommand {
  const child = spawn(command, { shell: true, windowsHide: true, stdio: 'ignore' });
  const result = new Promise<boolean>((resolve) => {
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
  return { result, kill: () => { if (child.pid !== undefined) { void killTree(child.pid); } } };
}

function expandTilde(p: string): string {
  // violations-suppress: shared/no-out-of-repo-path expanding a user's own `~/` is this function's entire purpose
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function orchConfigDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  return process.env['ORCH_CONFIG_DIR']
    // violations-suppress: shared/no-out-of-repo-path the documented config dir; ORCH_CONFIG_DIR and XDG_CONFIG_HOME both take precedence
    ?? (xdg ? path.join(xdg, 'orchestrator') : path.join(os.homedir(), '.config', 'orchestrator'));
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPidFromPortFile(filePath: string): number | null {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { pid?: unknown };
  return typeof data.pid === 'number' ? data.pid : null;
}

async function checkPortFile(portFile: string): Promise<boolean> {
  try {
    const pid = readPidFromPortFile(expandTilde(portFile));
    return pid !== null && isPidAlive(pid);
  } catch { return false; }
}

async function checkPidFile(jobId: string): Promise<boolean> {
  try {
    const raw = fs.readFileSync(path.join(orchConfigDir(), 'pids', `${jobId}.pid`), 'utf8').trim();
    const pid = parseInt(raw, 10);
    return Number.isFinite(pid) && isPidAlive(pid);
  } catch { return false; }
}

/**
 * A command that does not end in time is killed and the target counts as NOT alive, so the job starts: the check could
 * not say "alive", and holding the job back for good on a hung check is the worse failure. Said in the log, with the fix.
 */
async function checkCommand(jobId: string, command: string, timeoutSeconds: number, deps: LivenessDeps): Promise<boolean> {
  const time  = deps.time  ?? systemTime;
  const start = deps.start ?? startShellCommand;
  const warn  = deps.warn  ?? (() => { /* said nowhere unless the caller passes a log */ });
  return new Promise((resolve) => {
    let run: RunningCommand;
    try {
      run = start(command);
    } catch {
      resolve(false);
      return;
    }
    const timer = time.after(timeoutSeconds * 1000, () => {
      warn(`the liveness command of "${jobId}" did not end within ${timeoutSeconds} s, so it was killed and the target is treated as not alive (the job starts). `
        + `If the check is just slow, raise it: orch edit ${jobId} --liveness-strategy command --liveness-command "<cmd>" --liveness-timeout <seconds>`);
      run.kill();
      resolve(false);
    });
    run.result.then(
      (alive) => { timer.cancel(); resolve(alive); },
      () => { timer.cancel(); resolve(false); },
    );
  });
}

export async function checkLiveness(job: Pick<Job, 'id' | 'liveness'>, deps: LivenessDeps = {}): Promise<boolean> {
  try {
    const liveness = job.liveness;
    if (!liveness || liveness.strategy === 'none') {
      return false;
    }
    switch (liveness.strategy) {
      case 'portFile': return await checkPortFile(liveness.portFile ?? '');
      case 'pidFile':  return await checkPidFile(job.id);
      case 'command':  return await checkCommand(job.id, liveness.command ?? '', liveness.timeoutSeconds ?? LIVENESS_COMMAND_TIMEOUT_SECONDS, deps);
      default:         return false;
    }
  } catch { return false; }
}
