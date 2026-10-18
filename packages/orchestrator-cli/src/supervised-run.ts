import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runLogPath } from './logger.js';
import { getErrorMessage } from './fsUtil.js';
import type { TriggerSource } from './types.js';

/*
 * A job run under orchestrator-supervisor (supervisor-go): a small detached process that runs the job, owns its
 * output and records how it ended, so the daemon can stop, update and start again without touching the job.
 *
 * The daemon and the supervisor share files and nothing else (the contract is documented in
 * supervisor-go/run.go): spec.json goes in, status.json / heartbeat come out, a `kill` file asks for the end.
 */

const DEFAULT_HEARTBEAT_MS = 2000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
/**
 * How much later than the daemon's own timeout the supervisor enforces the same limit. The daemon normally acts
 * first, at the right moment, with its event and its peaks flush; the supervisor's deadline only matters when the
 * daemon is gone.
 */
const DEFAULT_TIMEOUT_MARGIN_SECONDS = 15;

export interface SupervisorOptions {
  /** The supervisor executable to start (staged out of node_modules, see platform-binary.ts). */
  supervisorPath: string;
  configDir: string;
  heartbeatMs?: number;
  /** How often status.json is read while the job runs. */
  pollMs?: number;
  /** How long to wait for the supervisor to report that the job started. */
  startupTimeoutMs?: number;
  timeoutMarginSeconds?: number;
}

export interface SupervisedRequest {
  jobId: string;
  /** ISO start time of the run: names the run folder and the run log. */
  startedAt: string;
  command: string;
  cwd: string;
  /** Reaches the job through the supervisor's own environment: it is never written to disk. */
  env: NodeJS.ProcessEnv;
  /** The job's timeout; 0 means none. */
  timeoutSeconds: number;
  label?: string;
  trigger: TriggerSource;
}

/** status.json, as written by the supervisor. */
interface SupervisorStatus {
  state: 'running' | 'exited' | 'failed-to-start';
  supervisorPid: number;
  childPid?: number;
  exitCode?: number;
  signal?: string;
  killed?: boolean;
  killReason?: string;
  timedOut?: boolean;
  error?: string;
}

/**
 * The scheduler's view of a supervised job: a ChildProcess whose `pid` is the job itself (so the sampler, the
 * state record and the tree kill work unchanged) and which closes when the supervisor says the job ended.
 */
export class SupervisedChild extends ChildProcess {
  readonly runDir: string;
  /** Why the job could not be started, when it could not. */
  startError?: string;
  private _killRequested = false;
  private _watcher: NodeJS.Timeout | null = null;

  constructor(runDir: string, rootPid: number | undefined) {
    super();
    this.runDir = runDir;
    Object.defineProperty(this, 'pid', { value: rootPid, writable: true, configurable: true });
    Object.defineProperty(this, 'killed', { get: () => this._killRequested, configurable: true });
  }

  /**
   * Asks the supervisor to end the job's whole tree, and says why. The daemon also ends the tree itself when it
   * is alive, so this file is what makes the kill happen, and be explained, when it is not.
   */
  requestKill(reason: string): void {
    this._killRequested = true;
    try {
      fs.writeFileSync(path.join(this.runDir, 'kill'), reason);
    } catch {
      // The run folder is gone: the run is already over and finalized.
    }
  }

  override kill(): boolean {
    this.requestKill('unspecified');
    return true;
  }

  /** Reads status.json until the job has ended, then closes like a child process would. */
  watch(pollMs: number): void {
    this._watcher = setInterval(() => {
      const status = readStatus(this.runDir);
      if (status === null || status.state === 'running') {
        return;
      }
      this.stopWatching();
      this._close(status);
    }, pollMs);
    // A job that outlives the daemon is the point: this timer must never be what keeps the daemon alive.
    this._watcher.unref();
  }

  /** Leaves the job running and stops reporting on it, for a daemon that is shutting down. */
  stopWatching(): void {
    if (this._watcher !== null) {
      clearInterval(this._watcher);
      this._watcher = null;
    }
  }

  /** Closes the child the way a spawned one closes, for a run whose end was already recorded. */
  closeWith(status: Pick<SupervisorStatus, 'exitCode' | 'signal'>): void {
    this._close(status);
  }

  private _close(status: Pick<SupervisorStatus, 'exitCode' | 'signal'>): void {
    const code = status.exitCode ?? null;
    const signal = (status.signal ?? null) as NodeJS.Signals | null;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function readStatus(runDir: string): SupervisorStatus | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8')) as SupervisorStatus;
  } catch {
    // Not written yet, or caught between the supervisor's write and its rename: the next read will do.
    return null;
  }
}

