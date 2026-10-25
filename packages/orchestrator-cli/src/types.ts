// Enum values - single source of truth
export const JOB_TYPES = ['cron', 'startup', 'once', 'manual'] as const;

/**
 * Job fields that only mean something to a job the scheduler fires by itself.
 *
 * A `manual` job is never fired by the scheduler, so it refuses these (validateJob) and loses them when a
 * job is edited into one (Registry.edit). `spent` and `spentAt` are the once job's own state: not refused
 * on a manual job, which a daemon never writes them to, but dropped when a spent once job becomes manual.
 */
export const MANUAL_REFUSED_FIELDS = [
  'schedule', 'delaySeconds', 'delayMs', 'scheduledAt', 'missedFiring', 'activeFrom', 'activeUntil',
] as const;
export const MANUAL_DROPPED_ON_CONVERSION = [...MANUAL_REFUSED_FIELDS, 'spent', 'spentAt'] as const;
export const TRIGGER_MODES = ['fire-and-forget', 'wait'] as const;
export const MISSED_FIRINGS = ['catch-up', 'skip'] as const;
export const LIVENESS_STRATEGIES = ['none', 'portFile', 'pidFile', 'command'] as const;

// Derived types from enums (prevents divergence)
export type JobType = typeof JOB_TYPES[number];
export type TriggerMode = typeof TRIGGER_MODES[number];
export type MissedFiring = typeof MISSED_FIRINGS[number];
export type LivenessStrategy = typeof LIVENESS_STRATEGIES[number];

export interface LivenessConfig {
  strategy: LivenessStrategy;
  portFile?: string;
  command?: string;
}

/** What the resource monitor does when a run stays over its hard budget. */
export const RESOURCE_ENFORCE_MODES = ['kill', 'warn', 'off'] as const;
export type ResourceEnforce = typeof RESOURCE_ENFORCE_MODES[number];

/**
 * Per-job tuning of the resource monitor. Every key is optional; see resource-limits.ts for the defaults,
 * the ranges and how they combine.
 */
export interface ResourceLimits {
  /** kill (default): end the run on a sustained breach. warn: log and publish, kill nothing. off: no threshold is checked. */
  enforce?: ResourceEnforce;
  /** Hard budget as a multiple of the baseline (mean of the last peaks). Finite, > 1, <= 100. Default 3. */
  hardFactor?: number;
  /** Soft (warning-only) budget as a multiple of the baseline. Finite, > 1, below hardFactor. Default 1.5. */
  softFactor?: number;
  /** How long the hard budget must stay exceeded before it counts. Integer 2..3600. Default 30. */
  sustainSeconds?: number;
  /** Absolute CPU ceiling in percent (> 0). Replaces the factor-derived hard CPU threshold; needs no baseline. */
  maxCpuPct?: number;
  /** Absolute RAM ceiling in MB (> 0). Replaces the factor-derived hard RAM threshold; needs no baseline. */
  maxRamMb?: number;
}

/** The longest description a job may have, counted on the trimmed text. */
export const DESCRIPTION_MAX_LENGTH = 2000;

