// Enum values - single source of truth
export const JOB_TYPES = ['cron', 'startup', 'once'] as const;
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
  timeoutSeconds?: number;
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
}

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
 * The two mapped to a function cannot vanish: `label` is read raw in a dozen places (orch-ui's
 * `job.label.toLowerCase()` throws on undefined) and `triggerMode` is non-optional in the type
 * orch-ui consumes and rendered as-is. They fall back to their creation-time value instead.
 *
 * The rule is mechanical, so a new Job field does not land in a grey area: every optional field of
 * Job is here, and only the required ones are absent -- id, type, command, enabled, a cron's
 * schedule, a once job's delayMs and scheduledAt -- because clearing one of those would write a job
 * the scheduler cannot fire. Add a field to Job, add it here.
 */
export const UNSETTABLE_FIELDS: Record<string, 'delete' | ((job: Job) => unknown)> = {
  cwd:                'delete',
  delaySeconds:       'delete',
  missedFiring:       'delete',
  timeoutSeconds:     'delete',
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
  label:              (job) => job.id,
  triggerMode:        () => 'fire-and-forget',
};

/** Job fields that cannot be cleared, so the error can say "required" instead of "unknown". */
const REQUIRED_FIELDS = new Set(['id', 'type', 'command', 'enabled', 'schedule', 'delayMs', 'scheduledAt']);

/**
 * Explains why `field` cannot be cleared, and lists what can be -- the caller typed a name and needs
 * to know which one to type instead. Returns null when the field is unsettable, i.e. all is well.
 */
export function unsettableFieldError(field: string): string | null {
  if (UNSETTABLE_FIELDS[field]) return null;
  const valid = Object.keys(UNSETTABLE_FIELDS).join(', ');
  const reason = REQUIRED_FIELDS.has(field)
    ? `"${field}" is required to run the job and cannot be unset.`
    : `Unknown job field "${field}".`;
  return `${reason}\n\nFields that can be unset: ${valid}`;
}

export interface StartupResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

export type TriggerSource =
  | { kind: 'cron' }
  | { kind: 'manual'; ip?: string; userAgent?: string }
  | { kind: 'dependency'; dependsOnJobId: string }
  | { kind: 'retry'; attempt: number };

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

/** RPC command map for the orchestrator daemon (used with singleton-daemon-kit). */
export type OrchestratorCommands = {
  'list-jobs':   (payload?: unknown) => Job[];
  'get-job':     (payload?: unknown) => Job | null;
  'add-job':     (payload?: unknown) => Job;
  'remove-job':  (payload?: unknown) => void;
  'enable-job':  (payload?: unknown) => void;
  'disable-job': (payload?: unknown) => void;
  'edit-job':    (payload?: unknown) => Job;
  'trigger-job': (payload?: unknown) => Promise<{ pid: number | null } | { exitCode: number | null }>;
  'kill-job':          (payload?: unknown) => Promise<{ killed: boolean }>;
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
  'get-uptime':             (payload?: unknown) => Record<string, number | null>;
  'get-resource-baseline':  (payload?: unknown) => { cpuPct: number; ramMb: number } | null;
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

export interface CliDeps {
  /** RPC-style send: command name + optional payload. 'version' resolves via client.version(). */
  send: (command: string, payload?: unknown) => Promise<unknown>;
  startDaemon: () => void;
  configDir: string;
}
