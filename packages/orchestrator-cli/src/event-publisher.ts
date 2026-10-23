import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getErrorMessage } from './fsUtil.js';

interface LogSink { write(line: string): void }

export interface FallbackLimits {
  /** Minimum time between two `queue push` spawns. */
  intervalMs: number;
  maxConcurrent: number;
  /** Events waiting for a spawn; beyond it the oldest are dropped. */
  bufferSize: number;
  /** A `queue push` still running after this is killed. */
  timeoutMs: number;
}

const DEFAULT_FALLBACK: FallbackLimits = { intervalMs: 1000, maxConcurrent: 4, bufferSize: 50, timeoutMs: 15_000 };
// Windows allows about 32 K characters on a command line, some launch paths about 8 K: stay under the smaller one.
const MAX_ARGV_PAYLOAD = 6000;

interface CliCommand { command: string; args: string[] }

interface FallbackItem {
  event: string;
  json: string;
  cwd: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface EventPublisherOptions {
  /** The queue daemon's config dir (config.port, health_token). Default: $QUEUE_CONFIG_DIR, then ~/.config/queue like queue. */
  queueConfigDir?: string;
  /** Project the events belong to when they are not about a job: the queue walks up from it to find `.queue/subscribers.yml`. */
  cwd?: string;
  /** The cwd of a job, by id. An event whose payload has a `jobId` with a (absolute) cwd is sent with it, so that project's subscribers match. */
  jobCwd?: (jobId: string) => string | null | undefined;
  /** Limits of the `queue push` fallback (tests). */
  fallback?: Partial<FallbackLimits>;
}

const REQUEST_TIMEOUT_MS = 2000;
const TOKEN_CACHE_MS = 5000;
const BODY_EXCERPT = 300;

/** Why a publish failed, already worded for the log: the cause, then what to do. */
class PublishFailure extends Error {
  /** The queue daemon is down (no config.port, connection refused): only the queue CLI can wake it. */
  constructor(message: string, readonly daemonDown = false) { super(message); }
}

/** An event pushed out of the fallback buffer: already counted in the single "dropped" line, not a failure of its own. */
class DroppedEvent extends Error {}

/**
 * Where the `queue` CLI is, as a command that can be spawned without a shell. Node refuses to spawn a .cmd shim
 * without one (EINVAL), so on Windows the npm shim is read for the script it runs and `node <script>` is spawned.
 * Null when `queue` is not on PATH (or is a shim this does not understand), or when ORCH_QUEUE_CLI=off.
 */
function resolveQueueCli(): CliCommand | null {
  if (process.env['ORCH_QUEUE_CLI'] === 'off') {
    return null;
  }
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    if (process.platform === 'win32') {
      const shim = path.join(dir, 'queue.cmd');
      if (!fs.existsSync(shim)) {
        continue;
      }
      const match = /"%dp0%\\([^"]+?\.js)"/i.exec(fs.readFileSync(shim, 'utf8'));
      const script = match?.[1] === undefined ? null : path.join(dir, match[1]);
      if (script !== null && fs.existsSync(script)) {
        return { command: process.execPath, args: [script] };
      }
    } else {
      const bin = path.join(dir, 'queue');
      if (fs.existsSync(bin)) {
        return { command: bin, args: [] };
      }
    }
  }
  return null;
}

