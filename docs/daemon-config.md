# Daemon configuration -- config.yml

File: `<configDir>/config.yml` (default `~/.config/orchestrator/config.yml`).

Read once at daemon startup. Changes take effect after `orch restart`.

## Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoUpdate` | bool | `true` | Enable automatic background updates |
| `catchUpInitialDelaySeconds` | int | `300` | Seconds to wait after daemon start before firing the first catch-up job |
| `catchUpStaggerSeconds` | int | `300` | Seconds between consecutive catch-up jobs on startup |
| `onceRetentionDays` | int | `360` | Days a spent `once` job is kept before being pruned |
| `onceRetentionMaxJobs` | int | `50` | How many spent `once` jobs are kept at most |

Integers must be whole and non-negative. `0` is valid and means "keep none".

## Invalid values

A line the parser cannot use is reported in the daemon log (`orch logs`) and the default applies:

```
config: config.yml line 4: onceRetentionDays must be a non-negative whole number, found "soon" -- using 360
config: config.yml line 7: unknown key "onceRetentionDay", ignored. Known keys: autoUpdate, ...
```

Unknown keys are reported too: a typo used to be indistinguishable from "not configured".

## Past `once` jobs

A `once` job that has fired is marked `spent` + `spentAt` in `registry.json` instead of being deleted,
so its run history and audit entries still have a definition to point at.

Pruning applies whichever bound is reached first, on daemon start and after each firing. `orch list`
hides spent jobs (use `--past`); the dashboard has a "Past once" filter chip.

## Catch-up behaviour

On startup, for each cron job with `missedFiring: catch-up`, the scheduler compares the last expected firing time (computed from the cron schedule, up to 48h back) against the last recorded run. If the last expected firing is more recent than the last run, the job was missed and is queued for catch-up.

Catch-up jobs fire with staggered delays to avoid simultaneous load (e.g. after hibernation):
- Job 1 fires after `catchUpInitialDelaySeconds`
- Job 2 fires after `catchUpInitialDelaySeconds + catchUpStaggerSeconds`
- Job N fires after `catchUpInitialDelaySeconds + (N-1) × catchUpStaggerSeconds`

Only the **most recent** missed firing is caught up per job -- multiple missed days do not accumulate.

## Example

```yaml
autoUpdate: false
catchUpInitialDelaySeconds: 300
catchUpStaggerSeconds: 300
onceRetentionDays: 360
onceRetentionMaxJobs: 50
```
