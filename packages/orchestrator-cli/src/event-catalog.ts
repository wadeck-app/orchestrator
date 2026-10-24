import type { EventDeclaration } from '@wadeck-app/queue-sdk';

/**
 * Every event the orchestrator pushes to the queue, declared to it at each daemon start (`queue events list|show`).
 *
 * Single source: a test fails when the code publishes a name that is not here, when a name here is never published, and
 * when docs/daemon-config.md does not list exactly these names. The payloads below are the real ones, read from the
 * publish() call sites.
 *
 * "Finished" = any `terminal` event, and the terminal events are exclusive per run, so it never counts twice:
 *   - job.completed | job.failed | job.skipped | job.killed_manual end a run, one of them per run (the chain in
 *     Scheduler._finishRun is an if / else-if); job.failed is also the end of a run that could not be started.
 *   - job.timed_out and a hard resource kill are NOT terminal: the killed run still ends with job.failed (or
 *     job.completed when the process exits 0 after the kill).
 *   - exec.completed | exec.failed end an `orch exec` run.
 */

export const EVENT_SOURCE = 'orchestrator';

type Schema = Record<string, unknown>;

const str = { type: 'string' };
const int = { type: 'integer' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const nullableStr = { type: ['string', 'null'] };

function payload(properties: Record<string, Schema>, required: string[]): Schema {
  return { type: 'object', properties, required, additionalProperties: true };
}

// Set on the events published when the end of a run is learned late (the daemon was down when it ended).
const LATE = {
  late: { type: 'boolean', description: 'Present and true when the daemon only learned of the end of the run afterwards.' },
  finishedAt: { type: 'string', description: 'With late: when the run really ended (ISO 8601).' },
};

const JOB = { jobId: str, label: str };
const JOB_REQUIRED = ['jobId', 'label'];
const RUN_END = { ...JOB, exitCode: int, durationMs: int, ...LATE };
const REQUEST = { ip: nullableStr, userAgent: nullableStr };
const THRESHOLD = { type: 'object', properties: { cpuPct: { type: ['number', 'null'] }, ramMb: { type: ['number', 'null'] } } };

export const EVENT_CATALOG: EventDeclaration[] = [
  {
    name: 'job.started',
    description: 'A run of a job was spawned. Fires once per run, so several times for one job (every cron firing, retry, dependency or manual trigger). Does NOT fire for a firing that was skipped (job.skipped) or whose process could not be started (job.failed with durationMs 0).',
    schema: payload({ ...JOB, pid: { type: ['integer', 'null'] }, trigger: { enum: ['cron', 'manual', 'dependency', 'retry'] } }, [...JOB_REQUIRED, 'pid', 'trigger']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', pid: 4242, trigger: 'cron' },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.completed',
    description: 'A run of a job ended with exit code 0. Terminal, one per run (exclusive with job.failed, job.skipped, job.killed_manual). Does NOT fire for a run stopped by `orch kill`, for an exit code listed in skipExitCodes, or for a failed run. A timed-out run that exits 0 after being killed still ends here, after job.timed_out.',
    schema: payload({ ...RUN_END }, [...JOB_REQUIRED, 'exitCode', 'durationMs']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', exitCode: 0, durationMs: 93200 },
    correlationKey: 'payload.jobId',
    terminal: true,
    outcome: 'success',
  },
  {
    name: 'job.failed',
    description: 'A run of a job ended with a non-zero exit code, or could not be started (exitCode 1, durationMs 0, no job.started). Terminal, one per run. Also the end of a run killed by the timeout (after job.timed_out) or by a hard resource limit (after job.resource_hard_limit with enforced true). Does NOT fire for `orch kill` (job.killed_manual) or skipExitCodes (job.skipped).',
    schema: payload({ ...RUN_END }, [...JOB_REQUIRED, 'exitCode', 'durationMs']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', exitCode: 2, durationMs: 1800 },
    correlationKey: 'payload.jobId',
    terminal: true,
    outcome: 'failure',
  },
  {
    name: 'job.skipped',
    description: 'A firing produced no success and no failure. Terminal, one per firing. reason "exitCode": the run ended with an exit code the job declares as "nothing to do" (skipExitCodes). reason "concurrency", "adopted" or "liveness": the firing was refused and nothing was started (no job.started). Does NOT fire for a run that succeeds or fails.',
    schema: payload({ ...JOB, exitCode: { type: ['integer', 'null'] }, durationMs: int, reason: { enum: ['exitCode', 'concurrency', 'adopted', 'liveness'] }, running: int, maxConcurrency: int, ...LATE }, [...JOB_REQUIRED, 'exitCode', 'durationMs', 'reason']),
    example: { jobId: 'sync', label: 'Sync', exitCode: null, durationMs: 0, reason: 'concurrency', running: 1, maxConcurrency: 1 },
    correlationKey: 'payload.jobId',
    terminal: true,
    outcome: 'info',
  },
  {
    name: 'job.recovered',
    description: 'A run succeeded right after a failed one. Fires after the job.completed of that same run, once per recovery. Not terminal (job.completed already ended the run). Does NOT fire for a success that follows a success.',
    schema: payload({ ...JOB, ...LATE }, JOB_REQUIRED),
    example: { jobId: 'nightly-backup', label: 'Nightly backup' },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.anomaly',
    description: 'A successful run took more than 3 times the rolling average duration of the job. Fires after the job.completed of that run, at most once per run. Not terminal. Does NOT fire for failed runs or when there is no history yet.',
    schema: payload({ ...JOB, durationMs: int, avgMs: int, multiplier: num, ...LATE }, [...JOB_REQUIRED, 'durationMs', 'avgMs', 'multiplier']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', durationMs: 310000, avgMs: 90000, multiplier: 3 },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.timed_out',
    description: 'A run exceeded its timeoutSeconds and the daemon is killing it. NOT terminal: the killed run then ends with job.failed (or job.completed if the process exits 0, job.skipped for a skipExitCodes code), so wait for those. Fires once per timed-out run. Does NOT fire for jobs without a timeout.',
    schema: payload({ ...JOB, timeoutSeconds: num, ...LATE }, [...JOB_REQUIRED, 'timeoutSeconds']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', timeoutSeconds: 300 },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.kill_requested',
    description: 'Someone asked to stop a job (`orch kill`, the dashboard). Fires per request, even when nothing was running. NOT terminal: the stopped run ends with job.killed_manual, which fires once per run that was really stopped. Does NOT fire when a job is stopped by its timeout or a resource limit.',
    schema: payload({ ...JOB, ...REQUEST }, JOB_REQUIRED),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', ip: '127.0.0.1', userAgent: 'orch-cli' },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.killed_manual',
    description: 'A run was stopped on request (`orch kill`, the dashboard, or the stop half of `orch restart-job`). Terminal, one per stopped run, INSTEAD of job.failed and job.completed (they do not follow). Does NOT fire for a kill by timeout (job.timed_out then job.failed) or by a resource limit.',
    schema: payload({ ...JOB, durationMs: int, ...LATE }, [...JOB_REQUIRED, 'durationMs']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', durationMs: 12000 },
    correlationKey: 'payload.jobId',
    terminal: true,
    outcome: 'info',
  },
  {
    name: 'job.triggered_manual',
    description: 'Someone asked to run a job now (`orch trigger`, the dashboard, the API). Fires per request, before the run starts. NOT terminal and not a start: a job.started follows, or a job.skipped if the job is already running. Does NOT fire for scheduled, dependency or retry runs.',
    schema: payload({ ...JOB, ...REQUEST }, JOB_REQUIRED),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', ip: '127.0.0.1', userAgent: 'orch-cli' },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.restarted',
    description: 'A job was restarted on request (`orch restart-job`): its running instances were ended and a new run started. Fires once per request, after the old runs ended (each of them ends with job.killed_manual) and the new one started. Not terminal. Does NOT fire for `orch restart` (the daemon, see daemon.restarted).',
    schema: payload({ ...JOB, wasRunning: bool, killed: int, started: bool, ...REQUEST }, [...JOB_REQUIRED, 'wasRunning', 'killed', 'started']),
    example: { jobId: 'dev-server', label: 'Dev server', wasRunning: true, killed: 1, started: true, ip: '127.0.0.1', userAgent: 'orch-cli' },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.window_expired',
    description: 'The job reached its activeUntil date and was disabled. Fires once per job, when the window closes. Not terminal. Does NOT fire for a job disabled by hand.',
    schema: payload({ ...JOB, activeUntil: str }, [...JOB_REQUIRED, 'activeUntil']),
    example: { jobId: 'campaign', label: 'Campaign', activeUntil: '2026-12-31T23:59:00.000Z' },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.resource_soft_limit',
    description: 'A running job went over its soft CPU or RAM budget. Fires at most once per run. Not terminal and nothing is killed. Does NOT fire for the hard limit (job.resource_hard_limit).',
    schema: payload({ ...JOB, cpuPct: num, ramMb: num, softThreshold: THRESHOLD }, [...JOB_REQUIRED, 'cpuPct', 'ramMb']),
    example: { jobId: 'scraper', label: 'Scraper', cpuPct: 82.5, ramMb: 1900, softThreshold: { cpuPct: 80, ramMb: 1500 } },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'job.resource_hard_limit',
    description: 'A running job stayed over its hard CPU or RAM budget for several consecutive samples. Fires once per continuous breach (once per run when enforced). enforced true: the process tree is being killed, and the run then ends with job.failed. enforced false (enforce: warn): nothing is killed. Not terminal.',
    schema: payload({ ...JOB, cpuPct: num, ramMb: num, hardThreshold: THRESHOLD, consecutiveSamples: int, enforced: bool }, [...JOB_REQUIRED, 'cpuPct', 'ramMb', 'consecutiveSamples', 'enforced']),
    example: { jobId: 'scraper', label: 'Scraper', cpuPct: 99, ramMb: 4100, hardThreshold: { cpuPct: 95, ramMb: 4000 }, consecutiveSamples: 3, enforced: true },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'alert.consecutive_failures',
    description: 'A job failed at least alertAfterFailures times in a row (default 3). Fires after the job.failed of each further failed run while the streak lasts, so several times for one streak. Not terminal. Does NOT fire for a success, a skip or a kill.',
    schema: payload({ ...JOB, consecutiveFailures: int, threshold: int, ...LATE }, [...JOB_REQUIRED, 'consecutiveFailures', 'threshold']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', consecutiveFailures: 3, threshold: 3 },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'alert.retry_exhausted',
    description: 'A job failed with an exit code listed in retryOnExitCodes and all its retryDelays attempts are used up: the failure is permanent. Fires once per exhausted series, after the job.failed of the last attempt. Not terminal. Does NOT fire while attempts remain.',
    schema: payload({ ...JOB, exitCode: int, attempts: int, ...LATE }, [...JOB_REQUIRED, 'exitCode', 'attempts']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', exitCode: 75, attempts: 3 },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'alert.sla_breach',
    description: 'A job has not succeeded within slaWindowMinutes of a scheduled firing. Fires once per scheduled firing that missed its window. Not terminal. Does NOT fire when a run started after the firing succeeded in time, or for jobs without slaWindowMinutes.',
    schema: payload({ ...JOB, scheduledAt: str, windowMinutes: num }, [...JOB_REQUIRED, 'scheduledAt', 'windowMinutes']),
    example: { jobId: 'nightly-backup', label: 'Nightly backup', scheduledAt: '2026-10-24T01:00:00.000Z', windowMinutes: 30 },
    correlationKey: 'payload.jobId',
  },
  {
    name: 'exec.started',
    description: 'An ad-hoc command started with `orch exec`. Fires once per run id. Not terminal. Does NOT fire for scheduled jobs (job.started).',
    schema: payload({ runId: str, command: str, label: str, pid: { type: ['integer', 'null'] } }, ['runId', 'command', 'pid']),
    example: { runId: 'exec-20261024-0001', command: 'npm run build', label: 'build', pid: 5150 },
    correlationKey: 'payload.runId',
  },
  {
    name: 'exec.completed',
    description: 'An `orch exec` command ended with exit code 0. Terminal, one per run id (exclusive with exec.failed). Does NOT fire for scheduled jobs (job.completed).',
    schema: payload({ runId: str, command: str, label: str, exitCode: int, durationMs: int }, ['runId', 'command', 'exitCode', 'durationMs']),
    example: { runId: 'exec-20261024-0001', command: 'npm run build', label: 'build', exitCode: 0, durationMs: 41000 },
    correlationKey: 'payload.runId',
    terminal: true,
    outcome: 'success',
  },
  {
    name: 'exec.failed',
    description: 'An `orch exec` command ended with a non-zero exit code, including one that was killed. Terminal, one per run id (exclusive with exec.completed). Does NOT fire for scheduled jobs (job.failed).',
    schema: payload({ runId: str, command: str, label: str, exitCode: int, durationMs: int }, ['runId', 'command', 'exitCode', 'durationMs']),
    example: { runId: 'exec-20261024-0001', command: 'npm run build', label: 'build', exitCode: 1, durationMs: 8000 },
    correlationKey: 'payload.runId',
    terminal: true,
    outcome: 'failure',
  },
  {
    name: 'daemon.started',
    description: 'The orchestrator daemon finished starting (also after `orch restart` and after an update). Fires once per daemon process. About the daemon, not a job: no correlation key. Does NOT fire when only the CLI runs.',
    schema: payload({ pid: int, version: str }, ['pid', 'version']),
    example: { pid: 34888, version: '2026.10.24-100-abcdef01' },
  },
  {
    name: 'daemon.restarted',
    description: 'A restart of the daemon was requested (`orch restart`); the old process publishes it just before it exits, then daemon.started comes from the new process. Fires once per request. No correlation key. Does NOT fire for an update or a crash.',
    schema: payload({ pid: int }, ['pid']),
    example: { pid: 34888 },
  },
];
