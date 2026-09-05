export type JobType = 'cron' | 'startup' | 'once';
export type TriggerMode = 'fire-and-forget' | 'wait';
export type MissedFiring = 'catch-up' | 'skip';
export type LivenessStrategy = 'none' | 'portFile' | 'pidFile' | 'command';

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
  triggerMode: TriggerMode;
  missedFiring?: MissedFiring;
  liveness: LivenessConfig | null;
  onExitCode?: Record<string, string>;
  timeoutSeconds?: number;
  env?: Record<string, string>;
  tags?: string[];
  alertAfterFailures?: number;
  dependsOn?: string;
  slaWindowMinutes?: number;
  secrets?: string[];
  dryRunSupported?: boolean;
}

export interface StartupResult {
  ok: boolean;
  detail?: string;
  error?: string;
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
}

export interface RegistryData {
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
  'trigger-job': (payload?: unknown) => Promise<{ pid: number | null } | { exitCode: number }>;
  'list-state':  (payload?: unknown) => Record<string, RuntimeEntry[]>;
  'list-failures': (payload?: unknown) => Array<{ jobId: string; entry: RuntimeEntry }>;
  'ack-failures':  (payload?: unknown) => Record<string, never>;
  'list-audit':    (payload?: unknown) => Array<{ ts: string; event: string; [key: string]: unknown }>;
  'get-schedule':           (payload?: unknown) => Array<{ jobId: string; label: string; next: string[] }>;
  'get-uptime':             (payload?: unknown) => Record<string, number | null>;
  'get-resource-baseline':  (payload?: unknown) => { cpuPct: number; ramMb: number } | null;
  'list-webhooks': (payload?: unknown) => import('./webhook-manager.js').WebhookConfig[];
  'add-webhook':   (payload?: unknown) => void;
  'remove-webhook':(payload?: unknown) => void;
  'toggle-webhook':(payload?: unknown) => import('./webhook-manager.js').WebhookConfig | null;
  'dry-run-job':   (payload?: unknown) => Promise<{ pid: number | null } | { exitCode: number } | { error: string }>;
  'list-secrets':  (payload?: unknown) => string[];
  'set-secret':    (payload?: unknown) => void;
  'delete-secret': (payload?: unknown) => void;
  'quit':        (payload?: unknown) => void;
  'restart':     (payload?: unknown) => void;
};

export interface CliDeps {
  /** RPC-style send: command name + optional payload. 'version' resolves via client.version(). */
  send: (command: string, payload?: unknown) => Promise<unknown>;
  startDaemon: () => void;
  configDir: string;
}
