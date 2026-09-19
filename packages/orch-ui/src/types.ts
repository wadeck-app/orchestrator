// Shared domain types (duplicated from orchestrator-cli to avoid circular dep)
export type MissedFiring = 'catch-up' | 'skip';
export type LivenessStrategy = 'none' | 'portFile' | 'pidFile' | 'command';

export interface LivenessConfig {
  strategy: LivenessStrategy;
  portFile?: string;
  command?: string;
}

export interface Job {
  id: string;
  type: 'cron' | 'startup' | 'once';
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
  timeoutSeconds?: number;
  env?: Record<string, string>;
  tags?: string[];
  dependsOn?: string;
  alertAfterFailures?: number;
  slaWindowMinutes?: number;
  secrets?: string[];
  dryRunSupported?: boolean;
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
}

/**
 * The fields `PUT /api/jobs/:id` accepts in its `unset` array. Mirrors UNSETTABLE_FIELDS in
 * orchestrator-cli's types.ts - anything else makes registry.edit() throw, and the daemon is right
 * to: id, type, command, enabled, a cron's schedule and a once job's delayMs are what let the
 * scheduler fire the job at all.
 */
export type UnsettableJobField =
  | 'cwd' | 'delaySeconds' | 'missedFiring' | 'timeoutSeconds' | 'env' | 'tags'
  | 'onExitCode' | 'retryOnExitCodes' | 'retryDelays' | 'skipExitCodes' | 'liveness'
  | 'alertAfterFailures' | 'dependsOn' | 'slaWindowMinutes' | 'secrets' | 'dryRunSupported'
  | 'label' | 'triggerMode'
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

export function getErrorMessage(e: unknown): string {
  // violations-suppress: ts/no-err-message-direct this IS the instanceof-guarded safe accessor - the one place in orch-ui where .message access is correct
  if (e instanceof Error) return e.message;
  return String(e);
}

export type TriggerSource =
  | { kind: 'cron' }
  | { kind: 'manual'; ip?: string; userAgent?: string }
  | { kind: 'dependency'; dependsOnJobId: string };

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
   * The daemon deliberately did no work, or the child exited with a code the job declares as
   * "not a failure" (a scraper exiting 2 because a sibling already holds its lock).
   *
   * Authoritative: it wins over every exitCode-based classification. exitCode may still be the
   * child's own code, or null when nothing was ever spawned, and neither may raise an alarm.
   */
  skipped?: boolean;
}

// Picks the run with the latest startedAt. Do not trust index 0: overlapping runs
// could leave a finished entry at the head, and older histories still contain
// exitCode:null orphans from runs whose completion was never recorded.
export function latestRun(entries: RuntimeEntry[] | undefined): RuntimeEntry | null {
  if (!entries || entries.length === 0) return null;
  return entries.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
}

// Both conditions are required. A process killed by signal has no exit code, so a cancelled
// run looks exactly like an in-flight one on exitCode alone and finishedAt is what separates
// them. But history written before finishedAt existed has an exit code and no finishedAt, and
// treating those as running would leave old entries stuck on "Running" forever.
export function isRunActive(entry: RuntimeEntry | null): boolean {
  return entry !== null && entry.finishedAt == null && entry.exitCode == null;
}

// A non-event: neither an outcome to celebrate nor one to alarm about. Checked first by every
// other classifier below, because a skipped run's exitCode is indistinguishable from a real
// failure (exit 2) or a signal kill (null) and would otherwise be reported as one.
export function isRunSkipped(entry: RuntimeEntry | null): boolean {
  return entry !== null && entry.skipped === true;
}

// Finished without an exit code (killed by signal), or explicitly cancelled.
export function isRunCancelled(entry: RuntimeEntry | null): boolean {
  if (entry === null || isRunActive(entry) || isRunSkipped(entry)) return false;
  return entry.cancelledByUser === true || entry.exitCode === null;
}

// Only a real non-zero exit code is a failure: null means killed, not failed.
export function isRunFailed(entry: RuntimeEntry | null): boolean {
  if (isRunSkipped(entry)) return false;
  return entry !== null && entry.exitCode != null && entry.exitCode !== 0;
}