export interface Job {
  id: string;
  type: JobType;
  label: string;
  schedule?: string;
  delaySeconds?: number;
  delayMs?: number;
  scheduledAt?: string;
  cwd?: string | null;
  command: string;
  /**
   * Free text for humans: what the job is for. Plain text, may contain line breaks, stored trimmed, at
   * most DESCRIPTION_MAX_LENGTH characters (longer is refused, never cut). Absent when empty. No effect
   * on scheduling.
   */
  description?: string;
  /** Tunes the resource monitor for this job. Absent means the defaults. Clear it with `--unset resourceLimits`. */
  resourceLimits?: ResourceLimits;
  enabled: boolean;
  /**
   * The window a cron job is allowed to fire in. Both ISO timestamps, both optional.
   *
   * `activeFrom` may be in the FUTURE: a job can be configured now to start firing later, which is a
   * third state rather than a flavour of disabled. Enabled-but-not-yet-started is the job working as
   * configured; disabled is someone having turned it off.
   *
   * At `activeUntil` the job is DISABLED, not deleted - its definition, history and logs stay, and
   * re-enabling it is a decision the user makes rather than a recovery from deletion. "Active for
   * three weeks" is activeFrom now, activeUntil now + 3 weeks.
   */
  activeFrom?: string;
  activeUntil?: string;
  triggerMode: TriggerMode;
  missedFiring?: MissedFiring;
  /**
   * Absent when the job has no liveness check -- the registry drops the key rather than storing a
   * null. Every reader tests it for truthiness (`!liveness` in checkLiveness, `!= null` in
   * validateJob), so absence and null behave identically.
   */
  liveness?: LivenessConfig | null;
  onExitCode?: Record<string, string>;
  /** Default 300 (applied where this is read, not stored). 0 means no timeout -- for a process
   * that must stay up, e.g. a dev server. No upper bound: the scheduler's job-timeout timer is
   * armed through waitUntil (time-service.ts), which absorbs the runtime's 2^31-1 ms ceiling. */
  timeoutSeconds?: number;
  /**
   * How many runs of this job may be alive at once. Absent means no limit, which is today's
   * behaviour; 1 means "never start a second instance while one is running".
   *
   * A firing that finds the job at its limit is refused and reported as a skip with reason
   * `concurrency` -- an outcome, not an error. `orch trigger --force` bypasses it.
   *
   * `orch kill` stops every live instance of the job.
   */
  maxConcurrency?: number;
  env?: Record<string, string>;
  tags?: string[];
  alertAfterFailures?: number;
  dependsOn?: string;
  slaWindowMinutes?: number;
  secrets?: string[];
  dryRunSupported?: boolean;
  retryOnExitCodes?: number[];
  retryDelays?: number[];
  /**
   * Exit codes that mean "this run deliberately did nothing", not "this run broke".
   *
   * Per job because the meaning of a code belongs to the program being launched, not to orch: the
   * scrapers use 2 for "another instance already holds the lock" (documented in their CLAUDE.md as
   * "consumers must treat 2 as skipped"), while for any other binary 2 could be a real fault.
   *
   * orch takes the program at its word and cannot verify the claim: a program that does work before
   * checking its own lock reports "nothing was done" after having done something. So this declares
   * "treat this code as a skip", not "the state is guaranteed unchanged", which is why the real exit
   * code and the child's stderr stay in the run history and the per-run log. See P-8 in
   * .claude/guiding-principles.md.
   */
  skipExitCodes?: number[];
  /**
   * A `once` job has had its single firing. Absent means it is still waiting for it.
   *
   * A spent job used to be deleted outright, which made the audit trail lie by omission: `job.added`
   * recorded `type: once` and then the job was simply gone, indistinguishable from one a user removed
   * by hand -- and the run history in state.json pointed at an id the registry no longer knew.
   *
   * Kept instead, bounded by the retention policy in registry.ts so the file cannot grow without
   * limit. Every reader that arms or reports on a job must treat this as terminal: the scheduler does
   * not arm it, and `orch timers` does not call it a problem.
   */
  spent?: boolean;
  /** When the firing that spent the job happened. Set once, with `spent`, and never moved after. */
  spentAt?: string;
  /**
   * How the progress and estimated end of a running job are computed. Absent means 'auto'.
   * Validated by progressSettingError (progress/setting.ts), which lists the registered strategies.
   */
  progress?: JobProgressSetting;
}

/** A string: 'auto' picks a strategy per run, 'off' disables the estimate, a strategy id forces it (no fallback). Or the object form with options. */
export type JobProgressSetting = string | { strategy: string; options?: unknown };

/**
 * Fields that can hold nothing, and what "nothing" is stored as for each.
 *
 * Used for both ways a field ends up empty, so they cannot drift apart: `orch edit --unset <field>`
 * (an edit is a patch, so an omitted flag means "leave it alone" -- there is no value that spells
 * "remove this option") and any write that carries an empty value, from `orch add` leaving cwd out
 * to `--cwd ""`.
 *
 * `'delete'` drops the key: these fields are optional in Job and every consumer reads them with a
 * fallback (`job.cwd ?? undefined`, `job.delaySeconds ?? 0`, `job.timeoutSeconds ?? 300`, `!liveness`),
 * so an absent key behaves exactly like "not configured" and `orch show` stops mentioning it.
 *
 * The two mapped to a function cannot vanish: `label` is read raw in a dozen places (dsl-lib-orch's
 * `job.label.toLowerCase()` throws on undefined) and `triggerMode` is non-optional in the type
 * dsl-lib-orch consumes and rendered as-is. They fall back to their creation-time value instead.
 *
 * The rule is mechanical, so a new Job field does not land in a grey area: every optional field of
 * Job is here, except the ones listed in REQUIRED_FIELDS -- clearing one of those would write a job
 * the scheduler cannot fire -- and the ones in DAEMON_OWNED_FIELDS, which no user ever set. Add a
 * field to Job, add it to exactly one of the three.
 */