/** The run folder of a run: <configDir>/runs/<jobId>/<startedAt, colons replaced, milliseconds kept>. */
export function runDirFor(configDir: string, jobId: string, startedAt: string): string {
  return path.join(configDir, 'runs', jobId, startedAt.replace(/:/g, '-'));
}

/**
 * Starts the job under a supervisor and returns once the supervisor reports that the job is running (or that it
 * could not start it).
 */
export async function startSupervised(options: SupervisorOptions, request: SupervisedRequest): Promise<SupervisedChild> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const runDir = runDirFor(options.configDir, request.jobId, request.startedAt);
  const logDir = path.join(options.configDir, 'logs', 'jobs', request.jobId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const margin = options.timeoutMarginSeconds ?? DEFAULT_TIMEOUT_MARGIN_SECONDS;
  const spec = {
    command: request.command,
    cwd: request.cwd,
    logPath: runLogPath(logDir, request.jobId, request.startedAt),
    timeoutSeconds: request.timeoutSeconds > 0 ? request.timeoutSeconds + margin : 0,
    heartbeatMs,
    // What a finished run needs to be understood by whoever finds it, even if the job was edited or deleted since.
    context: { jobId: request.jobId, label: request.label, trigger: request.trigger },
  };
  fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(spec));

  const supervisor = nodeSpawn(options.supervisorPath, [runDir], {
    // Detached is what lets it outlive the daemon, and on Windows what lets it leave the launcher's Job Object.
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: runDir,
    env: request.env,
  });
  let spawnError: string | null = null;
  supervisor.once('error', (err) => { spawnError = getErrorMessage(err); });
  supervisor.unref();

  const status = await waitForReport(runDir, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, () => spawnError);
  const child = new SupervisedChild(runDir, status.childPid);
  if (status.state === 'failed-to-start') {
    child.startError = status.error ?? 'the supervisor reported that it could not start the job';
    // Closed on the next tick, after the scheduler has attached its listeners.
    setImmediate(() => child.closeWith({ exitCode: 1 }));
    return child;
  }
  // A job already over when we first looked is closed by this same watcher, on its first read.
  child.watch(options.pollMs ?? DEFAULT_POLL_MS);
  return child;
}

async function waitForReport(runDir: string, timeoutMs: number, spawnError: () => string | null): Promise<SupervisorStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readStatus(runDir);
    if (status !== null) {
      return status;
    }
    const failure = spawnError();
    if (failure !== null) {
      throw new Error(`Could not start the job supervisor: ${failure}. It is staged from the platform package; reinstall with: orch cli update`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `The job supervisor did not report within ${timeoutMs} ms: ${path.join(runDir, 'status.json')} was never written. `
    + `Look at ${runDir} for spec.json, and check that the supervisor executable runs (an antivirus scanning a freshly copied executable can delay it).`,
  );
}

export type SupervisorLauncher = (request: SupervisedRequest) => Promise<SupervisedChild>;

export interface SupervisorSetup {
  /** `supervisedJobs` in config.yml. */
  enabled: boolean;
  configDir: string;
  /** Finds the supervisor executable and stages it out of node_modules (platform-binary.ts supervisorToRun). */
  locate: (configDir: string) => string | null;
  log: (line: string) => void;
}

/**
 * Decides, once at daemon start, whether jobs run under a supervisor. Asking for it and not getting it is logged
 * as a warning that names the consequence: jobs run unsupervised, so a restart will still stop them.
 */
export function supervisorFor(setup: SupervisorSetup): SupervisorLauncher | undefined {
  if (!setup.enabled) {
    return undefined;
  }
  let supervisorPath: string | null;
  try {
    supervisorPath = setup.locate(setup.configDir);
  } catch (err) {
    setup.log(`supervisedJobs: true, but the supervisor cannot be prepared (${getErrorMessage(err)}). Jobs run unsupervised and will not survive a daemon restart. Reinstall with: orch cli update`);
    return undefined;
  }
  if (supervisorPath === null) {
    setup.log(`supervisedJobs: true, but there is no supervisor executable for ${process.platform}-${process.arch}. Jobs run unsupervised and will not survive a daemon restart. Set supervisedJobs: false to silence this.`);
    return undefined;
  }
  setup.log(`supervisedJobs is on: jobs run under ${supervisorPath}`);
  return (request) => startSupervised({ supervisorPath, configDir: setup.configDir }, request);
}
