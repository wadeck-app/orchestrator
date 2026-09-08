# Daemon configuration — config.yml

File: `<configDir>/config.yml` (default `~/.config/orchestrator/config.yml`).

Read once at daemon startup. Changes take effect after `orch restart`.

## Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoUpdate` | bool | `true` | Enable automatic background updates |
| `catchUpInitialDelaySeconds` | int | `300` | Seconds to wait after daemon start before firing the first catch-up job |
| `catchUpStaggerSeconds` | int | `300` | Seconds between consecutive catch-up jobs on startup |

## Catch-up behaviour

On startup, for each cron job with `missedFiring: catch-up`, the scheduler compares the last expected firing time (computed from the cron schedule, up to 48h back) against the last recorded run. If the last expected firing is more recent than the last run, the job was missed and is queued for catch-up.

Catch-up jobs fire with staggered delays to avoid simultaneous load (e.g. after hibernation):
- Job 1 fires after `catchUpInitialDelaySeconds`
- Job 2 fires after `catchUpInitialDelaySeconds + catchUpStaggerSeconds`
- Job N fires after `catchUpInitialDelaySeconds + (N-1) × catchUpStaggerSeconds`

Only the **most recent** missed firing is caught up per job — multiple missed days do not accumulate.

## Example

```yaml
autoUpdate: false
catchUpInitialDelaySeconds: 300
catchUpStaggerSeconds: 300
```
