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
  delaySeconds?: number;
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

// A process killed by signal has no exit code, so a cancelled run is recorded with
// exitCode:null just like an in-flight one. Only finishedAt separates the two.
export function isRunActive(entry: RuntimeEntry | null): boolean {
  return entry !== null && entry.finishedAt == null;
}
