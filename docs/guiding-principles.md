# Orchestrator - Guiding Principles

## P1: Local-first, single-user
Dashboard binds to 127.0.0.1 only. No auth in v1/v2/v3.

## P2: Daemon stability over features
Web server and tray are child processes - daemon survives their restart. CLI daemon never crashes due to dashboard or tray failures.

## P3: Jobs are simple scripts, not flows
A job runs ONE command. Dependencies between 2 jobs are supported (B after A). If you need graph dependencies, branching, or parallel fan-out → use a workflow engine (Prefect, Temporal, n8n). Orchestrator is not a flow engine.

## P4: Event-driven architecture
All significant job lifecycle events (started, completed, failed, recovered, anomaly) are pushed to the queue daemon. Notifications, webhooks, and UI real-time updates are subscribers - never direct calls from the scheduler.

## P5: Reuse over reinvent
- Events: queue daemon at C:/Workspace_Tooling/queue
- Updates: shared-cli UpdateManager
- UI composition: dsl-renderer/dsl-ui

## P6: Transparency over silence
Config errors warn. Missing required fields error. No silent fallbacks. Jobs that time out log why. Failed events in the queue go to DLQ, not /dev/null.

## P7: Keep docs in sync with code
After every feature implementation:
- Mark `[x]` in `.claude/v3-todo.md`
- Update spec `_index.md` decisions table
- Update `CHANGELOG.md`
The TODO file is the source of truth for what is done and what is pending.
