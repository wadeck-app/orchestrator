# Plan: Real-time Transport Layer (RT-01)

Replace SSE polling with an abstracted transport that gracefully degrades.

**Prerequisite: EVENT-01 must be complete first.**

## Protocol priority
1. WebSocket — bidirectional, lowest latency
2. SSE — current implementation, fallback
3. Long-poll — last resort

## Reference implementations
- `C:/Workspace_Other/poc-node` — Node.js transport experiments
- `C:/Workspace_Tooling/agent-fleet/packages/e2e-web` — real-time test patterns
- `C:/Workspace_Tooling/agent-fleet/packages/orchestrator/src/core/BackendEventBridge.ts` — event bus pattern

## Architecture

```
Client                    orch-server
  |-- GET /api/connect --> |
  |                        |--> protocol detection (Upgrade header → WS, else SSE)
  |<-- WS/SSE/poll <------ |
  |                        |
  |                  in-memory EventBus
  |                        |<-- queue daemon subscription (job.* events)
  |                        |<-- scheduler events
  |<-- push ←------------- |
```

## Integration test suite (required before shipping)
- WS connection, message delivery, reconnect after drop
- SSE fallback when WS unavailable
- Long-poll fallback
- End-to-end: job completes → event reaches frontend browser

## Estimated effort: L
