import { isAlive } from './process-tree.js';

export interface DashboardInfo {
  port: number;
  pid: number;
  startedAt?: string;
}

/**
 * State of `<configDir>/config.dashboard`.
 *
 * `stale` and `corrupt` both mean "no dashboard is serving, delete the file":
 * they are kept apart so the CLI can say which one it cleaned up.
 */
export type DashboardState =
  | { kind: 'stopped' }
  | { kind: 'corrupt' }
  | { kind: 'stale'; info: DashboardInfo }
  | { kind: 'running'; info: DashboardInfo };

/**
 * Classifies the dashboard pid file contents.
 *
 * `raw` is the file contents, or null when the file does not exist. Liveness is
 * injected so this stays pure and testable; callers pass `isAlive`.
 *
 * A present file is never treated as proof that the dashboard is up - the pid is
 * always probed. Trusting the file alone made a leftover file from a crashed
 * server wedge `orch server start` into reporting "already running" forever.
 */
export function classifyDashboard(
  raw: string | null,
  isPidAlive: (pid: number) => boolean = isAlive,
): DashboardState {
  if (raw === null) return { kind: 'stopped' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isDashboardInfo(parsed)) return { kind: 'corrupt' };

  const info: DashboardInfo = {
    port: parsed.port,
    pid: parsed.pid,
    startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : undefined,
  };
  return isPidAlive(info.pid) ? { kind: 'running', info } : { kind: 'stale', info };
}

/** Narrows parsed JSON to the two fields the CLI needs to act on. */
function isDashboardInfo(value: unknown): value is DashboardInfo & { startedAt?: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  return 'port' in value && typeof value.port === 'number'
    && 'pid' in value && typeof value.pid === 'number';
}