export const UNSETTABLE_FIELDS: Record<string, 'delete' | ((job: Job) => unknown)> = {
  cwd:                'delete',
  delaySeconds:       'delete',
  missedFiring:       'delete',
  timeoutSeconds:     'delete',
  maxConcurrency:     'delete',
  env:                'delete',
  tags:               'delete',
  onExitCode:         'delete',
  retryOnExitCodes:   'delete',
  retryDelays:        'delete',
  skipExitCodes:      'delete',
  liveness:           'delete',
  alertAfterFailures: 'delete',
  dependsOn:          'delete',
  slaWindowMinutes:   'delete',
  secrets:            'delete',
  dryRunSupported:    'delete',
  description:        'delete',
  resourceLimits:     'delete',
  // Absent is 'auto', so clearing it is the way back to the default.
  progress:           'delete',
  label:             (job) => job.id,
  triggerMode:        () => 'fire-and-forget',
};

/** Job fields that cannot be cleared, so the error can say "required" instead of "unknown". */
const REQUIRED_FIELDS = new Set(['id', 'type', 'command', 'enabled', 'schedule', 'delayMs', 'scheduledAt']);

/**
 * Job fields the daemon writes and the user does not, so the error can say so instead of "unknown".
 *
 * A name the user can see in `orch show` and in registry.json but cannot unset needs to explain which
 * of the two it is: a typo, or a field that is simply not theirs. "Unknown job field" would send them
 * looking for a spelling mistake that is not there.
 *
 * Clearing `spent` is not merely disallowed for tidiness -- a once job whose moment has long passed
 * would be re-armed by the next daemon start and run again, which is precisely what the type promises
 * will not happen.
 */
const DAEMON_OWNED_FIELDS = new Set(['spent', 'spentAt']);

/**
 * Explains why `field` cannot be cleared, and lists what can be -- the caller typed a name and needs
 * to know which one to type instead. Returns null when the field is unsettable, i.e. all is well.
 */
export function unsettableFieldError(field: string): string | null {
  if (UNSETTABLE_FIELDS[field]) {
    return null;
  }
  const valid = Object.keys(UNSETTABLE_FIELDS).join(', ');
  let reason: string;
  if (REQUIRED_FIELDS.has(field)) {
    reason = `"${field}" is required to run the job and cannot be unset.`;
  } else if (DAEMON_OWNED_FIELDS.has(field)) {
    reason = `"${field}" is set by the daemon when a once job fires, not by you, and cannot be unset. `
      + `To run the same command again, add a new job (orch add once ...).`;
  } else {
    reason = `Unknown job field "${field}".`;
  }
  return `${reason}\n\nFields that can be unset: ${valid}`;
}

export interface StartupResult {
  ok: boolean;
  detail?: string;
  error?: string;
  /** The entry was written, but something the user should act on happened (e.g. the login-shell PATH could not be read). */
  warnings?: string[];
}

export type TriggerSource =
  | { kind: 'cron' }
  | { kind: 'manual'; ip?: string; userAgent?: string }
  | { kind: 'dependency'; dependsOnJobId: string }
  | { kind: 'retry'; attempt: number };

/**
 * Version of the method that measures a run's CPU and RAM peaks. Raise it whenever a change would make
 * old peaks mean something different.
 *
 * 2: the process-tree guard compares creation times. Version 1 compared the age each process had when
 * it was queried, so under load a real child queried seconds after its parent looked older and was
 * dropped, and a job was recorded as its idle shell wrapper (17 MB where it weighs 130 MB). The hard
 * budget is twice the average of past peaks, so the old figures cannot be mixed with correct ones:
 * correct measurements would exceed a budget built from them, every run would be killed, and since only
 * successful runs feed the baseline it would never recover.
 */
export const PEAK_MEASURE_VERSION = 2;

