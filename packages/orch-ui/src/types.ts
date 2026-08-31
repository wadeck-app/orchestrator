// Shared domain types (duplicated from orchestrator-cli to avoid circular dep)
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
}

export interface RuntimeEntry {
  startedAt: string;
  exitCode: number | null;
  pid: number | null;
}
