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
}

export interface StartupResult {
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface RuntimeEntry {
  startedAt: string;
  exitCode: number | null;
  pid: number | null;
}

export interface RegistryData {
  version: number;
  jobs: Job[];
}

export interface StateData {
  jobs: Record<string, RuntimeEntry>;
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
  'list-state':  (payload?: unknown) => Record<string, RuntimeEntry>;
  'quit':        (payload?: unknown) => void;
  'restart':     (payload?: unknown) => void;
};

export interface CliDeps {
  /** RPC-style send: command name + optional payload. 'version' resolves via client.version(). */
  send: (command: string, payload?: unknown) => Promise<unknown>;
  startDaemon: () => void;
  configDir: string;
}
