import type { DailyLogger } from './logger.js';

const QUEUE_URL = 'http://localhost:47910';

export class EventPublisher {
  constructor(private readonly _projectName = 'orchestrator', private readonly _logger?: DailyLogger) {}

  publish(event: string, payload: Record<string, unknown>): void {
    // Fire and forget - never throws, never blocks job execution
    fetch(`${QUEUE_URL}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
      signal: AbortSignal.timeout(2000),
    }).catch((err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      this._logger?.write(`[event-publisher] Failed to publish "${event}": ${reason}`);
    });
  }
}