/** Same resolution as queue's getQueueConfigDir(). */
function defaultQueueConfigDir(): string {
  const explicit = process.env['QUEUE_CONFIG_DIR'];
  if (explicit) {
    return explicit;
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  // violations-suppress: shared/no-out-of-repo-path the queue daemon's documented config dir, resolved exactly as queue does
  return xdg ? path.join(xdg, 'queue') : path.join(os.homedir(), '.config', 'queue');
}

/**
 * Pushes orchestrator events to the queue daemon (`POST /push`).
 *
 * The daemon's contract: it listens on 127.0.0.1 only, on the port in `<queueConfigDir>/config.port`; the request
 * needs `Authorization: Bearer <contents of health_token>` (rewritten at each daemon start) and a `cwd` in the body.
 * Anything else is answered 401 or 500, which `fetch` resolves rather than rejects: so every non-2xx is checked.
 *
 * Fire and forget: never throws, never blocks a job. A failure is logged once per streak with the cause and what to
 * do, and once more when delivery works again.
 */
export class EventPublisher {
  private readonly _queueConfigDir: string | undefined;
  private readonly _cwd: string | undefined;
  private readonly _jobCwd: ((jobId: string) => string | null | undefined) | undefined;
  private _token: { value: string; at: number } | null = null;
  private _failing = false;
  private readonly _limits: FallbackLimits;
  private _cli: CliCommand | null = null;
  private readonly _buffer: FallbackItem[] = [];
  private _running = 0;
  private _lastSpawnAt = 0;
  private _pumpTimer: NodeJS.Timeout | null = null;
  private _dropped = 0;
  private _dropReportScheduled = false;

  constructor(private readonly _projectName = 'orchestrator', private readonly _logger?: LogSink, options: EventPublisherOptions = {}) {
    this._queueConfigDir = options.queueConfigDir;
    this._cwd = options.cwd;
    this._jobCwd = options.jobCwd;
    this._limits = { ...DEFAULT_FALLBACK, ...options.fallback };
  }

  publish(event: string, payload: Record<string, unknown>): void {
    this._deliver(event, payload).then(
      () => this._recovered(event),
      (err: unknown) => {
        if (!(err instanceof DroppedEvent)) {
          this._failed(event, err);
        }
      },
    );
  }

  private get _dir(): string {
    return this._queueConfigDir ?? defaultQueueConfigDir();
  }

  private _resolveCwd(payload: Record<string, unknown>): string {
    const jobId = payload['jobId'];
    let cwd: string | null | undefined;
    if (typeof jobId === 'string' && this._jobCwd !== undefined) {
      const jobCwd = this._jobCwd(jobId);
      // A relative job cwd means nothing to the queue daemon (its own cwd is elsewhere): the default is used instead.
      if (typeof jobCwd === 'string' && path.isAbsolute(jobCwd)) {
        cwd = jobCwd;
      }
    }
    cwd ??= this._cwd;
    if (cwd === undefined || !path.isAbsolute(cwd)) {
      throw new PublishFailure(
        `no absolute cwd to send (got ${JSON.stringify(cwd)}): the queue needs one to find the project's subscribers. `
        + 'This is a bug in how the publisher was built; report it.',
      );
    }
    return cwd.replace(/\\/g, '/');
  }

  private _readPort(): number {
    const file = path.join(this._dir, 'config.port');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new PublishFailure(
        `the queue daemon is not running (cannot read ${file}: ${getErrorMessage(err)}). `
        + 'It stops itself when idle: run `queue start` (or `queue status`) and the next event will be delivered.',
        true,
      );
    }
    try {
      const port = (JSON.parse(raw) as { port?: unknown }).port;
      if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
        return port;
      }
    } catch { /* reported below */ }
    throw new PublishFailure(`${file} does not hold a port (${raw.slice(0, 80)}). Run \`queue stop\` then \`queue start\`.`);
  }

  private _readToken(fresh: boolean): string {
    if (!fresh && this._token !== null && Date.now() - this._token.at < TOKEN_CACHE_MS) {
      return this._token.value;
    }
    const file = path.join(this._dir, 'health_token');
    let value: string;
    try {
      value = fs.readFileSync(file, 'utf8').trim();
    } catch (err) {
      this._token = null;
      throw new PublishFailure(
        `cannot read the queue token ${file} (${getErrorMessage(err)}): queue is not installed, or its daemon never started. `
        + 'Run `queue start` / `queue status`; set QUEUE_CONFIG_DIR if queue uses another config dir.',
      );
    }
    this._token = { value, at: Date.now() };
    return value;
  }

  private async _post(port: number, token: string, event: string, payload: Record<string, unknown>, cwd: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ event, payload, cwd }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async _deliver(event: string, payload: Record<string, unknown>): Promise<void> {
    const cwd = this._resolveCwd(payload);
    let port: number;
    try {
      port = this._readPort();
    } catch (err) {
      if (err instanceof PublishFailure && err.daemonDown) {
        return this._viaCli(event, payload, cwd, err);
      }
      throw err;
    }
    let res: Response;
    try {
      res = await this._post(port, this._readToken(false), event, payload, cwd);
      if (res.status === 401) {
        // The daemon rewrites health_token at each start: the cached one may be stale.
        res = await this._post(port, this._readToken(true), event, payload, cwd);
      }
    } catch (err) {
      if (err instanceof PublishFailure) {
        throw err;
      }
      const unreachable = new PublishFailure(
        `cannot reach the queue daemon at 127.0.0.1:${port} (${getErrorMessage(err)}). Is it running? Run \`queue status\`.`,
        (err as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED',
      );
      if (unreachable.daemonDown) {
        return this._viaCli(event, payload, cwd, unreachable);
      }
      throw unreachable;
    }
    if (res.ok) {
      return;
    }
    const body = (await res.text().catch(() => '')).slice(0, BODY_EXCERPT);
    if (res.status === 401) {
      throw new PublishFailure(
        `queue answered 401: the token in ${path.join(this._dir, 'health_token')} was not accepted. `
        + 'Is it the daemon of that config dir (QUEUE_CONFIG_DIR)? Run `queue status`.',
      );
    }
    throw new PublishFailure(`queue answered ${res.status} ${body}. Run \`queue status\`; \`queue logs\` has the daemon's side.`);
  }

  /**
   * The queue daemon is down and only the `queue` CLI starts it: `queue push` wakes it, then pushes. Resolves when
   * the CLI accepted the event. Spawns are bounded (concurrency, rate, buffer): events come in bursts.
   */
  private _viaCli(event: string, payload: Record<string, unknown>, cwd: string, down: PublishFailure): Promise<void> {
    this._cli ??= resolveQueueCli();
    if (this._cli === null) {
      return Promise.reject(new PublishFailure(
        'queue daemon not running and the queue CLI was not found on PATH: events are lost; install queue or start its daemon '
        + `(${down.message})`,
      ));
    }
    const json = JSON.stringify(payload);
    if (json.length > MAX_ARGV_PAYLOAD) {
      return Promise.reject(new PublishFailure(
        `the queue daemon is not running and the payload of "${event}" is too long for a command line `
        + `(${json.length} characters, limit ${MAX_ARGV_PAYLOAD}): the event is lost. Run \`queue start\` so events go through HTTP.`,
      ));
    }
    return new Promise<void>((resolve, reject) => {
      this._buffer.push({ event, json, cwd, resolve, reject });
      while (this._buffer.length > this._limits.bufferSize) {
        this._buffer.shift()?.reject(new DroppedEvent());
        this._dropped++;
      }
      this._scheduleDropReport();
      this._pump();
    });
  }

  private _scheduleDropReport(): void {
    if (this._dropped === 0 || this._dropReportScheduled) {
      return;
    }
    this._dropReportScheduled = true;
    // After the burst: one line for all of it.
    setImmediate(() => {
      this._dropReportScheduled = false;
      const n = this._dropped;
      this._dropped = 0;
      if (n > 0) {
        this._logger?.write(
          `[event-publisher] The queue daemon is not running and \`queue push\` is limited to ${this._limits.maxConcurrent} at once, `
          + `one per ${this._limits.intervalMs} ms: dropped ${n} event(s), the ${this._limits.bufferSize} newest are kept. Run \`queue start\`.`,
        );
      }
    });
  }

  private _pump(): void {
    if (this._buffer.length === 0 || this._running >= this._limits.maxConcurrent || this._pumpTimer !== null) {
      return;
    }
    const wait = this._lastSpawnAt + this._limits.intervalMs - Date.now();
    if (wait > 0) {
      this._pumpTimer = setTimeout(() => { this._pumpTimer = null; this._pump(); }, wait);
      this._pumpTimer.unref();
      return;
    }
    const item = this._buffer.shift();
    const cli = this._cli;
    if (item === undefined || cli === null) {
      return;
    }
    this._lastSpawnAt = Date.now();
    this._running++;
    this._spawnCli(cli, item).then(item.resolve, (err: unknown) => {
      // The next failure looks for the CLI again.
      this._cli = null;
      item.reject(err instanceof Error ? err : new Error(getErrorMessage(err)));
    }).finally(() => {
      this._running--;
      this._pump();
    });
    this._pump();
  }

  private _spawnCli(cli: CliCommand, item: FallbackItem): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const label = `\`queue push ${item.event}\``;
      // Argv array, no shell, hidden window, detached and unref'd: the daemon never waits on it.
      const child = spawn(cli.command, [...cli.args, 'push', item.event, item.json], {
        cwd: item.cwd, detached: true, stdio: 'ignore', windowsHide: true, shell: false,
      });
      child.unref();
      const timer = setTimeout(() => {
        child.kill();
        reject(new PublishFailure(`${label} did not finish within ${this._limits.timeoutMs / 1000}s and was killed. Run \`queue status\`.`));
      }, this._limits.timeoutMs);
      timer.unref();
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new PublishFailure(`could not run ${label} in ${item.cwd}: ${getErrorMessage(err)}. Is the queue CLI installed and the folder present?`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          reject(new PublishFailure(`${label} exited with code ${code}. Run it by hand in ${item.cwd} to see why.`));
        }
      });
    });
  }

  private _failed(event: string, err: unknown): void {
    if (this._failing) {
      return;
    }
    this._failing = true;
    const reason = getErrorMessage(err);
    this._logger?.write(
      `[event-publisher] Failed to publish "${event}" to the queue: ${reason} `
      + '(further failures are not logged until one event is delivered)',
    );
  }

  private _recovered(event: string): void {
    if (!this._failing) {
      return;
    }
    this._failing = false;
    this._logger?.write(`[event-publisher] Queue delivery recovered: "${event}" was accepted.`);
  }
}
