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
  command: string;
  cwd?: string | null;
  enabled: boolean;
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

// Finished without an exit code (killed by signal), or explicitly cancelled.
export function isRunCancelled(entry: RuntimeEntry | null): boolean {
  if (entry === null || isRunActive(entry)) return false;
  return entry.cancelledByUser === true || entry.exitCode === null;
}

// Only a real non-zero exit code is a failure: null means killed, not failed.
export function isRunFailed(entry: RuntimeEntry | null): boolean {
  return entry !== null && entry.exitCode != null && entry.exitCode !== 0;
}
