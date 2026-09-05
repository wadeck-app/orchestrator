const QUEUE_URL = 'http://localhost:47910';

export class EventPublisher {
  constructor(private readonly _projectName = 'orchestrator') {}

  publish(event: string, payload: Record<string, unknown>): void {
    // Fire and forget - never throws, never blocks job execution
    fetch(`${QUEUE_URL}/push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, payload }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {
      // Queue unavailable = silent drop, no crash
    });
  }
}
