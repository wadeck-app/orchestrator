# Plan: Event Queue Integration (EVENT-01)

Push job lifecycle events to the queue daemon (port 47910) so subscribers react without tight coupling.

## Events

| Event | Trigger | Key payload fields |
|-------|---------|-------------------|
| `job.started` | Job spawned | jobId, label, pid, trigger |
| `job.completed` | Exit code 0 | jobId, label, exitCode, durationMs |
| `job.failed` | Exit code ≠ 0 | jobId, label, exitCode, durationMs |
| `job.recovered` | Exit 0 after prior failure | jobId, label |
| `job.timed_out` | Scheduler timeout | jobId, label, timeoutSeconds |
| `job.anomaly` | Duration > N× rolling avg | jobId, label, durationMs, avgMs |
| `job.triggered_manual` | Manual trigger | jobId, label, ip, userAgent |
| `daemon.started` | Daemon init | pid, version |
| `daemon.restarted` | orch restart | pid, version |

## Architecture

```
scheduler._fire()
  → spawn child
  → EventPublisher.publish('job.started', {...})   // fire-and-forget
  → child.on('close')
  → EventPublisher.publish('job.completed'|'job.failed', {...})
```

## Implementation

1. `packages/orchestrator-cli/src/event-publisher.ts`
   - `publish(event, payload): void` — fire and forget, never throws
   - POST to `http://localhost:47910/push` using `fetch`
   - Catches all errors, logs warning only, never blocks job execution
   - No-op if queue daemon unreachable

2. Wire `scheduler.ts`: publish started on spawn, completed/failed on close, timed_out on timeout kill.

3. Wire `index.ts`: publish daemon.started on init, daemon.restarted via restart command handler.

4. Recovery detection in `state.ts`: if previous `exitCode !== 0` and new `exitCode === 0`, publish `job.recovered`.

## Config
No config needed. Queue daemon address is the well-known `localhost:47910`. Events are silently dropped if queue is not running.

## Tests
- Unit: EventPublisher with mocked fetch (success, network error, timeout)
- Integration: run a job → verify POST to queue daemon mock
