// Shared domain types (duplicated from orchestrator-cli to avoid circular dep)
export type MissedFiring = 'catch-up' | 'skip';
export type LivenessStrategy = 'none' | 'portFile' | 'pidFile' | 'command';

export interface LivenessConfig {
  strategy: LivenessStrategy;
  portFile?: string;
  command?: string;
  /** Command strategy only: the liveness command is killed after this many seconds (whole, 1-3600; default 30). */
  timeoutSeconds?: number;
}

/** The longest description a job may have, counted on the trimmed text. Mirrors orchestrator-cli's types.ts. */
export const DESCRIPTION_MAX_LENGTH = 2000;

export interface Job {
  id: string;
  /** `manual` is never fired by the scheduler: no schedule, no delay, it runs only when triggered. */
  type: 'cron' | 'startup' | 'once' | 'manual';
  label: string;
  schedule?: string;
  /** `startup` only: how long after the daemon starts. May be 0. */
  delaySeconds?: number;
  /**
   * `once` only, and REQUIRED by the daemon for that type: how long until the single run.
   * Must be a positive integer - registry.ts rejects 0 and any non-integer.
   *
   * Its absence from this type is why the web form never sent it, so every `once` job created from
   * the dashboard came back 500.
   */
  delayMs?: number;
  /**
   * `once` only: the moment `delayMs` is measured from, ISO. The job fires at scheduledAt + delayMs.
   *
   * It was absent from this type while being present on the wire, so the dashboard had `delayMs` and
   * nothing to measure it from and could only say the bare word "Once" -- it could not tell a job due
   * in three hours from one whose moment passed last week. The daemon defaults it at creation, so it
   * is only missing on jobs written before the field existed.
   */
  scheduledAt?: string;
  command: string;
  cwd?: string | null;
  /** How the resource monitor treats this job's runs. Absent means all defaults (kill at 3x the baseline held for 30 s). */
  resourceLimits?: ResourceLimits;
  /** What the job is for: plain text, may contain line breaks, at most DESCRIPTION_MAX_LENGTH characters. Absent when none. */
  description?: string;
  enabled: boolean;
  /**
   * The window a cron job may fire in, both ISO timestamps and both optional.
   *
   * `activeFrom` may be in the FUTURE, which is a third state rather than a flavour of disabled: a
   * job waiting for its window to open is enabled and working as configured. At `activeUntil` the
   * daemon disables the job rather than deleting it.
   */
  activeFrom?: string;
  activeUntil?: string;
  triggerMode: 'fire-and-forget' | 'wait';
  missedFiring?: MissedFiring;
  liveness?: LivenessConfig | null;
  onExitCode?: Record<string, string>;
  /** Default 300 where it is read. 0 means no timeout, for a process that must stay up. */
  timeoutSeconds?: number;
  /** How many runs of this job may be alive at once. Absent means no limit. */
  maxConcurrency?: number;
  env?: Record<string, string>;
  tags?: string[];
  dependsOn?: string;
  alertAfterFailures?: number;
  slaWindowMinutes?: number;
  secrets?: string[];
  dryRunSupported?: boolean;
  /** Exit codes that make the daemon run the job again, after the matching entry of `retryDelays`. */
  retryOnExitCodes?: number[];
  /** Seconds to wait before each retry; its length is the number of retries. */
  retryDelays?: number[];
  /**
   * Bring the job back after ANY exit (code 0, a failure, a signal, its timeout), for a job that must stay up. `true` means
   * the defaults, an object tunes them. A manual kill never restarts. Not combinable with retryOnExitCodes/retryDelays.
   */
  restartOnExit?: boolean | RestartOnExit;
  /** Size-based rotation of one run's log; absent means the daemon-wide values (50 MB, 5 segments). Clear it with --unset logRotation. */
  logRotation?: LogRotation;
  /**
   * Exit codes that mean "this run deliberately did nothing", not "this run broke". The run is recorded
   * as skipped (real exit code kept) and never counted as a failure.
   */
  skipExitCodes?: number[];
  /**
   * `once` only: the job has already had its single firing.
   *
   * A spent job used to be deleted from the registry, so the dashboard never saw one. It is kept now
   * (bounded by onceRetentionDays / onceRetentionMaxJobs in config.yml), which means every list has to
   * decide whether it is looking at the future or the past: without filtering on this, the job grid
   * would fill with one-off jobs that have nothing left to do.
   */
  spent?: boolean;
  /** When the firing that spent the job happened, ISO. Set with `spent` and never moved after. */
  spentAt?: string;
  /** How the progress and estimated end of a running job are computed. Absent means 'auto'. */
  progress?: JobProgressSetting;
}

