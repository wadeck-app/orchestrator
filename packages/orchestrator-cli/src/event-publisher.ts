import path from 'node:path';
import { createQueuePublisher } from '@wadeck-app/queue-sdk';
import type { QueuePublisher } from '@wadeck-app/queue-sdk';
import { getErrorMessage } from './fsUtil.js';

interface LogSink { write(line: string): void }

export interface EventPublisherOptions {
  /** Project the events belong to when they are not about a job: the queue walks up from it to find `.queue/subscribers.yml`. */
  cwd?: string;
  /** The cwd of a job, by id. An event whose payload has a `jobId` with an absolute cwd is sent with it, so that project's subscribers match. */
  jobCwd?: (jobId: string) => string | null | undefined;
}

/**
 * Pushes orchestrator events to the queue daemon through `@wadeck-app/queue-sdk`, which owns the transport: finding the
 * daemon, the token, starting it with `queue start` when it stopped itself, retries and protocol checks.
 *
 * What orchestrator decides here: the `cwd` of each event, and the log. Fire and forget: `publish` never throws and never
 * waits. A failure is logged once per streak (cause and what to do come from the SDK), and once more when delivery works again.
 */
export class EventPublisher {
  private readonly _cwd: string | undefined;
  private readonly _jobCwd: ((jobId: string) => string | null | undefined) | undefined;
  private _queue: QueuePublisher | null = null;
  private _failing = false;

  constructor(private readonly _projectName = 'orchestrator', private readonly _logger?: LogSink, options: EventPublisherOptions = {}) {
    this._cwd = options.cwd;
    this._jobCwd = options.jobCwd;
  }

  publish(event: string, payload: Record<string, unknown>): void {
    try {
      const cwd = this._resolveCwd(payload);
      this._publisher().publishAndWait(event, payload, { cwd }).then(
        (result) => {
          if (result.status === 'queued' || result.status === 'dispatched') {
            this._recovered(event);
          }
          // 'dropped' and 'unknown' already went through onError, which logged them.
        },
        (err: unknown) => this._failed(`Failed to publish "${event}" to the queue: ${getErrorMessage(err)}`),
      );
    } catch (err) {
      this._failed(`Failed to publish "${event}" to the queue: ${getErrorMessage(err)}`);
    }
  }

  /** Waits for the pushes in flight, at most `timeoutMs` (a hanging queue must not hold the daemon back). */
  async flush(timeoutMs: number): Promise<void> {
    if (this._queue === null) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try {
      await Promise.race([this._queue.flush(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Built at the first event, not at construction: the SDK reads QUEUE_CONFIG_DIR and PATH then.
  private _publisher(): QueuePublisher {
    this._queue ??= createQueuePublisher({
      cwd: this._cwd,
      // The log below is the one place a failure is reported.
      silent: true,
      onError: (failure) => this._failed(`Failed to publish "${failure.event}" to the queue (${failure.kind}, ${failure.outcome}): ${failure.message}`),
    });
    return this._queue;
  }

  private _resolveCwd(payload: Record<string, unknown>): string {
    const jobId = payload['jobId'];
    if (typeof jobId === 'string' && this._jobCwd !== undefined) {
      const jobCwd = this._jobCwd(jobId);
      // A relative job cwd means nothing to the queue daemon (its own cwd is elsewhere): the default is used instead.
      if (typeof jobCwd === 'string' && path.isAbsolute(jobCwd)) {
        return jobCwd.replace(/\\/g, '/');
      }
    }
    if (this._cwd === undefined || !path.isAbsolute(this._cwd)) {
      throw new Error(
        `no absolute cwd to send (got ${JSON.stringify(this._cwd)}): the queue needs one to find the project's subscribers. `
        + 'This is a bug in how the publisher was built; report it.',
      );
    }
    return this._cwd.replace(/\\/g, '/');
  }

  private _failed(message: string): void {
    if (this._failing) {
      return;
    }
    this._failing = true;
    this._logger?.write(`[event-publisher] ${message} (further failures are not logged until one event is delivered)`);
  }

  private _recovered(event: string): void {
    if (!this._failing) {
      return;
    }
    this._failing = false;
    this._logger?.write(`[event-publisher] Queue delivery recovered: "${event}" was accepted.`);
  }
}