export interface RuntimeEntry {
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  pid: number | null;
  triggeredBy?: TriggerSource;
  acknowledgedAt?: string;
  peakCpuPct?: number;
  peakRamMb?: number;
  /**
   * Which measurement method produced `peakCpuPct`/`peakRamMb`: PEAK_MEASURE_VERSION when the run was
   * measured by the current sampler. Absent on runs recorded before it existed, whose peaks may have
   * counted only the job's idle shell wrapper. The resource baseline ignores those; see
   * PEAK_MEASURE_VERSION.
   */
  peakMeasure?: number;
  cancelledByUser?: boolean;
  /**
   * Why the run was ended by force: the job's timeout, a user's kill, or the resource limit. Absent for a run that
   * ended on its own. `cancelledByUser` stays for entries and readers that predate it.
   */
  endReason?: 'timeout' | 'manual-kill' | 'resource-limit';
  /**
   * The daemon learned of this run's end after the fact (it ended while the daemon was down), so `finishedAt` is
   * when it really ended, not when it was noticed. Absent for a run the daemon watched end.
   */
  late?: boolean;
  /**
   * Set when the daemon deliberately did not do the work: the liveness check found the target
   * already alive, or the child exited with one of the job's `skipExitCodes`.
   *
   * Authoritative over exitCode for every reader -- failures, consecutive-failure count, uptime,
   * systray, dashboard. A skip is neither a success nor a failure, so it is excluded from all of
   * them rather than counted on either side.
   */
  skipped?: boolean;
  retryAttempt?: number;
  /**
   * Set when the daemon closed this run at startup because it had no finishedAt: the daemon that
   * spawned it is gone, so nothing could ever have observed the process end. Distinguishes an
   * interrupted run from one whose exit was actually seen.
   */
  orphaned?: boolean;
  /**
   * The run is owned by a supervisor process, not by the daemon, so it survives a daemon restart and is followed
   * again after it. Set while the run is open; it is what keeps the updater from waiting for it.
   */
  supervised?: boolean;
}

export interface RegistryData {
  /**
   * Notice aimed at whoever opens registry.json expecting to edit it, agents included. Written by
   * Registry on every save; see REGISTRY_NOTICE in registry.ts for why it has to be there.
   */
  _README?: string;
  version: number;
  jobs: Job[];
}

export interface StateData {
  jobs: Record<string, RuntimeEntry[]>;
}

/**
 * What `trigger-job` answers. `status` is the discriminant: a refused trigger is a result, not an
 * error, so a caller chaining commands can tell "started" from "was already running" without
 * parsing a message. A CLI older than this field never reads `status` and prints its usual line.
 */
export type TriggerResult =
  | { status: 'started';  pid: number | null;      consumed?: boolean }
  | { status: 'finished'; exitCode: number | null; consumed?: boolean }
  | { status: 'already-running'; running: number; maxConcurrency: number };

/**
 * What `restart-job` answers. A refused start is a result, not an error (the instances were still ended, and
 * the caller needs to know that): `started: false` carries `reason`, and `skipped` names the refusal when it is
 * one of the scheduler's own. `skipped` is absent when the old instance would not end in time.
 */
export interface RestartResult {
  id: string;
  wasRunning: boolean;
  /** Instances ended by this restart. */
  killed: number;
  started: boolean;
  pid: number | null;
  skipped?: 'liveness' | 'concurrency' | 'adopted';
  /** A plain sentence saying why nothing started and what to do. */
  reason?: string;
}

/** What `get-daemon-info` answers. No job command, environment or secret is ever part of it. */
export interface DaemonInfo {
  version: string;
  pid: number;
  port: number;
  /** ISO. */
  startedAt: string;
  uptimeSeconds: number;
  config: {
    supervisedJobs: boolean; lateActionWindowMinutes: number; autoUpdate: boolean; appCore: boolean;
    catchUpInitialDelaySeconds: number; catchUpStaggerSeconds: number;
  };
  supervisor: { requested: boolean; active: boolean; note?: string };
  runs: { running: number; supervised: number; followedAgain: number };
  scheduler: { armed: number; desired: number; problems: Array<{ jobId: string; problem: string }> };
}