/** The `logRotation` setting of a job; every key is optional. Mirrors LogRotation in orchestrator-cli's log-rotation.ts. */
export interface LogRotation {
  /** A segment is closed when the next line would take it over this many MB (decimals allowed, min 0.001). 0 = never rotate. Default 50. */
  maxSizeMb?: number;
  /** How many segments of a run are kept, the newest ones, 1-1000. Default 5. */
  keepSegments?: number;
}

/** The object form of `restartOnExit`; every key is optional. Mirrors RestartOnExit in orchestrator-cli's restart-policy.ts. */
export interface RestartOnExit {
  /** Default 'exponential'. */
  strategy?: 'fixed' | 'linear' | 'exponential';
  /** Pause before the first restart, seconds. Default 1. */
  initialDelaySeconds?: number;
  /** exponential only. Default 2. */
  factor?: number;
  /** linear only. Default: initialDelaySeconds. */
  stepSeconds?: number;
  /** linear and exponential: ceiling of the pause. Default 30. */
  maxDelaySeconds?: number;
  /** Restarts allowed within windowSeconds. Default 10. */
  maxRestarts?: number;
  /** Sliding window of the limit, seconds. Default 300. */
  windowSeconds?: number;
  /** A run this long clears the backoff and the restart count, seconds. Default 900. */
  stableAfterSeconds?: number;
}

/** A string: 'auto' picks a strategy per run, 'off' disables the estimate, a strategy id forces it (no fallback). Or the object form with options. */
export type JobProgressSetting = string | { strategy: string; options?: unknown };

/**
 * The fields `PUT /api/jobs/:id` accepts in its `unset` array. Mirrors UNSETTABLE_FIELDS in
 * orchestrator-cli's types.ts - anything else makes registry.edit() throw, and the daemon is right
 * to: id, type, command, enabled, a cron's schedule and a once job's delayMs are what let the
 * scheduler fire the job at all.
 */
export type UnsettableJobField =
  | 'cwd' | 'delaySeconds' | 'missedFiring' | 'timeoutSeconds' | 'env' | 'tags'
  | 'onExitCode' | 'retryOnExitCodes' | 'retryDelays' | 'restartOnExit' | 'logRotation' | 'skipExitCodes' | 'liveness'
  | 'alertAfterFailures' | 'dependsOn' | 'slaWindowMinutes' | 'secrets' | 'dryRunSupported'
  | 'label' | 'triggerMode' | 'maxConcurrency' | 'description' | 'resourceLimits' | 'progress'
  // Clearing the end of a window leaves the job running indefinitely; clearing the start makes it
  // active now. Both are ordinary edits, so both must be clearable rather than only replaceable.
  | 'activeFrom' | 'activeUntil';

/**
 * What a job form submits. An edit is a PATCH, so an omitted key means "leave it alone" and there is
 * no value that spells "clear this" - `unset` is how a field the user emptied travels to the daemon.
 * The server lifts it out of the body, so it is a sibling of the job fields, never one of them.
 */
export interface JobFormPayload extends Partial<Job> {
  unset?: UnsettableJobField[];
}

/**
 * What a trigger answers when the job is at its concurrency limit. Not an error: nothing went wrong,
 * the run was simply not started.
 */
export interface TriggerRefused {
  status: 'already-running';
  running: number;
  maxConcurrency: number;
}

/**
 * What `POST /api/jobs/:id/restart` answers (the daemon's `restart-job`). A refused start is a normal answer:
 * the old instance was still ended, so `killed` says so and `reason` says what to do.
 */
export interface RestartResult {
  id: string;
  wasRunning: boolean;
  killed: number;
  started: boolean;
  pid: number | null;
  skipped?: 'liveness' | 'concurrency' | 'adopted';
  reason?: string;
}

export function isTriggerRefused(result: unknown): result is TriggerRefused {
  return typeof result === 'object' && result !== null
    && (result as { status?: unknown }).status === 'already-running';
}

export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    // violations-suppress: ts/no-err-message-direct this IS the instanceof-guarded safe accessor - the one place in dsl-lib-orch where .message access is correct
    return e.message;
  }
  return String(e);
}

