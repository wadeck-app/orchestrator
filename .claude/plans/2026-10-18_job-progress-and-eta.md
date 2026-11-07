# Plan: job progress and estimated end time

Status: delivered. The behaviour is documented in `docs/daemon-config.md` ("Progress and ETA", "Reporting progress from a job"); the code is in `packages/orchestrator-cli/src/progress/`. This file keeps the decisions and the risks that are still open; delete it when the risks are closed or accepted.

## Decisions

1. The engine lives in the daemon and is exposed by the RPC `get-progress`; controllers only proxy it through `orch-core` (`GET /api/jobs/:jobId/progress`).
2. Strategies are built in and declarative (patterns and JSON). No external code is loaded, so there is no plugin setting in `config.yml` (`threat-model.md` T-04). The plugin types stay as the internal interface.
3. Dropped: the `resource` strategy (telemetry retention would have to change).
4. Job-side reporting is opt-in per job: `##orch-progress` lines or the `file` option.
5. Learning may use run logs older than the 20-entry history, bounded to the 20 newest usable runs and a byte cap per file.
6. Low-confidence estimates are shown, with a `~`; `confidence` is `low` under 5 usable runs or a score under 0.5.
7. Test fixtures are synthetic only (`test/progress/helpers/make-fixtures.js`); no real log is copied into the repo.
8. Parallel runs (`maxConcurrency` > 1): one estimate per job, from the oldest open run.
9. Two definitions of "usual duration" stay apart on purpose: the anomaly check averages the last 10 finished runs with an exit code (failures included, needs 3); the `history` strategy takes the median of the last 10 usable runs (exit code 0 only). Sharing one function would change what the anomaly check alerts on.

## Open risks

- Never checked on a live daemon with a real supervised run folder. Run logs keep the `[YYYY-MM-DD HH:MM:SS]` prefix and the `[job:started]` / `[job:finished]` markers (also for adopted runs), but that is verified in code and fixtures only.
- A job nobody polls whose run ended while the daemon was down learns nothing until polled; `log-declared` learns only lazily.
- `ensemble` needs about 5 usable runs and several polls before it commits.
- Calibration rests on an interval defined as (1 - score) x duration, not on one the strategies state themselves.
- The regex budget is wall time (V8 timeout, 500 ms per batch): a heavily loaded machine could trip it.
- A save pending when the daemon stops is lost (derived data, rebuilt from the logs).
- Two runs started in the same second share one log file.
- `log-learned` shows ETA flips on the input-dependent fixture.
- The first one or two log lines of an open run are not judged for a format change.
- Log timestamps have 1 s resolution: jobs shorter than about 10 s get no useful interpolation.
- Stdout buffering by the job (block-buffered when piped) delays log lines; undetectable from outside, only mitigated by the confidence from replay.
- Jobs without a timeout have no meaningful ETA; the `reason` says so.
- The sticky `auto` choice and learned data can drift silently; the replay report (`orch progress replay`) and the `reason` string are the controls.
- `dsl-lib-orch` has its own copy of `Job` / `RuntimeEntry`, behind the CLI's; the contract test in `test/progress` is the control.
- There is no `orch import` CLI command: `POST /api/jobs/import` is the only import.