/** RPC command map for the orchestrator daemon (used with singleton-daemon-kit). */
export type OrchestratorCommands = {
  'list-jobs':   (payload?: unknown) => Job[];
  'get-job':     (payload?: unknown) => Job | null;
  'add-job':     (payload?: unknown) => Job;
  /** Replies with `leftovers` (path + reason) only when some derived data of the job could not be deleted. */
  'remove-job':  (payload?: unknown) => { leftovers: Array<{ path: string; reason: string }> } | void;
  'enable-job':  (payload?: unknown) => void;
  'disable-job': (payload?: unknown) => void;
  'edit-job':    (payload?: unknown) => Job;
  'trigger-job': (payload?: unknown) => Promise<TriggerResult>;
  'kill-job':          (payload?: unknown) => Promise<{ killed: boolean; count: number }>;
  'restart-job':       (payload?: unknown) => Promise<RestartResult>;
  'skip-next-firing':  (payload?: unknown) => Record<string, never>;
  'list-state':  (payload?: unknown) => Record<string, RuntimeEntry[]>;
  'list-failures': (payload?: unknown) => Array<{ jobId: string; entry: RuntimeEntry }>;
  'ack-failures':  (payload?: unknown) => Record<string, never>;
  'list-audit':    (payload?: unknown) => Array<{ ts: string; event: string; [key: string]: unknown }>;
  'get-schedule':           (payload?: unknown) => Array<{ jobId: string; label: string; next: string[] }>;
  /** What the scheduler has armed, per job, next to what the registry asks for. See inspectTimers. */
  'list-timers':            (payload?: unknown) => Array<{
    jobId: string; type: string; enabled: boolean;
    armed: string | null; dueAt: string | null; windowEndsAt: string | null;
    nextFiring: string | null; windowState: string | null; problem: string | null;
  }>;
  /** The daemon's own status; see DaemonInfo and docs/daemon-config.md. */
  'get-daemon-info':        (payload?: unknown) => DaemonInfo;
  'get-uptime':             (payload?: unknown) => Record<string, number | null>;
  /** Progress and ETA per job with an open run (others are absent); see progress/engine.ts. `jobIds` restricts it. */
  'get-progress':           (payload?: unknown) => Record<string, import('./progress/types.js').ProgressEstimate>;
  'get-resource-baseline':  (payload?: unknown) => { cpuPct: number; ramMb: number } | null;
  /** One run's resource curve from the telemetry file; see run-telemetry.ts. `run` is its startedAt, default the newest. */
  'get-run-telemetry':      (payload?: unknown) => Promise<import('./run-telemetry.js').RunTelemetry>;
  /** The newest runs' consumption, from <configDir>/resource-history; see resource-history.ts. `limit` 1..500, default 100. */
  'get-resource-history':   (payload?: unknown) => import('./resource-history.js').ResourceHistory;
  'dry-run-job':   (payload?: unknown) => Promise<{ pid: number | null } | { exitCode: number | null } | { error: string }>;
  'list-secrets':  (payload?: unknown) => string[];
  'set-secret':    (payload?: unknown) => void;
  'delete-secret': (payload?: unknown) => void;
  'exec-run':    (payload?: unknown) => { runId: string; pid: number | null; status: 'running' };
  'exec-status': (payload?: unknown) => import('./exec-manager.js').ExecRun | { error: string };
  'exec-list':   (payload?: unknown) => import('./exec-manager.js').ExecRun[];
  'exec-kill':   (payload?: unknown) => { ok: boolean };
  'quit':        (payload?: unknown) => void;
  'restart':     (payload?: unknown) => void;
  'tray-action': (payload?: unknown) => { ok: boolean; error?: string };
  'tray-list':   (payload?: unknown) => string[];
};

export interface SendOptions {
  /**
   * Whether a command that finds the daemon down starts it and retries (default true, the ssh-agent pattern).
   * `false` for a command whose answer IS whether the daemon is there: it rethrows the connection error.
   */
  autoStart?: boolean;
}

export interface CliDeps {
  /** RPC-style send: command name + optional payload. 'version' resolves via client.version(). */
  send: (command: string, payload?: unknown, options?: SendOptions) => Promise<unknown>;
  startDaemon: () => void;
  configDir: string;
  /** `orch job <jobId> logs` seams: how often -f reads the followed file (ms, default 250) and where its output goes. Tests set them. */
  jobLogs?: { pollMs?: number; stdout?: (text: string) => void; stderr?: (text: string) => void; time?: import('./time-service.js').TimeService };
}