export type TriggerSource =
  | { kind: 'cron' }
  | { kind: 'manual'; ip?: string; userAgent?: string }
  | { kind: 'dependency'; dependsOnJobId: string }
  // A re-run the daemon started after an exit code listed in retryOnExitCodes; `attempt` counts from 1.
  | { kind: 'retry'; attempt: number }
  // A run the daemon started because the job's restartOnExit brought it back after an exit; `attempt` counts from 1.
  | { kind: 'restart'; attempt: number };

export interface RuntimeEntry {
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  pid: number | null;
  triggeredBy?: TriggerSource;
  acknowledgedAt?: string;
  peakCpuPct?: number;
  peakRamMb?: number;
  cancelledByUser?: boolean;
  /**
   * Why the run was ended by force: the job's timeout, a user's kill, or the resource limit. Absent for a run that
   * ended on its own, and on history recorded before it existed (see `runEndReason`).
   */
  endReason?: 'timeout' | 'manual-kill' | 'resource-limit';
  /**
   * The daemon learned of this run's end after the fact (it ended while the daemon was down), so `finishedAt` is
   * when it really ended, not when it was noticed.
   */
  late?: boolean;
  /**
   * The daemon deliberately did no work, or the child exited with a code the job declares as
   * "not a failure" (a scraper exiting 2 because a sibling already holds its lock).
   *
   * Authoritative: it wins over every exitCode-based classification. exitCode may still be the
   * child's own code, or null when nothing was ever spawned, and neither may raise an alarm.
   */
  skipped?: boolean;
  /** Which attempt of a retried run this is, counted from 1. Absent on a first attempt. */
  retryAttempt?: number;
  /**
   * The daemon that spawned this run is gone: the run was closed at the next daemon start because
   * nobody could have seen the process end. Not a failure of the job.
   */
  orphaned?: boolean;
  /** The run is owned by its own supervisor process, so it survives a daemon restart. */
  supervised?: boolean;
  /** Version of the method that measured peakCpuPct/peakRamMb; absent on runs recorded before it existed. */
  peakMeasure?: number;
}

// Picks the run with the latest startedAt. Do not trust index 0: overlapping runs
// could leave a finished entry at the head, and older histories still contain
// exitCode:null orphans from runs whose completion was never recorded.
export function latestRun(entries: RuntimeEntry[] | undefined): RuntimeEntry | null {
  if (!entries || entries.length === 0) {
    return null;
  }
  return entries.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
}

// Both conditions are required. A process killed by signal has no exit code, so a cancelled
// run looks exactly like an in-flight one on exitCode alone and finishedAt is what separates
// them. But history written before finishedAt existed has an exit code and no finishedAt, and
// treating those as running would leave old entries stuck on "Running" forever.
export function isRunActive(entry: RuntimeEntry | null): boolean {
  return entry !== null && entry.finishedAt == null && entry.exitCode == null;
}

/**
 * Whether ANY run of the job is still open.
 *
 * Not `isRunActive(latestRun(history))`: with several instances alive (maxConcurrency above 1, or a
 * forced trigger) the newest run can have ended while an older one is still going, and reading only
 * the newest said the job was idle - no Kill button, "Run now" offered, the counter one short.
 * latestRun stays for what really means "the newest run": the last result, durations, health dots.
 */
export function isJobRunning(entries: RuntimeEntry[] | undefined): boolean {
  return entries?.some(isRunActive) ?? false;
}

/**
 * The run to describe when showing "what is happening now": the newest run still open, otherwise the
 * newest run. A running job shows the instance that is actually alive (its pid, its elapsed time)
 * rather than a newer one that has already finished.
 */
export function liveOrLatestRun(entries: RuntimeEntry[] | undefined): RuntimeEntry | null {
  return latestRun(entries?.filter(isRunActive)) ?? latestRun(entries);
}

// A non-event: neither an outcome to celebrate nor one to alarm about. Checked first by every
// other classifier below, because a skipped run's exitCode is indistinguishable from a real
// failure (exit 2) or a signal kill (null) and would otherwise be reported as one.
export function isRunSkipped(entry: RuntimeEntry | null): boolean {
  return entry !== null && entry.skipped === true;
}

