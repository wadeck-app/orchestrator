import path from 'node:path';
import { createQueuePublisher } from '@wadeck-app/queue-sdk';
import type { EventDeclaration, QueuePublisher, RegisterResult } from '@wadeck-app/queue-sdk';
import { getErrorMessage } from './fsUtil.js';

interface LogSink { write(line: string): void }

export interface EventPublisherOptions {
  /** Project the events belong to when they are not about a job: the queue walks up from it to find `.queue/subscribers.yml`. */
  cwd?: string;
  /** The cwd of a job, by id. An event whose payload has a `jobId` with an absolute cwd is sent with it, so that project's subscribers match. */
  jobCwd?: (jobId: string) => string | null | undefined;
  /** Upper bound of `flush()`, in ms. Default 8000. */
  flushBoundMs?: number;
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
  // A declaration the queue did not take for a reason that may pass: retried once, after the first accepted publish.
  private _pendingDeclaration: { source: string; events: EventDeclaration[] } | null = null;
  private readonly _flushBoundMs: number;

  constructor(private readonly _projectName = 'orchestrator', private readonly _logger?: LogSink, options: EventPublisherOptions = {}) {
    this._cwd = options.cwd;
    this._jobCwd = options.jobCwd;
    this._flushBoundMs = options.flushBoundMs ?? 8000;
  }

  publish(event: string, payload: Record<string, unknown>): void {
    try {
      const cwd = this._resolveCwd(payload);
      this._publisher().publishAndWait(event, payload, { cwd }).then(
        (result) => {
          if (result.status === 'queued' || result.status === 'dispatched') {
            this._recovered(event);
            this._retryDeclaration();
          }
          // 'dropped' and 'unknown' already went through onError, which logged them.
        },
        (err: unknown) => this._failed(`Failed to publish "${event}" to the queue: ${getErrorMessage(err)}`),
      );
    } catch (err) {
      this._failed(`Failed to publish "${event}" to the queue: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Tells the queue which events this program pushes (`queue events list|show`), replacing what `source` declared before.
   * Never rejects. Every outcome is one line in the daemon log; with the SDK switched off (QUEUE_SDK_OFF=1) nothing is
   * logged as an error. A declaration that did not reach the daemon is retried once, at the first accepted publish.
   */
  declareEvents(source: string, events: EventDeclaration[]): Promise<RegisterResult['status']> {
    return this._declare(source, events, true);
  }

  private async _declare(source: string, events: EventDeclaration[], mayRetry: boolean): Promise<RegisterResult['status']> {
    let result: RegisterResult;
    try {
      result = await this._publisher().registerEvents(source, events);
    } catch (err) {
      this._logger?.write(`[event-publisher] Could not declare the events of "${source}" to the queue: ${getErrorMessage(err)}`);
      return 'dropped';
    }
    const log = (text: string): void => this._logger?.write(`[event-publisher] ${text}`);
    switch (result.status) {
      case 'registered':
        log(`Declared ${result.count ?? events.length} event(s) of "${source}" to the queue (see \`queue events list\`).`);
        break;
      case 'rejected': {
        const problems = (result.problems ?? []).map((p) => `${p.path}: ${p.message}`).join('; ') || (result.reason ?? 'no detail');
        log(`The queue rejected the event declaration of "${source}" and stored nothing: ${problems}. Fix src/event-catalog.ts.`);
        break;
      }
      case 'unsupported':
        log(`Events of "${source}" are not declared: the queue daemon is older than protocol 1.1.0: run queue cli update (pushes keep working).`);
        break;
      default: {
        // Switched off on purpose (QUEUE_SDK_OFF): the SDK already announced it once, there is nothing to report or retry.
        if (result.status === 'dropped' && /switched off/i.test(result.reason ?? '')) {
          return result.status;
        }
        log(`The event declaration of "${source}" did not reach the queue (${result.status}): ${result.reason ?? 'no reason given'}`
          + (mayRetry ? ' It is tried once more at the first event that gets through.' : ''));
        if (mayRetry) {
          this._pendingDeclaration = { source, events };
        }
      }
    }
    return result.status;
  }

  private _retryDeclaration(): void {
    const pending = this._pendingDeclaration;
    if (pending === null) {
      return;
    }
    this._pendingDeclaration = null;
    void this._declare(pending.source, pending.events, false);
  }

  /**
   * Waits for the pushes in flight. The SDK's flush takes no argument and is bounded by its push timeouts; this adds an
   * outer bound (`flushBoundMs`) so a hanging queue can never hold the daemon back.
   */
  async flush(): Promise<void> {
    if (this._queue === null) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, this._flushBoundMs); });
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
      // The log below is the one place a failure is reported. QUEUE_SDK_OFF=1 in the daemon's environment (development
      // without a queue, or the test preload) switches the SDK off: it announces that once, through onWarning.
      silent: true,
      onWarning: (warning) => this._logger?.write(`[event-publisher] ${warning}`),
      // A failed declaration is reported by declareEvents, from its result: not a second time here.
      onError: (failure) => failure.operation === 'register-events' ? undefined : this._failed(`Failed to publish "${failure.event}" to the queue (${failure.kind}, ${failure.outcome}): ${failure.message}`),
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
