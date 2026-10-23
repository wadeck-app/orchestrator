import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getErrorMessage } from './fsUtil.js';

interface LogSink { write(line: string): void }

export interface EventPublisherOptions {
  /** The queue daemon's config dir (config.port, health_token). Default: $QUEUE_CONFIG_DIR, then ~/.config/queue like queue. */
  queueConfigDir?: string;
  /** Project the events belong to when they are not about a job: the queue walks up from it to find `.queue/subscribers.yml`. */
  cwd?: string;
  /** The cwd of a job, by id. An event whose payload has a `jobId` with a (absolute) cwd is sent with it, so that project's subscribers match. */
  jobCwd?: (jobId: string) => string | null | undefined;
}

const REQUEST_TIMEOUT_MS = 2000;
const TOKEN_CACHE_MS = 5000;
const BODY_EXCERPT = 300;

/** Why a publish failed, already worded for the log: the cause, then what to do. */
class PublishFailure extends Error {}

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

  constructor(private readonly _projectName = 'orchestrator', private readonly _logger?: LogSink, options: EventPublisherOptions = {}) {
    this._queueConfigDir = options.queueConfigDir;
    this._cwd = options.cwd;
    this._jobCwd = options.jobCwd;
  }

  publish(event: string, payload: Record<string, unknown>): void {
    this._deliver(event, payload).then(
      () => this._recovered(event),
      (err: unknown) => this._failed(event, err),
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
        + 'It stops itself when idle: run `queue start` (or `queue status`) and the next event will be delivered. This event is lost.',
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
    const port = this._readPort();
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
      throw new PublishFailure(
        `cannot reach the queue daemon at 127.0.0.1:${port} (${getErrorMessage(err)}). Is it running? Run \`queue status\`.`,
      );
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
