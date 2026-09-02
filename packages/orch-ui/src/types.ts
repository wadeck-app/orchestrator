// Shared domain types (duplicated from orchestrator-cli to avoid circular dep)
export type MissedFiring = 'catch-up' | 'skip';

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
  onExitCode?: Record<string, string>;
}

export function getErrorMessage(e: unknown): string {
  // violations-suppress: ts/no-err-message-direct this IS the instanceof-guarded safe accessor - the one place in orch-ui where .message access is correct
  if (e instanceof Error) return e.message;
  return String(e);
}

export type TriggerSource =
  | { kind: 'cron' }
  | { kind: 'manual'; ip?: string; userAgent?: string };

export interface RuntimeEntry {
  startedAt: string;
  exitCode: number | null;
  pid: number | null;
  triggeredBy?: TriggerSource;
}