// Finished without an exit code (killed by signal), or explicitly cancelled.
export function isRunCancelled(entry: RuntimeEntry | null): boolean {
  if (entry === null || isRunActive(entry) || isRunSkipped(entry)) {
    return false;
  }
  return entry.cancelledByUser === true || entry.exitCode === null;
}

export type RunEndReason = NonNullable<RuntimeEntry['endReason']>;

/**
 * Why a finished run was ended by force, or undefined when it ended on its own.
 *
 * A legacy `cancelledByUser` entry reads as a manual kill, which is what it always meant. A legacy entry that
 * only has a null exit code stays undefined: nothing says it was a timeout, and guessing would mislabel old data.
 */
export function runEndReason(entry: RuntimeEntry | null): RunEndReason | undefined {
  if (entry === null || isRunActive(entry) || isRunSkipped(entry)) {
    return undefined;
  }
  return entry.endReason ?? (entry.cancelledByUser === true ? 'manual-kill' : undefined);
}

// Only a real non-zero exit code is a failure: null means killed, not failed.
export function isRunFailed(entry: RuntimeEntry | null): boolean {
  if (isRunSkipped(entry)) {
    return false;
  }
  return entry !== null && entry.exitCode != null && entry.exitCode !== 0;
}

/** What a job does when a run stays over its resource budget. Mirrors orchestrator-cli's types.ts. */
export type ResourceEnforce = 'kill' | 'warn' | 'off';

/**
 * A job's resource-limit settings; every key is optional and an absent one takes the daemon's default
 * (enforce 'kill', hardFactor 3, softFactor 1.5, sustainSeconds 30). The daemon refuses an invalid value
 * with a sentence naming the field. Mirrors orchestrator-cli's types.ts.
 */
export interface ResourceLimits {
  enforce?: ResourceEnforce;
  /** Over baseline x this, for sustainSeconds, is a breach. Greater than 1 and at most 100. */
  hardFactor?: number;
  /** Warning threshold, baseline x this. Greater than 1 and below the hard factor. */
  softFactor?: number;
  /** How long a breach must last, whole seconds, 2 to 3600. */
  sustainSeconds?: number;
  /** Absolute CPU ceiling in percent, instead of a baseline-derived one. Greater than 0. */
  maxCpuPct?: number;
  /** Absolute RAM ceiling in MB, instead of a baseline-derived one. Greater than 0. */
  maxRamMb?: number;
}

/** A pair of limits; a side is null when nothing defines it (an absolute ceiling for the other resource only, and no baseline yet). */
export interface ResourceThreshold {
  cpuPct: number | null;
  ramMb: number | null;
}

/** One measured run in the answer of `GET /api/jobs/:jobId/resource-history` (the daemon's `get-resource-history`). */
export interface ResourceHistoryRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  endReason?: 'timeout' | 'manual-kill' | 'resource-limit';
  peakCpuPct: number | null;
  peakRamMb: number | null;
  avgCpuPct: number | null;
  avgRamMb: number | null;
  samples: number;
  /** The thresholds this run was held to; null when none existed (no baseline yet, nothing absolute set), and a side may be null. */
  soft: ResourceThreshold | null;
  hard: ResourceThreshold | null;
  enforce: ResourceEnforce;
}

/** The answer of `GET /api/jobs/:jobId/resource-history`: runs newest first. */
export interface ResourceHistory {
  runs: ResourceHistoryRun[];
  /** Runs the daemon has for the job, which can exceed `runs.length` when a limit was asked for. */
  total: number;
  /** How many runs per job the daemon keeps. */
  retention: number;
}

export type ProgressConfidence = 'high' | 'medium' | 'low' | 'none';

/**
 * Progress and ETA of a running job, as the daemon's get-progress and `progress` on GET /api/jobs answer.
 * Mirrors orchestrator-cli's progress/types.ts (types-parity.test.ts compares the fields).
 */
export interface ProgressEstimate {
  /** null when no strategy ran: a long-running job, or the daemon could not compute it. */
  strategyId: string | null;
  /** 0..1, or null when there is no estimate. */
  progress: number | null;
  /** Absolute ISO time; null when there is no estimate or the run is past its usual duration. */
  etaAt: string | null;
  confidence: ProgressConfidence;
  confidenceScore: number;
  /** Always set. With a null progress it says why and what to do. */
  reason: string;
  /** The daemon clock when this was computed; remaining time is measured against it, not against this machine's clock. */
  serverNow: string;
  detail?: Record<string, unknown>;
}
